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

  const base = Date.now();
  for (let i = 0; i < 12; i += 1) {
    detector.recordEvent({
      type: 'chat',
      user: `viewer${i}`,
      text: 'LUL LUL LUL pogchamp',
      at: base + i * 1000,
      emotes: ['LUL', 'pogchamp'],
    });
  }

  const moment = detector.detectCurrentMoment();
  assert.ok(moment, 'expected a hype moment to be detected');
  assert.ok(moment.label, 'expected a generated label');
  assert.ok(moment.score > 0, 'expected a positive hype score');
});
