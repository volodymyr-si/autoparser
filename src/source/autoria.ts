import type { ListingDetails, ListingSummary, SearchResult, Source } from '../types.js';
import { createHttpClient, type FetchLike, type SleepFn } from './http.js';
import { parseAdPage, parseSearchPage } from './parse.js';

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export interface AutoRiaOptions {
  delayMs?: [number, number];
  fetchImpl?: FetchLike;
  sleep?: SleepFn;
  /** Backoff base for retries (tests pass 0). */
  backoffMs?: number;
}

/**
 * Edit the query string segment by segment so the user's raw `[0]` brackets are never re-encoded.
 */
export function normalizeSearchUrl(userUrl: string, page: number): string {
  const hashAt = userUrl.indexOf('#');
  const noHash = hashAt >= 0 ? userUrl.slice(0, hashAt) : userUrl;
  const q = noHash.indexOf('?');
  const base = q >= 0 ? noHash.slice(0, q) : noHash;
  const segs = q >= 0 ? noHash.slice(q + 1).split('&').filter(Boolean) : [];
  const keyOf = (s: string): string => {
    const k = s.split('=')[0] ?? '';
    try {
      return decodeURIComponent(k);
    } catch {
      return k;
    }
  };
  const has = (k: string): boolean => segs.some((s) => keyOf(s) === k);
  const hasSort = segs.some((s) => keyOf(s).startsWith('sort[') || keyOf(s) === 'order_by');
  const kept = segs.filter((s) => keyOf(s) !== 'page' && keyOf(s) !== 'size');
  if (!has('indexName')) kept.push('indexName=auto');
  if (!hasSort) kept.push('sort[0].order=dates.created.desc');
  kept.push(`size=${PAGE_SIZE}`, `page=${page}`);
  return `${base}?${kept.join('&')}`;
}

function removedDetails(id: number): ListingDetails {
  return {
    id, status: 'removed', vin: null, plate: null, publishedAt: null, priceUsd: null,
    price: null, currency: null, brand: null, model: null, year: null, mileageKm: null, city: null,
  };
}

export function createAutoRiaSource(opts: AutoRiaOptions = {}): Source {
  const http = createHttpClient({
    delayMs: opts.delayMs,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    backoffMs: opts.backoffMs,
  });

  return {
    async search(url: string): Promise<SearchResult> {
      const byId = new Map<number, ListingSummary>();
      let total = 0;
      let pages = MAX_PAGES;
      for (let page = 0; page < pages; page++) {
        const res = await http.get(normalizeSearchUrl(url, page));
        if (res.status !== 200) throw new Error(`Search page ${page} returned HTTP ${res.status}`);
        const parsed = parseSearchPage(res.body);
        if (page === 0) {
          total = parsed.total;
          pages = Math.min(MAX_PAGES, parsed.maxPage ?? Math.ceil(total / PAGE_SIZE));
        }
        if (parsed.listings.length === 0) break;
        for (const l of parsed.listings) if (!byId.has(l.id)) byId.set(l.id, l);
      }
      return { total, listings: [...byId.values()] };
    },

    async details(id: number): Promise<ListingDetails> {
      const res = await http.get(`https://auto.ria.com/uk/auto___${id}.html`, { redirect: 'manual' });
      if (res.status === 301 || res.status === 302 || res.status === 404) return removedDetails(id);
      if (res.status === 200) return parseAdPage(res.body, id);
      throw new Error(`Unexpected HTTP ${res.status} for ad ${id}`);
    },

    get requestCount() {
      return http.requestCount;
    },
  };
}
