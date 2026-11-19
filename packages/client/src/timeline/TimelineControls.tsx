import { useSyncExternalStore } from 'react';
import { PLAYBACK_SPEEDS, type TimelineController } from './TimelineController';
import './timeline.css';

const utcClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function TimelineControls({ timeline }: { timeline: TimelineController }) {
  const { phase, oldest, liveAt, presentedAt, target, notice, speed } =
    useSyncExternalStore(timeline.subscribe, timeline.getView);
  const displayAt = target ?? presentedAt;
  const loading = target !== null;
  const available = oldest !== null;
  const availableFrom = oldest ?? liveAt;
  const edge = Math.max(availableFrom, liveAt);
  const utc = `${utcClock.format(displayAt)} UTC`;

  return (
    <section className="flight-timeline" aria-label="Flight timeline">
      <div className="flight-timeline-header">
        <span className="flight-timeline-label">Flight timeline · last hour</span>
        <span className="flight-timeline-state" role="status">
          {notice ?? (loading ? 'Loading history…' : !available ? 'Waiting for history' :
            phase === 'live' ? 'At live edge' : phase === 'playing' ? 'Playing history' : 'Paused')}
        </span>
      </div>
      <div className="flight-timeline-track">
        <input
          type="range"
          aria-label="Flight timeline time"
          aria-valuetext={utc}
          min={availableFrom}
          max={edge}
          step={1}
          value={Math.min(edge, Math.max(availableFrom, displayAt))}
          disabled={!available || edge <= availableFrom}
          onChange={(event) => timeline.seek(event.currentTarget.valueAsNumber)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            const direction = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1;
            timeline.seek(displayAt + direction * (event.shiftKey ? 60_000 : 1_000));
          }}
        />
        <time dateTime={new Date(displayAt).toISOString()}>{utc}</time>
      </div>
      <div className="flight-timeline-actions">
        <button
          type="button"
          onClick={() => phase === 'paused' ? timeline.play() : timeline.pause()}
          disabled={!available || loading}
        >
          {phase === 'paused' ? 'Play' : 'Pause'}
        </button>
        <select
          aria-label="Playback speed"
          value={speed}
          disabled={!available}
          onChange={(event) => {
            const selected = PLAYBACK_SPEEDS.find((choice) => choice === Number(event.currentTarget.value));
            if (selected) timeline.setSpeed(selected);
          }}
        >
          {PLAYBACK_SPEEDS.map((choice) => <option key={choice} value={choice}>{choice}×</option>)}
        </select>
        <button type="button" disabled={phase === 'live' && !loading} onClick={() => timeline.goLive()}>
          Go live
        </button>
        {available && <span className="flight-timeline-earliest">From {utcClock.format(availableFrom)} UTC</span>}
      </div>
    </section>
  );
}
