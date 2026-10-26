import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../../public');

export function createLocalServer({ port = Number(process.env.PORT) || 3000, logger = console } = {}) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  const clients = new Set();
  let triggerHandler = async () => ({ ok: true });
  let unreadState = { questions: 0, events: 0, total: 0 };
  let latestDigest = null;

  app.use(express.static(publicDir));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, status: 'healthy' });
  });

  app.get('/api/unread', (_req, res) => {
    res.json({ ok: true, unread: unreadState });
  });

  app.get('/api/trigger-catchup', async (_req, res) => {
    try {
      const result = await triggerHandler({ source: 'http' });
      res.json({ ok: true, digest: result });
    } catch (error) {
      logger.error('[server] trigger failed', error.message || error);
      res.status(500).json({ ok: false, error: error.message || 'trigger failed' });
    }
  });

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

  const start = () => new Promise((resolve) => {
    server.listen(port, () => {
      logger.info(`[server] listening on http://localhost:${port}`);
      resolve(server);
    });
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
    emitStatus(message) {
      broadcast('status', { message });
    },
  };
}
