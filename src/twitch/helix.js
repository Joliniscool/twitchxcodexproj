export async function createMomentAssets({ simulate = true, logger = console, triggerText = '' } = {}) {
  if (simulate) {
    logger.info('[helix] simulator mode: fake moment asset created', triggerText || 'moment');
    return {
      clipUrl: 'https://example.com/fake-clip.mp4',
      markerId: `sim-marker-${Date.now()}`,
    };
  }

  const headers = {
    'Client-Id': process.env.TWITCH_CLIENT_ID || '',
    Authorization: `Bearer ${process.env.TWITCH_TOKEN || ''}`,
    'Content-Type': 'application/json',
  };

  const clipResponse = await fetch('https://api.twitch.tv/helix/clips', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      broadcaster_id: process.env.BROADCASTER_ID,
      title: triggerText || 'Hype moment',
    }),
  });

  const clipData = await clipResponse.json().catch(() => ({}));

  const markerResponse = await fetch('https://api.twitch.tv/helix/streams/markers', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      user_id: process.env.BROADCASTER_ID,
      description: triggerText || 'Hype moment',
    }),
  });

  const markerData = await markerResponse.json().catch(() => ({}));

  return {
    clipUrl: clipData?.data?.[0]?.edit_url || 'https://example.com/fake-clip.mp4',
    markerId: markerData?.data?.[0]?.id || `marker-${Date.now()}`,
  };
}
