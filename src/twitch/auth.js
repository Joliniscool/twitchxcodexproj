import fs from 'fs/promises';
import path from 'path';

const DEFAULT_TWITCH_BASE = 'https://id.twitch.tv/oauth2';
const ENV_PATH = path.resolve(process.cwd(), '.env');

export const TWITCH_SCOPES = [
  'user:read:chat',
  'user:write:chat',
  'channel:read:subscriptions',
  'bits:read',
  'channel:read:redemptions',
  'clips:edit',
  'channel:manage:broadcast',
  'moderator:manage:announcements',
];

// Public-app refresh tokens are single use, so each new pair must be written back to .env.
export async function saveTokensToEnv({ accessToken, refreshToken }) {
  let contents = await fs.readFile(ENV_PATH, 'utf8').catch(() => '');
  for (const [key, value] of [['TWITCH_TOKEN', accessToken], ['TWITCH_REFRESH_TOKEN', refreshToken]]) {
    if (!value) continue;
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    contents = pattern.test(contents) ? contents.replace(pattern, line) : `${contents.replace(/\n?$/, '\n')}${line}\n`;
  }
  await fs.writeFile(ENV_PATH, contents);
}

export function getTwitchHeaders(accessToken) {
  return {
    'Client-Id': process.env.TWITCH_CLIENT_ID || '',
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
}

export async function refreshAccessToken({ clientId, refreshToken, clientSecret = '' } = {}) {
  const id = clientId || process.env.TWITCH_CLIENT_ID;
  const token = refreshToken || process.env.TWITCH_REFRESH_TOKEN;

  if (!id || !token) {
    throw new Error('Missing Twitch client credentials for refresh.');
  }

  const params = new URLSearchParams({
    client_id: id,
    refresh_token: token,
    grant_type: 'refresh_token',
  });

  if (clientSecret || process.env.TWITCH_CLIENT_SECRET) {
    params.set('client_secret', clientSecret || process.env.TWITCH_CLIENT_SECRET);
  }

  const response = await fetch(`${DEFAULT_TWITCH_BASE}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Twitch token refresh failed: ${data?.message || response.statusText}`);
  }

  return data;
}

let refreshInFlight = null;

// EventSub and Helix can both hit an expired token at once, and refresh tokens are single use, so share one refresh.
export function refreshStoredToken() {
  refreshInFlight = refreshInFlight || refreshAccessToken({})
    .then(async (refreshed) => {
      process.env.TWITCH_TOKEN = refreshed.access_token;
      process.env.TWITCH_REFRESH_TOKEN = refreshed.refresh_token || process.env.TWITCH_REFRESH_TOKEN;
      await saveTokensToEnv({ accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token });
      return refreshed.access_token;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

export async function validateToken(accessToken) {
  const response = await fetch(`${DEFAULT_TWITCH_BASE}/validate`, {
    headers: { Authorization: `OAuth ${accessToken}` },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Twitch token validation failed: ${data?.message || response.statusText}`);
  }

  return data;
}

export function isUnauthorizedStatus(statusCode) {
  return statusCode === 401;
}
