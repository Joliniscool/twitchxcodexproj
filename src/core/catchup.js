export function createCatchupManager({ buffer, summarizeFn, logger = console, defaultWindowMs = 15 * 60 * 1000 }) {
  let lastOpenedAt = Date.now() - defaultWindowMs;

  const isQuestion = (item) => {
    if (!item || item.type !== 'chat' || !item.text) {
      return false;
    }

    return /\?|who|what|when|where|why|how|can|could|did|anyone|someone/i.test(item.text);
  };

  const getRecentItems = () => {
    const all = buffer.getAll();
    return all.filter((item) => item.at >= lastOpenedAt);
  };

  const buildUnread = () => {
    const recent = getRecentItems();
    const questions = recent.filter(isQuestion).length;
    const events = recent.filter((item) => item.type !== 'chat').length + recent.filter((item) => item.type === 'chat' && /^!/.test(item.text || '')).length;

    return {
      questions,
      events,
      total: recent.length,
    };
  };

  return {
    getUnread() {
      return buildUnread();
    },
    async runDigest({ source = 'dashboard', windowMs = defaultWindowMs } = {}) {
      const recent = buffer.getAll().filter((item) => item.at >= lastOpenedAt - windowMs);
      const digest = await summarizeFn({ items: recent, logger, source });
      lastOpenedAt = Date.now();
      logger.info(`[catchup] digest created via ${source}`);
      return digest;
    },
    getRecentItems,
  };
}
