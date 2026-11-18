import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import type { SnapshotHub } from './hub';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export interface AppOptions {
  hub: SnapshotHub;
  /** Built client to serve; omitted in development, where Vite serves the UI. */
  staticDir?: string | null;
}

export function createApp({ hub, staticDir = null }: AppOptions): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    if (url.pathname === '/api/stream') return stream(req, res, hub);
    if (url.pathname === '/api/status') return json(res, hub.getStatus());
    if (url.pathname === '/api/health') return json(res, { ok: true, clients: hub.clientCount });
    if (url.pathname.startsWith('/api/')) return json(res, { error: 'Not found' }, 404);
    if (staticDir) return serveStatic(url.pathname, res, staticDir);
    json(res, { error: 'Not found' }, 404);
  });
}

function stream(req: IncomingMessage, res: ServerResponse, hub: SnapshotHub): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.socket?.setNoDelay(true);
  hub.addClient(res);
  const cleanup = (): void => hub.removeClient(res);
  req.on('close', cleanup);
  res.on('error', cleanup);
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveStatic(pathname: string, res: ServerResponse, root: string): void {
  let rel: string;
  try {
    rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = join(root, rel);
  if (file !== root && !file.startsWith(root.endsWith(sep) ? root : root + sep)) {
    res.writeHead(403).end();
    return;
  }
  if (!isFile(file)) file = join(root, 'index.html');
  if (!isFile(file)) {
    res.writeHead(404).end();
    return;
  }
  const immutable = rel.startsWith('assets/');
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
