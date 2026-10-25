// Pure parsers for auto.ria.com HTML (embedded window.__PINIA__ JSON). See docs/recon.md.
import type { Currency, ListingDetails, ListingSummary } from '../types.js';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const MARKER = 'window.__PINIA__ = ';

export function extractPinia(html: string): Json {
  const a = html.indexOf(MARKER);
  if (a < 0) throw new Error('auto.ria layout changed: window.__PINIA__ not found in page');
  const start = a + MARKER.length;
  const end = html.indexOf('</script>', start);
  if (end < 0) throw new Error('auto.ria layout changed: window.__PINIA__ script is not terminated');
  const raw = html
    .slice(start, end)
    .trim()
    .replace(/;$/, '');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`auto.ria layout changed: window.__PINIA__ is not valid JSON (${(e as Error).message})`);
  }
}

const CYR_TO_LAT: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', І: 'I', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X',
};

export function normalizePlate(s: string | null | undefined): string | null {
  if (!s) return null;
  const out = s
    .toUpperCase()
    .replace(/[\s\- ]+/g, '')
    .replace(/[АВЕІКМНОРСТХ]/g, (c) => CYR_TO_LAT[c] ?? c);
  return out || null;
}

/** "121 тис. км" -> 121000, "850 км" -> 850, "Без пробігу" -> 0, otherwise null. */
export function parseMileage(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = s.replace(/ /g, ' ').trim().toLowerCase();
  if (t.startsWith('без пробігу')) return 0;
  if (!/км/.test(t)) return null;
  if (/тис/.test(t)) {
    const m = t.match(/(\d+(?:[.,]\d+)?)/);
    return m?.[1] ? Math.round(parseFloat(m[1].replace(',', '.')) * 1000) : null;
  }
  const digits = t.replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export interface SearchPage {
  total: number;
  maxPage?: number;
  listings: ListingSummary[];
}

export function parseSearchPage(html: string): SearchPage {
  const p = extractPinia(html);
  const data = p?.searchPage?.searchResultData;
  const total = num(data?.count);
  if (total === null) throw new Error('auto.ria layout changed: searchPage.searchResultData.count missing');
  const maxPage = num(data?.maxPage) ?? undefined;
  const items: Json[] = p?.list?.lists?.items?.items ?? [];
  if (!Array.isArray(items)) throw new Error('auto.ria layout changed: list.lists.items.items is not an array');
  const listings: ListingSummary[] = [];
  for (const it of items) {
    const d = it?.component?.advertisementCard?.data;
    if (!d || d.type !== 'Auto') continue;
    const id = num(d.id);
    if (id === null) continue;
    const title: string = d.title?.content ?? '';
    const ym = title.match(/^(.*?)\s+(\d{4})$/);
    const info: Json[] = Array.isArray(d.basicInfo) ? d.basicInfo : [];
    const styleOf = (b: Json): string => b?.icon?.data?.style ?? '';
    const speedo = info.find((b) => styleOf(b).includes('speedometer'));
    const loc = info.find((b) => styleOf(b).includes('location'));
    const km = parseMileage((speedo ?? info[0])?.content) ?? info.map((b) => parseMileage(b?.content)).find((v) => v !== null) ?? null;
    const city: string | null = (loc ?? info[info.length - 1])?.content ?? null;
    const plateBadge = (d.photoContainer?.badges ?? []).find((b: Json) => b?.type === 'CarNumberTemplate');
    const plateText = plateBadge?.elements?.find((e: Json) => e?.type === 'Text')?.content;
    listings.push({
      id,
      url: d.link,
      title,
      brand: null,
      model: null,
      year: ym ? Number(ym[2]) : null,
      mileageKm: km,
      city,
      priceUsd: num(d.price?.USD),
      priceUah: num(d.price?.UAH),
      priceEur: num(d.price?.EUR),
      plate: normalizePlate(plateText),
    });
  }
  return { total, maxPage, listings };
}

function findById(node: Json, id: string): Json | null {
  if (!node || typeof node !== 'object') return null;
  if (!Array.isArray(node) && node.id === id) return node;
  for (const v of Object.values(node)) {
    const r = findById(v, id);
    if (r) return r;
  }
  return null;
}

function collectTexts(node: Json, out: string[]): string[] {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'Text' && typeof node.content === 'string') out.push(node.content);
  for (const v of Object.values(node)) collectTexts(v, out);
  return out;
}

/** Offset of Europe/Kyiv from UTC in minutes at the given instant. */
function kyivOffsetMinutes(at: Date): number {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv', timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((x) => x.type === 'timeZoneName')?.value; // "GMT+03:00"
  const m = part?.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 120;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** dd.mm.yyyy (Kyiv local date) -> ISO UTC timestamp of 00:00 Europe/Kyiv that day. */
export function kyivDateToIso(dmy: string): string | null {
  const m = dmy.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const naive = Date.UTC(y, mo - 1, d, 0, 0, 0);
  // Offset at (approximately) local midnight; DST switches happen at 03:00/04:00 so this is exact.
  const off = kyivOffsetMinutes(new Date(naive - 3 * 3600_000));
  const dt = new Date(naive - off * 60_000);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function asCurrency(v: unknown): Currency | null {
  return v === 'USD' || v === 'UAH' || v === 'EUR' ? v : null;
}

export function parseAdPage(html: string, id: number): ListingDetails {
  const p = extractPinia(html);
  const structures = p?.page?.structures;
  const R: Json = structures && typeof structures === 'object' ? Object.values(structures)[0] : null;
  if (!R || typeof R !== 'object' || !R.additionalParams) {
    throw new Error(`auto.ria layout changed: page.structures entry missing for ad ${id}`);
  }
  const ld: Json = R.ldJSON ?? {};
  const active = R.additionalParams.isActive === true;

  let plate: string | null = null;
  const plateNode = findById(p.page, 'badgesPlateNumber');
  const plateText = plateNode ? collectTexts(plateNode, [])[0] : undefined;
  plate = normalizePlate(plateText);
  if (!plate) {
    const m = String(R.seo?.title ?? '').match(/\(([A-ZА-ЯІ0-9]{6,9})\)/);
    plate = normalizePlate(m?.[1]);
  }

  let publishedAt: string | null = null;
  const stat = p.page?.templates?.advertStatistic;
  if (stat) {
    const m = collectTexts(stat, []).join('|').match(/створене (\d{2}\.\d{2}\.\d{4})/);
    if (m?.[1]) publishedAt = kyivDateToIso(m[1]);
  }

  const offers: Json = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
  const prices = R.additionalParams.prices;
  const usdFromParams = prices?.USD ? num(String(prices.USD).replace(/\D/g, '')) : null;
  const currency = asCurrency(offers?.priceCurrency);
  const price = num(offers?.price);
  const priceUsd = currency === 'USD' && price !== null ? price : usdFromParams;
  const year = num(ld.productionDate);
  const city = R.breadcrumbsLD?.itemListElement?.[3]?.item?.name;

  return {
    id,
    status: active ? 'active' : 'removed',
    vin: typeof ld.vehicleIdentificationNumber === 'string' && ld.vehicleIdentificationNumber ? ld.vehicleIdentificationNumber : null,
    plate,
    publishedAt,
    priceUsd,
    price: currency ? price : null,
    currency: price !== null ? currency : null,
    brand: ld.brand?.name ?? null,
    model: typeof ld.model === 'string' ? ld.model : null,
    year,
    mileageKm: num(ld.mileageFromOdometer?.value),
    city: typeof city === 'string' ? city : null,
  };
}
