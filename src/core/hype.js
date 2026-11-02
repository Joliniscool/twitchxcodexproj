import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_STORAGE_PATH = path.resolve(process.cwd(), 'data/moments.json');
const BUCKET_MS = 5000;
const MIN_BURST_MESSAGES = 8;

export function createHypeDetector({ storagePath = DEFAULT_STORAGE_PATH, logger = console } = {}) {
  const buckets = [];
  const recentMoments = [];
  let lastMomentAt = 0;
  let persistQueue = Promise.resolve();

  const ensureStorage = async () => {
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    try {
      await fs.access(storagePath);
    } catch {
      await fs.writeFile(storagePath, JSON.stringify([], null, 2));
    }
  };

  const writeJsonAtomically = async (targetPath, value) => {
    const tempPath = `${targetPath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(value, null, 2));
    await fs.rename(tempPath, targetPath);
  };

  const loadMoments = async () => {
    await ensureStorage();
    try {
      const raw = await fs.readFile(storagePath, 'utf8');
      const parsed = JSON.parse(raw || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      logger.warn('[hype] unable to read moments file', error.message || error);
      return [];
    }
  };

  const persistMoment = async (moment) => {
    persistQueue = persistQueue
      .then(async () => {
        await ensureStorage();
        const current = await loadMoments();
        const next = [...current, moment];
        await writeJsonAtomically(storagePath, next);
        logger.info('[hype] saved moment', moment.label);
      })
      .catch((error) => {
        logger.error('[hype] failed to save moment', error.message || error);
      });

    await persistQueue;
  };

  // Replace by id so a moment can gain its clip link after it was first saved.
  const saveMoment = async (moment) => {
    persistQueue = persistQueue
      .then(async () => {
        await ensureStorage();
        const current = await loadMoments();
        await writeJsonAtomically(storagePath, [...current.filter((entry) => entry.id !== moment.id), moment]);
      })
      .catch((error) => {
        logger.error('[hype] failed to save moment', error.message || error);
      });

    await persistQueue;
  };

  const scoreBucket = (events) => {
    if (!events.length) return 0;

    const volume = events.length;
    const emoteDensity = events.filter((event) => (event.emotes || []).length > 0).length;
    const bonusEvents = events.filter((event) => ['sub', 'cheer', 'raid', 'redemption'].includes(event.type)).length;
    const totalBoost = emoteDensity * 2 + bonusEvents * 3;
    return volume + totalBoost;
  };

  const buildLabel = (events) => {
    const sampleText = events
      .map((event) => (event.text || '').trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(' ')
      .toLowerCase();

    const seed = sampleText || 'the chat got loud';
    const templates = [
      `chat lost it when ${seed}`,
      `the room exploded as ${seed}`,
      `everyone hit the hype train when ${seed}`,
      `the chat snapped when ${seed}`,
    ];

    return templates[0].charAt(0).toUpperCase() + templates[0].slice(1);
  };

  const bucketEvents = (bucket) => {
    if (!bucket) return [];
    return bucket.events || [];
  };

  const detectBucket = (bucket) => {
    if (!bucket || !bucket.events || bucket.events.length === 0) {
      return null;
    }

    const baselineWindow = 5 * 60 * 1000;
    const priorBuckets = buckets.filter((entry) => entry.at < bucket.at && bucket.at - entry.at <= baselineWindow);
    const oldestAt = priorBuckets.reduce((oldest, entry) => Math.min(oldest, entry.at), bucket.at);
    const slots = Math.max(1, (bucket.at - oldestAt) / BUCKET_MS);

    // Quiet 5-second windows have no bucket, but they still count toward the baseline as zero.
    const counts = priorBuckets.map((entry) => entry.events.length);
    while (counts.length < slots) counts.push(0);

    const mean = counts.reduce((sum, count) => sum + count, 0) / counts.length;
    const std = Math.sqrt(counts.reduce((sum, count) => sum + (count - mean) ** 2, 0) / counts.length);
    const currentCount = bucket.events.length;
    const recentEvents = bucket.events;

    if (currentCount > mean + 3 * std && currentCount >= mean * 3 && currentCount >= MIN_BURST_MESSAGES) {
      const currentScore = scoreBucket(recentEvents);
      const now = Date.now();
      if (now - lastMomentAt < 60_000) {
        return null;
      }

      const moment = {
        id: `moment-${now}-${Math.random().toString(16).slice(2, 8)}`,
        at: now,
        score: Number(currentScore.toFixed(1)),
        reason: 'chat intensity surge',
        label: buildLabel(recentEvents),
        chatSample: recentEvents.slice(0, 8).map((event) => ({ user: event.user, text: event.text, at: event.at })),
      };

      lastMomentAt = now;
      recentMoments.push(moment);
      persistMoment(moment).catch((error) => logger.error('[hype] failed to save moment', error.message || error));
      return moment;
    }

    return null;
  };

  return {
    recordEvent(event) {
      const bucketAt = Math.floor((event.at || Date.now()) / BUCKET_MS) * BUCKET_MS;
      let bucket = buckets.find((entry) => entry.at === bucketAt);

      if (!bucket) {
        bucket = { at: bucketAt, events: [] };
        buckets.push(bucket);
      }

      bucket.events.push(event);
      while (buckets.length > 120) {
        buckets.shift();
      }
      return bucket;
    },
    detectCurrentMoment() {
      const now = Date.now();
      const latestBucket = buckets.reduce((latest, entry) => {
        if (!latest || entry.at > latest.at) {
          return entry;
        }
        return latest;
      }, null);

      if (!latestBucket) {
        return null;
      }

      if (now - latestBucket.at > 60_000) {
        return null;
      }

      return detectBucket(latestBucket);
    },
    getRecentMoments() {
      return [...recentMoments];
    },
    async listMoments() {
      return await loadMoments();
    },
    saveMoment,
  };
}
