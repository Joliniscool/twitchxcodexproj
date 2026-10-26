import 'dotenv/config';

import { createRollingBuffer } from './core/buffer.js';
import { createCatchupManager } from './core/catchup.js';
import { parseCommandText, isAllowedTrigger } from './core/commands.js';
import { summarizeCatchup } from './ai/openai.js';
import { createLocalServer } from './server/server.js';
import { EventSubClient } from './twitch/eventsub.js';
import { startSimulator } from './sim/simulator.js';

const logger = console;
const buffer = createRollingBuffer(30 * 60 * 1000);
const server = createLocalServer({ port: Number(process.env.PORT) || 3000, logger });
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

function handleIncomingEvent(event) {
  buffer.add(event);
  const summary = event.text ? `${event.user || 'system'}: ${event.text}` : `${event.type}`;
  logger.info(`[pipeline] ${summary}`);

  const command = parseCommandText(event.text || '');
  if (command && command.command === '!rewind' && isAllowedTrigger(event.user)) {
    triggerCatchup({ source: 'chat' });
  }

  updateUnread();
}

const shouldSimulate = process.env.SIMULATE === 'true' || !process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_TOKEN;

logger.info('[rewind] booting Rewind');
logger.info(`[rewind] simulation mode: ${shouldSimulate ? 'enabled' : 'disabled'}`);

server.setTriggerHandler(triggerCatchup);

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
