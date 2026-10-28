import 'dotenv/config';

// Device code flow: works for public Twitch apps, which have no client secret.
const TWITCH_BASE = 'https://id.twitch.tv/oauth2';
const SCOPES = 'user:read:chat channel:read:subscriptions bits:read channel:read:redemptions';

const clientId = process.env.TWITCH_CLIENT_ID;
if (!clientId) {
  console.error('Set TWITCH_CLIENT_ID in .env first.');
  process.exit(1);
}

async function post(path, params) {
  const response = await fetch(`${TWITCH_BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return { ok: response.ok, data: await response.json() };
}

const device = await post('device', { client_id: clientId, scopes: SCOPES });
if (!device.ok) {
  console.error('Could not start device login:', device.data?.message);
  process.exit(1);
}

const { device_code: deviceCode, user_code: userCode, verification_uri: verificationUri, interval = 5 } = device.data;
console.log(`\nOpen ${verificationUri}`);
console.log(`Log in as the streamer account and enter code: ${userCode}\n`);
console.log('Waiting for you to authorize...');

while (true) {
  await new Promise((resolve) => setTimeout(resolve, interval * 1000));

  const token = await post('token', {
    client_id: clientId,
    scopes: SCOPES,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });

  if (token.ok) {
    console.log('\nAdd these to .env:\n');
    console.log(`TWITCH_TOKEN=${token.data.access_token}`);
    console.log(`TWITCH_REFRESH_TOKEN=${token.data.refresh_token}`);
    process.exit(0);
  }

  if (token.data?.message !== 'authorization_pending') {
    console.error('Login failed:', token.data?.message);
    process.exit(1);
  }
}
