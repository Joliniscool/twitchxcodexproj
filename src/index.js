import 'dotenv/config';
import path from 'node:path';

import { createRollingBuffer } from './core/buffer.js';
import { createCatchupManager } from './core/catchup.js';
import { parseCommandText, isAllowedTrigger } from './core/commands.js';
import { createHypeDetector } from './core/hype.js';
import { summarizeCatchup } from './ai/openai.js';
import { createLocalServer } from './server/server.js';
import { createMomentAssets } from './twitch/helix.js';
import { EventSubClient } from './twitch/eventsub.js';
import { startSimulator } from './sim/simulator.js';

const logger = console;
const buffer = createRollingBuffer(30 * 60 * 1000);
const server = createLocalServer({ port: Number(process.env.PORT) || 3000, logger });
const hypeDetector = createHypeDetector({
  storagePath: path.resolve(process.cwd(), 'data/moments.json'),
  logger,
});
const catchupManager = createCatchupManager({
  buffer,
  summarizeFn: summarizeCatchup,
  logger,
});

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

async function handleMomentCommand() {
  const moments = await hypeDetector.listMoments();
  const today = moments.filter((moment) => {
    const at = Number(moment.at || 0);
    return at && at >= Date.now() - 24 * 60 * 60 * 1000;
  });

  const message = today.length
    ? `Today's moments: ${today.map((moment) => moment.label).slice(-5).join(' • ')}`
    : 'No moments yet today.';

  handleIncomingEvent({
    type: 'chat',
    user: 'Rewind',
    text: message,
    emotes: [],
    badges: ['bot'],
    at: Date.now(),
    raw: { text: message },
  });
}

async function handleIncomingEvent(event) {
  buffer.add(event);
  hypeDetector.recordEvent(event);

  const summary = event.text ? `${event.user || 'system'}: ${event.text}` : `${event.type}`;
  logger.info(`[pipeline] ${summary}`);

  const command = parseCommandText(event.text || '');
  if (command && command.command === '!rewind' && isAllowedTrigger(event)) {
    triggerCatchup({ source: 'chat' });
  }

  if (command && command.command === '!moments') {
    await handleMomentCommand();
  }

  const moment = hypeDetector.detectCurrentMoment();
  if (moment) {
    const media = await createMomentAssets({
      simulate: process.env.SIMULATE === 'true' || !process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_TOKEN,
      logger,
      triggerText: moment.label,
    });

    const enrichedMoment = {
      ...moment,
      clipUrl: media.clipUrl,
      markerId: media.markerId,
      createdAt: Date.now(),
    };

    await hypeDetector.listMoments().then(async (moments) => {
      const next = moments.filter((entry) => entry.id !== moment.id);
      next.push(enrichedMoment);
      await require('node:fs/promises').writeFile(path.resolve(process.cwd(), 'data/moments.json'), JSON.stringify(next, null, 2));
    });

    const message = `Moment detected: ${moment.label} | score ${moment.score}`;
    server.emitStatus(message);
    logger.info('[hype] moment detected', moment);
  }

  updateUnread();
}

const shouldSimulate = process.env.SIMULATE === 'true' || !process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_TOKEN;

logger.info('[rewind] booting Rewind');
logger.info(`[rewind] simulation mode: ${shouldSimulate ? 'enabled' : 'disabled'}`);

server.setTriggerHandler(triggerCatchup);
server.emitStatus('Rewind ready');

if (shouldSimulate) {
  logger.info('[rewind] starting simulator for local development');
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
  logger,
});

if (!shouldSimulate) {
  twitchClient.connect();
}

server.start().then(() => {
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
