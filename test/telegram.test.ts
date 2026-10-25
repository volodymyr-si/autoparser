import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDigest, formatFailure, sendTelegram } from '../src/report/telegram.js';
import type { ListingView, PriceDrop, RunReport, SearchReport } from '../src/types.js';

function listing(over: Partial<ListingView> = {}): ListingView {
  return {
    id: 1,
    url: 'https://auto.ria.com/uk/auto_toyota_camry_1.html',
    title: 'Toyota Camry 2018',
    brand: 'Toyota',
    model: 'Camry',
    year: 2018,
    mileageKm: 120000,
    city: 'Київ',
    priceUsd: 15500,
    daysOnMarket: 3,
    ...over,
  };
}

function search(over: Partial<SearchReport> = {}): SearchReport {
  return {
    search: 'Camry',
    url: 'https://auto.ria.com/uk/search/?a=1&b=2',
    ok: true,
    baseline: false,
    activeCount: 10,
    newListings: [],
    reposts: [],
    priceDrops: [],
    soldCount: 0,
    outOfFilterCount: 0,
    backCount: 0,
    ...over,
  };
}

function report(over: Partial<RunReport> = {}): RunReport {
  return {
    runId: 1,
    startedAt: '2026-10-25T09:00:00Z',
    finishedAt: '2026-10-25T09:05:00Z',
    ok: true,
    requests: 10,
    searches: [],
    errors: [],
    ...over,
  };
}

const joined = (messages: string[]) => messages.join('\n');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('formatDigest', () => {
  it('puts the Kyiv date in the header', () => {
    // 23:30 UTC on 24.10 is 01:30 on 25.10 in Kyiv.
    const [first] = formatDigest(report({ finishedAt: '2026-10-24T23:30:00Z' }));
    expect(first).toContain('🚗 AutoRia — 25.10.2026');
  });

  it('prints the summary line and shows reposts only when present', () => {
    const without = joined(
      formatDigest(report({ searches: [search({ newListings: [listing()], soldCount: 2, priceDrops: [] })] })),
    );
    expect(without).toContain('+1 нових · −2 продано · ↓0 подешевшало · 10 активних');
    expect(without).not.toContain('репост');

    const withReposts = joined(
      formatDigest(report({ searches: [search({ reposts: [listing()] })] })),
    );
    expect(withReposts).toContain('↻1 репостів');
  });

  it('prints the baseline line instead of events on the first run', () => {
    const text = joined(
      formatDigest(report({ searches: [search({ baseline: true, activeCount: 42, newListings: [listing()] })] })),
    );
    expect(text).toContain('Перший запуск: зафіксовано 42 оголошень');
    expect(text).not.toContain('нових');
    expect(text).not.toContain('Нові:');
  });

  it('shows the error for a failed search', () => {
    const text = joined(formatDigest(report({ searches: [search({ ok: false, error: 'HTTP 503 <try>' })] })));
    expect(text).toContain('⚠️ Помилка: HTTP 503 &lt;try&gt;');
  });

  it('formats a new listing with thousands separators and thousand-km mileage', () => {
    const text = joined(formatDigest(report({ searches: [search({ newListings: [listing()] })] })));
    expect(text).toContain(
      '• <a href="https://auto.ria.com/uk/auto_toyota_camry_1.html">Toyota Camry 2018</a>, 2018, 120 тис. км, $15 500, Київ',
    );
  });

  it('formats fractional thousand-km mileage with a decimal comma', () => {
    const text = joined(formatDigest(report({ searches: [search({ newListings: [listing({ mileageKm: 12345 })] })] })));
    expect(text).toContain('12,3 тис. км');
  });

  it('omits null fields instead of printing them', () => {
    const text = joined(
      formatDigest(
        report({
          searches: [
            search({
              newListings: [listing({ year: null, mileageKm: null, priceUsd: null, city: null })],
            }),
          ],
        }),
      ),
    );
    expect(text).not.toMatch(/null|undefined/);
    expect(text).toMatch(/^• <a href="[^"]+">Toyota Camry 2018<\/a>$/m);
  });

  it('formats a USD price drop with absolute and percent change and days on market', () => {
    const drop: PriceDrop = {
      listing: listing(),
      currency: 'USD',
      oldPrice: 20000,
      newPrice: 18500,
      oldPriceUsd: 20000,
      newPriceUsd: 18500,
    };
    const text = joined(formatDigest(report({ searches: [search({ priceDrops: [drop] })] })));
    expect(text).toContain('Подешевшали:');
    expect(text).toContain('$20 000 → $18 500 (−$1 500, −7,5%), 3 дн. на ринку');
  });

  it('formats UAH and EUR drops in the seller currency with a USD hint for non-USD', () => {
    const uah: PriceDrop = {
      listing: listing(),
      currency: 'UAH',
      oldPrice: 650000,
      newPrice: 620000,
      oldPriceUsd: 15600,
      newPriceUsd: 14900,
    };
    const eur: PriceDrop = {
      listing: listing({ id: 2 }),
      currency: 'EUR',
      oldPrice: 15000,
      newPrice: 14000,
      oldPriceUsd: null,
      newPriceUsd: null,
    };
    const text = joined(formatDigest(report({ searches: [search({ priceDrops: [uah, eur] })] })));
    expect(text).toContain('650 000 ₴ → 620 000 ₴ (−30 000 ₴, −4,6%) ≈ $14 900, 3 дн. на ринку');
    expect(text).toContain('€15 000 → €14 000 (−€1 000, −6,7%), 3 дн. на ринку');
  });

  it('escapes dynamic text and attribute values', () => {
    const text = joined(
      formatDigest(
        report({
          searches: [
            search({
              search: 'A & B <x>',
              url: 'https://x.test/?a=1&b="2"',
              newListings: [listing({ title: '<script>"hi" & bye</script>', city: 'Львів & <>' })],
            }),
          ],
        }),
      ),
    );
    expect(text).toContain('A &amp; B &lt;x&gt;');
    expect(text).toContain('href="https://x.test/?a=1&amp;b=&quot;2&quot;"');
    expect(text).toContain('&lt;script&gt;&quot;hi&quot; &amp; bye&lt;/script&gt;');
    expect(text).toContain('Львів &amp; &lt;&gt;');
    expect(text).not.toContain('<script>');
  });

  it('still sends the header and summary lines when nothing changed', () => {
    const messages = formatDigest(report({ searches: [search(), search({ search: 'Prius', activeCount: 0 })] }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('🚗 AutoRia');
    expect(messages[0]).toContain('+0 нових · −0 продано · ↓0 подешевшало · 10 активних');
    expect(messages[0]).toContain('Prius');
  });

  it('adds the dashboard link and error count in the footer', () => {
    const text = joined(
      formatDigest(report({ errors: ['details failed', 'x'] }), { dashboardUrl: 'https://o.github.io/dash/' }),
    );
    expect(text).toContain('<a href="https://o.github.io/dash/">Дашборд</a>');
    expect(text).toContain('⚠️ 2 помилок');
  });

  it('omits the footer when there is no dashboard url and no errors', () => {
    const text = joined(formatDigest(report()));
    expect(text).not.toContain('Дашборд');
    expect(text).not.toContain('помилок');
  });

  it('splits a large report into messages under 4096 chars without breaking items or tags', () => {
    const listings = Array.from({ length: 300 }, (_, i) =>
      listing({ id: i, url: `https://auto.ria.com/uk/auto_${i}.html`, title: `Car number ${i} ${'x'.repeat(120)}` }),
    );
    const messages = formatDigest(report({ searches: [search({ newListings: listings })] }), {
      dashboardUrl: 'https://o.github.io/dash/',
    });

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(4096);
      expect(message.match(/<a /g)?.length ?? 0).toBe(message.match(/<\/a>/g)?.length ?? 0);
    }
    const text = joined(messages);
    for (const item of listings) {
      expect(text.split(`auto_${item.id}.html`).length - 1).toBe(1);
    }
    expect(text).toContain('Дашборд');
  });
});

describe('formatFailure', () => {
  it('builds the failure message with an escaped error and a run link', () => {
    const text = formatFailure(new Error('boom <b> & "x"'), 'https://github.com/o/r/actions/runs/1');
    expect(text).toContain('❌ AutoRia tracker впав');
    expect(text).toContain('boom &lt;b&gt; &amp; &quot;x&quot;');
    expect(text).toContain('<a href="https://github.com/o/r/actions/runs/1">');
  });

  it('omits the run link when none is given and truncates long errors', () => {
    const text = formatFailure('e'.repeat(10000));
    expect(text).not.toContain('<a ');
    expect(text.length).toBeLessThan(3100);
  });
});

describe('sendTelegram', () => {
  it('dry run: prints messages and does not call fetch when credentials are missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await sendTelegram(['first <b>', 'second'], {});

    expect(fetchMock).not.toHaveBeenCalled();
    const printed = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('first <b>');
    expect(printed).toContain('second');
  });

  it('posts each message sequentially with HTML parse mode', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendTelegram(['one', 'two'], { TELEGRAM_BOT_TOKEN: 'TOKEN', TELEGRAM_CHAT_ID: '42' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: '42',
      text: 'one',
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    const second = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(second[1].body)).text).toBe('two');
  });

  it('throws with the response body on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"description":"Bad Request"}', { status: 400 })));

    await expect(
      sendTelegram(['x'], { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '1' }),
    ).rejects.toThrow(/400.*Bad Request/);
  });

  it('retries once after 429 respecting retry_after', async () => {
    const responses = [
      new Response('{"ok":false,"parameters":{"retry_after":0}}', { status: 429 }),
      new Response('{"ok":true}', { status: 200 }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    vi.stubGlobal('fetch', fetchMock);

    await sendTelegram(['x'], { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '1' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
