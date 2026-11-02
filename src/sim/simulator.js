// Channel commands a typical streamer's Nightbot answers. !lurk has no reply, so it shows up as possibly broken.
const botReplies = {
  '!discord': 'Join the community Discord: discord.gg/rewind-demo',
  '!schedule': 'Streams are Mon/Wed/Fri at 7pm PT. Next stream is Wednesday!',
  '!socials': 'Follow on Twitter and YouTube: @rewinddemo',
  '!uptime': 'The stream has been live for 1 hour 12 minutes.',
};

export const SIM_CHANNEL_TOOLS = {
  rewards: [
    { title: 'Hydrate', cost: 500, prompt: 'Make the streamer drink some water.' },
    { title: 'Highlight My Message', cost: 1000, prompt: '' },
  ],
  extensions: [{ name: 'Stream Leaderboard', type: 'panel' }],
};

const streamers = ['xqc', 'nickmercs', 'shroud', 'sodapoppin'];
const chatters = ['alice', 'brad', 'charlie', 'dan', 'erin', 'frank'];

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export function startSimulator({ onEvent, logger = console, intervalMs = 2000 }) {
  const tick = () => {
    const eventType = Math.random();

    // An occasional emote burst, so the hype detector has something to find.
    if (Math.random() < 0.03) {
      for (let i = 0; i < 14; i += 1) {
        const text = randomFrom(['LUL LUL LUL', 'pogchamp pogchamp', 'OMEGALUL']);
        onEvent?.({ type: 'chat', user: randomFrom(chatters), text, emotes: [text.split(' ')[0]], badges: ['subscriber'], at: Date.now(), raw: { text } });
      }
      logger.info('[simulator] emote burst');
      return;
    }

    if (eventType < 0.72) {
      const user = randomFrom(chatters);
      const text = randomFrom([
        'this is so hype',
        'Did anyone catch the last raid?',
        'wtf that clip was insane',
        '!discord',
        '!schedule',
        '!socials',
        '!uptime',
        '!lurk',
        '!tools',
        '!ask is there a discord?',
        'LUL LUL LUL',
        'pogchamp pogchamp',
        'I need a recap for that moment',
        'this game is wild',
      ]);

      const normalized = {
        type: 'chat',
        user,
        text,
        emotes: text.includes('LUL') ? ['LUL'] : [],
        badges: ['subscriber'],
        at: Date.now(),
        raw: { text },
      };

      onEvent?.(normalized);
      logger.info('[simulator] chat', normalized);

      // Real bots answer a moment after the command, inside the catalog's 5-second window.
      if (botReplies[text]) {
        setTimeout(() => {
          const botMessage = {
            type: 'chat',
            user: 'Nightbot',
            text: botReplies[text],
            emotes: [],
            badges: ['bot'],
            at: Date.now(),
            raw: { text: botReplies[text] },
          };
          onEvent?.(botMessage);
          logger.info('[simulator] bot reply', botMessage);
        }, 800);
      }
      return;
    }

    if (eventType < 0.88) {
      const event = {
        type: 'sub',
        user: randomFrom(chatters),
        text: `${randomFrom(chatters)} subscribed`,
        emotes: [],
        badges: ['subscriber'],
        at: Date.now(),
        raw: { user: randomFrom(chatters) },
      };
      onEvent?.(event);
      logger.info('[simulator] sub', event);
      return;
    }

    if (eventType < 0.95) {
      const event = {
        type: 'raid',
        user: randomFrom(streamers),
        text: `${randomFrom(streamers)} raided the channel`,
        emotes: [],
        badges: [],
        at: Date.now(),
        raw: { from_broadcaster_user_login: randomFrom(streamers) },
      };
      onEvent?.(event);
      logger.info('[simulator] raid', event);
      return;
    }

    const reward = {
      type: 'redemption',
      user: randomFrom(chatters),
      text: `${randomFrom(chatters)} redeemed highlight shoutout`,
      emotes: [],
      badges: ['vip'],
      at: Date.now(),
      raw: { reward: { title: 'Highlight shoutout' } },
    };
    onEvent?.(reward);
    logger.info('[simulator] redemption', reward);
  };

  const interval = setInterval(tick, intervalMs);

  return {
    stop() {
      clearInterval(interval);
    },
  };
}
