const botReplies = {
  '!commands': 'Available commands: !rewind, !recap, !moments, !tools, !ask',
  '!help': 'Use !rewind to get the recap and !tools for channel guides',
  '!rewind': 'Rewind is catching up on chat, hype, and channel tools for you.',
  '!tools': 'The channel includes Nightbot, stream alerts, and a points reward called !goals.',
};

const streamers = ['xqc', 'nickmercs', 'shroud', 'sodapoppin'];
const chatters = ['alice', 'brad', 'charlie', 'dan', 'erin', 'frank'];

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export function startSimulator({ onEvent, logger = console, intervalMs = 2000 }) {
  const tick = () => {
    const eventType = Math.random();

    if (eventType < 0.72) {
      const user = randomFrom(chatters);
      const text = [
        'this is so hype',
        'Did anyone catch the last raid?',
        'wtf that clip was insane',
        '!commands',
        '!help',
        '!tools',
        'LUL LUL LUL',
        'pogchamp pogchamp',
        'I need a recap for that moment',
        'this game is wild',
      ][Math.floor(Math.random() * 10)];

      const normalized = {
        type: 'chat',
        user,
        text,
        emotes: text.includes('LUL') ? ['LUL'] : [],
        badges: ['subscriber'],
        at: Date.now(),
        raw: { text },
      };

      if (botReplies[text]) {
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
      }

      onEvent?.(normalized);
      logger.info('[simulator] chat', normalized);
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
