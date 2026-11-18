# Route test fixture

`routes.json` is **synthetic test data** in the bundled route-database format
(`flight-routes-v1`, plain JSON instead of gzip). It gives scheduled routes to callsigns in
`../replay`: TST101, TST202 and TST303 fly routes that pass their positions, TST808 has a
route across the antimeridian, and TST404 has a route on another continent that the
plausibility check must reject. Real data lives in `data/routes/routes.json.gz`.
