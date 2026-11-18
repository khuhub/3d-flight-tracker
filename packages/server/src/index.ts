import { loadConfig, loadDotEnv } from './config';
import { createApp } from './app';
import { SnapshotHub } from './hub';
import { createClientFromCredentials } from './opensky';
import { LivePoller } from './poller';
import { ReplaySource, loadRecordings } from './replay';
import { loadRouteDatabase, type RouteDatabase } from './routes';

loadDotEnv();
const config = loadConfig();
const log = (message: string): void => console.log(`[${new Date().toISOString()}] ${message}`);

let routes: RouteDatabase | null = null;
try {
  routes = loadRouteDatabase(config.routesFile);
  log(`Loaded ${routes.count.toLocaleString()} scheduled routes from ${config.routesFile} (built ${routes.generatedAt}).`);
} catch (err) {
  log(`Warning: no route database (${err instanceof Error ? err.message : String(err)}); flights will show no routes. Run npm run routes:update.`);
}

const authenticated = config.clientId !== '' && config.clientSecret !== '';
const hub = new SnapshotHub({
  mode: config.mode,
  pollIntervalS: config.pollIntervalS,
  authenticated: config.mode === 'live' && authenticated,
  heartbeatMs: config.heartbeatMs,
  routes,
});

let stopSource: () => void;
if (config.mode === 'live') {
  const client = createClientFromCredentials(
    { clientId: config.clientId, clientSecret: config.clientSecret },
    { apiUrl: config.apiUrl, tokenUrl: config.tokenUrl, timeoutMs: config.requestTimeoutMs },
  );
  const creditsPerDay = Math.ceil(86_400 / config.pollIntervalS) * 4;
  log(
    `LIVE mode: polling OpenSky every ${config.pollIntervalS}s (${authenticated ? 'OAuth client' : 'anonymous'}), ` +
      `about ${creditsPerDay} credits/day for global queries.`,
  );
  if (!authenticated && creditsPerDay > 400) {
    log('Warning: anonymous access allows 400 credits/day. Use POLL_INTERVAL_S=900 or more for continuous use.');
  }
  const poller = new LivePoller({ client, hub, intervalS: config.pollIntervalS, maxBackoffS: config.maxBackoffS, log });
  poller.start();
  stopSource = () => poller.stop();
} else {
  if (config.replayFallback) {
    log('No recordings in data/recordings yet: replaying the SYNTHETIC test fixture. Run `npm run record` to capture real snapshots.');
  }
  const recordings = loadRecordings(config.replayDir, log);
  const replay = new ReplaySource({ recordings, hub, loopGapS: config.replayLoopGapS });
  log(
    `REPLAY mode: ${recordings.length} recorded snapshot(s) from ${config.replayDir}, ` +
      `looping every ${recordings.at(-1)!.snapshot.time - recordings[0]!.snapshot.time + replay.loopGapS}s. No OpenSky requests are made.`,
  );
  replay.start();
  stopSource = () => replay.stop();
}

const server = createApp({ hub, staticDir: config.staticDir });
server.listen(config.port, config.host, () => {
  log(`Backend listening on http://${config.host}:${config.port}${config.staticDir ? ' (serving built client)' : ''}`);
});

function shutdown(): void {
  stopSource();
  hub.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
