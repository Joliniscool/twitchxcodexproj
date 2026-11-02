import { refreshStoredToken } from './auth.js';

const HELIX_BASE = 'https://api.twitch.tv/helix';

// Every Helix call goes through here so an expired token mid-stream refreshes itself,
// and failures come back as a result instead of throwing into the chat pipeline.
async function helixRequest(pathAndQuery, { method = 'GET', body, retried = false } = {}) {
  let response;
  try {
    response = await fetch(`${HELIX_BASE}${pathAndQuery}`, {
      method,
      headers: {
        'Client-Id': process.env.TWITCH_CLIENT_ID || '',
        Authorization: `Bearer ${process.env.TWITCH_TOKEN || ''}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    return { ok: false, status: 0, data: {}, message: `network error: ${error.message}` };
  }

  const data = await response.json().catch(() => ({}));
  const message = data?.message || response.statusText;

  // A 401 can also mean a missing scope, which a refresh would not fix.
  if (response.status === 401 && !retried && /invalid.*token/i.test(message)) {
    try {
      await refreshStoredToken();
      return helixRequest(pathAndQuery, { method, body, retried: true });
    } catch (error) {
      return { ok: false, status: 401, data, message: `${error.message}. Run "npm run token" to log in again.` };
    }
  }

  return { ok: response.ok, status: response.status, data, message };
}

// Twitch rejects chat messages over 500 characters.
export async function sendChatMessage({ broadcasterId, senderId, message, logger = console }) {
  const result = await helixRequest('/chat/messages', {
    method: 'POST',
    body: {
      broadcaster_id: broadcasterId,
      sender_id: senderId,
      message: message.slice(0, 500),
    },
  });

  if (!result.ok) {
    const hint = result.status === 401 || result.status === 403 ? ' (run "npm run token" to grant the user:write:chat scope)' : '';
    logger.error(`[helix] chat send failed: ${result.status} ${result.message}${hint}`);
    return false;
  }

  const sent = result.data?.data?.[0];
  if (sent && !sent.is_sent) {
    logger.warn('[helix] chat message dropped by Twitch', sent.drop_reason?.message || '');
    return false;
  }

  return true;
}

export async function sendAnnouncement({ broadcasterId, moderatorId, message, logger = console }) {
  const result = await helixRequest(`/chat/announcements?broadcaster_id=${broadcasterId}&moderator_id=${moderatorId}`, {
    method: 'POST',
    body: { message: message.slice(0, 500), color: 'purple' },
  });

  if (!result.ok) {
    logger.error(`[helix] announcement failed: ${result.status} ${result.message}`);
  }
  return result.ok;
}

// Returns null when the list can't be read (e.g. the channel isn't Affiliate), so the catalog keeps what it has.
export async function fetchChannelRewards({ broadcasterId, logger = console }) {
  const result = await helixRequest(`/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`);
  if (!result.ok) {
    logger.warn(`[helix] channel point rewards unavailable: ${result.status} ${result.message}`);
    return null;
  }

  return (result.data.data || [])
    .filter((reward) => reward.is_enabled)
    .map((reward) => ({ title: reward.title, cost: reward.cost, prompt: reward.prompt }));
}

export async function fetchActiveExtensions({ broadcasterId, logger = console }) {
  const result = await helixRequest(`/users/extensions?user_id=${broadcasterId}`);
  if (!result.ok) {
    logger.warn(`[helix] active extensions unavailable: ${result.status} ${result.message}`);
    return null;
  }

  const slots = result.data.data || {};
  return ['panel', 'overlay', 'component'].flatMap((type) => Object.values(slots[type] || {})
    .filter((slot) => slot.active && slot.name)
    .map((slot) => ({ name: slot.name, type })));
}

// Clips and markers only work while the channel is live; offline they fail and the moment is kept without them.
export async function createMomentAssets({ simulate = true, broadcasterId, logger = console, triggerText = '' } = {}) {
  if (simulate) {
    logger.info('[helix] simulator mode: fake moment asset created', triggerText || 'moment');
    return {
      clipUrl: 'https://example.com/fake-clip.mp4',
      markerId: `sim-marker-${Date.now()}`,
    };
  }

  const clip = await helixRequest(`/clips?broadcaster_id=${broadcasterId}`, { method: 'POST' });
  if (!clip.ok) {
    logger.warn(`[helix] clip failed (the channel must be live): ${clip.status} ${clip.message}`);
  }

  const marker = await helixRequest('/streams/markers', {
    method: 'POST',
    body: {
      user_id: broadcasterId,
      description: (triggerText || 'Hype moment').slice(0, 140),
    },
  });
  if (!marker.ok) {
    logger.warn(`[helix] marker failed (the channel must be live): ${marker.status} ${marker.message}`);
  }

  const clipId = clip.data?.data?.[0]?.id;
  return {
    clipUrl: clipId ? `https://clips.twitch.tv/${clipId}` : null,
    markerId: marker.data?.data?.[0]?.id || null,
  };
}
