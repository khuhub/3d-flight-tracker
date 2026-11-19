import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGzip, gunzip } from 'node:zlib';
import type { HistoryPayload, SnapshotHistory } from './history';

const CONCURRENT_DOWNLOADS = 4;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const decompress = promisify(gunzip);

async function* seedParts(frames: HistoryPayload[]): AsyncGenerator<string | Buffer> {
  yield '[';
  for (const [i, frame] of frames.entries()) {
    if (i > 0) yield ',';
    yield await decompress(frame.gzip);
  }
  yield ']';
}

function sendPayload(res: ServerResponse, payload: HistoryPayload | HistoryPayload[], gzip: boolean): void {
  if (Array.isArray(payload)) {
    // Use one streaming gzip member. Some browsers stop decoding at the first
    // member of a concatenated response. Keep backpressure and avoid a full copy.
    const source = Readable.from(seedParts(payload), { objectMode: false });
    const transfer = gzip ? pipeline(source, createGzip({ level: 1 }), res) : pipeline(source, res);
    void transfer.catch(() => res.destroy());
  } else if (gzip) {
    res.end(payload.gzip);
  } else {
    void decompress(payload.gzip).then((body) => res.end(body)).catch(() => res.destroy());
  }
}

function acceptsGzip(header: string | undefined): boolean {
  const codings = new Map(header?.split(',').map((item) => {
    const [coding, quality] = item.trim().toLowerCase().split(';');
    return [coding?.trim(), quality === undefined ? 1 : Number(quality.trim().replace(/^q=/, ''))];
  }));
  return (codings.get('gzip') ?? codings.get('*') ?? 0) > 0;
}

export function historyHandler(history: SnapshotHistory) {
  let activeDownloads = 0;
  return (url: URL, res: ServerResponse, head: boolean, acceptEncoding: string | undefined): void => {
    if (url.pathname === '/api/history') {
      res.writeHead(200, HEADERS).end(head ? undefined : JSON.stringify(history.index()));
      return;
    }
    const match = /^\/api\/history\/([a-f0-9-]{36})(?:\/(\d+))?$/.exec(url.pathname);
    const sequence = Number(match?.[2]);
    const at = url.searchParams.get('at');
    const cursor = at !== null && /^\d+$/.test(at) ? Number(at) : NaN;
    if (!match || !(match[2] ? Number.isSafeInteger(sequence) : Number.isSafeInteger(cursor))) {
      res.writeHead(400, HEADERS).end(head ? undefined : '{"error":"Invalid history request"}');
      return;
    }
    if (activeDownloads >= CONCURRENT_DOWNLOADS) {
      res.writeHead(503, { ...HEADERS, 'Retry-After': '1' }).end(head ? undefined : '{"error":"History is busy"}');
      return;
    }
    const generation = match[1]!;
    const payload = match[2] ? history.frame(generation, sequence) : history.seed(generation, cursor);
    if (!payload) {
      res.writeHead(404, HEADERS).end(head ? undefined : '{"error":"History no longer available"}');
      return;
    }
    const gzip = acceptsGzip(acceptEncoding);
    res.writeHead(200, { ...HEADERS, 'Vary': 'Accept-Encoding', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
    if (head) {
      res.end();
      return;
    }
    activeDownloads++;
    const deadline = setTimeout(() => res.destroy(), DOWNLOAD_TIMEOUT_MS);
    deadline.unref();
    res.once('close', () => {
      clearTimeout(deadline);
      activeDownloads--;
    });
    sendPayload(res, payload, gzip);
  };
}
