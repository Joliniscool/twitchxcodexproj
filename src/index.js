import 'dotenv/config';
import path from 'node:path';

import { createRollingBuffer } from './core/buffer.js';
import { createCatchupManager } from './core/catchup.js';
import { parseCommandText, isAllowedTrigger } from './core/commands.js';
import { createHypeDetector } from './core/hype.js';
import { createCatalogManager } from './core/catalog.js';
import { createStreamRecap, createViewerAssistant } from './core/recap.js';
import { summarizeCatchup, describeCatalogEntries } from './ai/openai.js';
import { createLocalServer } from './server/server.js';
import { createMomentAssets, sendAnnouncement, sendChatMessage, fetchChannelRewards, fetchActiveExtensions } from './twitch/helix.js';
import { EventSubClient } from './twitch/eventsub.js';
import { startSimulator, SIM_CHANNEL_TOOLS } from './sim/simulator.js';

const CHANNEL_TOOLS_SYNC_MS = 10 * 60 * 1000;
const STATUS_PUSH_MS = 3000;
const SPOTLIGHT_MS = 45 * 1000;
const CUSTOM_REPLY_COOLDOWN_MS = 15 * 1000;
const ANNOUNCEMENT_TEXT = 'Rewind is here: !recap for what you missed, !moments for highlights, !tools for the channel guide, !ask <question>.';

const shouldSimulate = process.env.SIMULATE === 'true' || !process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_TOKEN;

// Simulator data stays in its own files so fake commands never reach real viewers.
const dataPath = (name) => path.resolve(process.cwd(), 'data', shouldSimulate ? `sim-${name}` : name);

const logger = console;
const buffer = createRollingBuffer(30 * 60 * 1000);
const catalogManager = createCatalogManager({
  storagePath: dataPath('catalog.json'),
  logger,
  describeFn: describeCatalogEntries,
});
const server = createLocalServer({ port: Number(process.env.PORT) || 3000, logger, catalogManager, momentsPath: dataPath('moments.json') });
const hypeDetector = createHypeDetector({
  storagePath: dataPath('moments.json'),
  logger,
});
const catchupManager = createCatchupManager({
  buffer,
  summarizeFn: summarizeCatchup,
  logger,
});
const viewerAssistant = createViewerAssistant({ buffer, logger });
const streamRecap = createStreamRecap({
  catalogManager,
  hypeDetector,
  storageDir: dataPath('recaps'),
  logger,
});
const customReplyAt = new Map();
let lastClip = null;
let lastChatAt = null;

const updateUnread = () => {
  const unread = catchupManager.getUnread();
  server.emitUnread(unread);
  return unread;
};

async function triggerCatchup({ source = 'dashboard' } = {}) {
  const digest = await catchupManager.runDigest({ source });
  server.emitDigest(digest);
  updateUnread();
  logger.info(`[catchup] trigger from ${source}`);
  return digest;
}

async function attachClip(moment) {
  const media = await createMomentAssets({
    simulate: shouldSimulate,
    broadcasterId: twitchClient.broadcasterId,
    logger,
    triggerText: moment.label,
  });

  await hypeDetector.saveMoment({ ...moment, clipUrl: media.clipUrl, markerId: media.markerId, createdAt: Date.now() });
  if (media.clipUrl) {
    lastClip = { at: Date.now(), url: media.clipUrl };
  }
  server.emitMoments(await hypeDetector.listMoments());
  return media;
}

async function clipNow() {
  const at = Date.now();
  const moment = { id: `moment-${at}-manual`, at, score: 0, reason: 'manual clip', label: 'Clipped by the streamer', chatSample: [] };
  const media = await attachClip(moment);
  if (!media.clipUrl) {
    throw new Error('Twitch could not create a clip. The channel must be live.');
  }
  return media;
}

async function postRecap() {
  const recap = await streamRecap.build();
  server.publish('recap', recap);
  modelReply(streamRecap.summarize(recap));
  return recap;
}

function getStatus() {
  return {
    simulate: shouldSimulate,
    login: twitchClient.login || null,
    chatConnected: shouldSimulate || twitchClient.isConnected,
    lastChatAt,
    hypeWatching: true,
    lastClip,
    missingScopes: twitchClient.missingScopes,
    announcementsEvery: announcementMinutes,
  };
}

function sendTestMessage() {
  modelReply('Rewind is connected to this chat. Try !tools or !help.');
  return { sent: true };
}

async function handleMomentCommand() {
  const moments = await hypeDetector.listMoments();
  const today = moments.filter((moment) => {
    const at = Number(moment.at || 0);
    return at && at >= Date.now() - 24 * 60 * 60 * 1000;
  });

  const message = today.length
    ? `Today's moments: ${today.map((moment) => moment.label).slice(-5).join(' • ')}`
    : 'No moments yet today.';

  modelReply(message);
}

function modelReply(text, user = 'Rewind') {
  const event = {
    type: 'chat',
    user,
    text,
    emotes: [],
    badges: ['bot'],
    at: Date.now(),
    raw: { text },
  };

  buffer.add(event);
  logger.info(`[chatbot] ${text}`);
  postToTwitchChat(text);
  return event;
}

// Replies are sent as the streamer's account, so EventSub echoes them back; remember them to skip the echo.
const pendingEchoes = new Set();

function postToTwitchChat(text) {
  if (shouldSimulate || !twitchClient.userId) return;

  const message = text.slice(0, 500);
  pendingEchoes.add(message);
  sendChatMessage({
    broadcasterId: twitchClient.broadcasterId,
    senderId: twitchClient.userId,
    message,
    logger,
  }).then((sent) => {
    if (!sent) pendingEchoes.delete(message);
  });
}

async function handleIncomingEvent(event) {
  if (event.type === 'chat' && pendingEchoes.delete(event.text)) {
    return;
  }

  if (event.type === 'stream_online') {
    logger.info('[rewind] stream started, resetting per-stream state');
    viewerAssistant.reset();
    streamRecap.reset();
    return;
  }

  if (event.type === 'stream_offline') {
    logger.info('[rewind] stream ended, building recap');
    await postRecap();
    return;
  }

  streamRecap.recordEvent(event);

  if (event.type === 'chat') {
    lastChatAt = event.at;
    catalogManager.observeEvent(event);

    const viewerReply = viewerAssistant.handleEvent(event);
    if (viewerReply) {
      modelReply(viewerReply.text, viewerReply.user || 'Rewind');
    }
  }

  buffer.add(event);
  hypeDetector.recordEvent(event);

  const summary = event.text ? `${event.user || 'system'}: ${event.text}` : `${event.type}`;
  logger.info(`[pipeline] ${summary}`);

  const command = parseCommandText(event.text || '');
  const isBotGenerated = String(event.user || '').toLowerCase() === 'rewind' || (event.badges || []).some((badge) => String(badge || '').toLowerCase() === 'bot');

  if (!isBotGenerated) {
    if (command && command.command === '!rewind' && isAllowedTrigger(event)) {
      triggerCatchup({ source: 'chat' });
    }

    if (command && command.command === '!moments') {
      await handleMomentCommand();
    }

    if (command && command.command === '!tools') {
      modelReply(catalogManager.buildToolsMenu());
    }

    if (command && command.command === '!ask') {
      const answer = catalogManager.answerQuestion(command.args || '');
      modelReply(answer);
    }

    if (command && catalogManager.getReply(command.command)) {
      const lastAt = customReplyAt.get(command.command) ?? -Infinity;
      if (Date.now() - lastAt >= CUSTOM_REPLY_COOLDOWN_MS) {
        customReplyAt.set(command.command, Date.now());
        modelReply(catalogManager.getReply(command.command));
      }
    }
  }

  const moment = hypeDetector.detectCurrentMoment();
  if (moment) {
    await attachClip(moment);
    const message = `Moment detected: ${moment.label} | score ${moment.score}`;
    server.emitStatus(message);
    logger.info('[hype] moment detected', moment);
  }

  updateUnread();
}

async function syncChannelTools() {
  const broadcasterId = twitchClient.broadcasterId;
  if (!broadcasterId) return;

  const [rewards, extensions] = await Promise.all([
    fetchChannelRewards({ broadcasterId, logger }),
    fetchActiveExtensions({ broadcasterId, logger }),
  ]);
  catalogManager.syncChannelTools({ rewards, extensions });
}

const announcementMinutes = Number(process.env.ANNOUNCE_INTERVAL_MINUTES) || 0;

logger.info('[rewind] booting Rewind');
logger.info(`[rewind] simulation mode: ${shouldSimulate ? 'enabled' : 'disabled'}`);

server.setTriggerHandler(triggerCatchup);
server.setActions({
  getStatus,
  clipNow,
  postRecap,
  sendTestMessage,
  getLatestRecap: () => streamRecap.latest(),
});
server.emitStatus('Rewind ready');

await catalogManager.load();

if (shouldSimulate) {
  logger.info('[rewind] starting simulator for local development');
  catalogManager.syncChannelTools(SIM_CHANNEL_TOOLS);
  startSimulator({
    onEvent: handleIncomingEvent,
    logger,
    intervalMs: 1800,
  });
}

const twitchClient = new EventSubClient({
  accessToken: process.env.TWITCH_TOKEN,
  broadcasterId: process.env.BROADCASTER_ID,
  onEvent: handleIncomingEvent,
  onReady: () => syncChannelTools().catch((error) => logger.error('[catalog] channel tools sync failed', error.message || error)),
  logger,
});

if (!shouldSimulate) {
  twitchClient.connect();
  setInterval(() => syncChannelTools().catch((error) => logger.error('[catalog] channel tools sync failed', error.message || error)), CHANNEL_TOOLS_SYNC_MS);
}

setInterval(() => server.publish('health', getStatus()), STATUS_PUSH_MS);
setInterval(() => server.publish('spotlight', catalogManager.spotlight()), SPOTLIGHT_MS);

if (announcementMinutes > 0) {
  setInterval(() => {
    if (shouldSimulate) {
      logger.info(`[chatbot] (announcement) ${ANNOUNCEMENT_TEXT}`);
      return;
    }
    sendAnnouncement({
      broadcasterId: twitchClient.broadcasterId,
      moderatorId: twitchClient.userId,
      message: ANNOUNCEMENT_TEXT,
      logger,
    });
  }, announcementMinutes * 60 * 1000);
}

server.start().then(async () => {
  server.emitMoments(await hypeDetector.listMoments());
  server.publish('spotlight', catalogManager.spotlight());
  logger.info('[rewind] buffer ready', {
    size: buffer.size(),
    windowMinutes: 30,
  });

  updateUnread();
});

if (process.env.NODE_ENV !== 'production') {
  process.on('SIGINT', () => {
    logger.info('[rewind] shutting down');
    process.exit(0);
  });
}
