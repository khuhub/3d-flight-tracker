import { useCallback, useEffect, useRef, useState } from 'react';
import { FlightStore } from './data/flightStore';
import { installDebugApi } from './debug';
import { GlobeView } from './globe/GlobeView';
import { DetailsPanel } from './components/DetailsPanel';
import { Legend } from './components/Legend';
import { StatusBar } from './components/StatusBar';
import { advanceSyntheticFleet, createSyntheticFleet, syntheticRoutes } from './stress/syntheticFleet';
import { TimelineControls } from './timeline/TimelineControls';
import { useTimeline } from './timeline/useTimeline';

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
  const [liveStore] = useState(() => new FlightStore());
  const [stress] = useState(stressCount);
  const [dataVersion, setDataVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const onPresented = useCallback((store: FlightStore) => {
    viewRef.current?.setStore(store);
    setDataVersion((version) => version + 1);
  }, []);
  const { controller, store, historyActive, status, connection } = useTimeline(liveStore, stress === null, onPresented);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const store = liveStore;
    const view = new GlobeView(container, store, setSelectedId);
    viewRef.current = view;
    const extras: Parameters<typeof installDebugApi>[3] = {};

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
    }
    const uninstall = installDebugApi(view, () => view.getStore(), () => selectedRef.current, extras);
    return () => {
      uninstall();
      view.dispose();
      viewRef.current = null;
    };
  }, [liveStore, stress]);

  useEffect(() => {
    selectedRef.current = selectedId;
    viewRef.current?.setSelected(selectedId);
  }, [selectedId]);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const selectedTrack = selectedId ? store.get(selectedId) : undefined;
  const nowS = store.now();

  return (
    <div className="app">
      <div className="globe" ref={containerRef} />
      <header className="title">
        <h1>Flight Tracker</h1>
        <p className="hint">Drag to rotate · Scroll to zoom · Click an aircraft for details</p>
      </header>
      <Legend routeCount={store.routes.size} aircraftCount={store.tracks.length} />
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
        mode={stress !== null ? 'synthetic' : historyActive ? store.mode : (status?.mode ?? store.mode)}
        connection={stress !== null ? 'open' : connection}
        status={historyActive ? null : status}
        aircraftCount={store.tracks.length}
        nowMs={nowS * 1000}
        lastUpdateMs={stress !== null ? null : historyActive ? controller.lastUpdateAt : (status?.lastSuccessAt ?? null)}
      />
      {stress === null && <TimelineControls timeline={controller} />}
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
