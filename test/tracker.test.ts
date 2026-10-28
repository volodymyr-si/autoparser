import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { runTracker } from '../src/tracker.js';
import type { ListingDetails, ListingSummary, RunReport, SearchConfig, SearchResult, Source } from '../src/types.js';

/** In-memory Source: tests mutate `results` / `pages` between runs. */
class FakeSource implements Source {
  requestCount = 0;
  results = new Map<string, SearchResult | Error>();
  pages = new Map<number, Partial<ListingDetails> | Error>();
  detailCalls: number[] = [];

  setSearch(url: string, listings: ListingSummary[], total = listings.length): void {
    this.results.set(url, { total, listings });
  }
  async search(url: string): Promise<SearchResult> {
    this.requestCount++;
    const r = this.results.get(url);
    if (!r) throw new Error(`no scripted result for ${url}`);
    if (r instanceof Error) throw r;
    return r;
  }
  /** Default ad pages mirror the card: a USD-priced seller. */
  private cardFor(id: number): ListingSummary | undefined {
    for (const r of this.results.values()) {
      const hit = r instanceof Error ? undefined : r.listings.find((l) => l.id === id);
      if (hit) return hit;
    }
    return undefined;
  }
  async details(id: number): Promise<ListingDetails> {
    this.requestCount++;
    this.detailCalls.push(id);
    const p = this.pages.get(id) ?? {};
    if (p instanceof Error) throw p;
    const card = this.cardFor(id);
    return {
      id, status: 'active', vin: null, plate: null, publishedAt: null, priceUsd: card?.priceUsd ?? null,
      price: card?.priceUsd ?? null, currency: card?.priceUsd != null ? 'USD' : null,
      brand: 'Toyota', model: 'Camry', year: 2018, mileageKm: 98765, city: 'Київ',
      ...p,
    };
  }
}

const day = (n: number) => new Date(Date.UTC(2026, 9, 1 + n, 9)).toISOString();
const A: SearchConfig = { name: 'A', url: 'https://auto.ria.com/a', enabled: true };
const B: SearchConfig = { name: 'B', url: 'https://auto.ria.com/b', enabled: true };

const ad = (id: number, priceUsd: number | null = 10000): ListingSummary => ({
  id,
  url: `https://auto.ria.com/ad_${id}.html`,
  title: `Toyota Camry ${id}`,
  brand: 'Toyota',
  model: 'Camry',
  year: 2018,
  mileageKm: 100000,
  city: 'Київ',
  priceUsd,
  priceUah: null,
  priceEur: null,
  plate: null,
});

/** UAH-priced card: the USD figure drifts with FX, so it is passed separately. */
const adUah = (id: number, priceUah: number, priceUsd: number): ListingSummary => ({ ...ad(id, priceUsd), priceUah });

let db: DatabaseSync;
let src: FakeSource;
let n: number;

/** Runs the tracker on the next "day". */
const run = (searches: SearchConfig[] = [A], at = n++) => runTracker(db, src, searches, day(at));

const all = <T = any>(sql: string, ...p: any[]) => db.prepare(sql).all(...p) as T[];
const status = (id: number) => (db.prepare('SELECT status FROM listings WHERE id = ?').get(id) as any)?.status;
const eventTypes = (r: RunReport) =>
  all<{ type: string }>('SELECT type FROM events WHERE run_id = ? ORDER BY id', r.runId).map((e) => e.type);
const prices = (id: number) =>
  all<{ price_usd: number }>('SELECT price_usd FROM price_history WHERE listing_id = ? ORDER BY observed_at', id).map((r) => r.price_usd);

beforeEach(() => {
  db = openDb(':memory:');
  src = new FakeSource();
  n = 0;
  src.setSearch(A.url, [ad(1), ad(2)]);
  src.setSearch(B.url, [ad(2), ad(3)]);
});

describe('baseline and new listings', () => {
  it('first run records everything without events', async () => {
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.searches[0]).toMatchObject({ baseline: true, activeCount: 2, newListings: [], soldCount: 0 });
    expect(all('SELECT * FROM events')).toEqual([]);
    expect(all('SELECT * FROM listings')).toHaveLength(2);
    expect(prices(1)).toEqual([10000]);
    expect((all('SELECT * FROM runs')[0] as any)).toMatchObject({ ok: 1, finished_at: day(0) });
  });

  it('reports a new listing on the next day with details-derived vehicle', async () => {
    await run();
    src.setSearch(A.url, [ad(1), ad(2), ad(3, 9000)]);
    src.pages.set(3, { vin: 'VIN3', plate: 'AA1111AA' });
    const r = await run();
    const s = r.searches[0]!;
    expect(s.baseline).toBe(false);
    expect(s.newListings.map((l) => l.id)).toEqual([3]);
    expect(s.newListings[0]).toMatchObject({ priceUsd: 9000, daysOnMarket: 0 });
    expect(s.activeCount).toBe(3);
    expect(all('SELECT vin, plate FROM vehicles WHERE vin = ?', 'VIN3')).toHaveLength(1);
  });

  it('daysOnMarket uses publishedAt when it is earlier than first sight', async () => {
    await run();
    src.setSearch(A.url, [ad(1), ad(2), ad(3)]);
    src.pages.set(3, { vin: 'V3', publishedAt: day(-5) });
    const r = await run(); // now = day(1), published 6 days earlier
    expect(r.searches[0]!.newListings[0]!.daysOnMarket).toBe(6);
  });

  it('ignores a publishedAt in the future', async () => {
    await run();
    src.setSearch(A.url, [ad(1), ad(2), ad(3)]);
    src.pages.set(3, { publishedAt: day(50) });
    const r = await run();
    expect(r.searches[0]!.newListings[0]!.daysOnMarket).toBe(0);
  });
});

describe('prices', () => {
  it('price drop emits an event with old/new; increase only adds history', async () => {
    await run();
    src.setSearch(A.url, [ad(1, 9000), ad(2, 11000)]);
    const r = await run();
    
    expect(eventTypes(r)).toEqual(['price_drop']);
    expect(prices(1)).toEqual([10000, 9000]);
    expect(prices(2)).toEqual([10000, 11000]);
  });

  it('unchanged price adds no history; null price never drops', async () => {
    await run();
    src.setSearch(A.url, [ad(1), ad(2, null)]);
    const r = await run();
    expect(eventTypes(r)).toEqual([]);
    expect(prices(1)).toEqual([10000]);
    expect(prices(2)).toEqual([10000]);
  });
});

describe('disappearing listings', () => {
  it.each(['sold', 'removed'] as const)('page status %s becomes sold', async (pageStatus) => {
    await run();
    src.setSearch(A.url, [ad(1)]);
    src.pages.set(2, { status: pageStatus });
    const r = await run();
    expect(status(2)).toBe('sold');
    expect(eventTypes(r)).toEqual(['sold']);
    expect(r.searches[0]).toMatchObject({ soldCount: 1, activeCount: 1 });
    expect((all('SELECT closed_at FROM listings WHERE id = 2')[0] as any).closed_at).toBe(day(1));
  });

  it('sold report carries the last and the first price', async () => {
    await run();
    src.setSearch(A.url, [ad(1), ad(2, 9000)]);
    await run();
    src.setSearch(A.url, [ad(1)]);
    src.pages.set(2, { status: 'removed' });
    const r = await run();
    expect(r.searches[0]!.sold).toEqual([
      expect.objectContaining({ id: 2, price: 9000, currency: 'USD', firstPrice: 10000, priceUsd: 9000, daysOnMarket: 2 }),
    ]);
  });

  it('out_of_filter then back with the same history', async () => {
    await run();
    src.setSearch(A.url, [ad(1)]);
    src.pages.set(2, { status: 'active' });
    const r1 = await run();
    expect(status(2)).toBe('out_of_filter');
    expect(r1.searches[0]).toMatchObject({ outOfFilterCount: 1, soldCount: 0 });

    src.detailCalls.length = 0;
    const r2 = await run(); // still gone: no longer tracked, no further requests
    expect(src.detailCalls).toEqual([]);
    expect(eventTypes(r2)).toEqual([]);

    src.setSearch(A.url, [ad(1), ad(2, 9500)]);
    const r3 = await run();
    expect(status(2)).toBe('active');
    expect(r3.searches[0]).toMatchObject({ backCount: 1, activeCount: 2 });
    expect(eventTypes(r3)).toEqual(['price_drop', 'back']);
    expect(prices(2)).toEqual([10000, 9500]);
  });

  it('details failure on a disappeared listing leaves it active and reports an error', async () => {
    await run();
    src.setSearch(A.url, [ad(1)]);
    src.pages.set(2, new Error('boom'));
    const r = await run();
    expect(status(2)).toBe('active');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/2.*boom/);
  });
});

describe('reposts', () => {
  async function repostSetup(extra: Partial<ListingDetails>) {
    src.setSearch(A.url, [ad(1, 10000)]);
    src.pages.set(1, { vin: 'VIN1', plate: 'KA1234AB' });
    await run();
    src.setSearch(A.url, [ad(5, 9000)]);
    src.pages.set(5, extra);
    src.pages.set(1, { status: 'removed' });
    return run();
  }

  it('same VIN on the day the old ad disappears: repost, old is relisted, no sold', async () => {
    const r = await repostSetup({ vin: 'VIN1', plate: null });
    const s = r.searches[0]!;
    expect(s.newListings).toEqual([]);
    expect(s.reposts.map((l) => l.id)).toEqual([5]);
    expect(s.priceDrops).toMatchObject([{ currency: 'USD', oldPrice: 10000, newPrice: 9000, listing: { id: 5 } }]);
    expect(s.soldCount).toBe(0);
    expect(eventTypes(r)).toEqual(['repost', 'price_drop']);
    expect(status(1)).toBe('relisted');
    expect(status(5)).toBe('active');
    expect(all('SELECT DISTINCT vehicle_id FROM listings')).toHaveLength(1);
    expect(s.activeCount).toBe(1);
  });

  it('same plate with a different VIN source still matches; vehicle learns the VIN', async () => {
    const r = await repostSetup({ vin: null, plate: 'KA1234AB' });
    expect(r.searches[0]!.reposts.map((l) => l.id)).toEqual([5]);
    expect(status(1)).toBe('relisted');
  });

  it('repost keeps days on market from the original vehicle', async () => {
    const r = await repostSetup({ vin: 'VIN1' });
    expect(r.searches[0]!.reposts[0]!.daysOnMarket).toBe(1);
  });

  it('a different VIN and plate is a new vehicle', async () => {
    const r = await repostSetup({ vin: 'OTHER', plate: 'XX0000XX' });
    expect(r.searches[0]!.newListings.map((l) => l.id)).toEqual([5]);
    expect(status(1)).toBe('sold');
    expect(eventTypes(r)).toEqual(['new', 'sold']);
  });

  it('null plates never match each other', async () => {
    src.setSearch(A.url, [ad(1)]);
    await run();
    src.setSearch(A.url, [ad(1), ad(5)]);
    const r = await run();
    expect(r.searches[0]!.newListings.map((l) => l.id)).toEqual([5]);
  });
});

describe('failures', () => {
  it('a failed search yields no sold events and run.ok=false', async () => {
    await run();
    src.detailCalls.length = 0;
    src.results.set(A.url, new Error('HTTP 429'));
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.searches[0]).toMatchObject({ ok: false, error: 'HTTP 429', activeCount: 2, soldCount: 0 });
    expect(status(1)).toBe('active');
    expect(src.detailCalls).toEqual([]);
    expect((all('SELECT ok, error FROM runs WHERE id = ?', r.runId)[0] as any)).toMatchObject({ ok: 0 });
  });

  it('sanity check: fewer listings than 90% of total is a failure', async () => {
    await run();
    src.setSearch(A.url, [ad(1)], 20);
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.searches[0]!.error).toMatch(/sanity/);
    expect(status(2)).toBe('active');
  });

  it('sanity check: zero listings with total > 0 fails, and a failed search is not baselined', async () => {
    src.setSearch(A.url, [], 5);
    const r = await run();
    expect(r.ok).toBe(false);
    expect((all('SELECT baseline_at FROM searches')[0] as any).baseline_at).toBeNull();
    src.setSearch(A.url, [ad(1)]);
    const r2 = await run();
    expect(r2.searches[0]!.baseline).toBe(true);
  });

  it('listing in two searches is not marked sold when one search fails', async () => {
    await run([A, B]);
    src.setSearch(A.url, [ad(1)]);
    src.results.set(B.url, new Error('down'));
    src.pages.set(2, { status: 'sold' });
    src.detailCalls.length = 0;
    const r = await run([A, B]);
    expect(status(2)).toBe('active');
    expect(r.searches.map((s) => s.ok)).toEqual([true, false]);
    expect(src.detailCalls).toEqual([]);
  });

  it('listing in two searches is sold when both succeed without it', async () => {
    await run([A, B]);
    src.setSearch(A.url, [ad(1)]);
    src.setSearch(B.url, [ad(3)]);
    src.pages.set(2, { status: 'sold' });
    const r = await run([A, B]);
    expect(status(2)).toBe('sold');
    expect(r.searches.map((s) => s.soldCount)).toEqual([1, 1]);
  });

  it('details failure for a new id still inserts the listing and reports the error', async () => {
    await run();
    src.setSearch(A.url, [ad(1), ad(2), ad(3)]);
    src.pages.set(3, new Error('page 500'));
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/3.*page 500/);
    expect(status(3)).toBe('active');
    expect(r.searches[0]!.newListings.map((l) => l.id)).toEqual([3]);
    expect(all('SELECT vin, plate FROM vehicles WHERE id = (SELECT vehicle_id FROM listings WHERE id = 3)')[0]).toMatchObject({ vin: null, plate: null });
  });

  it('rolls back and marks the run failed if applying throws', async () => {
    src.setSearch(A.url, [ad(1)]);
    await run();
    src.setSearch(A.url, [ad(1), ad(7)]);
    db.exec('CREATE TRIGGER boom BEFORE INSERT ON listings BEGIN SELECT RAISE(ABORT, "boom"); END');
    await expect(run()).rejects.toThrow(/boom/);
    expect(all('SELECT * FROM listings')).toHaveLength(1);
    expect((all('SELECT ok, error FROM runs ORDER BY id DESC LIMIT 1')[0] as any)).toMatchObject({ ok: 0 });
  });
});

describe('search configuration changes', () => {
  it('a search added later is baseline only for itself', async () => {
    await run([A]);
    src.setSearch(A.url, [ad(1), ad(2), ad(4)]);
    src.setSearch(B.url, [ad(2), ad(3)]);
    const r = await run([A, B]);
    const [a, b] = r.searches;
    expect(a!.newListings.map((l) => l.id)).toEqual([4]);
    expect(b).toMatchObject({ baseline: true, newListings: [], activeCount: 2 });
    expect(status(3)).toBe('active');
    expect(eventTypes(r)).toEqual(['new']);

    const r2 = await run([A, B]);
    expect(r2.searches[1]!.baseline).toBe(false);
  });

  it('an id first seen in a baseline and a non-baseline search is reported as new', async () => {
    await run([A]);
    src.setSearch(A.url, [ad(1), ad(2), ad(3)]);
    src.setSearch(B.url, [ad(3)]);
    const r = await run([A, B]);
    expect(r.searches.map((s) => s.newListings.map((l) => l.id))).toEqual([[3], [3]]);
  });

  it('disabled search: listings untouched and not reported', async () => {
    await run([A, B]);
    const off = { ...B, enabled: false };
    src.setSearch(A.url, [ad(1)]);
    src.pages.set(2, { status: 'sold' });
    const r = await run([A, off]);
    expect(r.searches.map((s) => s.search)).toEqual(['A']);
    expect(status(3)).toBe('active'); // only in B
    expect(status(2)).toBe('active'); // also linked to disabled B: no conclusions
    expect((all('SELECT enabled FROM searches WHERE name = ?', 'B')[0] as any).enabled).toBe(0);
    expect(r.ok).toBe(true);
  });

  it('updates the stored url of a renamed-url search', async () => {
    await run([A]);
    src.setSearch('https://auto.ria.com/a2', [ad(1), ad(2)]);
    await run([{ ...A, url: 'https://auto.ria.com/a2' }]);
    expect(all<{ url: string }>('SELECT url FROM searches')).toEqual([{ url: 'https://auto.ria.com/a2' }]);
  });

  it('changing the url re-baselines: newly matching ads are not reported as new', async () => {
    await run([A]);
    const A2 = { ...A, url: 'https://auto.ria.com/a2' };
    src.setSearch(A2.url, [ad(1), ad(2), ad(5)]);
    const r = await run([A2]);
    expect(eventTypes(r)).toEqual([]);
    expect(r.searches[0]!.baseline).toBe(true);
    src.setSearch(A2.url, [ad(1), ad(2), ad(5), ad(6)]);
    expect(eventTypes(await run([A2]))).toEqual(['new']);
  });
});

describe('prices in the seller currency', () => {
  const priceRows = (id: number) =>
    all<{ price: number; currency: string; price_usd: number | null }>(
      'SELECT price, currency, price_usd FROM price_history WHERE listing_id = ? ORDER BY observed_at', id);
  const uahPage = (price: number) => ({ price, currency: 'UAH' as const });

  async function uahBaseline() {
    src.setSearch(A.url, [adUah(1, 400000, 10000)]);
    src.pages.set(1, uahPage(400000));
    await run();
    src.detailCalls.length = 0;
  }

  it('new listing takes brand/model/mileage from the ad page and stores the seller price', async () => {
    await uahBaseline();
    expect(all('SELECT brand, model, mileage_km, price, currency, price_usd FROM listings')[0]).toMatchObject({
      brand: 'Toyota', model: 'Camry', mileage_km: 98765, price: 400000, currency: 'UAH', price_usd: 10000,
    });
  });

  it('later runs keep ad-page fields that the card lacks or rounds', async () => {
    await uahBaseline();
    src.setSearch(A.url, [{ ...adUah(1, 400000, 10000), brand: null, model: null, mileageKm: 99000 }]);
    await run();
    expect(all('SELECT brand, model, mileage_km FROM listings WHERE id = 1')[0]).toMatchObject({
      brand: 'Toyota', model: 'Camry', mileage_km: 98765,
    });
  });

  it('a block while fetching details aborts the run without applying anything', async () => {
    await uahBaseline();
    src.setSearch(A.url, [adUah(1, 400000, 10000), ad(7)]);
    src.pages.set(7, Object.assign(new Error('blocked'), { name: 'BlockedError' }));
    await expect(run()).rejects.toThrow('blocked');
    expect(status(7)).toBeUndefined();
    expect(all('SELECT ok, finished_at FROM runs ORDER BY id DESC LIMIT 1')[0]).toMatchObject({ ok: 0 });
  });

  it('FX drift of the USD value is not a price change', async () => {
    await uahBaseline();
    src.setSearch(A.url, [adUah(1, 400000, 9800)]);
    const r = await run();
    expect(eventTypes(r)).toEqual([]);
    expect(priceRows(1)).toHaveLength(1);
    expect((all('SELECT price_usd FROM listings')[0] as any).price_usd).toBe(9800);
    expect(src.detailCalls).toEqual([]);
  });

  it('lowering the UAH price is a drop in UAH, with USD for display', async () => {
    await uahBaseline();
    src.setSearch(A.url, [adUah(1, 380000, 9500)]);
    const r = await run();
    expect(r.searches[0]!.priceDrops).toMatchObject([
      { currency: 'UAH', oldPrice: 400000, newPrice: 380000, oldPriceUsd: 10000, newPriceUsd: 9500 },
    ]);
    expect(JSON.parse((all('SELECT payload FROM events')[0] as any).payload)).toEqual({
      currency: 'UAH', old: 400000, new: 380000, oldUsd: 10000, newUsd: 9500,
    });
    expect(priceRows(1)).toEqual([
      { price: 400000, currency: 'UAH', price_usd: 10000 },
      { price: 380000, currency: 'UAH', price_usd: 9500 },
    ]);
  });

  it('a UAH increase only adds history', async () => {
    await uahBaseline();
    src.setSearch(A.url, [adUah(1, 420000, 10500)]);
    const r = await run();
    expect(eventTypes(r)).toEqual([]);
    expect(priceRows(1)).toHaveLength(2);
  });

  it('EUR ad with no EUR on the card: details are fetched for the price', async () => {
    const eur = { ...ad(1, 11000), priceEur: null };
    src.setSearch(A.url, [eur]);
    src.pages.set(1, { price: 10000, currency: 'EUR' });
    await run();
    src.detailCalls.length = 0;

    src.pages.set(1, { price: 9000, currency: 'EUR' });
    const r = await run();
    expect(src.detailCalls).toEqual([1]);
    expect(r.searches[0]!.priceDrops).toMatchObject([{ currency: 'EUR', oldPrice: 10000, newPrice: 9000 }]);
  });

  it('EUR ad with the EUR price on the card needs no details call', async () => {
    src.setSearch(A.url, [{ ...ad(1, 11000), priceEur: 10000 }]);
    src.pages.set(1, { price: 10000, currency: 'EUR' });
    await run();
    src.detailCalls.length = 0;
    src.setSearch(A.url, [{ ...ad(1, 11000), priceEur: 9500 }]);
    const r = await run();
    expect(src.detailCalls).toEqual([]);
    expect(r.searches[0]!.priceDrops).toMatchObject([{ currency: 'EUR', oldPrice: 10000, newPrice: 9500 }]);
  });

  it('unknown currency (details failed earlier) is retried next run without a drop', async () => {
    src.setSearch(A.url, [adUah(1, 400000, 10000)]);
    src.pages.set(1, new Error('page 500'));
    await run();
    expect(all('SELECT price, currency FROM listings')[0]).toMatchObject({ price: null, currency: null });
    expect(priceRows(1)).toEqual([]);

    src.detailCalls.length = 0;
    src.pages.set(1, uahPage(390000));
    const r = await run();
    expect(src.detailCalls).toEqual([1]);
    expect(eventTypes(r)).toEqual([]);
    expect(all('SELECT price, currency FROM listings')[0]).toMatchObject({ price: 390000, currency: 'UAH' });
    expect(priceRows(1)).toEqual([{ price: 390000, currency: 'UAH', price_usd: 10000 }]);

    src.detailCalls.length = 0;
    await run();
    expect(src.detailCalls).toEqual([]);
  });

  it('repost across currencies compares USD', async () => {
    src.setSearch(A.url, [adUah(1, 400000, 10000)]);
    src.pages.set(1, { ...uahPage(400000), vin: 'V1' });
    await run();
    src.setSearch(A.url, [ad(5, 9000)]); // now priced in USD
    src.pages.set(5, { vin: 'V1', price: 9000, currency: 'USD' });
    src.pages.set(1, { status: 'removed' });
    const r = await run();
    expect(r.searches[0]!.priceDrops).toMatchObject([{ currency: 'USD', oldPrice: 10000, newPrice: 9000 }]);
    expect(status(1)).toBe('relisted');
  });

  it('repost in the same currency compares seller prices, not USD', async () => {
    src.setSearch(A.url, [adUah(1, 400000, 10000)]);
    src.pages.set(1, { ...uahPage(400000), vin: 'V1' });
    await run();
    src.setSearch(A.url, [adUah(5, 400000, 9000)]); // cheaper in USD only through FX
    src.pages.set(5, { vin: 'V1', ...uahPage(400000) });
    src.pages.set(1, { status: 'removed' });
    const r = await run();
    expect(eventTypes(r)).toEqual(['repost']);
  });

  it('card plate is a fallback for vehicle matching when details failed', async () => {
    src.setSearch(A.url, [{ ...ad(1), plate: 'KA1234AB' }]);
    await run();
    src.setSearch(A.url, [{ ...ad(1), plate: 'KA1234AB' }, { ...ad(6), plate: 'KA1234AB' }]);
    src.pages.set(6, new Error('page 500'));
    const r = await run();
    expect(r.searches[0]!.reposts.map((l) => l.id)).toEqual([6]);
  });
});
