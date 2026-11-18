export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type OpenSkyErrorKind = 'auth' | 'rate-limit' | 'http' | 'network' | 'timeout' | 'parse';

export class OpenSkyError extends Error {
  override name = 'OpenSkyError';
  constructor(
    message: string,
    readonly kind: OpenSkyErrorKind,
    readonly status: number | null = null,
    readonly retryAfterS: number | null = null,
  ) {
    super(message);
  }
}

export const DEFAULT_TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
export const DEFAULT_API_URL = 'https://opensky-network.org/api';

export interface TokenManagerOptions {
  clientId: string;
  clientSecret: string;
  tokenUrl?: string;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  /** Refresh this many seconds before the token's stated expiry. */
  refreshMarginS?: number;
}

/** OAuth2 client-credentials token cache. Concurrent callers share one refresh. */
export class TokenManager {
  private token: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<string> | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(private readonly options: TokenManagerOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  async getToken(): Promise<string> {
    if (this.token !== null && this.now() < this.expiresAt) return this.token;
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }

  private async refresh(): Promise<string> {
    const { clientId, clientSecret, tokenUrl = DEFAULT_TOKEN_URL, timeoutMs = 15_000, refreshMarginS = 60 } = this.options;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
    let res: Response;
    try {
      res = await this.fetchImpl(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw transportError('Token request', err);
    }
    if (!res.ok) {
      // The response body is deliberately not echoed: it can reflect request details.
      throw new OpenSkyError(`Token request failed with HTTP ${res.status}`, 'auth', res.status);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new OpenSkyError('Token response was not JSON', 'auth', res.status);
    }
    const { access_token: accessToken, expires_in: expiresIn } = json as { access_token?: unknown; expires_in?: unknown };
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new OpenSkyError('Token response had no access_token', 'auth', res.status);
    }
    const lifetimeS = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 1800;
    this.token = accessToken;
    this.expiresAt = this.now() + Math.max(lifetimeS - refreshMarginS, lifetimeS / 2) * 1000;
    return accessToken;
  }
}

export interface OpenSkyClientOptions {
  baseUrl?: string;
  tokens: TokenManager | null;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface StatesResponse {
  body: unknown;
  creditsRemaining: number | null;
}

/** Minimal `/states/all` client: one request per call, plus a single re-auth on 401. */
export class OpenSkyClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenSkyClientOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get authenticated(): boolean {
    return this.options.tokens !== null;
  }

  async fetchAllStates(): Promise<StatesResponse> {
    let res = await this.request();
    if (res.status === 401 && this.options.tokens) {
      this.options.tokens.invalidate();
      res = await this.request();
    }
    const remaining = numberHeader(res, 'x-rate-limit-remaining');
    if (res.status === 429) {
      const retryAfter = numberHeader(res, 'x-rate-limit-retry-after-seconds');
      throw new OpenSkyError('OpenSky rate limit reached (HTTP 429)', 'rate-limit', 429, retryAfter);
    }
    if (res.status === 401 || res.status === 403) {
      throw new OpenSkyError(`OpenSky rejected the credentials (HTTP ${res.status})`, 'auth', res.status);
    }
    if (!res.ok) throw new OpenSkyError(`OpenSky returned HTTP ${res.status}`, 'http', res.status);
    try {
      return { body: await res.json(), creditsRemaining: remaining };
    } catch {
      throw new OpenSkyError('OpenSky response was not valid JSON', 'parse', res.status);
    }
  }

  private async request(): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.options.tokens) headers.Authorization = `Bearer ${await this.options.tokens.getToken()}`;
    try {
      return await this.fetchImpl(`${this.baseUrl}/states/all`, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw transportError('OpenSky request', err);
    }
  }
}

function transportError(what: string, err: unknown): OpenSkyError {
  if (err instanceof OpenSkyError) return err;
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return new OpenSkyError(`${what} timed out`, 'timeout');
  return new OpenSkyError(`${what} failed: ${err instanceof Error ? err.message : String(err)}`, 'network');
}

function numberHeader(res: Response, name: string): number | null {
  const raw = res.headers.get(name);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function createClientFromCredentials(
  creds: { clientId: string; clientSecret: string },
  opts: { apiUrl?: string; tokenUrl?: string; fetch?: FetchLike; timeoutMs?: number } = {},
): OpenSkyClient {
  const hasCreds = creds.clientId.length > 0 && creds.clientSecret.length > 0;
  const tokens = hasCreds
    ? new TokenManager({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        ...(opts.tokenUrl ? { tokenUrl: opts.tokenUrl } : {}),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      })
    : null;
  return new OpenSkyClient({
    tokens,
    ...(opts.apiUrl ? { baseUrl: opts.apiUrl } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
}
