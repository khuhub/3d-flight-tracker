# Flight filters

Open **Filters** beside the globe legend. The controls combine with AND: an aircraft
must match every active filter. **Reset filters** restores the full fleet.

- **Altitude band** uses the latest reported altitude, not the animated or rounded
  value. The wire value is in metres; 10,000 ft is exactly 3,048 m, and 30,000 ft is
  exactly 9,144 m. The bands are below 10,000 ft (including any negative reported
  altitude), 10,000 ft inclusive to 30,000 ft exclusive, and 30,000 ft or higher.
  Missing altitude belongs to **Unknown altitude**. **All altitudes** includes it.
- **Origin country (registration)** matches the aircraft's reported registration
  country, not its departure airport. The list comes from the full current snapshot;
  a selected country stays selectable if it disappears from a later snapshot.
- **Known routes only** requires a decoded, position-plausible scheduled route in
  the current snapshot. It doesn't infer a route from flight history or the callsign
  alone.

The status bar counts aircraft that pass the filters, including those on the far
side of the globe. The legend counts known routes among those aircraft. When filters
are active, the filters heading shows the filtered count out of the full fleet.

Filters stay in effect as the data updates, replay rewinds, or the mode changes in
the same session. Hiding an aircraft closes its details and deselects it. Resetting
filters shows it again without selecting it.
