import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { HistoryFrame, HistoryIndex, SnapshotMessage } from '@flight/shared';

export const HISTORY_WINDOW_MS = 60 * 60 * 1000;
const SEED_WINDOW_MS = 10 * 60 * 1000;
const MIB = 1024 * 1024;
const DEFAULT_LIMITS = {
  bytes: 128 * MIB,
  frames: 240,
  frameBytes: 4 * MIB,
  seedBytes: 40 * MIB,
  seedEncodedBytes: 16 * MIB,
  seedFrames: 48,
};

export interface HistoryPayload {
  gzip: Buffer;
  decodedBytes: number;
}

interface StoredFrame extends HistoryFrame, HistoryPayload {
  observationTime: number;
}

/** Owns bounded serialized data, not the substantially larger decoded fleet objects. */
export class SnapshotHistory {
  private generation = randomUUID();
  private frames: StoredFrame[] = [];
  private bytes = 0;
  private lastClock = -Infinity;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private readonly limits: typeof DEFAULT_LIMITS;

  constructor(private readonly now: () => number, limits: Partial<typeof DEFAULT_LIMITS> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  append(message: SnapshotMessage, json: string): void {
    this.prune(message.serverNow);
    const decodedBytes = Buffer.byteLength(json);
    if (decodedBytes > Math.min(this.limits.frameBytes, this.limits.seedBytes - 2)) {
      // Do not advertise previous frames if the new latest frame can't be replayed.
      this.reset();
      return;
    }
    // Use fast compression at ingestion to protect the one-hour window even at the
    // fastest supported live cadence; keep the encoded data for zero-copy HTTP delivery.
    const gzip = gzipSync(json, { level: 1 });
    if (gzip.length > Math.min(this.limits.bytes, this.limits.seedEncodedBytes)) {
      this.reset();
      return;
    }
    while (this.bytes + gzip.length > this.limits.bytes || this.frames.length >= this.limits.frames) this.evictFirst();
    // Keep an exact-size backing allocation, not a slice of zlib's output slab.
    const stored = Buffer.allocUnsafeSlow(gzip.length);
    gzip.copy(stored);
    this.frames.push({
      sequence: message.sequence,
      capturedAt: message.serverNow,
      replayEpoch: message.replayEpoch,
      observationTime: message.time,
      gzip: stored,
      decodedBytes,
    });
    this.bytes += gzip.length;
    this.scheduleExpiry();
  }

  index(): HistoryIndex {
    const serverNow = this.now();
    this.prune(serverNow);
    return {
      generation: this.generation,
      serverNow,
      frames: this.frames.map(({ sequence, capturedAt, replayEpoch }) => ({ sequence, capturedAt, replayEpoch })),
    };
  }

  frame(generation: string, sequence: number): HistoryPayload | undefined {
    this.prune(this.now());
    if (generation !== this.generation) return;
    return this.frames.find((frame) => frame.sequence === sequence);
  }

  /** Latest frame at/before the cursor plus its bounded, continuous ten-minute prefix. */
  seed(generation: string, cursor: number): HistoryPayload[] | undefined {
    const now = this.now();
    this.prune(now);
    if (generation !== this.generation) return;
    cursor = Math.min(cursor, now);
    const index = this.frames.findLastIndex((frame) => frame.capturedAt <= cursor);
    const target = this.frames[index];
    if (!target) return;
    const frames = [target];
    let previous = target;
    const start = cursor - SEED_WINDOW_MS;
    let decodedBytes = target.decodedBytes;
    let encodedBytes = target.gzip.length;
    for (let i = index - 1; i >= 0 && frames.length < this.limits.seedFrames; i--) {
      const frame = this.frames[i]!;
      if (
        previous.capturedAt <= start ||
        frame.replayEpoch !== target.replayEpoch ||
        frame.observationTime > previous.observationTime ||
        decodedBytes + frame.decodedBytes + frames.length + 2 > this.limits.seedBytes ||
        encodedBytes + frame.gzip.length > this.limits.seedEncodedBytes
      ) break;
      frames.push(frame);
      previous = frame;
      decodedBytes += frame.decodedBytes;
      encodedBytes += frame.gzip.length;
    }
    return frames.reverse();
  }

  close(): void {
    this.reset();
  }

  private evictFirst(): void {
    this.bytes -= this.frames.shift()!.gzip.length;
  }

  private reset(): void {
    this.generation = randomUUID();
    this.frames = [];
    this.bytes = 0;
    if (this.expiry !== null) clearTimeout(this.expiry);
    this.expiry = null;
  }

  private prune(now: number): void {
    if (now < this.lastClock) this.reset();
    this.lastClock = now;
    while (this.frames[0] && this.frames[0].capturedAt < now - HISTORY_WINDOW_MS) this.evictFirst();
  }

  private scheduleExpiry(): void {
    if (this.expiry !== null) clearTimeout(this.expiry);
    const oldest = this.frames[0];
    if (!oldest) {
      this.expiry = null;
      return;
    }
    this.expiry = setTimeout(() => {
      this.prune(this.now());
      this.scheduleExpiry();
    }, Math.max(1, oldest.capturedAt + HISTORY_WINDOW_MS + 1 - this.lastClock));
    this.expiry.unref();
  }
}
