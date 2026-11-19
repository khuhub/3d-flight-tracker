import type { HistoryFrame, HistoryIndex, SnapshotMessage } from '@flight/shared';
import { FlightStore } from '../data/flightStore';
import { historyClient } from './historyClient';

export const PLAYBACK_SPEEDS = [1, 4, 16] as const;
type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];
type Phase = 'live' | 'paused' | 'playing';

export interface TimelineView {
  phase: Phase;
  speed: PlaybackSpeed;
  oldest: number | null;
  liveAt: number;
  presentedAt: number;
  target: number | null;
  notice: string | null;
}

const PREFETCH_MS = 3_000;
const HISTORY_POLL_MS = 5_000;
const SEEK_DELAY_MS = 150;

/** A separate historical source leaves the live store and its observers ingesting normally. */
export class TimelineController {
  private readonly listeners = new Set<() => void>();
  private readonly historical = new FlightStore();
  private phase: Phase = 'live';
  private speed: PlaybackSpeed = 1;
  private index: HistoryIndex | null = null;
  private generation: string | null = null;
  private cursor = 0;
  private playStartedAt = 0;
  private presentedSnapshotAt: number | null = null;
  private target: number | null = null;
  private notice: string | null = null;
  private next: HistoryFrame | undefined;
  private prefetched: SnapshotMessage | null = null;
  private seekDelay: ReturnType<typeof setTimeout> | null = null;
  private seekRequest: AbortController | null = null;
  private frameRequest: AbortController | null = null;
  private indexRequest: AbortController | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private playTimer: ReturnType<typeof setInterval> | null = null;
  private statusClockAt: number | null = null;
  private view: TimelineView;

  constructor(
    private readonly live: FlightStore,
    private readonly onPresented: (store: FlightStore) => void,
    private readonly api: typeof historyClient = historyClient,
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {
    this.historical.setPresentationClock(() => this.position() / 1000);
    this.view = this.readView();
  }

  get store(): FlightStore {
    return this.phase === 'live' ? this.live : this.historical;
  }

  get lastUpdateAt(): number | null {
    return this.presentedSnapshotAt;
  }

  historyActive = (): boolean => this.phase !== 'live';
  getView = (): TimelineView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): () => void {
    void this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), HISTORY_POLL_MS);
    let lastPaint = 0;
    this.playTimer = setInterval(() => {
      if (this.phase === 'playing') this.advance();
      const now = this.monotonicNow();
      if (now - lastPaint >= (this.phase === 'playing' ? 250 : 1000)) {
        lastPaint = now;
        this.emit();
      }
    }, 100);
    return () => {
      if (this.pollTimer !== null) clearInterval(this.pollTimer);
      if (this.playTimer !== null) clearInterval(this.playTimer);
      this.indexRequest?.abort();
      this.indexRequest = null;
      this.cancelSeek();
      this.cancelPrefetch();
    };
  }

  ingest(message: SnapshotMessage): void {
    const result = this.live.applySnapshot(message);
    // New SSE connections get a fresh status followed by the last cached snapshot.
    // Keep the fresh wall clock so that a sparse live or replay stream doesn't jump back.
    if (this.statusClockAt !== null) this.live.syncClock(Math.max(this.statusClockAt, message.serverNow));
    if (this.phase === 'live' && result !== 'duplicate') this.onPresented(this.live);
    if (this.index?.frames.length === 0 || this.index === null) void this.refresh();
  }

  syncLiveClock(serverNow: number): void {
    this.statusClockAt = serverNow;
    this.live.syncClock(serverNow);
  }

  seek(at: number): void {
    this.requestSeek(at, SEEK_DELAY_MS);
  }

  private requestSeek(at: number, delay: number): void {
    const oldest = this.index?.frames[0]?.capturedAt;
    const generation = this.index?.generation;
    if (oldest === undefined || !generation) return;
    if (this.phase === 'playing') this.pause();
    this.cancelSeek();
    this.cancelPrefetch();
    const target = Math.round(Math.max(oldest, Math.min(at, this.liveAt())));
    this.target = target;
    this.notice = null;
    if (delay === 0) void this.loadSeek(generation, target);
    else this.seekDelay = setTimeout(() => void this.loadSeek(generation, target), delay);
    this.emit();
  }

  pause(): void {
    if (this.phase === 'live') {
      this.requestSeek(this.liveAt(), 0);
    } else if (this.phase === 'playing') {
      this.cursor = this.position();
      this.phase = 'paused';
      this.emit();
    }
  }

  play(): void {
    if (this.phase !== 'paused' || this.target !== null) return;
    this.notice = null;
    this.playStartedAt = this.monotonicNow();
    this.phase = 'playing';
    this.emit();
    this.advance();
  }

  setSpeed(speed: PlaybackSpeed): void {
    if (this.phase === 'playing') {
      this.cursor = this.position();
      this.playStartedAt = this.monotonicNow();
    }
    this.speed = speed;
    this.emit();
  }

  goLive(notice: string | null = null): void {
    const switched = this.phase !== 'live';
    this.cancelSeek();
    this.cancelPrefetch();
    this.phase = 'live';
    this.generation = null;
    this.presentedSnapshotAt = null;
    this.next = undefined;
    this.notice = notice;
    if (switched) {
      this.historical.clear();
      this.onPresented(this.live);
    }
    this.emit();
  }

  private async refresh(): Promise<void> {
    if (this.indexRequest !== null) return;
    const request = (this.indexRequest = new AbortController());
    try {
      const index = await this.api.index(request.signal);
      if (this.indexRequest !== request) return;
      if (this.index === null) this.notice = null;
      this.index = index;
      if (this.phase !== 'live') {
        const oldest = index.frames[0];
        if (this.generation !== index.generation || !oldest || oldest.sequence > (this.historical.lastSequence ?? 0)) {
          this.goLive('That time is no longer in flight history.');
          return;
        }
        this.updateNext();
      }
      this.emit();
    } catch {
      if (this.indexRequest === request && this.index === null) {
        this.notice = 'Could not load flight history.';
        this.emit();
      }
    } finally {
      if (this.indexRequest === request) this.indexRequest = null;
    }
  }

  private async loadSeek(generation: string, at: number): Promise<void> {
    this.seekDelay = null;
    const request = (this.seekRequest = new AbortController());
    try {
      const seed = await this.api.seek(generation, at, request.signal);
      if (this.seekRequest !== request) return;
      const selected = seed.at(-1);
      if (!selected || this.index?.generation !== generation) throw new Error('That time is no longer in flight history.');
      this.cancelPrefetch();
      this.generation = generation;
      this.phase = 'paused';
      this.historical.clear();
      // Apply once in temporal order so observers of setAircraft (including trails)
      // get their own sample time and never seed across a replay clock reset.
      for (const message of seed) {
        this.cursor = message.serverNow;
        this.historical.applySnapshot(message);
      }
      this.cursor = Math.max(at, selected.serverNow);
      this.presentedSnapshotAt = selected.serverNow;
      this.updateNext();
      this.onPresented(this.historical);
    } catch (error) {
      if (this.seekRequest !== request) return;
      this.notice = error instanceof Error ? error.message : 'Could not load flight history.';
      void this.refresh();
    } finally {
      if (this.seekRequest === request) {
        this.seekRequest = null;
        this.target = null;
        this.emit();
      }
    }
  }

  private position(): number {
    if (this.phase !== 'playing') return this.cursor;
    const elapsed = (this.monotonicNow() - this.playStartedAt) * this.speed;
    const limit = Math.min(this.next?.capturedAt ?? Infinity, this.index?.serverNow ?? this.cursor);
    return Math.max(this.cursor, Math.min(this.cursor + elapsed, limit));
  }

  private advance(): void {
    const next = this.next;
    const position = this.position();
    if (next) {
      if (this.prefetched && position >= next.capturedAt) {
        const message = this.prefetched;
        this.prefetched = null;
        this.cursor = next.capturedAt;
        this.playStartedAt = this.monotonicNow();
        this.historical.applySnapshot(message);
        this.presentedSnapshotAt = message.serverNow;
        this.updateNext();
        this.onPresented(this.historical);
      } else if (this.generation && !this.prefetched && !this.frameRequest && next.capturedAt - position <= PREFETCH_MS * this.speed) {
        void this.prefetch(this.generation, next.sequence);
      }
    } else if (this.historical.lastSequence === this.live.lastSequence && this.liveAt() - position < 500) {
      this.goLive();
    }
  }

  private async prefetch(generation: string, sequence: number): Promise<void> {
    const request = (this.frameRequest = new AbortController());
    try {
      const message = await this.api.frame(generation, sequence, request.signal);
      if (this.frameRequest === request) this.prefetched = message;
    } catch (error) {
      if (this.frameRequest !== request) return;
      this.pause();
      this.notice = error instanceof Error ? error.message : 'Could not load flight history.';
      this.emit();
      void this.refresh();
    } finally {
      if (this.frameRequest === request) this.frameRequest = null;
    }
  }

  private updateNext(): void {
    this.next = this.index?.frames.find(({ sequence }) => sequence > (this.historical.lastSequence ?? 0));
  }

  private cancelSeek(): void {
    if (this.seekDelay !== null) clearTimeout(this.seekDelay);
    this.seekDelay = null;
    this.seekRequest?.abort();
    this.seekRequest = null;
    this.target = null;
  }

  private cancelPrefetch(): void {
    this.frameRequest?.abort();
    this.frameRequest = null;
    this.prefetched = null;
  }

  private liveAt(): number {
    return this.live.now() * 1000;
  }

  private readView(): TimelineView {
    return {
      phase: this.phase,
      oldest: this.index?.frames[0]?.capturedAt ?? null,
      speed: this.speed,
      liveAt: Math.round(this.liveAt()),
      presentedAt: Math.round(this.phase === 'live' ? this.liveAt() : this.position()),
      target: this.target,
      notice: this.notice,
    };
  }

  private emit(): void {
    this.view = this.readView();
    for (const listener of this.listeners) listener();
  }
}
