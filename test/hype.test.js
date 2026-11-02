import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createHypeDetector } from '../src/core/hype.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tempMomentsPath = path.join(__dirname, '../data/test-moments.json');

test('detects a hype burst from emote-heavy chat', async () => {
  await fs.rm(tempMomentsPath, { force: true });

  const detector = createHypeDetector({
    storagePath: tempMomentsPath,
    logger: { info() {}, warn() {}, error() {} },
  });

  const base = Math.floor(Date.now() / 5000) * 5000;
  for (let i = 0; i < 12; i += 1) {
    detector.recordEvent({
      type: 'chat',
      user: `viewer${i}`,
      text: 'LUL LUL LUL pogchamp',
      at: base + i * 100,
      emotes: ['LUL', 'pogchamp'],
    });
  }

  const moment = detector.detectCurrentMoment();
  assert.ok(moment, 'expected a hype moment to be detected');
  assert.ok(moment.label, 'expected a generated label');
  assert.ok(moment.score > 0, 'expected a positive hype score');
});

test('steady chat does not count as a hype moment', async () => {
  await fs.rm(tempMomentsPath, { force: true });

  const detector = createHypeDetector({
    storagePath: tempMomentsPath,
    logger: { info() {}, warn() {}, error() {} },
  });

  const base = Math.floor(Date.now() / 5000) * 5000 - 60 * 5000;
  let moment = null;
  for (let bucket = 0; bucket <= 60; bucket += 1) {
    for (let i = 0; i < 3; i += 1) {
      detector.recordEvent({ type: 'chat', user: `viewer${i}`, text: 'hello', at: base + bucket * 5000 + i, emotes: [] });
    }
    moment = detector.detectCurrentMoment() || moment;
  }

  assert.equal(moment, null, 'an even 3 messages per bucket is not a burst');
});
