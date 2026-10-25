import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface DashboardSearch { id: number; name: string; url: string }
export interface PricePoint { at: string; price: number; currency: string; priceUsd: number | null }
export interface ActiveListing {
  id: number; url: string; title: string;
  brand: string | null; model: string | null; year: number | null;
  mileageKm: number | null; city: string | null;
  priceUsd: number | null; price: number | null; currency: string | null; firstPrice: number | null;
  searchIds: number[]; daysOnMarket: number;
  firstSeenAt: string; priceHistory: PricePoint[];
}
export interface SoldListing {
  id: number; brand: string | null; model: string | null; year: number | null;
  priceUsd: number | null; daysOnMarket: number; closedAt: string; searchIds: number[];
}
export interface DashboardData {
  generatedAt: string;
  searches: DashboardSearch[];
  active: ActiveListing[];
  sold: SoldListing[];
  lastRun: { startedAt: string; finishedAt: string | null; ok: boolean; requests: number | null } | null;
}

const DAY = 86_400_000;
const days = (from: string, to: string): number =>
  Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / DAY));

type Row = Record<string, any>;

export function exportData(db: DatabaseSync, now: string): DashboardData {
  const searches = (db.prepare('SELECT id, name, url FROM searches ORDER BY id').all() as Row[])
    .map((r) => ({ id: r.id, name: r.name, url: r.url }));

  const links = new Map<number, number[]>();
  for (const r of db.prepare('SELECT listing_id, search_id FROM listing_searches ORDER BY search_id').all() as Row[]) {
    const a = links.get(r.listing_id) ?? [];
    a.push(r.search_id);
    links.set(r.listing_id, a);
  }
  const history = new Map<number, PricePoint[]>();
  for (const r of db.prepare('SELECT listing_id, observed_at, price, currency, price_usd FROM price_history ORDER BY observed_at ASC').all() as Row[]) {
    const a = history.get(r.listing_id) ?? [];
    a.push({ at: r.observed_at, price: r.price, currency: r.currency, priceUsd: r.price_usd });
    history.set(r.listing_id, a);
  }

  const q = (status: string) => db.prepare(
    `SELECT l.*, v.first_seen_at AS v_first FROM listings l JOIN vehicles v ON v.id = l.vehicle_id
     WHERE l.status = ? ORDER BY l.id`).all(status) as Row[];

  const active: ActiveListing[] = q('active').map((r) => {
    const h = history.get(r.id) ?? [];
    return {
      id: r.id, url: r.url, title: r.title, brand: r.brand, model: r.model, year: r.year,
      mileageKm: r.mileage_km, city: r.city, priceUsd: r.price_usd,
      price: r.price ?? null, currency: r.currency ?? null,
      firstPrice: h[0]?.price ?? r.price ?? null,
      searchIds: links.get(r.id) ?? [],
      daysOnMarket: days(r.v_first, now),
      firstSeenAt: r.v_first,
      priceHistory: h,
    };
  });

  const sold: SoldListing[] = q('sold').map((r) => ({
    id: r.id, brand: r.brand, model: r.model, year: r.year, priceUsd: r.price_usd,
    daysOnMarket: days(r.v_first, r.closed_at ?? now),
    closedAt: r.closed_at ?? r.last_seen_at,
    searchIds: links.get(r.id) ?? [],
  }));

  const run = db.prepare('SELECT started_at, finished_at, ok, requests FROM runs ORDER BY started_at DESC, id DESC LIMIT 1').get() as Row | undefined;
  return {
    generatedAt: now, searches, active, sold,
    lastRun: run ? { startedAt: run.started_at, finishedAt: run.finished_at, ok: !!run.ok, requests: run.requests } : null,
  };
}

export function emptyData(now: string): DashboardData {
  return { generatedAt: now, searches: [], active: [], sold: [], lastRun: null };
}

export function buildSite(dbPath: string, outDir: string, now = new Date().toISOString()): DashboardData {
  let data: DashboardData;
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { data = exportData(db, now); } finally { db.close(); }
  } else {
    data = emptyData(now);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'data.json'), JSON.stringify(data));
  const src = resolve(dirname(fileURLToPath(import.meta.url)), '../../dashboard');
  if (existsSync(src)) {
    for (const f of readdirSync(src)) {
      if (statSync(join(src, f)).isFile()) copyFileSync(join(src, f), join(outDir, f));
    }
  }
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dbPath = 'data/autoria.db', outDir = 'site'] = process.argv.slice(2);
  const d = buildSite(dbPath, outDir);
  console.log(`dashboard: ${d.active.length} active, ${d.sold.length} sold -> ${outDir}`);
}
