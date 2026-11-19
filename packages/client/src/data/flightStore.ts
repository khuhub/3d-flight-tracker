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
import { DEFAULT_FLIGHT_FILTERS, matchesFilters, sameFilters, type FlightFilters } from './flightFilters';

export type StoreMode = FlightMode | 'synthetic';
export type ApplyResult = 'applied' | 'duplicate' | 'reset';

/**
 * Client-side flight state: current motion tracks (one per displayed aircraft) and each
 * aircraft's scheduled airport route, when known. Time is kept on the server's clock so
 * replayed timestamps line up with extrapolation.
 */
export class FlightStore {
  /** Filtered fleet, in rendering and picking order. */
  tracks: MotionTrack[] = [];
  /** Full snapshot fleet, including hidden aircraft; filters never interrupt their motion. */
  allTracks: MotionTrack[] = [];
  /** icao24 -> scheduled route for the full snapshot, including filtered-out aircraft. */
  routes = new Map<string, DisplayRoute>();
  visibleRouteCount = 0;
  /** Incremented whenever any aircraft's route changes. */
  routesVersion = 0;
  mode: StoreMode | null = null;
  replayEpoch: number | null = null;
  lastSnapshotTime: number | null = null;
  lastSequence: number | null = null;
  clockOffsetMs = 0;
  /** Incremented whenever snapshot or filter state changes. */
  version = 0;
  private index = new Map<string, MotionTrack>();
  private visibleIndex = this.index;
  private currentFilters = DEFAULT_FLIGHT_FILTERS;

  constructor(private readonly nowMs: () => number = Date.now) {}

  /** Current time in unix seconds on the server's clock. */
  now(): number {
    return (this.nowMs() + this.clockOffsetMs) / 1000;
  }

  syncClock(serverNowMs: number): void {
    this.clockOffsetMs = serverNowMs - this.nowMs();
  }

  get(icao24: string): MotionTrack | undefined {
    return this.visibleIndex.get(icao24);
  }

  getRaw(icao24: string): MotionTrack | undefined {
    return this.index.get(icao24);
  }

  get filters(): FlightFilters {
    return this.currentFilters;
  }

  setFilters(filters: FlightFilters): void {
    if (sameFilters(this.currentFilters, filters)) return;
    this.currentFilters = { ...filters };
    this.updateVisibleFleet();
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

  /** Replaces the full fleet and its routes, then reapplies visibility filters. */
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
    this.allTracks = tracks;
    this.index = index;
    this.lastSnapshotTime = snapshotTime;
    if (!sameRoutes(this.routes, routes)) {
      this.routes = routes;
      this.routesVersion++;
    }
    this.updateVisibleFleet();
  }

  clear(): void {
    this.allTracks = [];
    this.index = new Map();
    this.routes = new Map();
    this.routesVersion++;
    this.lastSnapshotTime = null;
    this.updateVisibleFleet();
  }

  private updateVisibleFleet(): void {
    let routeCount = 0;
    if (sameFilters(this.currentFilters, DEFAULT_FLIGHT_FILTERS)) {
      this.tracks = this.allTracks;
      this.visibleIndex = this.index;
      for (const id of this.routes.keys()) if (this.index.has(id)) routeCount++;
    } else {
      const tracks: MotionTrack[] = [];
      const index = new Map<string, MotionTrack>();
      for (const track of this.allTracks) {
        const id = track.aircraft.icao24;
        const knownRoute = this.routes.has(id);
        if (!matchesFilters(track.aircraft, knownRoute, this.currentFilters)) continue;
        tracks.push(track);
        index.set(id, track);
        if (knownRoute) routeCount++;
      }
      this.tracks = tracks;
      this.visibleIndex = index;
    }
    this.visibleRouteCount = routeCount;
    this.version++;
  }
}

function sameRoutes(a: ReadonlyMap<string, DisplayRoute>, b: ReadonlyMap<string, DisplayRoute>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, r] of a) if (b.get(id)?.codes !== r.codes) return false;
  return true;
}
