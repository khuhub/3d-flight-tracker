import type { ServerResponse } from 'node:http';
import { toWire, type FlightMode, type Snapshot, type SnapshotMessage, type StatusMessage } from '@flight/shared';
import type { RouteDatabase } from './routes';
import { SnapshotHistory } from './history';

export interface HubOptions {
  mode: FlightMode;
  pollIntervalS: number;
  authenticated: boolean;
  heartbeatMs: number;
  now?: () => number;
  /** Clients whose unsent backlog exceeds this are disconnected instead of buffering without bound. */
  maxBacklogBytes?: number;
  /** Offline scheduled-route lookup; snapshots carry no routes without it. */
  routes?: RouteDatabase | null;
}

/**
 * Holds the latest filtered snapshot in memory and fans it out over Server-Sent Events.
 * Each snapshot is serialised once regardless of the number of connected browsers.
 */
export class SnapshotHub {
  readonly history: SnapshotHistory;
  private readonly clients = new Set<ServerResponse>();
  private snapshotFrame: string | null = null;
  private latest: SnapshotMessage | null = null;
  private sequence = 0;
  private status: Omit<StatusMessage, 'serverNow'>;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: HubOptions) {
    this.now = options.now ?? Date.now;
    this.history = new SnapshotHistory(this.now);
    this.status = {
      mode: options.mode,
      upstream: 'starting',
      lastSuccessAt: null,
      lastError: null,
      nextUpdateAt: null,
      pollIntervalS: options.pollIntervalS,
      authenticated: options.authenticated,
    };
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get latestSnapshot(): SnapshotMessage | null {
    return this.latest;
  }

  getStatus(): StatusMessage {
    return { ...this.status, serverNow: this.now() };
  }

  publishSnapshot(snapshot: Snapshot, replayEpoch = 0): SnapshotMessage {
    const now = this.now();
    const routes = this.options.routes?.match(snapshot.aircraft) ?? null;
    const message: SnapshotMessage = {
      mode: this.options.mode,
      sequence: ++this.sequence,
      replayEpoch,
      time: snapshot.time,
      serverNow: now,
      pollIntervalS: this.options.pollIntervalS,
      aircraft: snapshot.aircraft.map((a, i) => toWire(a, routes?.codes[i] ?? null)),
      airports: routes?.airports ?? {},
    };
    this.latest = message;
    const json = JSON.stringify(message);
    this.history.append(message, json);
    this.snapshotFrame = `event: snapshot\ndata: ${json}\n\n`;
    this.status = { ...this.status, upstream: 'ok', lastSuccessAt: now, lastError: null };
    this.broadcast(frame('status', this.getStatus()));
    this.broadcast(this.snapshotFrame);
    return message;
  }

  /** Records an upstream problem. The last good snapshot stays cached and keeps being served. */
  updateStatus(patch: Partial<Omit<StatusMessage, 'serverNow' | 'mode'>>): void {
    this.status = { ...this.status, ...patch };
    this.broadcast(frame('status', this.getStatus()));
  }

  addClient(res: ServerResponse): void {
    this.clients.add(res);
    res.write('retry: 5000\n\n');
    res.write(frame('status', this.getStatus()));
    if (this.snapshotFrame) res.write(this.snapshotFrame);
    this.heartbeat ??= setInterval(() => this.broadcast(frame('status', this.getStatus())), this.options.heartbeatMs);
  }

  removeClient(res: ServerResponse): void {
    this.clients.delete(res);
    if (this.clients.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  close(): void {
    this.history.close();
    for (const res of this.clients) res.end();
    this.clients.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private broadcast(data: string): void {
    const limit = this.options.maxBacklogBytes ?? 32 * 1024 * 1024;
    for (const res of this.clients) {
      if (res.writableEnded || res.destroyed) {
        this.removeClient(res);
        continue;
      }
      if (res.writableLength > limit) {
        res.destroy();
        this.removeClient(res);
        continue;
      }
      res.write(data);
    }
  }
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
