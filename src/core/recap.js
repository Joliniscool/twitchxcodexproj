import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parseCommandText } from './commands.js';

const RECAP_COOLDOWN_MS = 60 * 1000;
const CHAT_BOTS = ['nightbot', 'streamelements', 'moobot', 'fossabot', 'streamlabs'];

function normalizeUser(user = '') {
  return String(user || '').trim().toLowerCase();
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function badgeNames(event) {
  return (event.badges || []).map((badge) => String(badge?.set_id || badge).toLowerCase());
}

export function createViewerAssistant({ buffer, logger = console, recapCooldownMs = RECAP_COOLDOWN_MS } = {}) {
  const seenUsers = new Set();
  const lastRecapAt = new Map();

  // One viewer spamming !recap should not flood chat; repeats inside the cooldown are ignored silently.
  const recapReply = (userKey, at) => {
    if (at - (lastRecapAt.get(userKey) ?? -Infinity) < recapCooldownMs) {
      return null;
    }
    lastRecapAt.set(userKey, at);
    return { type: 'chat', user: 'Rewind', text: buildRecapText() };
  };

  const getRecentItems = () => {
    if (!buffer || typeof buffer.getAll !== 'function') {
      return [];
    }

    return buffer.getAll().filter(Boolean);
  };

  const buildRecapText = () => {
    const items = getRecentItems();
    if (!items.length) {
      return 'Rewind recap: no recent chat activity has landed in the catch-up window yet.';
    }

    const recentChats = items
      .filter((item) => item.type === 'chat' && item.user && String(item.user).toLowerCase() !== 'nightbot' && !/^!/.test(item.text || ''))
      .slice(-6);
    const eventSummary = items
      .filter((item) => item.type !== 'chat')
      .slice(-3)
      .map((item) => `${item.user || 'system'} ${compactText(item.text || item.type)}`)
      .join(' • ');
    const activeUsers = [...new Set(items
      .filter((item) => item.type === 'chat' && item.user && String(item.user).toLowerCase() !== 'nightbot')
      .map((item) => item.user)
      .slice(-5))];
    const highlight = recentChats.length
      ? compactText(recentChats[recentChats.length - 1].text)
      : 'chat stayed steady';

    const parts = [
      `Rewind recap: ${activeUsers.length ? `${activeUsers.slice(0, 3).join(', ')} were active` : 'a few viewers were active'}`,
      `The hot take was “${highlight}”`,
    ];

    if (eventSummary) {
      parts.push(`Recent stream activity: ${eventSummary}`);
    }

    return parts.join('. ');
  };

  const buildHelpText = () => {
    return 'Rewind help: !recap for what you missed, !moments for highlights, !tools for channel guide, !ask <question>.';
  };

  return {
    handleEvent(event) {
      if (!event || event.type !== 'chat' || !event.text) {
        return null;
      }

      const text = String(event.text || '').trim();
      const userKey = normalizeUser(event.user);
      const command = parseCommandText(text);
      const at = event.at || Date.now();
      const isBot = CHAT_BOTS.includes(userKey) || badgeNames(event).includes('bot');

      if (isBot) {
        return null;
      }

      if (command) {
        if (command.command === '!recap') {
          return recapReply(userKey, at);
        }

        if (command.command === '!rewind' && /help|guide/i.test(command.args || '')) {
          return {
            type: 'chat',
            user: 'Rewind',
            text: buildHelpText(),
          };
        }

        if (command.command === '!rewind' && !command.args) {
          return recapReply(userKey, at);
        }

        if ((command.command === '!help' || command.command === '!commands') && !command.args) {
          return {
            type: 'chat',
            user: 'Rewind',
            text: buildHelpText(),
          };
        }
      }

      if (userKey && !seenUsers.has(userKey) && !/^rewind$/.test(userKey) && !text.startsWith('!') && !badgeNames(event).includes('broadcaster')) {
        seenUsers.add(userKey);
        logger.info?.(`[recap] first message from ${event.user}`);
        return {
          type: 'chat',
          user: 'Rewind',
          text: `Welcome ${event.user}! Try !recap for a catch-up or !tools to browse the channel guide.`,
        };
      }

      if (userKey) {
        seenUsers.add(userKey);
      }

      return null;
    },
    reset() {
      seenUsers.clear();
      lastRecapAt.clear();
    },
    getSeenUsers() {
      return [...seenUsers];
    },
  };
}

function supporterSummary(supporter) {
  const parts = [];
  if (supporter.subs) parts.push(`${supporter.subs} sub${supporter.subs === 1 ? '' : 's'}`);
  if (supporter.bits) parts.push(`${supporter.bits} bits`);
  if (supporter.raids) parts.push('raid');
  return parts.join(', ');
}

// The rolling buffer only holds 30 minutes, so the end-of-stream recap keeps its own running tally.
export function createStreamRecap({ catalogManager, hypeDetector, storageDir, logger = console } = {}) {
  let startedAt = Date.now();
  let questions = new Map();
  let supporters = new Map();

  const supporterFor = (user) => {
    const supporter = supporters.get(user) || { user, subs: 0, bits: 0, raids: 0 };
    supporters.set(user, supporter);
    return supporter;
  };

  return {
    reset() {
      startedAt = Date.now();
      questions = new Map();
      supporters = new Map();
    },
    recordEvent(event) {
      if (!event) return;

      if (event.type === 'chat') {
        const text = compactText(event.text);
        const isBot = CHAT_BOTS.includes(normalizeUser(event.user));
        if (text.includes('?') && !text.startsWith('!') && !isBot) {
          const key = text.toLowerCase();
          const question = questions.get(key) || { user: event.user, text, count: 0 };
          question.count += 1;
          questions.set(key, question);
        }
        return;
      }

      if (event.type === 'sub' && !event.raw?.is_gift) supporterFor(event.user).subs += Number(event.raw?.total) || 1;
      if (event.type === 'cheer') supporterFor(event.user).bits += Number(event.raw?.bits) || 0;
      if (event.type === 'raid') supporterFor(event.user).raids += 1;
    },
    async build() {
      const moments = (await hypeDetector.listMoments())
        .filter((moment) => Number(moment.at) >= startedAt)
        .map((moment) => ({ label: moment.label, at: moment.at, clipUrl: moment.clipUrl || null }));
      const recap = {
        startedAt,
        endedAt: Date.now(),
        moments,
        topQuestions: [...questions.values()].sort((a, b) => b.count - a.count).slice(0, 5),
        topSupporters: [...supporters.values()]
          .sort((a, b) => (b.subs * 500 + b.bits + b.raids * 500) - (a.subs * 500 + a.bits + a.raids * 500))
          .slice(0, 5)
          .map((supporter) => ({ user: supporter.user, summary: supporterSummary(supporter) })),
        catalogHealth: catalogManager.health(),
      };

      await fs.mkdir(storageDir, { recursive: true });
      const fileName = `recap-${new Date(recap.endedAt).toISOString().replace(/[:.]/g, '-')}.json`;
      await fs.writeFile(path.join(storageDir, fileName), JSON.stringify(recap, null, 2));
      logger.info(`[recap] saved ${fileName}`);
      return recap;
    },
    summarize(recap) {
      const thanks = recap.topSupporters.length ? ` Thanks to ${recap.topSupporters.map((entry) => entry.user).join(', ')}!` : '';
      return `Stream recap: ${recap.moments.length} hype moment(s) and ${recap.topQuestions.length} top question(s).${thanks}`;
    },
    async latest() {
      const files = await fs.readdir(storageDir).catch(() => []);
      const newest = files.filter((file) => file.endsWith('.json')).sort().pop();
      if (!newest) return null;
      return JSON.parse(await fs.readFile(path.join(storageDir, newest), 'utf8'));
    },
  };
}
