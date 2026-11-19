import { useEffect, useRef, useState } from 'react';
import type { StatusMessage } from '@flight/shared';
import { DEFAULT_FLIGHT_FILTERS, type FlightFilters } from './data/flightFilters';
import { FlightStore } from './data/flightStore';
import { connectStream, type ConnectionState } from './data/stream';
import { installDebugApi } from './debug';
import { GlobeView } from './globe/GlobeView';
import { DetailsPanel } from './components/DetailsPanel';
import { FlightFilterPanel } from './components/FlightFilterPanel';
import { Legend } from './components/Legend';
import { StatusBar } from './components/StatusBar';
import { advanceSyntheticFleet, createSyntheticFleet, syntheticRoutes } from './stress/syntheticFleet';

function stressCount(): number | null {
  const raw = new URLSearchParams(window.location.search).get('stress');
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 100_000) : 12_000;
}

export function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<GlobeView | null>(null);
  const selectedRef = useRef<string | null>(null);
  const [store] = useState(() => new FlightStore());
  const [stress] = useState(stressCount);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [filters, setFilters] = useState(DEFAULT_FLIGHT_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const view = new GlobeView(container, store, setSelectedId);
    viewRef.current = view;
    const extras: Parameters<typeof installDebugApi>[3] = {};
    let cleanup = (): void => {};

    if (stress !== null) {
      let now = store.now();
      let fleet = createSyntheticFleet(stress, now);
      store.mode = 'synthetic';
      store.setAircraft(fleet, now, syntheticRoutes(fleet));
      extras.stressAdvance = (seconds: number) => {
        store.clockOffsetMs += seconds * 1000;
        now = store.now();
        const t0 = performance.now();
        fleet = advanceSyntheticFleet(fleet, now);
        store.setAircraft(fleet, now, store.routes);
        const applyMs = performance.now() - t0;
        setDataVersion(store.version);
        return { applyMs };
      };
      queueMicrotask(() => setDataVersion(store.version));
    } else {
      cleanup = connectStream('/api/stream', {
        onSnapshot: (message) => {
          store.applySnapshot(message);
          setDataVersion(store.version);
        },
        onStatus: (message) => {
          store.syncClock(message.serverNow);
          setStatus(message);
        },
        onConnection: setConnection,
      });
    }
    const uninstall = installDebugApi(view, store, () => selectedRef.current, extras);
    return () => {
      cleanup();
      uninstall();
      view.dispose();
      viewRef.current = null;
    };
  }, [store, stress]);

  useEffect(() => {
    selectedRef.current = selectedId;
    viewRef.current?.setSelected(selectedId);
  }, [selectedId]);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const selectedTrack = selectedId ? store.get(selectedId) : undefined;
  // A hidden aircraft is not lost. Clear the selection rather than restoring it on reset.
  if (selectedId && !selectedTrack && store.getRaw(selectedId)) setSelectedId(null);
  const nowS = store.now();

  function changeFilters(next: FlightFilters) {
    store.setFilters(next);
    setFilters(next);
    setDataVersion(store.version);
  }

  return (
    <div className="app">
      <div className="globe" ref={containerRef} />
      <header className="title">
        <h1>Flight Tracker</h1>
        <p className="hint">Drag to rotate · Scroll to zoom · Click an aircraft for details</p>
      </header>
      <div className="flight-filter-stack">
        <FlightFilterPanel filters={filters} onChange={changeFilters} allTracks={store.allTracks} visibleCount={store.tracks.length} />
        <Legend routeCount={store.visibleRouteCount} aircraftCount={store.tracks.length} />
      </div>
      {selectedTrack && (
        <DetailsPanel
          key={`${selectedTrack.aircraft.icao24}-${dataVersion}`}
          aircraft={selectedTrack.aircraft}
          now={nowS}
          route={store.routes.get(selectedTrack.aircraft.icao24)?.route}
          onClose={() => setSelectedId(null)}
        />
      )}
      {selectedId && !selectedTrack && (
        <div className="details lost" role="status">
          <p>{selectedId} is no longer reported.</p>
          <button type="button" onClick={() => setSelectedId(null)}>
            Dismiss
          </button>
        </div>
      )}
      <StatusBar
        mode={stress !== null ? 'synthetic' : (status?.mode ?? store.mode)}
        connection={stress !== null ? 'open' : connection}
        status={status}
        aircraftCount={store.tracks.length}
        nowMs={nowS * 1000}
        lastUpdateMs={stress !== null ? null : (status?.lastSuccessAt ?? null)}
      />
      <footer className="attribution">
        Flight data: <a href="https://opensky-network.org" target="_blank" rel="noreferrer">The OpenSky Network</a> · Map:
        Natural Earth
        {' · Routes: '}
        <a href="https://github.com/vradarserver/standing-data" target="_blank" rel="noreferrer">
          VRS standing data
        </a>
      </footer>
    </div>
  );
}
