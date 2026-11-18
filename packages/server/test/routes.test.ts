import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeRoute, routeFits, type Aircraft } from '@flight/shared';
import { SnapshotHub } from '../src/hub';
import { ROUTES_FORMAT, RouteDatabase, loadRouteDatabase, type RouteFile } from '../src/routes';
import { buildRouteFile, parseCsvLine } from '../src/updateRoutes';

const T = 1_700_000_000;

const FILE: RouteFile = {
  format: ROUTES_FORMAT,
  source: 'test',
  license: 'CC0-1.0',
  generatedAt: '2026-01-01T00:00:00.000Z',
  airports: {
    EGLL: ['London Heathrow', 'LHR', 51.4706, -0.4619],
    EDDF: ['Frankfurt am Main', 'FRA', 50.0264, 8.5431],
    KJFK: ['John F Kennedy', 'JFK', 40.6398, -73.7789],
    KLAX: ['Los Angeles', 'LAX', 33.9425, -118.4081],
  },
  routes: { DLH901: 'EGLL-EDDF', DLH400: 'EDDF-KJFK', AAL1: 'KJFK-KLAX', BAW1: 'EGLL-EDDF-KJFK' },
};

function plane(callsign: string | null, lat: number, lon: number): Aircraft {
  return { icao24: `x${callsign ?? 'none'}`.toLowerCase(), callsign, originCountry: 'X', timePosition: T, lastContact: T, lat, lon, altitude: 10_000, velocity: 230, heading: 90, verticalRate: 0 };
}

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'routes-test-'));
  temps.push(d);
  return d;
};

describe('route plausibility', () => {
  const route = decodeRoute('EGLL-EDDF', FILE.airports)!;

  it('accepts positions along the route, including at the airports', () => {
    expect(routeFits(route, { lat: 50.9, lon: 4 })).toBe(true);
    expect(routeFits(route, { lat: 51.47, lon: -0.46 })).toBe(true);
    expect(routeFits(route, { lat: 50.03, lon: 8.54 })).toBe(true);
  });

  it('rejects positions far from every leg', () => {
    expect(routeFits(route, { lat: 40, lon: -74 })).toBe(false);
    expect(routeFits(route, { lat: 55, lon: 4 })).toBe(false);
  });

  it('decodes nothing when an airport is unknown', () => {
    expect(decodeRoute('EGLL-ZZZZ', FILE.airports)).toBeNull();
  });
});

describe('RouteDatabase', () => {
  const db = new RouteDatabase(FILE);

  it('matches callsigns whose route fits the current position', () => {
    const fleet = [
      plane('DLH901', 50.9, 4), // between London and Frankfurt
      plane('DLH400', 30, 100), // callsign known, but nowhere near Frankfurt-New York
      plane('BAW1', 50, -40), // on the second leg of a multi-leg route
      plane('ABC123', 50, 4), // unknown callsign
      plane(null, 50, 4), // no callsign
      plane('constructor', 50, 4), // never resolves object prototype keys
    ];
    const { codes, airports } = db.match(fleet);
    expect(codes).toEqual(['EGLL-EDDF', null, 'EGLL-EDDF-KJFK', null, null, null]);
    expect(Object.keys(airports).sort()).toEqual(['EDDF', 'EGLL', 'KJFK']);
  });

  it('loads gzip-compressed and plain JSON route files and rejects other formats', () => {
    const dir = temp();
    writeFileSync(join(dir, 'r.json.gz'), gzipSync(JSON.stringify(FILE)));
    writeFileSync(join(dir, 'r.json'), JSON.stringify(FILE));
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ ...FILE, format: 'other' }));
    expect(loadRouteDatabase(join(dir, 'r.json.gz')).count).toBe(4);
    expect(loadRouteDatabase(join(dir, 'r.json')).codesFor(plane('DLH901', 50.9, 4))).toBe('EGLL-EDDF');
    expect(() => loadRouteDatabase(join(dir, 'bad.json'))).toThrow(/Unsupported route file format/);
  });

  it('is attached to every published snapshot', () => {
    const hub = new SnapshotHub({ mode: 'replay', pollIntervalS: 180, authenticated: false, heartbeatMs: 10_000, routes: db });
    const msg = hub.publishSnapshot({ time: T, aircraft: [plane('DLH901', 50.9, 4), plane('ABC123', 50, 4)] });
    expect(msg.aircraft.map((w) => w[11])).toEqual(['EGLL-EDDF', null]);
    expect(Object.keys(msg.airports).sort()).toEqual(['EDDF', 'EGLL']);
    const without = new SnapshotHub({ mode: 'replay', pollIntervalS: 180, authenticated: false, heartbeatMs: 10_000 });
    const plain = without.publishSnapshot({ time: T, aircraft: [plane('DLH901', 50.9, 4)] });
    expect(plain.aircraft[0]![11]).toBeNull();
    expect(plain.airports).toEqual({});
  });
});

describe('route file builder', () => {
  it('parses quoted CSV fields', () => {
    expect(parseCsvLine('A,"B, with comma","say ""hi""",')).toEqual(['A', 'B, with comma', 'say "hi"', '']);
  });

  it('builds a compact file from standing-data CSVs and drops routes with unknown airports', () => {
    const root = temp();
    mkdirSync(join(root, 'airports', 'schema-01', 'E'), { recursive: true });
    mkdirSync(join(root, 'routes', 'schema-01', 'D'), { recursive: true });
    writeFileSync(
      join(root, 'airports', 'schema-01', 'E', 'E.csv'),
      '\uFEFFCode,Name,ICAO,IATA,Location,CountryISO2,Latitude,Longitude,AltitudeFeet\r\n' +
        'EDDF,"Frankfurt-am-Main, International",EDDF,FRA,Frankfurt,DE,50.026402,8.54313,364\r\n' +
        'EGLL,London Heathrow,EGLL,LHR,London,GB,51.4706,-0.461941,83\r\n' +
        'XNOP,No position,XNOP,,Nowhere,XX,,,\r\n',
    );
    writeFileSync(
      join(root, 'routes', 'schema-01', 'D', 'DLH-all.csv'),
      '\uFEFFCallsign,Code,Number,AirlineCode,AirportCodes\n' +
        'DLH901,DLH,901,DLH,EGLL-EDDF\n' +
        'DLH902,DLH,902,DLH,EDDF-XNOP\n' +
        'DLH903,DLH,903,DLH,EDDF\n',
    );
    const file = buildRouteFile(root, 'fixed');
    expect(file).toEqual({
      format: ROUTES_FORMAT,
      source: expect.stringContaining('standing-data'),
      license: 'CC0-1.0',
      generatedAt: 'fixed',
      airports: { EDDF: ['Frankfurt-am-Main, International', 'FRA', 50.0264, 8.5431], EGLL: ['London Heathrow', 'LHR', 51.4706, -0.4619] },
      routes: { DLH901: 'EGLL-EDDF' },
    });
  });
});
