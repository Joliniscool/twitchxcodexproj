import test from 'node:test';
import assert from 'node:assert/strict';

import { createMomentAssets } from '../src/twitch/helix.js';
import { startSimulator } from '../src/sim/simulator.js';

test('simulator creates fake clip and stream marker assets when the stream is offline', async () => {
  const messages = [];
  const result = await createMomentAssets({
    simulate: true,
    broadcasterId: 'fake-broadcaster',
    triggerText: 'Big hype moment',
    logger: {
      info: (...args) => messages.push(args.join(' ')),
      warn() {},
      error() {},
    },
  });

  assert.equal(result.clipUrl, 'https://example.com/fake-clip.mp4');
  assert.match(result.markerId, /^sim-marker-/);
  assert.ok(messages.some((message) => message.includes('simulator mode: fake moment asset created')));
});

test('startSimulator emits real-shaped chat and event objects through the same pipeline', async () => {
  const events = [];
  const simulator = startSimulator({
    onEvent(event) {
      events.push(event);
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    intervalMs: 10,
  });

  await new Promise((resolve) => setTimeout(resolve, 80));
  simulator.stop();

  assert.ok(events.length > 0, 'expected the simulator to emit events');
  assert.ok(events.some((event) => event.type === 'chat'), 'expected fake chat events');
  assert.ok(events.some((event) => event.type === 'sub' || event.type === 'raid' || event.type === 'redemption'), 'expected non-chat stream events');
});
