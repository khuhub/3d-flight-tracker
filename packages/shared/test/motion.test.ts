import { describe, expect, it } from 'vitest';
import {
  CORRECTION_BLEND_S,
  EARTH_RADIUS_M,
  MAX_EXTRAPOLATION_S,
  estimateTrack,
  extrapolate,
  haversineDistance,
  lerpHeading,
  nextTrack,
  normalizeLon,
  slerpLatLon,
  unitVector,
  vectorToLatLon,
  type Aircraft,
} from '../src';

const T = 1_700_000_000;

function aircraft(overrides: Partial<Aircraft> = {}): Aircraft {
  return {
    icao24: 'abc123',
    callsign: 'TEST1',
    originCountry: 'Nowhere',
    timePosition: T,
    lastContact: T,
    lat: 0,
    lon: 0,
    altitude: 10_000,
    velocity: 250,
    heading: 90,
    verticalRate: 0,
    ...overrides,
  };
}

describe('geo helpers', () => {
  it('converts between lat/lon and scene vectors', () => {
    expect(unitVector(0, 0)).toEqual([1, 0, -0]);
    const v = unitVector(0, 90);
    expect(v[2]).toBeCloseTo(-1);
    const back = vectorToLatLon(...unitVector(37.5, -122.3));
    expect(back.lat).toBeCloseTo(37.5);
    expect(back.lon).toBeCloseTo(-122.3);
  });

  it('normalises longitudes and slerps across the dateline the short way', () => {
    expect(normalizeLon(190)).toBe(-170);
    expect(normalizeLon(-190)).toBe(170);
    const mid = slerpLatLon(10, 179, 10, -179, 0.5);
    expect(Math.abs(mid.lon)).toBeCloseTo(180, 0);
    expect(haversineDistance(10, 179, 10, -179)).toBeLessThan(250_000);
  });

  it('interpolates headings along the shorter turn', () => {
    expect(lerpHeading(350, 10, 0.5)).toBeCloseTo(0);
    expect(lerpHeading(10, 350, 0.25)).toBeCloseTo(5);
  });
});

describe('extrapolate', () => {
  it('moves along the great circle at the reported speed', () => {
    const e = extrapolate(aircraft(), T + 100);
    expect(e.lat).toBeCloseTo(0, 6);
    expect(e.lon).toBeCloseTo(((250 * 100) / EARTH_RADIUS_M) * (180 / Math.PI), 6);
    expect(e.stale).toBe(false);
  });

  it('stops at the documented extrapolation cutoff and flags the aircraft stale', () => {
    const atCutoff = extrapolate(aircraft(), T + MAX_EXTRAPOLATION_S);
    const later = extrapolate(aircraft(), T + MAX_EXTRAPOLATION_S + 600);
    expect(later.lon).toBeCloseTo(atCutoff.lon, 9);
    expect(later.stale).toBe(true);
    expect(atCutoff.stale).toBe(false);
  });

  it('keeps aircraft without speed or heading in place and never moves backwards in time', () => {
    expect(extrapolate(aircraft({ velocity: null }), T + 60)).toMatchObject({ lat: 0, lon: 0 });
    expect(extrapolate(aircraft({ heading: null }), T + 60)).toMatchObject({ lat: 0, lon: 0 });
    expect(extrapolate(aircraft(), T - 60)).toMatchObject({ lat: 0, lon: 0 });
  });

  it('wraps across the antimeridian', () => {
    const e = extrapolate(aircraft({ lon: 179.99, lat: 60 }), T + 60);
    expect(e.lon).toBeLessThan(-179.5);
    expect(haversineDistance(60, 179.99, e.lat, e.lon)).toBeCloseTo(250 * 60, -1);
  });
});

describe('correction blending', () => {
  it('glides from the previously displayed position to the corrected estimate', () => {
    const first = nextTrack(undefined, aircraft(), T);
    const now = T + 180;
    const shownBefore = estimateTrack(first, now);
    // The new report puts the aircraft about 5 km north of where it was being drawn.
    const corrected = aircraft({ timePosition: now, lat: 0.045, lon: shownBefore.lon });
    const track = nextTrack(first, corrected, now);
    expect(track.correctionFrom).not.toBeNull();

    const start = estimateTrack(track, now);
    expect(haversineDistance(start.lat, start.lon, shownBefore.lat, shownBefore.lon)).toBeLessThan(1);

    const end = estimateTrack(track, now + CORRECTION_BLEND_S);
    const target = extrapolate(corrected, now + CORRECTION_BLEND_S);
    expect(haversineDistance(end.lat, end.lon, target.lat, target.lon)).toBeLessThan(1);
    expect(track.correctionFrom).toBeNull();
  });

  it('snaps instead of sweeping when the correction is implausibly large', () => {
    const first = nextTrack(undefined, aircraft(), T);
    const track = nextTrack(first, aircraft({ timePosition: T + 10, lat: 5 }), T + 10);
    expect(track.correctionFrom).toBeNull();
  });
});
