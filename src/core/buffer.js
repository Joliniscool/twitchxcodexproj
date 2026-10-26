export function createRollingBuffer(windowMs = 30 * 60 * 1000) {
  const items = [];

  const prune = () => {
    const cutoff = Date.now() - windowMs;
    while (items.length && items[0].at < cutoff) {
      items.shift();
    }
  };

  return {
    add(item) {
      const normalized = {
        ...item,
        at: item.at ?? Date.now(),
      };

      items.push(normalized);
      prune();
      return normalized;
    },
    getAll() {
      prune();
      return [...items];
    },
    size() {
      prune();
      return items.length;
    },
    clear() {
      items.length = 0;
    },
  };
}
