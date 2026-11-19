# Agent instructions

## Setup and checks

- Use Node.js 20.19+ (CI uses Node 22). Run `npm ci` from the repository root.
- Run `npm run dev` for local development at http://localhost:5173. It starts both servers in replay mode. Without local recordings and without an explicit `REPLAY_DIR`, it uses synthetic fixtures. No credentials are needed.
- Before handing off code changes, run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. Tests cover parsing, motion between updates, routes, and backend behavior.
- For UI, streaming, or replay changes, also run `npm run test:e2e`. First install Chromium with `npx playwright install chromium` if needed. The harness builds and starts its own server on port 4319 with synthetic fixtures, then exercises aircraft movement, routes, and click-to-details.
- For rendering performance changes, run `npm run perf` on a GPU-equipped machine; software-rendered CI timings are not representative.

## Data safety

- Keep tests and CI offline: mock upstream requests and use synthetic fixtures. Never call OpenSky from tests or CI.
- Use live mode or `npm run record` only when explicitly requested; both consume OpenSky quota. Read the README's quota guidance first.
- Keep credentials server-side in the ignored `.env`. Never print credentials or commit real recordings (`data/recordings/*.json`); OpenSky data is not redistributable. Use `.env.example` for configuration documentation.

## Code boundaries and conventions

- `packages/shared`: wire types, parsing, geographic calculations, motion, and route matching.
- `packages/server`: OpenSky authentication/polling, replay, route database, and SSE/HTTP endpoints.
- `packages/client`: React UI and Three.js rendering; consume the backend stream rather than calling OpenSky directly.
- Use strict TypeScript, camelCase for functions and variables, and PascalCase for types and React components. Follow nearby file naming. Add regression tests alongside existing `packages/*/test/*.test.ts` tests for logic changes.
- Routes represent departure → current aircraft → arrival, not accumulated flight history. Preserve this distinction when changing motion or rendering.

See README.md for architecture, controls, scripts, and data limitations. Prefer focused improvements for this solo project; add team or release infrastructure only when requested.
