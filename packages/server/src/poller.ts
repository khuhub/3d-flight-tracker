import { parseOpenSkyStates } from '@flight/shared';
import type { SnapshotHub } from './hub';
import { OpenSkyError, type OpenSkyClient } from './opensky';

export interface PollerOptions {
  client: Pick<OpenSkyClient, 'fetchAllStates'>;
  hub: SnapshotHub;
  intervalS: number;
  /** Upper bound for exponential backoff after ordinary failures. Rate-limit waits are always honoured. */
  maxBackoffS: number;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * Polls OpenSky on a fixed interval. The next poll is only scheduled after the current
 * one settles, so requests can never overlap. Failures back off exponentially and
 * keep the last successful snapshot in the hub.
 */
export class LivePoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private stopped = true;
  private failures = 0;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: PollerOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Runs a single poll; resolves with the delay (ms) chosen for the next one. */
  async pollOnce(): Promise<number> {
    if (this.inFlight) return -1;
    this.inFlight = true;
    const { client, hub, intervalS, maxBackoffS } = this.options;
    let delayS = intervalS;
    try {
      const { body, creditsRemaining } = await client.fetchAllStates();
      const { snapshot, stats } = parseOpenSkyStates(body);
      hub.publishSnapshot(snapshot);
      this.failures = 0;
      this.log(
        `snapshot time=${snapshot.time} airborne=${stats.kept} filtered=${stats.grounded + stats.invalid + stats.stale}` +
          (creditsRemaining !== null ? ` creditsRemaining=${creditsRemaining}` : ''),
      );
    } catch (err) {
      this.failures++;
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof OpenSkyError && err.kind === 'rate-limit') {
        delayS = Math.max(intervalS, err.retryAfterS ?? intervalS * 2 ** this.failures);
        hub.updateStatus({ upstream: 'rate-limited', lastError: message });
      } else {
        delayS = Math.min(intervalS * 2 ** (this.failures - 1), Math.max(maxBackoffS, intervalS));
        hub.updateStatus({ upstream: 'error', lastError: message });
      }
      this.log(`poll failed (${this.failures} in a row): ${message}; next attempt in ${Math.round(delayS)}s`);
    } finally {
      this.inFlight = false;
    }
    const delayMs = delayS * 1000;
    if (!this.stopped) this.schedule(delayMs);
    return delayMs;
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.options.hub.updateStatus({ nextUpdateAt: this.now() + delayMs });
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollOnce();
    }, delayMs);
  }
}
