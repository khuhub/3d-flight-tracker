import { describe, expect, it } from 'vitest';
import { nextTrack, parseOpenSkyStates } from '@flight/shared';
import fixture from '../../server/test/fixtures/replay/fixture-0.json';
import { indexAircraft, searchAircraft } from '../src/data/aircraftSearch';

const { snapshot } = parseOpenSkyStates(fixture.response);
const index = indexAircraft(snapshot.aircraft.map((aircraft) => nextTrack(undefined, aircraft, snapshot.time)));
const ids = (query: string) => searchAircraft(index, query).map(({ icao24 }) => icao24);

describe('aircraft search', () => {
  it('finds case-insensitive callsigns and ICAO24 addresses, including aircraft without callsigns', () => {
    expect(ids('  tSt202  ')).toEqual(['3c66a1']);
    expect(ids('4CA9F0')).toEqual(['4ca9f0']);
    expect(ids('66A')).toEqual(['3c66a1']);
  });

  it('ranks prefix matches ahead of substring matches and excludes non-displayed aircraft', () => {
    expect(ids('a')[0]).toBe('a1b2c3');
    expect(ids('gnd001')).toEqual([]);
    expect(ids('  ')).toEqual([]);
  });
});
