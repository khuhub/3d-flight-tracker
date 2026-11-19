import { CORRECTION_BLEND_S, MAX_EXTRAPOLATION_S, type MotionTrack } from '@flight/shared';

export const SELECTED_TRAIL_S = 600;
export const FLEET_TRAIL_S = 90;
const MAX_SECTIONS = 48; // Covers the full window at the 15-second synthetic cadence.

/** MotionTrack is mutable during rendering. Keep our own copies of its correction state. */
interface TrailSection {
  track: MotionTrack;
  end: number;
}

/** One bounded trail journal per aircraft in the latest unfiltered snapshot. */
export class TrailHistory {
  private sections = new Map<string, TrailSection[]>();
  private lastTime = -Infinity;
  version = 0;

  replace(tracks: readonly MotionTrack[], now: number): void {
    if (now < this.lastTime) this.clear();
    const next = new Map<string, TrailSection[]>();
    for (const track of tracks) {
      const id = track.aircraft.icao24;
      const history = this.sections.get(id) ?? [];
      const previous = history.at(-1);
      if (previous) previous.end = now;

      // Disappearance is a hard break: only entries in `next` will survive this snapshot.
      // Two snapshots applied at the same time do not need two zero-length sections.
      if (previous && previous.track.appliedAt >= now) history.pop();
      while (history.length && (history[0]!.end <= now - SELECTED_TRAIL_S || history.length >= MAX_SECTIONS)) {
        history.shift();
      }
      history.push({ track: { ...track }, end: Infinity });
      next.set(id, history);
    }
    this.sections = next;
    this.lastTime = now;
    this.version++;
  }

  clear(): void {
    this.sections.clear();
    this.lastTime = -Infinity;
    this.version++;
  }

  /**
   * Visit recent sections newest first, clipped to the visible time window and motion
   * cutoff. Each section is independent, so large position corrections are never joined.
   * Copy `track` before calling the mutable estimateTrack implementation.
   */
  visit(
    id: string,
    now: number,
    duration: number,
    visit: (track: MotionTrack, start: number, end: number, current: boolean) => boolean,
  ): void {
    const history = this.sections.get(id);
    if (!history) return;
    const oldest = now - duration;
    for (let i = history.length - 1; i >= 0; i--) {
      const { track, end } = history[i]!;
      if (end <= oldest) break;
      const start = Math.max(oldest, track.appliedAt);
      const cutoff = Math.max(
        track.aircraft.timePosition + MAX_EXTRAPOLATION_S,
        track.correctionFrom ? track.appliedAt + CORRECTION_BLEND_S : track.appliedAt,
      );
      const finish = Math.min(end, now, cutoff);
      const current = end === Infinity && now >= track.appliedAt && now < cutoff;
      if ((finish > start || current) && !visit(track, start, finish, current)) break;
    }
  }
}
