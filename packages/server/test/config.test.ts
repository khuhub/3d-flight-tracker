import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('defaults to replay with a three-minute live interval', () => {
    const c = loadConfig({}, [], () => true);
    expect(c.mode).toBe('replay');
    expect(c.pollIntervalS).toBe(180);
    expect(c.replayDir).toMatch(/data[/\\]recordings$/);
    expect(c.replayFallback).toBe(false);
    expect(c.routesFile).toMatch(/data[/\\]routes[/\\]routes\.json\.gz$/);
  });

  it('replays the synthetic fixture and its routes when no recordings exist', () => {
    const c = loadConfig({}, [], () => false);
    expect(c.replayFallback).toBe(true);
    expect(c.replayDir).toMatch(/fixtures[/\\]replay$/);
    expect(c.routesFile).toMatch(/fixtures[/\\]routes[/\\]routes\.json$/);
    // Live mode still uses the real route database; explicit settings always win.
    expect(loadConfig({ FLIGHT_MODE: 'live' }, [], () => false).routesFile).toMatch(/routes\.json\.gz$/);
    const explicit = loadConfig({ REPLAY_DIR: '/tmp/mine' }, [], () => false);
    expect(explicit.replayFallback).toBe(false);
    expect(explicit.replayDir).toBe('/tmp/mine');
  });

  it('only goes live when asked explicitly', () => {
    expect(loadConfig({ FLIGHT_MODE: 'live' }, []).mode).toBe('live');
    expect(loadConfig({ FLIGHT_MODE: 'live' }, ['--mode=replay']).mode).toBe('replay');
    expect(() => loadConfig({ FLIGHT_MODE: 'turbo' }, [])).toThrow(/Unknown mode/);
  });

  it('refuses poll intervals that would burn through the quota', () => {
    expect(() => loadConfig({ POLL_INTERVAL_S: '5' }, [])).toThrow(/at least 30/);
    expect(loadConfig({ POLL_INTERVAL_S: '900' }, []).pollIntervalS).toBe(900);
  });
});
