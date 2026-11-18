import type { SnapshotMessage, StatusMessage } from '@flight/shared';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting';

export interface StreamHandlers {
  onSnapshot: (message: SnapshotMessage) => void;
  onStatus: (message: StatusMessage) => void;
  onConnection: (state: ConnectionState) => void;
}

/**
 * Subscribes to the backend's SSE stream. EventSource retries dropped connections by
 * itself; when it gives up (for example after an HTTP error) we reopen it after a delay.
 */
export function connectStream(url: string, handlers: StreamHandlers, retryMs = 5000): () => void {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const open = (): void => {
    source = new EventSource(url);
    source.onopen = () => handlers.onConnection('open');
    source.onerror = () => {
      handlers.onConnection('reconnecting');
      if (source?.readyState === EventSource.CLOSED && !closed) {
        source.close();
        timer = setTimeout(open, retryMs);
      }
    };
    source.addEventListener('snapshot', (e) => handlers.onSnapshot(JSON.parse((e as MessageEvent<string>).data) as SnapshotMessage));
    source.addEventListener('status', (e) => handlers.onStatus(JSON.parse((e as MessageEvent<string>).data) as StatusMessage));
  };

  handlers.onConnection('connecting');
  open();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    source?.close();
  };
}
