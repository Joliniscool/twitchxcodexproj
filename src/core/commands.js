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

// Real Twitch chat sends badges as { set_id } objects; the simulator uses plain strings and role-named users.
export function isAllowedTrigger(event = {}) {
  const badges = (event.badges || []).map((badge) => String(badge?.set_id || badge).toLowerCase());
  if (badges.some((badge) => ['broadcaster', 'moderator'].includes(badge))) {
    return true;
  }

  const normalized = String(event.user || '').toLowerCase();
  return ['streamer', 'mod', 'moderator', 'admin'].includes(normalized);
}
