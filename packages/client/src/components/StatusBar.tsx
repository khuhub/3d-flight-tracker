import type { StatusMessage } from '@flight/shared';
import type { ConnectionState } from '../data/stream';
import type { StoreMode } from '../data/flightStore';

interface Props {
  mode: StoreMode | null;
  connection: ConnectionState;
  status: StatusMessage | null;
  aircraftCount: number;
  nowMs: number;
  lastUpdateMs: number | null;
}

const MODE_LABEL: Record<StoreMode, string> = {
  live: 'Live · OpenSky',
  replay: 'Replay · recorded OpenSky data',
  synthetic: 'Synthetic stress test · not real data',
};

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  open: 'Connected',
  reconnecting: 'Reconnecting…',
};

export function formatAgo(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s ago`;
  return `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

export function StatusBar({ mode, connection, status, aircraftCount, nowMs, lastUpdateMs }: Props) {
  const upstreamProblem = status && (status.upstream === 'error' || status.upstream === 'rate-limited');
  const retryIn = status?.nextUpdateAt ? Math.max(0, Math.round((status.nextUpdateAt - nowMs) / 1000)) : null;
  return (
    <div className="status-bar" role="status" aria-live="polite" data-testid="status-bar">
      <span className={`pill mode-${mode ?? 'unknown'}`} data-testid="status-mode">
        {mode ? MODE_LABEL[mode] : 'Waiting for data'}
      </span>
      <span data-testid="status-count">
        <strong>{aircraftCount.toLocaleString()}</strong> aircraft
      </span>
      <span className={`connection connection-${connection}`} data-testid="status-connection">
        <span className="dot" aria-hidden="true" />
        {CONNECTION_LABEL[connection]}
      </span>
      <span data-testid="status-updated">
        {lastUpdateMs === null ? (mode === 'synthetic' ? 'Generated locally' : 'No update yet') : `Updated ${formatAgo((nowMs - lastUpdateMs) / 1000)}`}
      </span>
      {upstreamProblem && (
        <span className="warning" data-testid="status-upstream">
          {status.upstream === 'rate-limited' ? 'OpenSky rate limit reached' : 'OpenSky unavailable'}
          {retryIn !== null ? ` · retrying in ${formatAgo(retryIn).replace(' ago', '')}` : ''} · showing last data
        </span>
      )}
    </div>
  );
}
