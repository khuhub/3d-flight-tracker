import { useEffect, useState, useSyncExternalStore } from 'react';
import type { StatusMessage } from '@flight/shared';
import type { FlightStore } from '../data/flightStore';
import { connectStream, type ConnectionState } from '../data/stream';
import { TimelineController } from './TimelineController';

export function useTimeline(live: FlightStore, enabled: boolean, onPresented: (store: FlightStore) => void) {
  const [controller] = useState(() => new TimelineController(live, onPresented));
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const historyActive = useSyncExternalStore(controller.subscribe, controller.historyActive);

  useEffect(() => {
    if (!enabled) return;
    const stop = controller.start();
    const disconnect = connectStream('/api/stream', {
      onSnapshot: (message) => controller.ingest(message),
      onStatus: (message) => {
        controller.syncLiveClock(message.serverNow);
        setStatus(message);
      },
      onConnection: setConnection,
    });
    return () => {
      disconnect();
      stop();
    };
  }, [controller, enabled]);

  return { controller, store: controller.store, historyActive, status, connection };
}
