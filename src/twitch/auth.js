const DEFAULT_TWITCH_BASE = 'https://id.twitch.tv/oauth2';

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
