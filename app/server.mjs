import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import api from './api.mjs';
import { openDatabase } from './database.mjs';
export function createServer({ databasePath = ':memory:', assets, port = 3000 } = {}) {
  const DB = openDatabase(databasePath);
  const pending = new Set();
  const server = http.createServer(async (req, res) => {
    const actualPort = server.address().port;
    // Fixed loopback origin prevents Host-header and forwarded-header spoofing.
    const host = req.headers.host;
    if (![ `localhost:${actualPort}`, `127.0.0.1:${actualPort}` ].includes(host)) {
      res.writeHead(400); return res.end('Invalid host. Use localhost.');
    }
    const origin = `http://${host}`;
    const controller = new AbortController();
    req.on('aborted', () => controller.abort());
    try {
      const request = new Request(new URL(req.url, origin), {
        method: req.method, headers: req.headers, signal: controller.signal,
        ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
      });
      const response = await api.fetch(request, { DB, ASSETS: assets, clientIp: req.socket.remoteAddress }, {
        waitUntil(promise) { pending.add(promise); promise.finally(() => pending.delete(promise)); },
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error('HTTP request failed:', error.message);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request failed.' }));
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return {
    DB, server,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      return `http://localhost:${server.address().port}`;
    },
    async close() {
      server.closeIdleConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.allSettled([...pending]); DB.close();
    },
  };
}
export function loadAssets() {
  return JSON.parse(readFileSync(new URL('../dist/assets.json', import.meta.url), 'utf8'));
}
export function defaultDatabasePath() {
  mkdirSync(new URL('../.local/', import.meta.url), { recursive: true, mode: 0o700 });
  return new URL('../.local/chat.sqlite', import.meta.url).pathname;
}
