import OpenAI from 'openai';

function buildFallbackDigest(items) {
  const questions = items
    .filter((item) => item.type === 'chat' && /\?|who|what|when|where|why|how|can|could|did|anyone|someone/i.test(item.text || ''))
    .slice(0, 3)
    .map((item) => ({ user: item.user || 'viewer', text: item.text || '' }));

  const events = items
    .filter((item) => item.type !== 'chat')
    .slice(0, 4)
    .map((item) => ({ summary: `${item.user || 'system'}: ${item.text || item.type}` }));

  const jokes = items
    .filter((item) => item.type === 'chat' && /(lul|pogchamp|kappa|monkaS|omegalul)/i.test(item.text || ''))
    .slice(0, 3)
    .map((item) => ({ summary: `${item.user || 'viewer'} shouted ${item.text}` }));

  const moments = items
    .filter((item) => item.type === 'chat' && /(this is so hype|pogchamp|wtf that clip was insane|so hype)/i.test(item.text || ''))
    .slice(0, 3)
    .map((item, index) => ({ label: `Hype burst ${index + 1}`, at: item.at || Date.now() }));

  return {
    questions,
    events: events.length ? events : [{ summary: 'No major stream events were captured in the recent window.' }],
    jokes: jokes.length ? jokes : [{ summary: 'No notable meme spam surfaced in the catch-up window.' }],
    moments: moments.length ? moments : [{ label: 'Quiet stretch', at: Date.now() }],
    oneLine: `The stream had ${questions.length} questions and ${events.length} notable events in the recent catch-up window.`,
  };
}

function parseJsonFromText(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    return null;
  }

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    return null;
  }
}

export async function summarizeCatchup({ items, logger = console }) {
  const recentItems = (items || []).filter(Boolean);

  if (!recentItems.length) {
    return {
      questions: [],
      events: [{ summary: 'No recent activity was found.' }],
      jokes: [],
      moments: [],
      oneLine: 'There was no new activity since the last catch-up.',
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    logger.info('[ai] no OpenAI API key, using local fallback digest');
    return buildFallbackDigest(recentItems);
  }

  const prompt = `You are generating a Twitch catch-up digest for streamers and viewers. Return strict JSON only with this shape:
{
  "questions": [{"user":"string","text":"string"}],
  "events": [{"summary":"string"}],
  "jokes": [{"summary":"string"}],
  "moments": [{"label":"string","at":1234567890}],
  "oneLine":"string"
}

Use only the following events, in order, and do not invent missing details:
${JSON.stringify(recentItems, null, 2)}

Rules:
- questions are viewer questions with no streamer answer yet
- jokes are meme or funny moments
- moments are hype bursts or important moments with timestamps
- oneLine should be a short single sentence summary
`;

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      input: [{ role: 'user', content: prompt }],
    });

    const text = response.output_text || response.output?.[0]?.content?.[0]?.text || '';
    const parsed = parseJsonFromText(text);
    if (parsed && Array.isArray(parsed.questions) && Array.isArray(parsed.events) && Array.isArray(parsed.jokes) && Array.isArray(parsed.moments)) {
      logger.info('[ai] generated catch-up digest from OpenAI');
      return {
        questions: parsed.questions.map((entry) => ({ user: entry.user || 'viewer', text: entry.text || '' })),
        events: parsed.events.map((entry) => ({ summary: entry.summary || 'Stream event' })),
        jokes: parsed.jokes.map((entry) => ({ summary: entry.summary || 'Meme moment' })),
        moments: parsed.moments.map((entry) => ({ label: entry.label || 'Moment', at: Number(entry.at || Date.now()) })),
        oneLine: parsed.oneLine || 'Recent stream activity summarized.',
      };
    }
  } catch (error) {
    logger.error('[ai] OpenAI digest failed, falling back', error.message || error);
  }

  return buildFallbackDigest(recentItems);
}
