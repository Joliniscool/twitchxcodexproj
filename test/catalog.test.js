import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCatalogManager } from '../src/core/catalog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tempCatalogPath = path.join(__dirname, '../data/test-catalog.json');

async function resetCatalog() {
  await fs.rm(tempCatalogPath, { force: true });
}

test('learns bot replies and flags broken commands', async () => {
  await resetCatalog();
  const catalog = createCatalogManager({
    storagePath: tempCatalogPath,
    logger: { info() {}, warn() {}, error() {} },
  });

  catalog.observeEvent({ type: 'chat', user: 'alice', text: '!discord', at: 1000, badges: ['subscriber'] });
  catalog.observeEvent({ type: 'chat', user: 'Nightbot', text: 'The Discord is on the channel info panel.', at: 1500, badges: ['bot'] });

  const discord = catalog.getCommand('!discord');
  assert.ok(discord, 'expected !discord to be learned');
  assert.match(discord.description || '', /discord/i, 'expected description to reference Discord');

  catalog.observeEvent({ type: 'chat', user: 'bob', text: '!brokentool', at: 2000, badges: ['subscriber'] });
  catalog.observeEvent({ type: 'chat', user: 'charlie', text: '!brokentool', at: 3000, badges: ['subscriber'] });
  catalog.observeEvent({ type: 'chat', user: 'dan', text: '!brokentool', at: 4000, badges: ['subscriber'] });

  const broken = catalog.getCommand('!brokentool');
  assert.equal(Boolean(broken && broken.possiblyBroken), true, 'expected broken command to be flagged');
});

test('answers !ask questions using the catalog', async () => {
  await resetCatalog();
  const catalog = createCatalogManager({
    storagePath: tempCatalogPath,
    logger: { info() {}, warn() {}, error() {} },
  });

  catalog.addManualEntry({
    command: '!discord',
    category: 'community',
    description: 'Discord server invite and community updates.',
    examples: ['Discord server: use !discord'],
  });

  const answer = catalog.answerQuestion('is there a Discord?');
  assert.ok(answer, 'expected an answer from catalog');
  assert.match(answer, /!discord/i, 'expected answer to mention the command');
});

const quietLogger = { info() {}, warn() {}, error() {} };

test('ignores bot replies outside the 5-second window and skips Rewind commands', async () => {
  await resetCatalog();
  const catalog = createCatalogManager({ storagePath: tempCatalogPath, logger: quietLogger });

  catalog.observeEvent({ type: 'chat', user: 'alice', text: '!schedule', at: 1000 });
  catalog.observeEvent({ type: 'chat', user: 'Nightbot', text: 'Streams are Mon/Wed/Fri.', at: 7000 });
  assert.equal(catalog.getCommand('!schedule').replies, 0, 'late reply should not be credited');

  catalog.observeEvent({ type: 'chat', user: 'alice', text: '!tools', at: 8000 });
  assert.equal(catalog.getCommand('!tools'), null, 'Rewind commands are not channel tools');
});

test('!tools groups commands, rewards, and extensions by category', async () => {
  await resetCatalog();
  const catalog = createCatalogManager({ storagePath: tempCatalogPath, logger: quietLogger });

  catalog.observeEvent({ type: 'chat', user: 'alice', text: '!discord', at: 1000 });
  catalog.observeEvent({ type: 'chat', user: 'StreamElements', text: 'Join the Discord: discord.gg/x', at: 1500 });
  catalog.syncChannelTools({
    rewards: [{ title: 'Hydrate', cost: 500, prompt: 'Make the streamer drink water.' }],
    extensions: [{ name: 'Leaderboard', type: 'panel' }],
  });

  const menu = catalog.buildToolsMenu();
  assert.match(menu, /Community: !discord/);
  assert.match(menu, /Rewards: Hydrate/);
  assert.match(menu, /Extensions: Leaderboard/);
  assert.ok(menu.length <= 500);

  assert.match(catalog.answerQuestion('can I make them drink water?'), /redeem the "Hydrate"/);
  assert.match(catalog.answerQuestion('do you have a minecraft server?'), /couldn't find/);
});

test('manual edits survive resyncs and the catalog reloads from disk', async () => {
  await resetCatalog();
  const catalog = createCatalogManager({ storagePath: tempCatalogPath, logger: quietLogger });

  catalog.syncChannelTools({ rewards: [{ title: 'Hydrate', cost: 500, prompt: '' }] });
  catalog.addManualEntry({ command: 'Hydrate', kind: 'reward', description: 'Streamer takes a sip.', category: 'rewards' });
  catalog.syncChannelTools({ rewards: [{ title: 'Hydrate', cost: 500, prompt: 'from twitch' }] });
  assert.equal(catalog.listCommands()[0].description, 'Streamer takes a sip.');

  await catalog.persist();
  const reloaded = createCatalogManager({ storagePath: tempCatalogPath, logger: quietLogger });
  await reloaded.load();
  assert.equal(reloaded.listCommands().length, 1);
  assert.equal(reloaded.listCommands()[0].kind, 'reward');
});

test('an unanswered command does not steal the next bot reply', async () => {
  await resetCatalog();
  const catalog = createCatalogManager({ storagePath: tempCatalogPath, logger: quietLogger });

  catalog.observeEvent({ type: 'chat', user: 'alice', text: '!lurk', at: 1000 });
  catalog.observeEvent({ type: 'chat', user: 'bob', text: '!uptime', at: 2000 });
  catalog.observeEvent({ type: 'chat', user: 'Nightbot', text: 'Live for 1 hour 12 minutes.', at: 2600 });
  catalog.observeEvent({ type: 'chat', user: 'erin', text: '!discord', at: 3000 });
  catalog.observeEvent({ type: 'chat', user: 'frank', text: '!socials', at: 3100 });
  catalog.observeEvent({ type: 'chat', user: 'Nightbot', text: 'Join the Discord: discord.gg/x', at: 3500 });

  assert.equal(catalog.getCommand('!lurk').replies, 0);
  assert.equal(catalog.getCommand('!uptime').replies, 1);
  assert.equal(catalog.getCommand('!discord').replies, 1, 'reply naming discord goes to !discord, not the newer !socials');
});

test('unconfirmed commands stay out of !tools and !ask', async () => {
  await resetCatalog();
  const catalog = createCatalogManager({ storagePath: tempCatalogPath, logger: quietLogger });

  catalog.observeEvent({ type: 'chat', user: 'alice', text: '!dsicord', at: 1000 });
  assert.match(catalog.buildToolsMenu(), /No channel tools added yet.*!recap/);
  assert.match(catalog.answerQuestion('dsicord?'), /couldn't find/);
});

test('a dashboard reply makes a command work without a chat bot', async () => {
  await resetCatalog();
  const catalog = createCatalogManager({ storagePath: tempCatalogPath, logger: quietLogger });

  catalog.addManualEntry({ command: 'discord', description: 'Community server.', reply: 'Join us: discord.gg/x' });
  assert.equal(catalog.getReply('!discord'), 'Join us: discord.gg/x');

  for (const at of [1000, 2000, 3000]) {
    catalog.observeEvent({ type: 'chat', user: 'alice', text: '!discord', at });
  }
  assert.equal(catalog.getCommand('!discord').possiblyBroken, false);
  assert.match(catalog.buildToolsMenu(), /!discord/);
});

test('!ask about the tools themselves returns the menu', async () => {
  await resetCatalog();
  const catalog = createCatalogManager({ storagePath: tempCatalogPath, logger: quietLogger });

  assert.match(catalog.answerQuestion('what are channel tools'), /!recap/);
  assert.match(catalog.answerQuestion('what commands are there?'), /!recap/);

  catalog.addManualEntry({ command: '!discord', category: 'community', description: 'Community server.' });
  assert.match(catalog.answerQuestion('what are the tools?'), /Community: !discord/);
  assert.match(catalog.answerQuestion('is there a discord?'), /Yes, type !discord/);
  assert.match(catalog.answerQuestion(''), /!ask is there a discord/);
});
