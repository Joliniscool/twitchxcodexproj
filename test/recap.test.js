import test from 'node:test';
import assert from 'node:assert/strict';

import { createViewerAssistant } from '../src/core/recap.js';

test('sends a late-joiner nudge on first message and handles !recap', () => {
  const assistant = createViewerAssistant({
    buffer: {
      getAll() {
        return [
          { type: 'chat', user: 'alice', text: 'pogchamp', at: Date.now() - 1000 },
          { type: 'chat', user: 'bob', text: 'LUL LUL LUL', at: Date.now() - 2500 },
        ];
      },
    },
  });

  const nudge = assistant.handleEvent({ type: 'chat', user: 'charlie', text: 'hello there', at: Date.now(), badges: [] });
  assert.ok(nudge, 'expected a nudge for a new viewer');
  assert.match(nudge.text, /!recap|!tools/i, 'expected nudge to point to recap and tools');

  const recap = assistant.handleEvent({ type: 'chat', user: 'charlie', text: '!recap', at: Date.now() + 1000, badges: [] });
  assert.ok(recap, 'expected a recap reply for !recap');
  assert.match(recap.text, /what you missed|catch-up|recap/i, 'expected recap to summarize recent stream activity');
});

test('returns the help menu for !rewind help', () => {
  const assistant = createViewerAssistant({ buffer: { getAll() { return []; } } });
  const response = assistant.handleEvent({ type: 'chat', user: 'alice', text: '!rewind help', at: Date.now(), badges: [] });
  assert.ok(response, 'expected help output');
  assert.match(response.text, /!recap|!tools|!moments|!ask/i, 'expected menu to list rewind commands');
});

test('rate-limits !recap per viewer', () => {
  const assistant = createViewerAssistant({ buffer: { getAll() { return []; } }, recapCooldownMs: 60000 });
  const send = (user, at) => assistant.handleEvent({ type: 'chat', user, text: '!recap', at, badges: [] });

  assert.ok(send('alice', 1000));
  assert.equal(send('alice', 30000), null, 'second recap inside the cooldown is ignored');
  assert.ok(send('bob', 30000), 'other viewers are not affected');
  assert.ok(send('alice', 62000));
});
