// Polite sequential HTTP client over global fetch.

export class BlockedError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'BlockedError';
  }
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  body: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number) => Promise<void>;

export interface HttpClientOptions {
  /** [min, max] ms of random delay between consecutive requests. Default [1000, 3000]. */
  delayMs?: [number, number];
  fetchImpl?: FetchLike;
  sleep?: SleepFn;
  /** Random source in [0,1); injectable for tests. */
  random?: () => number;
  /** Retries after the first attempt (network errors, timeouts and 5xx). Default 5. */
  maxRetries?: number;
  /** Base for exponential backoff in ms. Default 5000: 5+10+20+40+80 s rides out a short network outage. */
  backoffMs?: number;
  /** Per-request timeout in ms. Default 30000. */
  timeoutMs?: number;
}

export interface GetOptions {
  redirect?: 'follow' | 'manual';
}

export interface HttpClient {
  get(url: string, opts?: GetOptions): Promise<HttpResponse>;
  /** Actual fetch calls made, retries included. */
  readonly requestCount: number;
}

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept-Language': 'uk-UA,uk;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

/** A small 200 page without the app payload that talks about a captcha/challenge. */
function looksLikeChallenge(body: string): boolean {
  if (body.includes('__PINIA__')) return false;
  if (body.length > 50_000) return false;
  return /captcha|challenge-platform|cf-chl|just a moment|attention required|access denied|are you a robot|перевірка безпеки/i.test(
    body,
  );
}

/** "fetch failed" alone says nothing; undici puts the real reason (ECONNRESET, ETIMEDOUT…) in `cause`. */
function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause as { code?: string; message?: string } | undefined;
  const detail = cause?.code ?? cause?.message;
  return detail && !e.message.includes(detail) ? `${e.message} (${detail})` : e.message;
}

export function createHttpClient(opts: HttpClientOptions = {}): HttpClient {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const [minDelay, maxDelay] = opts.delayMs ?? [1000, 3000];
  const maxRetries = opts.maxRetries ?? 5;
  const backoffMs = opts.backoffMs ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let count = 0;
  let first = true;

  async function politeDelay(): Promise<void> {
    if (first) {
      first = false;
      return;
    }
    const ms = minDelay + random() * Math.max(0, maxDelay - minDelay);
    if (ms > 0) await sleep(ms);
  }

  async function get(url: string, o: GetOptions = {}): Promise<HttpResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
      else await politeDelay();
      count++;
      let res: Response;
      let body: string;
      try {
        res = await fetchImpl(url, {
          headers: HEADERS,
          redirect: o.redirect ?? 'follow',
          signal: AbortSignal.timeout(timeoutMs),
        });
        body = await res.text();
      } catch (e) {
        lastError = e;
        continue;
      }
      if (res.status === 403 || res.status === 429) {
        throw new BlockedError(
          `auto.ria.com blocked the request (HTTP ${res.status}) for ${url}; aborting instead of recording bad data`,
          res.status,
          url,
        );
      }
      if (res.status >= 500) {
        lastError = new Error(`HTTP ${res.status} for ${url}`);
        continue;
      }
      if (res.status === 200 && looksLikeChallenge(body)) {
        throw new BlockedError(`auto.ria.com returned a captcha/challenge page for ${url}`, 200, url);
      }
      return { status: res.status, headers: res.headers, body };
    }
    const msg = describe(lastError);
    throw new Error(`Request failed after ${maxRetries + 1} attempts: ${url}: ${msg}`);
  }

  return {
    get,
    get requestCount() {
      return count;
    },
  };
}
