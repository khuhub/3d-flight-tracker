import {
  decodeRoute,
  fromWire,
  nextTrack,
  type Aircraft,
  type FlightMode,
  type MotionTrack,
  type SnapshotMessage,
} from '@flight/shared';
import type { DisplayRoute } from '../globe/routeLayer';
import { TrailHistory } from './trailHistory';

export type StoreMode = FlightMode | 'synthetic';
export type ApplyResult = 'applied' | 'duplicate' | 'reset';

/**
 * Client-side flight state: current motion tracks (one per displayed aircraft) and each
 * aircraft's scheduled airport route, when known. Time is kept on the server's clock so
 * replayed timestamps line up with extrapolation.
 */
export class FlightStore {
  tracks: MotionTrack[] = [];
  readonly trailHistory = new TrailHistory();
  /** icao24 -> scheduled route, only for displayed aircraft with a known, plausible route. */
  routes = new Map<string, DisplayRoute>();
  /** Incremented whenever any displayed aircraft's route changes. */
  routesVersion = 0;
  mode: StoreMode | null = null;
  replayEpoch: number | null = null;
  lastSnapshotTime: number | null = null;
  lastSequence: number | null = null;
  clockOffsetMs = 0;
  /** Incremented whenever the set of tracks changes. */
  version = 0;
  private index = new Map<string, MotionTrack>();

  constructor(private readonly nowMs: () => number = Date.now) {}

  /** Current time in unix seconds on the server's clock. */
  now(): number {
    return (this.nowMs() + this.clockOffsetMs) / 1000;
  }

  syncClock(serverNowMs: number): void {
    this.clockOffsetMs = serverNowMs - this.nowMs();
  }

  get(icao24: string): MotionTrack | undefined {
    return this.index.get(icao24);
  }

  applySnapshot(msg: SnapshotMessage): ApplyResult {
    this.syncClock(msg.serverNow);
    if (
      this.mode === msg.mode &&
      this.lastSequence === msg.sequence &&
      this.replayEpoch === msg.replayEpoch &&
      this.lastSnapshotTime === msg.time
    ) {
      return 'duplicate';
    }
    // A new replay loop, a mode switch or time running backwards means the previous
    // positions no longer belong to the incoming data, so gliding from them would be wrong.
    const reset =
      this.mode !== null &&
      (this.mode !== msg.mode ||
        this.replayEpoch !== msg.replayEpoch ||
        (this.lastSnapshotTime !== null && msg.time < this.lastSnapshotTime));
    if (reset) this.clear();
    this.mode = msg.mode;
    this.replayEpoch = msg.replayEpoch;
    this.lastSequence = msg.sequence;
    const routes = new Map<string, DisplayRoute>();
    const decoded = new Map<string, DisplayRoute | null>();
    for (const w of msg.aircraft) {
      const codes = w[11];
      if (!codes) continue;
      let r = decoded.get(codes);
      if (r === undefined) {
        const route = decodeRoute(codes, msg.airports ?? {});
        r = route ? { codes, route } : null;
        decoded.set(codes, r);
      }
      if (r) routes.set(w[0], r);
    }
    this.setAircraft(msg.aircraft.map(fromWire), msg.time, routes);
    return reset ? 'reset' : 'applied';
  }

  /** Replaces the displayed fleet and its routes; aircraft absent from `aircraft` stop being drawn. */
  setAircraft(aircraft: Aircraft[], snapshotTime: number, routes: Map<string, DisplayRoute> = new Map()): void {
    const now = this.now();
    const tracks: MotionTrack[] = new Array<MotionTrack>(aircraft.length);
    const index = new Map<string, MotionTrack>();
    for (let i = 0; i < aircraft.length; i++) {
      const a = aircraft[i]!;
      const track = nextTrack(this.index.get(a.icao24), a, now);
      tracks[i] = track;
      index.set(a.icao24, track);
    }
    this.tracks = tracks;
    this.trailHistory.replace(tracks, now);
    this.index = index;
    this.lastSnapshotTime = snapshotTime;
    if (!sameRoutes(this.routes, routes)) {
      this.routes = routes;
      this.routesVersion++;
    }
    this.version++;
  }

  clear(): void {
    this.tracks = [];
    this.trailHistory.clear();
    this.index = new Map();
    this.routes = new Map();
    this.routesVersion++;
    this.lastSnapshotTime = null;
    this.version++;
  }
}

function sameRoutes(a: ReadonlyMap<string, DisplayRoute>, b: ReadonlyMap<string, DisplayRoute>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, r] of a) if (b.get(id)?.codes !== r.codes) return false;
  return true;
}
