# Replay test fixture

`fixture-*.json` are **synthetic test data**, not real OpenSky recordings. They follow
the recorder's file format so the replay loader, backend tests and the Playwright test
can run offline and deterministically. Snapshots are 20 seconds apart so motion
and replay looping happen quickly. Each snapshot contains 8 airborne aircraft (one
crossing the antimeridian), one grounded aircraft and one without a position, which
the parser filters out.

Real recordings captured with `npm run record` live in `data/recordings/`.
