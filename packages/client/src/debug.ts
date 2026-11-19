import { vectorToLatLon } from '@flight/shared';
import type { FlightStore } from './data/flightStore';
import type { FrameStats, GlobeView } from './globe/GlobeView';

export interface DebugStats {
  aircraft: number;
  instanceCapacity: number;
  drawCalls: number;
  routeSegments: number;
  routes: number;
  selectedSegments: number;
  routeBufferBytes: number;
  fleetTrailSegments: number;
  selectedTrailSegments: number;
  trailBufferBytes: number;
  lastRouteRebuildMs: number;
  routesVersion: number;
  snapshotSequence: number | null;
  aircraftVisible: boolean;
  mode: string | null;
  replayEpoch: number | null;
  selected: string | null;
  jsHeapBytes: number | null;
}

export interface VisibleAircraft {
  index: number;
  icao24: string;
  lat: number;
  lon: number;
  x: number;
  y: number;
}

/** Read-mostly inspection hooks used by the Playwright e2e and performance tests. */
export interface FlightTrackerDebugApi {
  stats(): DebugStats;
  frameStats(): FrameStats;
  resetFrameStats(): void;
  visibleAircraft(limit?: number): VisibleAircraft[];
  aircraft(icao24: string): VisibleAircraft | null;
  setAutoRotate(enabled: boolean): void;
  lookAt(lat: number, lon: number, distance?: number): void;
  setAircraftVisible(visible: boolean): void;
  setRoutesVisible(visible: boolean): void;
  /** Synthetic stress mode only: jump the clock forward and apply a new synthetic snapshot. */
  stressAdvance?(seconds: number): { applyMs: number };
}

declare global {
  interface Window {
    __flightTracker?: FlightTrackerDebugApi;
  }
}

export function installDebugApi(
  view: GlobeView,
  store: FlightStore,
  getSelected: () => string | null,
  extras: Partial<FlightTrackerDebugApi> = {},
): () => void {
  const describe = (index: number): VisibleAircraft | null => {
    const track = store.tracks[index];
    const screen = view.screenPosition(index);
    if (!track || !screen) return null;
    const p = view.aircraft.positions;
    const ll = vectorToLatLon(p[index * 3]!, p[index * 3 + 1]!, p[index * 3 + 2]!);
    return { index, icao24: track.aircraft.icao24, lat: ll.lat, lon: ll.lon, ...screen };
  };

  const api: FlightTrackerDebugApi = {
    stats: () => {
      const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
      return {
        aircraft: view.aircraft.count,
        instanceCapacity: view.aircraft.capacity,
        drawCalls: view.drawCalls,
        routeSegments: view.routes.segments,
        routes: view.routes.routeCount,
        selectedSegments: view.routes.selectedSegments,
        routeBufferBytes: view.routes.gpuBytes(),
        fleetTrailSegments: view.trails.fleetSegments,
        selectedTrailSegments: view.trails.selectedSegments,
        trailBufferBytes: view.trails.gpuBytes(),
        lastRouteRebuildMs: view.routes.lastRebuildMs,
        routesVersion: store.routesVersion,
        snapshotSequence: store.lastSequence,
        aircraftVisible: view.aircraft.mesh.visible,
        mode: store.mode,
        replayEpoch: store.replayEpoch,
        selected: getSelected(),
        jsHeapBytes: memory?.usedJSHeapSize ?? null,
      };
    },
    frameStats: () => view.frameStats(),
    resetFrameStats: () => view.resetFrameStats(),
    visibleAircraft: (limit = 50) => {
      const out: VisibleAircraft[] = [];
      for (let i = 0; i < view.aircraft.count && out.length < limit; i++) {
        const d = describe(i);
        if (d) out.push(d);
      }
      return out;
    },
    aircraft: (icao24) => {
      const index = store.tracks.findIndex((t) => t.aircraft.icao24 === icao24);
      return index >= 0 ? describe(index) : null;
    },
    setAutoRotate: (enabled) => {
      view.autoRotate = enabled;
    },
    lookAt: (lat, lon, distance) => view.lookAt(lat, lon, distance),
    setAircraftVisible: (visible) => {
      view.aircraft.mesh.visible = visible;
    },
    setRoutesVisible: (visible) => {
      view.routes.group.visible = visible;
    },
    ...extras,
  };
  window.__flightTracker = api;
  return () => {
    if (window.__flightTracker === api) delete window.__flightTracker;
  };
}
