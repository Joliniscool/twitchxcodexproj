import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_STORAGE_PATH = path.resolve(process.cwd(), 'data/catalog.json');
const DEFAULT_BOT_NAMES = ['nightbot', 'streamelements', 'moobot', 'fossabot', 'streamlabs'];

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

export function createCatalogManager({ storagePath = DEFAULT_STORAGE_PATH, logger = console, botNames = [] } = {}) {
  const knownBots = pickBotNames(botNames);
  const commandMap = new Map();
  const commandUsage = new Map();

  async function ensureStorage() {
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    try {
      await fs.access(storagePath);
    } catch {
      await fs.writeFile(storagePath, JSON.stringify([], null, 2));
    }
  }

  async function loadCatalog() {
    await ensureStorage();
    try {
      const raw = await fs.readFile(storagePath, 'utf8');
      const parsed = JSON.parse(raw || '[]');
      if (!Array.isArray(parsed)) return [];
      parsed.forEach((entry) => {
        if (entry && entry.command) {
          const normalized = normalizeCommandName(entry.command);
          commandMap.set(normalized, entry);
        }
      });
      return parsed;
    } catch (error) {
      logger.warn('[catalog] unable to read catalog', error.message || error);
      return [];
    }
  }

  async function persistCatalog(entries) {
    await ensureStorage();
    await fs.writeFile(storagePath, JSON.stringify(entries, null, 2));
  }

  async function rebuildPersistence() {
    const entries = Array.from(commandMap.values());
    await persistCatalog(entries);
    return entries;
  }

  function upsertEntry(entry) {
    const normalized = normalizeCommandName(entry.command || '');
    if (!normalized) return null;

    const existing = commandMap.get(normalized) || {
      command: normalized,
      description: '',
      category: 'general',
      examples: [],
      examplesByBot: [],
      possibleBroken: false,
      lastSeenAt: Date.now(),
    };

    const merged = {
      ...existing,
      ...entry,
      command: normalized,
      description: entry.description || existing.description || buildDescription(normalized, [...(existing.examples || []), ...(entry.examples || [])]),
      category: entry.category || existing.category || inferCategory(normalized, [...(existing.examples || []), ...(entry.examples || [])]),
      examples: Array.from(new Set([...(existing.examples || []), ...(entry.examples || [])].filter(Boolean))),
      examplesByBot: Array.from(new Set([...(existing.examplesByBot || []), ...(entry.examplesByBot || [])].filter(Boolean))),
      lastSeenAt: Date.now(),
    };

    commandMap.set(normalized, merged);
    return merged;
  }

  function evaluateCommand(commandName, examples = []) {
    const normalized = normalizeCommandName(commandName);
    const current = commandMap.get(normalized) || { command: normalized, examples: [] };
    const combined = [...(current.examples || []), ...examples].filter(Boolean);
    const description = buildDescription(normalized, combined);
    const category = inferCategory(normalized, combined);

    const counts = commandUsage.get(normalized) || { count: 0, withReply: 0, since: Date.now() };
    const possiblyBroken = counts.count >= 3 && counts.withReply === 0;

    const updated = {
      ...current,
      command: normalized,
      description,
      category,
      examples: Array.from(new Set(combined)),
      possiblyBroken,
    };
    commandMap.set(normalized, updated);
    return updated;
  }

  function getCommand(commandName) {
    const normalized = normalizeCommandName(commandName);
    return commandMap.get(normalized) || null;
  }

  return {
    async load() {
      await loadCatalog();
      return Array.from(commandMap.values());
    },
    observeEvent(event) {
      if (!event || !event.text || event.type !== 'chat') return null;
      const parsed = /!\w+/i.exec(event.text || '');
      if (!parsed) return null;

      const command = normalizeCommandName(parsed[0]);
      const userName = String(event.user || '').toLowerCase();
      const isBotReply = knownBots.includes(userName) || (event.badges || []).some((badge) => String(badge || '').toLowerCase() === 'bot');

      const usage = commandUsage.get(command) || { count: 0, withReply: 0 };
      usage.count += 1;
      if (isBotReply) {
        usage.withReply += 1;
      }
      commandUsage.set(command, usage);

      const current = commandMap.get(command) || { command, examples: [], examplesByBot: [], description: '', category: 'general' };
      const examples = [...(current.examples || [])];
      const botExamples = [...(current.examplesByBot || [])];

      if (isBotReply) {
        const replyText = String(event.text || '').trim();
        const replyEntry = `${command} → ${replyText}`;
        examples.push(replyEntry);
        botExamples.push(replyEntry);
      } else {
        examples.push(String(event.text || '').trim());
      }

      const evaluated = evaluateCommand(command, examples);
      evaluated.examplesByBot = botExamples;
      evaluated.possiblyBroken = usage.count >= 3 && usage.withReply === 0;
      commandMap.set(command, evaluated);
      rebuildPersistence().catch((error) => logger.error('[catalog] failed to persist', error.message || error));
      return evaluated;
    },
    addManualEntry(entry = {}) {
      const normalized = normalizeCommandName(entry.command || '');
      const manualEntry = {
        command: normalized,
        description: entry.description || buildDescription(normalized, entry.examples || []),
        category: entry.category || inferCategory(normalized, entry.examples || []),
        examples: Array.from(new Set([...(entry.examples || [])].filter(Boolean))),
        examplesByBot: Array.from(new Set([...(entry.examplesByBot || [])].filter(Boolean))),
      };

      const updated = upsertEntry(manualEntry);
      rebuildPersistence().catch((error) => logger.error('[catalog] failed to persist', error.message || error));
      return updated;
    },
    getCommand,
    listCommands() {
      return Array.from(commandMap.values()).sort((a, b) => String(a.command).localeCompare(String(b.command)));
    },
    answerQuestion(question = '') {
      const query = String(question || '').toLowerCase();
      if (!query) return 'I do not have a matching answer in the channel guide yet.';

      const entries = Array.from(commandMap.values());
      if (!entries.length) {
        return 'I do not have a matching answer in the channel guide yet.';
      }

      const match = entries.find((entry) => {
        const text = `${entry.command || ''} ${entry.description || ''} ${(entry.examples || []).join(' ')}`.toLowerCase();
        return text.includes(query.replace(/\?$/, '')) || query.includes((entry.command || '').replace('!', ''));
      });

      if (!match) {
        return 'I do not have a matching answer in the channel guide yet.';
      }

      const normalizedCommand = String(match.command || '').toLowerCase();
      return `Yes, use ${normalizedCommand}. ${match.description || 'That command is in the channel guide.'}`;
    },
    async persist() {
      return await rebuildPersistence();
    },
  };
}
