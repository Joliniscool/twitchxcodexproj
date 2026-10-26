export function parseCommandText(text = '') {
  const cleaned = (text || '').trim();
  if (!cleaned || !cleaned.startsWith('!')) {
    return null;
  }

  const [command, ...args] = cleaned.split(/\s+/);
  return {
    command: command.toLowerCase(),
    args: args.join(' '),
    raw: cleaned,
  };
}

export function isAllowedTrigger(user = '') {
  const normalized = String(user || '').toLowerCase();
  return ['streamer', 'mod', 'moderator', 'admin'].includes(normalized);
}
