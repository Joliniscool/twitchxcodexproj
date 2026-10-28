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
