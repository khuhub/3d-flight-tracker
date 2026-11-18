import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FlightMode } from '@flight/shared';
import { DEFAULT_API_URL, DEFAULT_TOKEN_URL } from './opensky';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export const DEFAULT_REPLAY_DIR = 'data/recordings';
/** Synthetic replay data (and matching routes) used when no real recordings exist yet. */
export const FIXTURE_REPLAY_DIR = 'packages/server/test/fixtures/replay';
export const FIXTURE_ROUTES_FILE = 'packages/server/test/fixtures/routes/routes.json';

function hasRecordings(dir: string): boolean {
  try {
    return readdirSync(dir).some((n) => n.endsWith('.json'));
  } catch {
    return false;
  }
}

/** Loads the repository's `.env` once, without overriding variables already set. */
export function loadDotEnv(path = resolve(REPO_ROOT, '.env')): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

export interface ServerConfig {
  mode: FlightMode;
  port: number;
  host: string;
  pollIntervalS: number;
  maxBackoffS: number;
  requestTimeoutMs: number;
  heartbeatMs: number;
  replayDir: string;
  /** True when no recordings were found and the synthetic fixture is replayed instead. */
  replayFallback: boolean;
  /** Gap inserted after the last recorded snapshot before replay loops. */
  replayLoopGapS: number | null;
  staticDir: string | null;
  /** Bundled scheduled-route database; routes are omitted when the file is missing. */
  routesFile: string;
  clientId: string;
  clientSecret: string;
  apiUrl: string;
  tokenUrl: string;
}

export const MIN_POLL_INTERVAL_S = 30;

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
  recordingsExist: (dir: string) => boolean = hasRecordings,
): ServerConfig {
  const arg = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

  const modeRaw = (arg('mode') ?? env.FLIGHT_MODE ?? 'replay').toLowerCase();
  if (modeRaw !== 'live' && modeRaw !== 'replay') throw new Error(`Unknown mode "${modeRaw}" (expected live or replay)`);

  const pollIntervalS = int(env.POLL_INTERVAL_S, 180);
  if (pollIntervalS < MIN_POLL_INTERVAL_S) {
    throw new Error(`POLL_INTERVAL_S must be at least ${MIN_POLL_INTERVAL_S} seconds to protect the OpenSky quota`);
  }
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));
  const explicitReplayDir = arg('replay-dir') ?? env.REPLAY_DIR;
  // OpenSky recordings are not committed (its terms forbid redistribution), so a fresh
  // clone replays the synthetic fixture until `npm run record` has been run.
  const replayFallback = explicitReplayDir === undefined && !recordingsExist(abs(DEFAULT_REPLAY_DIR));
  const replayDir = explicitReplayDir ?? (replayFallback ? FIXTURE_REPLAY_DIR : DEFAULT_REPLAY_DIR);
  const staticDir = env.STATIC_DIR ?? 'packages/client/dist';
  const absStatic = isAbsolute(staticDir) ? staticDir : resolve(REPO_ROOT, staticDir);
  const routesFile = env.ROUTES_FILE ?? (replayFallback && modeRaw === 'replay' ? FIXTURE_ROUTES_FILE : 'data/routes/routes.json.gz');

  return {
    mode: modeRaw,
    port: int(arg('port') ?? env.PORT, 8787),
    host: env.HOST ?? '127.0.0.1',
    pollIntervalS,
    maxBackoffS: int(env.MAX_BACKOFF_S, 3600),
    requestTimeoutMs: int(env.REQUEST_TIMEOUT_MS, 30_000),
    heartbeatMs: int(env.SSE_HEARTBEAT_MS, 15_000),
    replayDir: abs(replayDir),
    replayFallback,
    replayLoopGapS: env.REPLAY_LOOP_GAP_S ? int(env.REPLAY_LOOP_GAP_S, 0) : null,
    staticDir: existsSync(absStatic) ? absStatic : null,
    routesFile: abs(routesFile),
    clientId: (env.OPENSKY_CLIENT_ID ?? '').trim(),
    clientSecret: (env.OPENSKY_CLIENT_SECRET ?? '').trim(),
    apiUrl: env.OPENSKY_API_URL ?? DEFAULT_API_URL,
    tokenUrl: env.OPENSKY_TOKEN_URL ?? DEFAULT_TOKEN_URL,
  };
}

function int(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Expected a non-negative integer, got "${raw}"`);
  return n;
}
