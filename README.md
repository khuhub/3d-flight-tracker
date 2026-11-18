# 3D Flight Tracker

Aircraft from the [OpenSky Network](https://opensky-network.org) on a dark, interactive
3D globe. React + strict TypeScript + Vite + Three.js in the browser, a small Node +
TypeScript backend that polls OpenSky (or replays recordings) and streams snapshots over
Server-Sent Events, and shared parsing, motion and route code.

- Slowly spinning atlas-style globe built from bundled Natural Earth data (works offline);
  drag to rotate, scroll to zoom. The spin pauses while you interact or have an aircraft selected.
- Every aircraft is a small airplane silhouette pointing along its track and coloured by
  altitude. All aircraft are one `InstancedMesh` (one draw call) and the dataset is never truncated.
- Aircraft glide along great circles between snapshots, blend smoothly onto corrected
  positions, and stop extrapolating after 5 minutes (see [Motion](#motion-and-routes)).
- **Routes, always shown:** every aircraft whose scheduled route is known gets a line from
  its departure airport, through the aircraft, to its arrival airport (via any intermediate
  stops). The line follows the plane as it moves; it appears with the first snapshot and
  never accumulates history. The selected
  aircraft's route is highlighted with its airports marked.
- Click an aircraft for where it is coming from and going to, plus callsign, registration
  country, altitude, speed and heading.
- Status bar: aircraft count, connection state, mode, and time since the last successful update.

## Quick start

Requires Node 20.19+ (CI uses Node 22).

```sh
npm install
npm run dev        # replay mode: http://localhost:5173
```

`npm run dev` always starts in **replay** mode (regardless of `.env`) using the real snapshots recorded in
`data/recordings/`. It never contacts OpenSky. Routes are shown immediately. The three
bundled snapshots are three minutes apart; when the recording ends, the replay loops.

## Live mode

```sh
cp .env.example .env   # then fill in credentials (optional)
npm run dev:live       # dev servers with live polling
FLIGHT_MODE=live npm start   # production build with live polling
```

Live mode is opt-in only. The browser never talks to OpenSky; the backend polls
`/api/states/all` and serves the cached result to every browser over `/api/stream`.

### Credentials

OpenSky uses the OAuth2 client-credentials flow:

1. Create a free account at [opensky-network.org](https://opensky-network.org) (Login → Register).
2. On the [Account page](https://opensky-network.org/my-opensky/account), create an **API client**.
3. Put the values in `.env` (git-ignored, never commit it):

   ```
   OPENSKY_CLIENT_ID=...
   OPENSKY_CLIENT_SECRET=...
   ```

Without credentials the backend polls anonymously. Tokens are fetched by the server,
cached, refreshed a minute before expiry, and refreshed once on a `401`.

### Polling interval and quota

| Setting | Default | Notes |
| --- | --- | --- |
| `POLL_INTERVAL_S` | `180` | Minimum 30. |
| `REQUEST_TIMEOUT_MS` | `30000` | Per OpenSky request. |
| `MAX_BACKOFF_S` | `3600` | Cap for exponential backoff after errors. |

A global `/states/all` query costs 4 credits. Polling every 3 minutes is 480 requests,
about **1,920 credits per day**, below a standard account's 4,000 daily credits
(assuming nothing else uses the account). Anonymous access gets only 400 credits per
day, so for continuous anonymous use set `POLL_INTERVAL_S=900` (15 minutes, 384 credits per day)
or more; the server prints a warning otherwise.

Polls never overlap: the next one is scheduled only after the current one finishes.
Failures back off exponentially (3, 6, 12 min ... up to `MAX_BACKOFF_S`), a `429` waits
for OpenSky's `X-Rate-Limit-Retry-After-Seconds`, and the last successful snapshot keeps
being served while the status bar shows the problem. `/states/own` (free, unlimited) only
covers receivers you operate, so it is not used for global coverage.

## Recording new snapshots

```sh
npm run record -- --count=3 --interval=180   # defaults shown; uses .env credentials if present
```

Makes at most `count` requests (4 credits each), never retries a failed snapshot, and
stops early on authentication or rate-limit errors. Files are written to
`data/recordings/` and replay picks them up automatically. The bundled recordings and
how they were captured are described in [data/recordings/README.md](data/recordings/README.md).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Backend (replay) + Vite dev server with hot reload. |
| `npm run dev:live` | Same, but the backend polls OpenSky. |
| `npm start` | Production build, served by the backend on http://127.0.0.1:8787 (replay unless `FLIGHT_MODE=live`). |
| `npm run build` | Production client build. |
| `npm run lint` / `npm run typecheck` | ESLint and strict TypeScript for all packages. |
| `npm test` | Vitest unit and backend tests (mocked network, no OpenSky). |
| `npm run test:e2e` | Playwright end-to-end test in replay mode against a synthetic fixture. |
| `npm run perf` | 12,000-aircraft browser benchmark; writes `perf-results/stress-12000.json`. |
| `npm run record` | Bounded capture of real snapshots (see above). |
| `npm run routes:update -w @flight/server` | Rebuild `data/routes/routes.json.gz` from the latest route data (see [Routes](#routes)). |

## Tests

- **Unit/backend (Vitest):** OpenSky parsing and filtering; great-circle extrapolation,
  stale cutoff and correction blending; route matching and plausibility (including
  multi-leg routes and rejected mismatches), the route-file builder and loader, routes in
  published snapshots, client route decoding and stability across snapshots, route
  geometry (great circles, antimeridian, staying above the surface); OAuth token caching and refresh; polling cadence, non-overlap, backoff and
  rate limits; replay clock and looping; SSE immediate delivery, heartbeats, broadcast and
  client cleanup. All network access is mocked or local.
- **End-to-end (Playwright):** one scenario that starts the built app in replay mode on
  `packages/server/test/fixtures/replay` (synthetic data, 20 s apart), aborts and fails on
  any non-local request, with the synthetic route fixture in
  `packages/server/test/fixtures/routes`. It checks that routes appear at once and stay
  fixed across snapshots, visible airplanes and routes (pixel comparisons), movement at
  the reported speed, origin/destination in the details panel, and that an aircraft whose
  route does not fit its position shows no route.
- **Performance:** `npm run perf` opens `/?stress=12000`, which generates 12,000 synthetic
  aircraft **in the browser**, each with a 6,000 km synthetic route.
  This data is labelled "Synthetic stress test · not real data" and is never mixed with
  recordings.

Measured on an Apple M4 Pro (Chromium headless, ANGLE Metal), 1600×1000 viewport:

| Metric | Result |
| --- | --- |
| Aircraft / routes / route segments | 12,000 / 12,000 / 1,447,070 |
| Draw calls per frame (whole scene) | 6 (aircraft: 1 instanced call, all routes: 1) |
| Frame interval p50 / p99 | 16.7 ms / 18.0 ms (60 fps, vsync-limited) |
| Main-thread time per frame p50 / p95 | 3.2–3.7 ms / 4.0–4.5 ms |
| Route buffers (vertices + aircraft-position texture) | 88.6 MiB |
| Route geometry build | about 100 ms, once per snapshot (one longer frame) |

On the real recordings (5,518 aircraft, 3,892 with routes, 233,111 segments, 14.5 MiB)
a route build takes about 20 ms.

Headless Chromium on Linux CI renders with SwiftShader (software), so the benchmark is
not part of CI; run it locally on a machine with a GPU.

## Controls

- Drag: rotate · Scroll / pinch: zoom · Click an airplane: details · × closes the panel.

## Motion and routes

- **Extrapolation:** each aircraft moves from its last reported position along a great
  circle at its reported ground speed and track. Extrapolation stops 5 minutes
  (`MAX_EXTRAPOLATION_S`) after the position report; the aircraft then freezes and is
  drawn dimmed. Positions more than 15 minutes old at snapshot time are dropped, and
  speeds above 400 m/s (seen in real data, e.g. 2,215 m/s) are treated as unknown.
- **Corrections:** when a new snapshot arrives, aircraft glide from where they were drawn
  to their corrected position over 2 seconds; corrections over 150 km snap instead.
- Aircraft that disappear from a snapshot are removed from the globe together with their route.

## Routes

OpenSky only reports positions, not where a flight is going. Routes come from
[Virtual Radar Server standing data](https://github.com/vradarserver/standing-data)
(CC0 1.0): a community-maintained table of airline callsigns and their scheduled
airports. A compressed copy (about 629,000 routes and 3,800 airports, 3 MiB) is bundled in
`data/routes/routes.json.gz`, so route lookups are offline: no extra requests,
quotas or API keys, in live and replay mode alike.

- The backend matches each aircraft's callsign and sends the airport codes with every
  snapshot. A route is used only if the aircraft's current position lies near one of its
  legs (detour under 300 km or 20% of the leg length). This rejects callsigns reused for
  a different flight and outdated entries; such aircraft show no route instead of a wrong one.
- Each route is drawn as two great circles: departure airport → aircraft and aircraft →
  arrival airport, rising from the ground at the airports to the aircraft's altitude.
  Legs already flown or still ahead on multi-stop routes are airport-to-airport arcs. The
  aircraft's animated position is passed to the GPU every frame, so the line bends
  exactly at the plane while geometry is only rebuilt when a snapshot arrives.
- The airports are the scheduled ones for the callsign, **not** a filed flight plan, and
  the lines are shortest paths, not the track actually flown (airways, weather and ATC
  change the real path).
- Coverage: on the bundled recordings about 70% of aircraft have a route (3,892 of
  5,518). Private, military, cargo-charter and non-airline callsigns are often missing.
- Refresh the data with `npm run routes:update -w @flight/server` (downloads about 6 MB
  from GitHub). `ROUTES_FILE` points the backend at another file; without a route file the
  app still runs and shows no routes.

## Coverage gaps and limitations

OpenSky is a volunteer receiver network. Coverage is dense over North America and Europe
and sparse or absent over oceans, polar routes, much of Africa, South America, Central
Asia and China. The REST API excludes MLAT and ADS-C positions, so many oceanic and
non-ADS-B aircraft are missing; a typical global snapshot has 5,000–7,000 airborne
aircraft rather than every flight in the sky. With 3-minute polling, displayed positions
between snapshots are estimates.

## Project layout

```
packages/shared   parsing, geo/motion, route matching, colour ramp (used by both sides)
packages/server   OpenSky client, poller, replay, route database, SSE hub, HTTP server, recorder
packages/client   React UI, Three.js globe, instanced aircraft, batched routes
data/recordings   real OpenSky snapshots for replay
data/routes       bundled scheduled-route database (CC0)
e2e               Playwright e2e test and performance benchmark
```

## Attribution

- Flight data: [The OpenSky Network](https://opensky-network.org). Matthias Schäfer,
  Martin Strohmeier, Vincent Lenders, Ivan Martinovic and Matthias Wilhelm, "Bringing Up
  OpenSky: A Large-scale ADS-B Sensor Network for Research", IPSN 2014. Use is subject to
  the OpenSky terms of use (non-commercial research and education).
- Map data: [Natural Earth](https://www.naturalearthdata.com) (public domain) via
  [world-atlas](https://github.com/topojson/world-atlas).
- Routes: [Virtual Radar Server standing data](https://github.com/vradarserver/standing-data)
  (CC0 1.0).
