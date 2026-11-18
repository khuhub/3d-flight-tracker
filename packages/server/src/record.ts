/**
 * One-off, bounded capture of real OpenSky snapshots for replay mode.
 *
 *   npm run record -- --count=3 --interval=180
 *
 * Makes at most `count` `/states/all` requests (4 credits each), never retries a
 * failed snapshot, and stops early on authentication or rate-limit errors.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseOpenSkyStates } from '@flight/shared';
import { REPO_ROOT, loadDotEnv } from './config';
import { OpenSkyError, createClientFromCredentials } from './opensky';

export const RECORDING_FORMAT = 'opensky-states-v1';

function arg(name: string, fallback: string): string {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
}

async function main(): Promise<number> {
  loadDotEnv();
  const count = Number(arg('count', '3'));
  const intervalS = Number(arg('interval', '180'));
  const outArg = arg('out', 'data/recordings');
  const outDir = isAbsolute(outArg) ? outArg : resolve(REPO_ROOT, outArg);
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('--count must be 1..10');
  if (!Number.isFinite(intervalS) || intervalS < 60) throw new Error('--interval must be at least 60 seconds');

  const client = createClientFromCredentials({
    clientId: (process.env.OPENSKY_CLIENT_ID ?? '').trim(),
    clientSecret: (process.env.OPENSKY_CLIENT_SECRET ?? '').trim(),
  });
  mkdirSync(outDir, { recursive: true });
  console.log(
    `Recording ${count} snapshot(s), ${intervalS}s apart, ${client.authenticated ? 'authenticated' : 'anonymous'}; ` +
      `at most ${count * 4} credits. Output: ${outDir}`,
  );

  let failures = 0;
  const start = Date.now();
  for (let i = 0; i < count; i++) {
    const due = start + i * intervalS * 1000;
    if (Date.now() < due) await sleep(due - Date.now());
    const recordedAt = new Date();
    try {
      const { body, creditsRemaining } = await client.fetchAllStates();
      const { snapshot, stats } = parseOpenSkyStates(body);
      const file = join(outDir, `opensky-${recordedAt.toISOString().replace(/[:.]/g, '-')}.json`);
      const payload = {
        format: RECORDING_FORMAT,
        source: 'OpenSky Network /api/states/all',
        recordedAt: recordedAt.toISOString(),
        authenticated: client.authenticated,
        creditsRemaining,
        stats,
        response: body,
      };
      writeFileSync(file, JSON.stringify(payload));
      console.log(
        `[${i + 1}/${count}] time=${snapshot.time} states=${stats.total} airborne=${stats.kept} ` +
          `grounded=${stats.grounded} invalid=${stats.invalid} stale=${stats.stale} creditsRemaining=${creditsRemaining ?? 'n/a'} -> ${file}`,
      );
    } catch (err) {
      failures++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${i + 1}/${count}] FAILED (not retried): ${msg}`);
      if (err instanceof OpenSkyError && (err.kind === 'auth' || err.kind === 'rate-limit')) {
        console.error('Stopping: further requests would fail the same way.');
        break;
      }
    }
  }
  console.log(failures === 0 ? 'Recording complete.' : `Recording finished with ${failures} failure(s).`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
