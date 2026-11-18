import { describe, expect, it } from 'vitest';
import { OpenSkyParseError, fromWire, parseOpenSkyStates, toWire } from '../src';

const T = 1_700_000_000;

function row(overrides: Record<number, unknown> = {}): unknown[] {
  const r: unknown[] = ['ABC123', 'DLH4XY  ', 'Germany', T - 2, T, 8.5, 50.1, 10_000, false, 230, 95.5, -1.2, null, 10_200, '1000', false, 0];
  for (const [k, v] of Object.entries(overrides)) r[Number(k)] = v;
  return r;
}

describe('parseOpenSkyStates', () => {
  it('normalises a valid airborne state vector', () => {
    const { snapshot, stats } = parseOpenSkyStates({ time: T, states: [row()] });
    expect(stats).toMatchObject({ total: 1, kept: 1, grounded: 0, invalid: 0 });
    expect(snapshot.time).toBe(T);
    expect(snapshot.aircraft[0]).toEqual({
      icao24: 'abc123',
      callsign: 'DLH4XY',
      originCountry: 'Germany',
      timePosition: T - 2,
      lastContact: T,
      lat: 50.1,
      lon: 8.5,
      altitude: 10_000,
      velocity: 230,
      heading: 95.5,
      verticalRate: -1.2,
    });
  });

  it('filters grounded aircraft and missing or invalid positions', () => {
    const { snapshot, stats } = parseOpenSkyStates({
      time: T,
      states: [
        row({ 8: true }),
        row({ 0: 'b00001', 5: null }),
        row({ 0: 'b00002', 6: null }),
        row({ 0: 'b00003', 6: 91 }),
        row({ 0: 'b00004', 5: -181 }),
        row({ 0: 'b00005', 3: null }),
        row({ 0: 'not-hex' }),
        'garbage',
        [1, 2],
        row({ 0: 'b00006' }),
      ],
    });
    expect(stats.grounded).toBe(1);
    expect(stats.invalid).toBe(8);
    expect(snapshot.aircraft.map((a) => a.icao24)).toEqual(['b00006']);
  });

  it('falls back to geometric altitude and tolerates missing optional fields', () => {
    const { snapshot } = parseOpenSkyStates({ time: T, states: [row({ 1: '   ', 7: null, 9: null, 10: null, 11: null })] });
    const a = snapshot.aircraft[0]!;
    expect(a.callsign).toBeNull();
    expect(a.altitude).toBe(10_200);
    expect(a.velocity).toBeNull();
    expect(a.heading).toBeNull();
    expect(a.verticalRate).toBeNull();
  });

  it('drops positions older than the stale limit and clears implausible speeds', () => {
    const { snapshot, stats } = parseOpenSkyStates({
      time: T,
      states: [row({ 0: 'c00001', 3: T - 7000 }), row({ 0: 'c00002', 9: 2215 }), row({ 0: 'c00003', 9: 340 })],
    });
    expect(stats.stale).toBe(1);
    expect(stats.implausibleSpeed).toBe(1);
    expect(snapshot.aircraft.find((a) => a.icao24 === 'c00002')?.velocity).toBeNull();
    expect(snapshot.aircraft.find((a) => a.icao24 === 'c00003')?.velocity).toBe(340);
  });

  it('keeps the newest report when an aircraft appears twice', () => {
    const { snapshot, stats } = parseOpenSkyStates({ time: T, states: [row({ 3: T - 1, 6: 1 }), row({ 3: T - 9, 6: 2 })] });
    expect(stats.duplicates).toBe(1);
    expect(snapshot.aircraft).toHaveLength(1);
    expect(snapshot.aircraft[0]!.lat).toBe(1);
  });

  it('accepts a null states array and rejects malformed envelopes', () => {
    expect(parseOpenSkyStates({ time: T, states: null }).snapshot.aircraft).toEqual([]);
    expect(() => parseOpenSkyStates(null)).toThrow(OpenSkyParseError);
    expect(() => parseOpenSkyStates({ states: [] })).toThrow(OpenSkyParseError);
    expect(() => parseOpenSkyStates({ time: T, states: {} })).toThrow(OpenSkyParseError);
  });

  it('round-trips through the compact wire format', () => {
    const a = parseOpenSkyStates({ time: T, states: [row()] }).snapshot.aircraft[0]!;
    expect(fromWire(toWire(a))).toEqual(a);
  });
});
