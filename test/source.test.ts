import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAutoRiaSource, normalizeSearchUrl } from '../src/source/autoria.js';
import { BlockedError, createHttpClient } from '../src/source/http.js';
import { extractPinia, kyivDateToIso, normalizePlate, parseAdPage, parseMileage, parseSearchPage } from '../src/source/parse.js';

const fx = (n: string): string => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const page1 = fx('search-page1.html');
const page2 = fx('search-page2.html');

const emptyPage = (): string =>
  `<script>window.__PINIA__ = ${JSON.stringify({
    searchPage: { searchResultData: { count: '12309', maxPage: '616' } },
    list: { lists: { items: { items: [{ component: {} }] } } },
  })};</script>`;

function res(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe('parse helpers', () => {
  it('normalizePlate maps Cyrillic look-alikes and strips separators', () => {
    expect(normalizePlate('KA 3747 MK')).toBe('KA3747MK');
    expect(normalizePlate('ка-3747 мк')).toBe('KA3747MK');
    expect(normalizePlate('АХ 2973 РА')).toBe('AX2973PA');
    expect(normalizePlate('')).toBeNull();
    expect(normalizePlate(null)).toBeNull();
  });

  it('parseMileage handles variants', () => {
    expect(parseMileage('121 тис. км')).toBe(121000);
    expect(parseMileage('850 км')).toBe(850);
    expect(parseMileage('1 200 км')).toBe(1200);
    expect(parseMileage('Без пробігу')).toBe(0);
    expect(parseMileage('Автомат')).toBeNull();
  });

  it('kyivDateToIso handles winter and summer time', () => {
    expect(kyivDateToIso('23.10.2026')).toBe('2026-10-22T21:00:00.000Z');
    expect(kyivDateToIso('15.01.2026')).toBe('2026-01-14T22:00:00.000Z');
  });

  it('extractPinia fails loudly', () => {
    expect(() => extractPinia('<html></html>')).toThrow(/__PINIA__ not found/);
    expect(() => extractPinia('<script>window.__PINIA__ = {oops</script>')).toThrow(/not valid JSON/);
    expect(extractPinia('<script>window.__PINIA__ = {"a":1};</script>')).toEqual({ a: 1 });
  });
});

describe('parseSearchPage', () => {
  it('extracts only Auto cards', () => {
    const r = parseSearchPage(page1);
    expect(r.total).toBe(12309);
    expect(r.maxPage).toBe(616);
    expect(r.listings).toHaveLength(20);
    const camry = r.listings.find((l) => l.id === 37456649)!;
    expect(camry).toMatchObject({
      url: 'https://auto.ria.com/uk/auto_toyota_camry_37456649.html',
      title: 'Toyota Camry 2018',
      brand: null,
      model: null,
      year: 2018,
      mileageKm: 121000,
      city: 'Київ',
      priceUsd: 18300,
      priceUah: 831369,
      priceEur: null,
      plate: 'KA3747MK',
    });
    expect(r.listings.find((l) => l.id === 40597534)!.city).toBe('Львів (Львівська)');
    expect(r.listings.find((l) => l.id === 40597534)!.plate).toBeNull();
  });

  it('page 2 is disjoint from page 1', () => {
    const a = new Set(parseSearchPage(page1).listings.map((l) => l.id));
    const b = parseSearchPage(page2).listings;
    expect(b.length).toBeGreaterThan(0);
    expect(b.some((l) => a.has(l.id))).toBe(false);
  });

  it('throws on a changed layout', () => {
    expect(() => parseSearchPage('<script>window.__PINIA__ = {"x":1};</script>')).toThrow(/layout changed/);
  });
});

describe('parseAdPage', () => {
  it('active USD ad', () => {
    expect(parseAdPage(fx('ad-active.html'), 37456649)).toEqual({
      id: 37456649,
      status: 'active',
      vin: '4T1B11HK7JU136181',
      plate: 'KA3747MK',
      publishedAt: '2026-10-22T21:00:00.000Z',
      priceUsd: 18300,
      price: 18300,
      currency: 'USD',
      brand: 'Toyota',
      model: 'Camry',
      year: 2018,
      mileageKm: 121000,
      city: 'Київ',
    });
  });

  it('UAH ad keeps the seller currency', () => {
    const d = parseAdPage(fx('ad-uah-price.html'), 40606269);
    expect(d).toMatchObject({
      status: 'active', currency: 'UAH', price: 1300000, plate: null, model: 'C-HR',
      vin: 'NMTK54BX40R066784', mileageKm: 50000,
    });
    expect(d.priceUsd).toBeGreaterThan(20000);
  });

  it('inactive ad served with 200 is removed', () => {
    const d = parseAdPage(fx('ad-sold.html'), 40300000);
    expect(d.status).toBe('removed');
    expect(d.vin).toBe('WV1ZZZ2EZG6015990');
    expect(d.plate).toBe('AX2973PA');
    expect(d.publishedAt).toBeNull();
  });

  it('404 body without pinia throws', () => {
    expect(() => parseAdPage(fx('ad-nonexistent-404.html'), 1)).toThrow(/__PINIA__/);
  });
});

describe('normalizeSearchUrl', () => {
  it('keeps raw params and adds indexName, sort, size, page', () => {
    const u = normalizeSearchUrl(
      'https://auto.ria.com/uk/search/?categories.main.id=1&brand.id[0]=79&size=20&page=3',
      2,
    );
    expect(u).toBe(
      'https://auto.ria.com/uk/search/?categories.main.id=1&brand.id[0]=79&indexName=auto&sort[0].order=dates.created.desc&size=100&limit=100&page=2',
    );
  });
  it('respects existing indexName and sort', () => {
    const u = normalizeSearchUrl('https://auto.ria.com/uk/search/?indexName=auto,order_auto&sort[0].order=price.asc', 0);
    expect(u).toBe('https://auto.ria.com/uk/search/?indexName=auto,order_auto&sort[0].order=price.asc&size=100&limit=100&page=0');
  });

  it('new-format URL: forces used cars via search_type=2 and replaces limit', () => {
    const u = normalizeSearchUrl('https://auto.ria.com/uk/search/?search_type=1&category=1&all[0].any[0].brand=84&page=0&limit=20', 1);
    expect(u).toBe('https://auto.ria.com/uk/search/?category=1&all[0].any[0].brand=84&search_type=2&sort[0].order=dates.created.desc&size=100&limit=100&page=1');
  });
});

describe('http client', () => {
  it('retries on 500 then succeeds', async () => {
    let n = 0;
    const sleeps: number[] = [];
    const c = createHttpClient({
      delayMs: [0, 0],
      sleep: async (ms) => void sleeps.push(ms),
      fetchImpl: async () => (++n < 3 ? res(500, 'err') : res(200, 'ok')),
    });
    const r = await c.get('https://x/');
    expect(r.body).toBe('ok');
    expect(c.requestCount).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('retries on network errors and gives up after 4 attempts', async () => {
    const c = createHttpClient({
      delayMs: [0, 0], sleep: async () => {}, fetchImpl: async () => { throw new Error('ECONNRESET'); },
    });
    await expect(c.get('https://x/')).rejects.toThrow(/ECONNRESET/);
    expect(c.requestCount).toBe(4);
  });

  it('does not retry 404', async () => {
    const c = createHttpClient({ delayMs: [0, 0], sleep: async () => {}, fetchImpl: async () => res(404, 'no') });
    expect((await c.get('https://x/')).status).toBe(404);
    expect(c.requestCount).toBe(1);
  });

  it('jittered delay between requests, none before the first', async () => {
    const sleeps: number[] = [];
    const c = createHttpClient({
      delayMs: [1000, 3000], random: () => 0.5, sleep: async (ms) => void sleeps.push(ms),
      fetchImpl: async () => res(200, 'ok'),
    });
    await c.get('https://x/');
    await c.get('https://x/');
    expect(sleeps).toEqual([2000]);
  });

  it('captcha-looking 200 body is a BlockedError', async () => {
    const c = createHttpClient({
      delayMs: [0, 0], sleep: async () => {}, fetchImpl: async () => res(200, '<html>Please solve the CAPTCHA</html>'),
    });
    await expect(c.get('https://x/')).rejects.toBeInstanceOf(BlockedError);
  });
});

describe('createAutoRiaSource', () => {
  const base = { delayMs: [0, 0] as [number, number], sleep: async () => {}, backoffMs: 0 };

  it('paginates until an empty page, dedupes, and normalizes the URL', async () => {
    const urls: string[] = [];
    const pages = [page1, page2, emptyPage()];
    const src = createAutoRiaSource({
      ...base,
      fetchImpl: async (u) => {
        urls.push(u);
        return res(200, pages[urls.length - 1] ?? emptyPage());
      },
    });
    const r = await src.search('https://auto.ria.com/uk/search/?categories.main.id=1&brand.id[0]=79');
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('brand.id[0]=79');
    expect(urls[0]).toContain('indexName=auto');
    expect(urls[0]).toContain('size=100');
    expect(urls.map((u) => /page=(\d+)/.exec(u)![1])).toEqual(['0', '1', '2']);
    expect(r.total).toBe(12309);
    const expected = new Set([...parseSearchPage(page1).listings, ...parseSearchPage(page2).listings].map((l) => l.id));
    expect(r.listings).toHaveLength(expected.size);
    expect(src.requestCount).toBe(3);
  });

  it('dedupes ids repeated across pages', async () => {
    const pages = [page1, page1, emptyPage()];
    let i = 0;
    const src = createAutoRiaSource({ ...base, fetchImpl: async () => res(200, pages[i++]!) });
    const r = await src.search('https://auto.ria.com/uk/search/?x=1');
    expect(r.listings).toHaveLength(20);
  });

  it('details: 200 active, 301 removed, 404 removed', async () => {
    const seen: Array<[string, RequestInit | undefined]> = [];
    const src = createAutoRiaSource({
      ...base,
      fetchImpl: async (u, init) => {
        seen.push([u, init]);
        if (u.includes('30000000')) return res(301, 'Moved', { location: 'https://auto.ria.com/uk/car/jawa/350/' });
        if (u.includes('99999')) return res(404, fx('ad-nonexistent-404.html'));
        return res(200, fx('ad-active.html'));
      },
    });
    expect((await src.details(37456649, 'ignored')).status).toBe('active');
    const gone = await src.details(30000000);
    expect(gone).toMatchObject({ status: 'removed', vin: null, plate: null, price: null, currency: null });
    expect((await src.details(99999999999)).status).toBe('removed');
    expect(seen[0]![0]).toBe('https://auto.ria.com/uk/auto___37456649.html');
    expect(seen[0]![1]?.redirect).toBe('manual');
  });

  it('403 -> BlockedError without retries', async () => {
    let n = 0;
    const src = createAutoRiaSource({ ...base, fetchImpl: async () => (n++, res(403, 'denied')) });
    await expect(src.search('https://auto.ria.com/uk/search/?x=1')).rejects.toBeInstanceOf(BlockedError);
    expect(n).toBe(1);
  });

  it('retries a 500 then succeeds', async () => {
    let n = 0;
    const src = createAutoRiaSource({
      ...base,
      fetchImpl: async () => (++n === 1 ? res(500, 'boom') : res(200, fx('ad-active.html'))),
    });
    expect((await src.details(37456649)).vin).toBe('4T1B11HK7JU136181');
    expect(src.requestCount).toBe(2);
  });

  it('unexpected status throws', async () => {
    const src = createAutoRiaSource({ ...base, fetchImpl: async () => res(418, 'x') });
    await expect(src.details(1)).rejects.toThrow(/418/);
  });
});
