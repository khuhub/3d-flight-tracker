# Bundled route database

`routes.json.gz` is gzip-compressed JSON (`flight-routes-v1`) built by
`npm run routes:update -w @flight/server` from
[Virtual Radar Server standing data](https://github.com/vradarserver/standing-data)
(snapshot of 2026-11-18, CC0 1.0 Universal). It maps airline callsigns to scheduled
airport sequences (e.g. `DLH400` -> `EDDF-KJFK`) and stores name, IATA code and
position for every referenced airport. Routes that reference unknown airports are dropped.

These are scheduled routes per callsign, not filed flight plans. The backend only uses a
route when the aircraft's current position fits it.
