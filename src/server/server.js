import express from 'express';
import http from 'http';
import fs from 'node:fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../../public');

export function createLocalServer({ port = Number(process.env.PORT) || 3000, logger = console, catalogManager = null, momentsPath = path.resolve(process.cwd(), 'data/moments.json') } = {}) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  const clients = new Set();
  let triggerHandler = async () => ({ ok: true });
  let unreadState = { questions: 0, events: 0, total: 0 };
  let latestDigest = null;
  let latestMoments = [];
  let actions = {};
  const latestByType = new Map();

  app.use(express.static(publicDir));

  // These act on the live channel, so don't let an unrelated website trigger them from the streamer's browser.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.get('sec-fetch-site') === 'cross-site') {
      res.status(403).json({ ok: false, error: 'cross-site request blocked' });
      return;
    }
    next();
  });

  const runAction = (name) => async (_req, res) => {
    try {
      res.json({ ok: true, result: await actions[name]() });
    } catch (error) {
      logger.error(`[server] ${name} failed`, error.message || error);
      res.status(500).json({ ok: false, error: error.message || `${name} failed` });
    }
  };

  app.get('/api/status', runAction('getStatus'));
  app.get('/api/recap', runAction('getLatestRecap'));
  app.post('/api/recap', runAction('postRecap'));
  app.post('/api/clip', runAction('clipNow'));
  app.post('/api/test-message', runAction('sendTestMessage'));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, status: 'healthy' });
  });

  app.get('/api/unread', (_req, res) => {
    res.json({ ok: true, unread: unreadState });
  });

  app.get('/api/moments', async (_req, res) => {
    try {
      const data = await fs.readFile(momentsPath, 'utf8');
      const parsed = JSON.parse(data || '[]');
      latestMoments = Array.isArray(parsed) ? parsed : [];
      res.json({ ok: true, moments: latestMoments });
    } catch (error) {
      res.json({ ok: true, moments: [] });
    }
  });

  app.get('/api/catalog', async (_req, res) => {
    try {
      if (!catalogManager) {
        res.json({ ok: true, commands: [] });
        return;
      }
      const commands = catalogManager.listCommands();
      res.json({ ok: true, commands });
    } catch (error) {
      res.json({ ok: true, commands: [] });
    }
  });

  app.post('/api/catalog', express.json(), async (req, res) => {
    try {
      if (!catalogManager) {
        res.status(500).json({ ok: false, error: 'catalog manager unavailable' });
        return;
      }
      const entry = catalogManager.addManualEntry(req.body || {});
      res.json({ ok: true, entry });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message || 'invalid entry' });
    }
  });

  app.delete('/api/catalog', express.json(), (req, res) => {
    if (!catalogManager) {
      res.status(500).json({ ok: false, error: 'catalog manager unavailable' });
      return;
    }
    const removed = catalogManager.removeEntry(req.body || {});
    res.status(removed ? 200 : 404).json({ ok: removed });
  });

  // GET so a Stream Deck or any hotkey tool can trigger it by opening a local URL.
  const handleCatchup = async (_req, res) => {
    try {
      const result = await triggerHandler({ source: 'http' });
      res.json({ ok: true, digest: result });
    } catch (error) {
      logger.error('[server] trigger failed', error.message || error);
      res.status(500).json({ ok: false, error: error.message || 'trigger failed' });
    }
  };

  app.get('/api/catchup', handleCatchup);
  app.get('/api/trigger-catchup', handleCatchup);

  const broadcast = (type, payload) => {
    const message = JSON.stringify({ type, payload });
    for (const client of clients) {
      if (client.readyState === 1) {
        client.send(message);
      }
    }
  };

  wss.on('connection', (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: 'unread', payload: unreadState }));
    if (latestDigest) {
      socket.send(JSON.stringify({ type: 'digest', payload: latestDigest }));
    }
    if (latestMoments.length) {
      socket.send(JSON.stringify({ type: 'moments', payload: latestMoments }));
    }
    for (const [type, payload] of latestByType) {
      socket.send(JSON.stringify({ type, payload }));
    }

    socket.on('message', async (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === 'requestUnread') {
          socket.send(JSON.stringify({ type: 'unread', payload: unreadState }));
          return;
        }

        if (parsed.type === 'triggerCatchup') {
          const result = await triggerHandler({ source: 'dashboard' });
          socket.send(JSON.stringify({ type: 'digest', payload: result }));
        }
      } catch (error) {
        logger.error('[server] websocket message parse error', error.message || error);
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
    });
  });

  const start = () => new Promise((resolve, reject) => {
    let listeningPort = port;

    const attemptStart = () => {
      const onError = (error) => {
        if (error && error.code === 'EADDRINUSE') {
          listeningPort += 1;
          logger.warn(`[server] port ${port} busy, retrying on ${listeningPort}`);
          server.listen(listeningPort, onListen);
          return;
        }

        reject(error);
      };

      const onListen = () => {
        logger.info(`[server] listening on http://localhost:${listeningPort}`);
        resolve(server);
      };

      server.once('error', onError);
      server.listen(listeningPort, onListen);
    };

    attemptStart();
  });

  return {
    app,
    server,
    wss,
    start,
    setTriggerHandler(nextHandler) {
      triggerHandler = nextHandler;
    },
    emitUnread(nextUnread) {
      unreadState = nextUnread;
      broadcast('unread', unreadState);
    },
    emitDigest(digest) {
      latestDigest = digest;
      broadcast('digest', digest);
    },
    emitMoments(moments) {
      latestMoments = moments;
      broadcast('moments', moments);
    },
    setActions(nextActions) {
      actions = nextActions;
    },
    // Broadcast and remember, so pages that connect later still get the latest value.
    publish(type, payload) {
      latestByType.set(type, payload);
      broadcast(type, payload);
    },
    emitStatus(message) {
      broadcast('status', { message });
    },
  };
}
