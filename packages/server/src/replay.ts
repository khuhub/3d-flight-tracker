import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOpenSkyStates, type Snapshot } from '@flight/shared';
import type { SnapshotHub } from './hub';

export interface Recording {
  file: string;
  snapshot: Snapshot;
}

/**
 * Loads recorded `/states/all` responses from a directory. Accepts the recorder's
 * wrapper format or a raw OpenSky response. Sorted by snapshot time.
 */
export function loadRecordings(dir: string, warn: (message: string) => void = () => {}): Recording[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    throw new Error(`Replay directory not found: ${dir}`);
  }
  const recordings: Recording[] = [];
  for (const name of names.sort()) {
    const file = join(dir, name);
    try {
      const json = JSON.parse(readFileSync(file, 'utf8')) as { response?: unknown };
      const body = typeof json === 'object' && json !== null && 'response' in json ? json.response : json;
      recordings.push({ file, snapshot: parseOpenSkyStates(body).snapshot });
    } catch (err) {
      warn(`Skipping ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (recordings.length === 0) throw new Error(`No usable recordings in ${dir}`);
  recordings.sort((a, b) => a.snapshot.time - b.snapshot.time);
  return recordings;
}

/** Shifts every timestamp in a snapshot by `offsetS` seconds. */
export function shiftSnapshot(snapshot: Snapshot, offsetS: number): Snapshot {
  return {
    time: snapshot.time + offsetS,
    aircraft: snapshot.aircraft.map((a) => ({
      ...a,
      timePosition: a.timePosition + offsetS,
      lastContact: a.lastContact + offsetS,
    })),
  };
}

export interface ReplayOptions {
  recordings: Recording[];
  hub: SnapshotHub;
  /** Pause after the final snapshot before looping; defaults to the median recording spacing. */
  loopGapS?: number | null;
  now?: () => number;
}

/**
 * Replays recordings in real time on a replay clock: the first recording is mapped to
 * "now" and later ones are emitted after their recorded spacing. When the recording is
 * exhausted, the replay epoch increments and the loop starts again on a fresh clock so
 * clients can reset their motion state.
 */
export class ReplaySource {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private index = 0;
  private epoch = 0;
  private offsetS = 0;
  private readonly now: () => number;
  readonly loopGapS: number;

  constructor(private readonly options: ReplayOptions) {
    this.now = options.now ?? Date.now;
    this.loopGapS = options.loopGapS ?? medianSpacing(options.recordings);
  }

  get replayEpoch(): number {
    return this.epoch;
  }

  start(): void {
    this.epoch = 0;
    this.startLoop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private startLoop(): void {
    this.index = 0;
    this.offsetS = this.now() / 1000 - this.options.recordings[0]!.snapshot.time;
    this.emit();
  }

  private emit(): void {
    const { recordings, hub } = this.options;
    const current = recordings[this.index]!;
    hub.publishSnapshot(shiftSnapshot(current.snapshot, this.offsetS), this.epoch);
    const next = recordings[this.index + 1];
    const delayS = next ? next.snapshot.time - current.snapshot.time : this.loopGapS;
    hub.updateStatus({ nextUpdateAt: this.now() + delayS * 1000 });
    this.timer = setTimeout(() => {
      if (next) {
        this.index++;
        this.emit();
      } else {
        this.epoch++;
        this.startLoop();
      }
    }, delayS * 1000);
  }
}

function medianSpacing(recordings: Recording[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < recordings.length; i++) {
    gaps.push(recordings[i]!.snapshot.time - recordings[i - 1]!.snapshot.time);
  }
  if (gaps.length === 0) return 180;
  gaps.sort((a, b) => a - b);
  return Math.max(1, gaps[Math.floor(gaps.length / 2)]!);
}
