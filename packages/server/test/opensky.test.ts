import { describe, expect, it, vi } from 'vitest';
import { OpenSkyClient, OpenSkyError, TokenManager, type FetchLike } from '../src/opensky';

const SECRET = 'super-secret-value';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function tokenFetch(tokens: string[], expiresIn = 1800): FetchLike & ReturnType<typeof vi.fn> {
  let i = 0;
  return vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ access_token: tokens[i++] ?? 'extra', expires_in: expiresIn }));
}

describe('TokenManager', () => {
  it('exchanges client credentials and caches the token until shortly before expiry', async () => {
    let now = 0;
    const fetch = tokenFetch(['t1', 't2']);
    const tm = new TokenManager({ clientId: 'id', clientSecret: SECRET, tokenUrl: 'https://auth.test/token', fetch, now: () => now });
    expect(await tm.getToken()).toBe('t1');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://auth.test/token');
    expect(init?.method).toBe('POST');
    expect(String(init?.body)).toBe(`grant_type=client_credentials&client_id=id&client_secret=${SECRET}`);

    now = 1000 * 1000;
    expect(await tm.getToken()).toBe('t1');
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 1750 * 1000; // inside the 60 s refresh margin
    expect(await tm.getToken()).toBe('t2');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares one refresh between concurrent callers', async () => {
    const fetch = tokenFetch(['t1']);
    const tm = new TokenManager({ clientId: 'id', clientSecret: SECRET, fetch });
    const tokens = await Promise.all([tm.getToken(), tm.getToken(), tm.getToken()]);
    expect(tokens).toEqual(['t1', 't1', 't1']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports token failures without echoing credentials or response bodies', async () => {
    const fetch: FetchLike = async () => new Response(`invalid client ${SECRET}`, { status: 401 });
    const tm = new TokenManager({ clientId: 'id', clientSecret: SECRET, fetch });
    const err = await tm.getToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenSkyError);
    expect((err as OpenSkyError).kind).toBe('auth');
    expect((err as Error).message).not.toContain(SECRET);
  });
});

describe('OpenSkyClient', () => {
  it('sends anonymous requests without an Authorization header', async () => {
    const fetch = vi.fn<FetchLike>(async () => jsonResponse({ time: 1, states: [] }, 200, { 'X-Rate-Limit-Remaining': '396' }));
    const client = new OpenSkyClient({ tokens: null, fetch, baseUrl: 'https://api.test/api/' });
    const res = await client.fetchAllStates();
    expect(res.creditsRemaining).toBe(396);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.test/api/states/all');
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('uses the bearer token and re-authenticates once after a 401', async () => {
    const auth = tokenFetch(['old', 'new']);
    const tokens = new TokenManager({ clientId: 'id', clientSecret: SECRET, fetch: auth });
    const seen: string[] = [];
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      const header = (init?.headers as Record<string, string>).Authorization!;
      seen.push(header);
      return header === 'Bearer old' ? new Response('', { status: 401 }) : jsonResponse({ time: 1, states: [] });
    });
    const client = new OpenSkyClient({ tokens, fetch });
    await client.fetchAllStates();
    expect(seen).toEqual(['Bearer old', 'Bearer new']);
  });

  it('does not loop when credentials keep being rejected', async () => {
    const tokens = new TokenManager({ clientId: 'id', clientSecret: SECRET, fetch: tokenFetch(['a', 'b', 'c']) });
    const fetch = vi.fn<FetchLike>(async () => new Response('', { status: 401 }));
    const client = new OpenSkyClient({ tokens, fetch });
    await expect(client.fetchAllStates()).rejects.toMatchObject({ kind: 'auth', status: 401 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('surfaces rate limits with the server-provided retry delay', async () => {
    const fetch: FetchLike = async () => new Response('', { status: 429, headers: { 'X-Rate-Limit-Retry-After-Seconds': '3600' } });
    const client = new OpenSkyClient({ tokens: null, fetch });
    await expect(client.fetchAllStates()).rejects.toMatchObject({ kind: 'rate-limit', retryAfterS: 3600 });
  });

  it('classifies timeouts, network failures, HTTP errors and bad JSON', async () => {
    const timeout: FetchLike = async () => {
      throw new DOMException('timed out', 'TimeoutError');
    };
    await expect(new OpenSkyClient({ tokens: null, fetch: timeout }).fetchAllStates()).rejects.toMatchObject({ kind: 'timeout' });
    const network: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(new OpenSkyClient({ tokens: null, fetch: network }).fetchAllStates()).rejects.toMatchObject({ kind: 'network' });
    const http: FetchLike = async () => new Response('', { status: 503 });
    await expect(new OpenSkyClient({ tokens: null, fetch: http }).fetchAllStates()).rejects.toMatchObject({ kind: 'http', status: 503 });
    const bad: FetchLike = async () => new Response('<html>', { status: 200 });
    await expect(new OpenSkyClient({ tokens: null, fetch: bad }).fetchAllStates()).rejects.toMatchObject({ kind: 'parse' });
  });

  it('applies a request timeout signal', async () => {
    const fetch = vi.fn<FetchLike>(async () => jsonResponse({ time: 1, states: [] }));
    await new OpenSkyClient({ tokens: null, fetch, timeoutMs: 1234 }).fetchAllStates();
    expect(fetch.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
