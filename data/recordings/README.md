# Recorded OpenSky snapshots

Real `/api/states/all` responses captured with `npm run record` (authenticated
OpenSky API client, 3 snapshots about three minutes apart, 12 credits, no retries) on
2026-11-18 between 03:57 and 04:04 UTC. Each file stores the unmodified response
under `response`, plus capture metadata and parser statistics. No credentials are
stored.

| File | Airborne aircraft kept |
| --- | --- |
| `opensky-2026-11-18T03-57-49-410Z.json` | 5,541 |
| `opensky-2026-11-18T04-00-49-381Z.json` | 5,485 |
| `opensky-2026-11-18T04-03-49-411Z.json` | 5,446 |

These files are **git-ignored**: OpenSky's terms of use do not allow redistributing its
data, so recordings stay on the machine that captured them. Run `npm run record` to make
your own. Without any recordings, `npm run dev` replays the synthetic test fixture
instead (and says so in the server log).

Replay mode (`npm run dev`) loops these files. Data © The OpenSky Network, used under
its terms of use for non-commercial research and education.
