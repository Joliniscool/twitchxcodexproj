import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_STORAGE_PATH = path.resolve(process.cwd(), 'data/catalog.json');
const DEFAULT_BOT_NAMES = ['nightbot', 'streamelements', 'moobot', 'fossabot', 'streamlabs'];
const REPLY_WINDOW_MS = 5000;
const BROKEN_AFTER_USES = 3;
const MAX_EXAMPLES = 10;
const DESCRIBE_DEBOUNCE_MS = 10 * 1000;
const CHAT_LIMIT = 500;

// Rewind answers these itself, so they are not channel tools.
const REWIND_COMMANDS = new Set(['!rewind', '!recap', '!moments', '!tools', '!ask']);

const CATEGORY_LABELS = {
  community: 'Community',
  social: 'Socials',
  stream: 'Stream',
  support: 'Support',
  media: 'Clips',
  utility: 'Help',
  rewards: 'Rewards',
  extensions: 'Extensions',
  general: 'Other',
};

const REWIND_MENU = '!recap for what you missed, !moments for highlights, !ask <question>';
const MENU_WORD = /^(tools?|commands?|guide|help|features?|options?|list)$/;

const STOP_WORDS = new Set([
  'is', 'are', 'was', 'be', 'there', 'here', 'the', 'an', 'do', 'does', 'did', 'how', 'can', 'could', 'you', 'we',
  'to', 'of', 'for', 'in', 'on', 'and', 'or', 'what', 'where', 'when', 'who', 'which', 'any', 'anyone', 'your',
  'this', 'that', 'it', 'get', 'my', 'me', 'with', 'have', 'has', 'please', 'channel', 'twitch', 'use', 'type',
  'command', 'commands', 'way', 'some', 'got', 'i',
]);

function normalizeCommandName(command = '') {
  const value = String(command || '').trim();
  if (!value) return '';
  return value.startsWith('!') ? value.toLowerCase() : `!${value.toLowerCase()}`;
}

function buildDescription(command, examples = []) {
  const exampleText = examples
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!exampleText) {
    return `Command entry for ${command}.`;
  }

  if (exampleText.includes('discord')) {
    return 'Links to the community Discord and channel updates.';
  }

  if (exampleText.includes('clip') || exampleText.includes('highlight')) {
    return 'Shows clip and highlight resources for the stream.';
  }

  if (exampleText.includes('schedule') || exampleText.includes('stream')) {
    return 'Shares stream schedule or upcoming session info.';
  }

  if (exampleText.includes('social') || exampleText.includes('twitter') || exampleText.includes('x.com')) {
    return 'Provides social links and community updates.';
  }

  if (exampleText.includes('tip') || exampleText.includes('donate') || exampleText.includes('support')) {
    return 'Points viewers to support the stream or channel.';
  }

  if (exampleText.includes('youtube') || exampleText.includes('video')) {
    return 'Shares recordings, highlights, or video content.';
  }

  if (exampleText.includes('command') || exampleText.includes('help')) {
    return 'Explains available commands and quick channel tools.';
  }

  return `Provides quick access to ${command.replace('!', '')} information for viewers.`;
}

function inferCategory(command, examples = []) {
  const exampleText = examples
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (exampleText.includes('discord')) return 'community';
  if (exampleText.includes('support') || exampleText.includes('tip') || exampleText.includes('donate')) return 'support';
  if (exampleText.includes('schedule') || exampleText.includes('time') || exampleText.includes('stream')) return 'stream';
  if (exampleText.includes('social') || exampleText.includes('twitter') || exampleText.includes('youtube')) return 'social';
  if (exampleText.includes('clip') || exampleText.includes('highlight')) return 'media';
  if (exampleText.includes('help') || command.includes('tool')) return 'utility';
  return 'general';
}

function pickBotNames(customList = []) {
  return Array.from(new Set([...DEFAULT_BOT_NAMES, ...customList].map((name) => String(name || '').trim().toLowerCase()).filter(Boolean)));
}

// Commands are keyed by "!name"; rewards and extensions by "kind:name" so they never collide with commands.
function entryKey(entry = {}) {
  const kind = entry.kind || 'command';
  if (kind === 'command') return normalizeCommandName(entry.command);
  const name = String(entry.command || '').trim().toLowerCase();
  return name ? `${kind}:${name}` : '';
}

function tokenize(text = '') {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

// Loose match so "socials" finds "social" and "sched" finds "schedule".
function hasWord(words, target) {
  return words.some((word) => word === target || (word.length >= 4 && target.length >= 4 && (word.startsWith(target) || target.startsWith(word))));
}

// Only advertise tools we know work: a bot answered it, the streamer added it, or Twitch reported it.
function isConfirmed(entry) {
  return entry.kind !== 'command' || entry.replies > 0 || entry.descriptionSource === 'manual';
}

export function createCatalogManager({
  storagePath = DEFAULT_STORAGE_PATH,
  logger = console,
  botNames = [],
  describeFn = null,
  replyWindowMs = REPLY_WINDOW_MS,
} = {}) {
  const knownBots = pickBotNames([...botNames, ...String(process.env.BOT_NAMES || '').split(',')]);
  const entries = new Map();
  const needsDescription = new Set();
  let pendingTriggers = [];
  let persistTimer = null;
  let describeTimer = null;

  async function persist() {
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, JSON.stringify(Array.from(entries.values()), null, 2));
    return Array.from(entries.values());
  }

  // Chat can arrive many times a second, so batch disk writes.
  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persist().catch((error) => logger.error('[catalog] failed to persist', error.message || error));
    }, 500);
  }

  function refreshAutoDescription(entry) {
    if (entry.descriptionSource && entry.descriptionSource !== 'auto') return;
    entry.description = buildDescription(entry.command, entry.examples);
    entry.category = inferCategory(entry.command, entry.examples);
    entry.descriptionSource = 'auto';
  }

  async function runDescriptions() {
    const batch = Array.from(needsDescription)
      .map((key) => entries.get(key))
      .filter((entry) => entry && entry.kind === 'command' && entry.descriptionSource !== 'manual');
    needsDescription.clear();
    if (!describeFn || !batch.length) return;

    try {
      const results = await describeFn({
        entries: batch.map((entry) => ({ command: entry.command, examples: entry.examples })),
        logger,
      });
      if (!results) return;
      for (const result of results) {
        const entry = entries.get(normalizeCommandName(result.command));
        if (!entry || entry.descriptionSource === 'manual' || !result.description) continue;
        entry.description = result.description;
        entry.category = CATEGORY_LABELS[result.category] ? result.category : entry.category;
        entry.descriptionSource = 'ai';
      }
      schedulePersist();
      logger.info(`[catalog] AI described ${batch.length} command(s)`);
    } catch (error) {
      logger.error('[catalog] AI description failed', error.message || error);
    }
  }

  function markForDescription(key) {
    if (!describeFn) return;
    needsDescription.add(key);
    clearTimeout(describeTimer);
    describeTimer = setTimeout(runDescriptions, DESCRIBE_DEBOUNCE_MS);
  }

  function createCommandEntry(command) {
    const entry = {
      command,
      kind: 'command',
      description: '',
      category: 'general',
      descriptionSource: 'auto',
      examples: [],
      uses: 0,
      replies: 0,
      possiblyBroken: false,
      lastSeenAt: Date.now(),
    };
    refreshAutoDescription(entry);
    entries.set(command, entry);
    return entry;
  }

  // Bots answer within about a second, so an unanswered command (like !lurk) must not steal the next reply:
  // prefer a command named in the reply, otherwise the most recent one.
  function pickTriggerFor(text) {
    const replyWords = tokenize(text);
    const named = [...pendingTriggers].reverse().find((pending) => hasWord(replyWords, pending.command.slice(1)));
    return named || pendingTriggers[pendingTriggers.length - 1];
  }

  function recordBotReply(text, at) {
    const trigger = pickTriggerFor(text);
    if (!trigger) return null;

    // One reply answers a burst of the same command, so drop the duplicates.
    pendingTriggers = pendingTriggers.filter((pending) => pending.command !== trigger.command);
    const entry = entries.get(trigger.command) || createCommandEntry(trigger.command);
    entry.replies += 1;
    entry.possiblyBroken = false;
    entry.lastSeenAt = at;
    entry.examples = Array.from(new Set([...entry.examples, `${trigger.command} → ${text}`])).slice(-MAX_EXAMPLES);
    refreshAutoDescription(entry);
    markForDescription(trigger.command);
    schedulePersist();
    return entry;
  }

  function recordTrigger(text, at) {
    const command = normalizeCommandName(text.split(/\s+/)[0]);
    if (command.length < 2 || REWIND_COMMANDS.has(command)) return null;

    const isNew = !entries.has(command);
    const entry = entries.get(command) || createCommandEntry(command);
    entry.uses += 1;
    entry.lastSeenAt = at;
    entry.possiblyBroken = entry.uses >= BROKEN_AFTER_USES && entry.replies === 0 && !entry.reply;
    pendingTriggers.push({ command, at });
    if (isNew) markForDescription(command);
    schedulePersist();
    return entry;
  }

  // Replace one kind of Twitch-sourced entry, keeping anything the streamer edited by hand.
  function replaceSyncedEntries(kind, items) {
    for (const [key, entry] of entries) {
      if (entry.kind === kind && entry.descriptionSource !== 'manual') entries.delete(key);
    }
    for (const item of items) {
      const key = entryKey({ ...item, kind });
      const existing = entries.get(key);
      if (existing && existing.descriptionSource === 'manual') continue;
      entries.set(key, { ...item, kind, descriptionSource: 'twitch', examples: [], possiblyBroken: false });
    }
  }

  function answerFor(entry) {
    if (entry.kind === 'reward') {
      const cost = entry.cost ? ` (${entry.cost} points)` : '';
      return `Yes, redeem the "${entry.command}" channel point reward${cost}. ${entry.description || ''}`.trim();
    }
    if (entry.kind === 'extension') {
      return `Yes, check the ${entry.command} extension on the stream page. ${entry.description || ''}`.trim();
    }
    return `Yes, type ${entry.command}. ${entry.description || ''}`.trim();
  }

  return {
    async load() {
      try {
        const raw = await fs.readFile(storagePath, 'utf8');
        const parsed = JSON.parse(raw || '[]');
        for (const stored of Array.isArray(parsed) ? parsed : []) {
          const key = entryKey(stored);
          if (!key || REWIND_COMMANDS.has(key)) continue;
          entries.set(key, {
            kind: 'command',
            descriptionSource: 'auto',
            examples: [],
            uses: 0,
            replies: 0,
            possiblyBroken: false,
            ...stored,
            command: stored.kind && stored.kind !== 'command' ? stored.command : key,
          });
        }
        logger.info(`[catalog] loaded ${entries.size} channel tool(s)`);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          logger.warn('[catalog] unable to read catalog', error.message || error);
        }
      }
      return Array.from(entries.values());
    },
    observeEvent(event) {
      if (!event || event.type !== 'chat' || !event.text) return null;

      const text = String(event.text).trim();
      const at = event.at || Date.now();
      pendingTriggers = pendingTriggers.filter((pending) => at - pending.at <= replyWindowMs);

      if (knownBots.includes(String(event.user || '').toLowerCase())) {
        return recordBotReply(text, at);
      }

      return text.startsWith('!') ? recordTrigger(text, at) : null;
    },
    syncChannelTools({ rewards = null, extensions = null } = {}) {
      if (Array.isArray(rewards)) {
        replaceSyncedEntries('reward', rewards.map((reward) => ({
          command: reward.title,
          cost: reward.cost,
          category: 'rewards',
          description: reward.prompt || `Channel point reward for ${reward.cost} points.`,
        })));
      }
      if (Array.isArray(extensions)) {
        replaceSyncedEntries('extension', extensions.map((extension) => ({
          command: extension.name,
          category: 'extensions',
          description: `Interactive ${extension.type || ''} extension on the stream page.`.replace(/\s+/g, ' '),
        })));
      }
      schedulePersist();
      logger.info(`[catalog] synced ${rewards?.length ?? 0} reward(s) and ${extensions?.length ?? 0} extension(s)`);
    },
    addManualEntry(entry = {}) {
      const kind = entry.kind || 'command';
      const key = entryKey({ ...entry, kind });
      if (!key || key === '!') {
        throw new Error('command is required');
      }

      const existing = entries.get(key) || { examples: [], uses: 0, replies: 0, possiblyBroken: false };
      const updated = {
        ...existing,
        command: kind === 'command' ? key : String(entry.command).trim(),
        kind,
        description: entry.description || existing.description || buildDescription(key, entry.examples || []),
        category: entry.category || existing.category || inferCategory(key, entry.examples || []),
        reply: String(entry.reply ?? existing.reply ?? '').trim().slice(0, CHAT_LIMIT),
        examples: Array.from(new Set([...(existing.examples || []), ...(entry.examples || [])].filter(Boolean))),
        descriptionSource: 'manual',
        possiblyBroken: false,
      };
      entries.set(key, updated);
      schedulePersist();
      return updated;
    },
    removeEntry({ command, kind = 'command' } = {}) {
      const removed = entries.delete(entryKey({ command, kind }));
      if (removed) schedulePersist();
      return removed;
    },
    getCommand(commandName) {
      return entries.get(normalizeCommandName(commandName)) || null;
    },
    // Channels without a chat bot can have Rewind answer a command, using the reply set on the dashboard.
    getReply(commandName) {
      return entries.get(normalizeCommandName(commandName))?.reply || '';
    },
    spotlight() {
      const confirmed = Array.from(entries.values()).filter(isConfirmed);
      return confirmed.length ? confirmed[Math.floor(Math.random() * confirmed.length)] : null;
    },
    health() {
      const all = Array.from(entries.values());
      return {
        broken: all.filter((entry) => entry.possiblyBroken).map((entry) => entry.command),
        unused: all.filter((entry) => entry.kind === 'command' && isConfirmed(entry) && !entry.uses).map((entry) => entry.command),
      };
    },
    listCommands() {
      return Array.from(entries.values()).sort((a, b) => String(a.command).localeCompare(String(b.command)));
    },
    buildToolsMenu() {
      const groups = new Map();
      for (const entry of entries.values()) {
        if (!isConfirmed(entry)) continue;
        const category = CATEGORY_LABELS[entry.category] ? entry.category : 'general';
        groups.set(category, [...(groups.get(category) || []), entry.command]);
      }

      if (!groups.size) {
        return `No channel tools added yet. Rewind commands: ${REWIND_MENU}.`;
      }

      const sections = Object.keys(CATEGORY_LABELS)
        .filter((category) => groups.has(category))
        .map((category) => `${CATEGORY_LABELS[category]}: ${groups.get(category).slice(0, 4).join(', ')}`);
      const menu = `Channel tools → ${sections.join(' | ')}. Also try ${REWIND_MENU}.`;
      return menu.length <= CHAT_LIMIT ? menu : `${menu.slice(0, CHAT_LIMIT - 1)}…`;
    },
    answerQuestion(question = '') {
      const words = tokenize(question);

      // "what are the tools?" is asking for the menu, not for one tool.
      const rawWords = String(question || '').toLowerCase().split(/[^a-z0-9]+/);
      if (rawWords.some((word) => MENU_WORD.test(word)) && words.every((word) => MENU_WORD.test(word))) {
        return this.buildToolsMenu();
      }

      if (!words.length) {
        return 'Ask me about the channel, like "!ask is there a discord?"';
      }

      let best = null;
      let bestScore = 0;
      for (const entry of entries.values()) {
        if (!isConfirmed(entry)) continue;
        const nameWords = tokenize(entry.command);
        const descriptionWords = tokenize(`${entry.description || ''} ${entry.category || ''}`);
        const exampleWords = tokenize((entry.examples || []).join(' '));
        let score = 0;
        for (const word of words) {
          if (hasWord(nameWords, word)) score += 3;
          else if (hasWord(descriptionWords, word)) score += 2;
          else if (hasWord(exampleWords, word)) score += 1;
        }
        if (score > bestScore) {
          best = entry;
          bestScore = score;
        }
      }

      // A lone match buried in a bot reply is too weak to claim the channel has it.
      if (!best || bestScore < 2) {
        return "I couldn't find that in the channel guide. Try !tools to see what's available.";
      }

      return answerFor(best).slice(0, CHAT_LIMIT);
    },
    persist,
  };
}
