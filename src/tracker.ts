import type { DatabaseSync } from 'node:sqlite';
import type {
  Currency,
  EventType,
  ListingDetails,
  ListingStatus,
  ListingSummary,
  ListingView,
  PriceDrop,
  RunReport,
  SearchConfig,
  SearchReport,
  SearchResult,
  Source,
} from './types.js';

const DAY_MS = 86_400_000;
const MIN_COVERAGE = 0.9;

interface SearchState {
  id: number;
  config: SearchConfig;
  /** No successful collection yet: this run only records a baseline. */
  baseline: boolean;
  result?: SearchResult;
  error?: string;
}

interface SeenListing {
  summary: ListingSummary;
  searchIds: number[];
}

type Fetched = { details: ListingDetails } | { error: string };

interface Ctx {
  db: DatabaseSync;
  runId: number;
  now: string;
}

interface ListingRow {
  id: number;
  url: string;
  vehicle_id: number;
  status: ListingStatus;
  price_usd: number | null;
  price: number | null;
  currency: Currency | null;
}

const LISTING_COLUMNS = 'id, url, vehicle_id, status, price_usd, price, currency';

/** A price in the seller's currency plus its (drifting) USD equivalent. */
interface Price {
  price: number | null;
  currency: Currency | null;
  usd: number | null;
}

interface Drop {
  currency: Currency;
  old: number;
  new: number;
  oldUsd: number | null;
  newUsd: number | null;
}

interface VehicleIds {
  vin: string | null;
  plate: string | null;
}

interface VehicleRow {
  id: number;
  vin: string | null;
  plate: string | null;
}

export async function runTracker(
  db: DatabaseSync,
  source: Source,
  searches: SearchConfig[],
  now: string,
): Promise<RunReport> {
  const { runId, states } = syncSearches(db, searches, now);
  await collect(source, states);

  const ok = states.filter((s) => s.result);
  const seen = mergeSeen(ok);
  const okIds = new Set(ok.map((s) => s.id));
  const errors: string[] = [];

  const newIds = [...seen.keys()].filter((id) => !listingExists(db, id));
  const disappeared = findDisappeared(db, seen, okIds);
  const knownIds = [...seen.keys()].filter((id) => !newIds.includes(id));
  const needPrice = knownIds.filter((id) => needsDetailsForPrice(db, seen.get(id)!.summary));
  const toItem = (id: number) => ({ id, url: seen.get(id)!.summary.url });
  const ctx: Ctx = { db, runId, now };
  const searchErrors = states.filter((s) => s.error).map((s) => `${s.config.name}: ${s.error}`);
  try {
    const newDetails = await fetchAll(source, newIds.map(toItem));
    const priceDetails = await fetchAll(source, needPrice.map(toItem));
    const goneDetails = await fetchAll(source, disappeared);

    inTransaction(db, () => {
      const isNew = new Set(newIds);
      const statesById = new Map(states.map((s) => [s.id, s]));
      for (const id of newIds) {
        const { summary, searchIds } = seen.get(id)!;
        const baseline = searchIds.every((sid) => statesById.get(sid)!.baseline);
        insertNew(ctx, summary, searchIds, newDetails.get(id)!, baseline, errors);
      }
      for (const [id, { summary, searchIds }] of seen) {
        if (!isNew.has(id)) updateKnown(ctx, summary, searchIds, priceDetails.get(id), errors);
      }
      for (const row of disappeared) closeDisappeared(ctx, row, goneDetails.get(row.id)!, errors);

      for (const s of ok) db.prepare('UPDATE searches SET baseline_at = ? WHERE id = ? AND baseline_at IS NULL').run(now, s.id);
      const runOk = searchErrors.length === 0 && errors.length === 0;
      db.prepare('UPDATE runs SET finished_at = ?, ok = ?, requests = ?, error = ? WHERE id = ?').run(
        now,
        runOk ? 1 : 0,
        source.requestCount,
        [...searchErrors, ...errors].join('\n') || null,
        runId,
      );
    });
  } catch (e) {
    db.prepare('UPDATE runs SET finished_at = ?, ok = 0, requests = ?, error = ? WHERE id = ?').run(
      now,
      source.requestCount,
      errorMessage(e),
      runId,
    );
    throw e;
  }

  return {
    runId,
    startedAt: now,
    finishedAt: now,
    ok: searchErrors.length === 0 && errors.length === 0,
    requests: source.requestCount,
    searches: states.map((s) => buildSearchReport(ctx, s)),
    errors,
  };
}

// ---------- phase 1-2: searches ----------

function syncSearches(db: DatabaseSync, searches: SearchConfig[], now: string) {
  return inTransaction(db, () => {
    const upsert = db.prepare(
      `INSERT INTO searches (name, url, enabled) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET url = excluded.url, enabled = excluded.enabled,
         -- changed filters: ads that only now match are not fresh, so take a new baseline
         baseline_at = CASE WHEN url = excluded.url THEN baseline_at END
       RETURNING id, baseline_at`,
    );
    const states: SearchState[] = [];
    for (const config of searches) {
      const row = upsert.get(config.name, config.url, config.enabled ? 1 : 0) as { id: number; baseline_at: string | null };
      if (config.enabled) states.push({ id: row.id, config, baseline: row.baseline_at === null });
    }
    const run = db.prepare('INSERT INTO runs (started_at) VALUES (?)').run(now);
    return { runId: Number(run.lastInsertRowid), states };
  });
}

async function collect(source: Source, states: SearchState[]): Promise<void> {
  for (const state of states) {
    try {
      const result = await source.search(state.config.url);
      const count = new Set(result.listings.map((l) => l.id)).size;
      if (count < MIN_COVERAGE * result.total || (result.total > 0 && count === 0)) {
        state.error = `sanity check failed: got ${count} listings, site reports ${result.total}`;
      } else {
        state.result = result;
      }
    } catch (e) {
      state.error = errorMessage(e);
    }
  }
}

function mergeSeen(states: SearchState[]): Map<number, SeenListing> {
  const seen = new Map<number, SeenListing>();
  for (const state of states) {
    for (const summary of state.result!.listings) {
      const entry = seen.get(summary.id) ?? { summary, searchIds: [] };
      if (!entry.searchIds.includes(state.id)) entry.searchIds.push(state.id);
      seen.set(summary.id, entry);
    }
  }
  return seen;
}

// ---------- detail fetching (no open transaction) ----------

async function fetchAll(source: Source, items: { id: number; url: string }[]): Promise<Map<number, Fetched>> {
  const out = new Map<number, Fetched>();
  for (const { id, url } of items) {
    try {
      out.set(id, { details: await source.details(id, url) });
    } catch (e) {
      // Once the site blocks us every further request fails too: abort the run, apply nothing.
      if (e instanceof Error && e.name === 'BlockedError') throw e;
      out.set(id, { error: `details for ${id} failed: ${errorMessage(e)}` });
    }
  }
  return out;
}

function listingExists(db: DatabaseSync, id: number): boolean {
  return db.prepare('SELECT 1 FROM listings WHERE id = ?').get(id) !== undefined;
}

function findDisappeared(db: DatabaseSync, seen: Map<number, SeenListing>, okIds: Set<number>): ListingRow[] {
  const active = db.prepare(`SELECT ${LISTING_COLUMNS} FROM listings WHERE status = 'active'`).all() as unknown as ListingRow[];
  const linked = db.prepare('SELECT search_id FROM listing_searches WHERE listing_id = ?');
  return active.filter((row) => {
    if (seen.has(row.id)) return false;
    const searchIds = (linked.all(row.id) as unknown as { search_id: number }[]).map((r) => r.search_id);
    return searchIds.every((id) => okIds.has(id));
  });
}

// ---------- phase 3: new ids ----------

function insertNew(
  ctx: Ctx,
  summary: ListingSummary,
  searchIds: number[],
  fetched: Fetched,
  baseline: boolean,
  errors: string[],
): void {
  const details = 'details' in fetched ? fetched.details : null;
  if ('error' in fetched) errors.push(fetched.error);

  const ids = { vin: details?.vin ?? null, plate: details?.plate ?? summary.plate };
  const price: Price = {
    price: details?.price ?? null,
    currency: details?.price != null ? details.currency : null,
    usd: summary.priceUsd ?? details?.priceUsd ?? null,
  };
  const listing = details
    ? { ...summary, brand: details.brand ?? summary.brand, model: details.model ?? summary.model,
        year: details.year ?? summary.year, mileageKm: details.mileageKm ?? summary.mileageKm,
        city: details.city ?? summary.city }
    : summary;

  const vehicle = findVehicle(ctx.db, ids);
  if (vehicle) {
    const previous = latestListingPrice(ctx.db, vehicle.id);
    fillVehicleIds(ctx.db, vehicle, ids);
    insertListing(ctx, listing, price, vehicle.id, searchIds);
    if (baseline) return;
    addEvent(ctx, summary.id, 'repost');
    const drop = compareRepost(previous, price);
    if (drop) addEvent(ctx, summary.id, 'price_drop', drop);
    return;
  }

  const vehicleId = insertVehicle(ctx, ids, details?.publishedAt ?? null);
  insertListing(ctx, listing, price, vehicleId, searchIds);
  if (!baseline) addEvent(ctx, summary.id, 'new');
}

/** Same currency: compare seller prices. Otherwise fall back to the USD equivalents. */
function compareRepost(old: Price, now: Price): Drop | null {
  const sameCurrency = old.currency !== null && old.currency === now.currency;
  const [o, n, currency] = sameCurrency ? [old.price, now.price, old.currency!] : [old.usd, now.usd, 'USD' as const];
  if (!isDrop(o, n)) return null;
  return { currency, old: o!, new: n!, oldUsd: old.usd, newUsd: now.usd };
}

function findVehicle(db: DatabaseSync, ids: VehicleIds): VehicleRow | undefined {
  if (ids.vin) {
    const byVin = db.prepare('SELECT id, vin, plate FROM vehicles WHERE vin = ?').get(ids.vin);
    if (byVin) return byVin as unknown as VehicleRow;
  }
  if (ids.plate) {
    return db.prepare('SELECT id, vin, plate FROM vehicles WHERE plate = ? ORDER BY id LIMIT 1').get(ids.plate) as unknown as VehicleRow | undefined;
  }
  return undefined;
}

/** Price of the vehicle's most recently listed ad. */
function latestListingPrice(db: DatabaseSync, vehicleId: number): Price {
  const row = db
    .prepare('SELECT price, currency, price_usd AS usd FROM listings WHERE vehicle_id = ? ORDER BY first_seen_at DESC, id DESC LIMIT 1')
    .get(vehicleId) as unknown as Price | undefined;
  return row ?? { price: null, currency: null, usd: null };
}

/** A vehicle matched by plate may still lack a VIN (or vice versa); learn it from the repost. */
function fillVehicleIds(db: DatabaseSync, vehicle: VehicleRow, ids: VehicleIds): void {
  const vin = vehicle.vin ?? ids.vin;
  const plate = vehicle.plate ?? ids.plate;
  if (vin !== vehicle.vin || plate !== vehicle.plate) {
    db.prepare('UPDATE vehicles SET vin = ?, plate = ? WHERE id = ?').run(vin, plate, vehicle.id);
  }
}

function insertVehicle(ctx: Ctx, ids: VehicleIds, published: string | null): number {
  const firstSeen = published && Date.parse(published) < Date.parse(ctx.now) ? published : ctx.now;
  const res = ctx.db
    .prepare('INSERT INTO vehicles (vin, plate, first_seen_at) VALUES (?, ?, ?)')
    .run(ids.vin, ids.plate, firstSeen);
  return Number(res.lastInsertRowid);
}

function insertListing(ctx: Ctx, s: ListingSummary, p: Price, vehicleId: number, searchIds: number[]): void {
  ctx.db
    .prepare(
      `INSERT INTO listings (id, vehicle_id, url, title, brand, model, year, mileage_km, city,
                             price_usd, price, currency, status, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(s.id, vehicleId, s.url, s.title, s.brand, s.model, s.year, s.mileageKm, s.city, p.usd, p.price, p.currency, ctx.now, ctx.now);
  recordPrice(ctx, s.id, p);
  linkSearches(ctx, s.id, searchIds);
}

// ---------- phase 4: known ids ----------

const cardPrice = (s: ListingSummary, currency: Currency) =>
  ({ USD: s.priceUsd, UAH: s.priceUah, EUR: s.priceEur })[currency];

/** The card only helps once the seller's currency is known and the card shows it. */
function needsDetailsForPrice(db: DatabaseSync, s: ListingSummary): boolean {
  const row = db.prepare('SELECT currency FROM listings WHERE id = ?').get(s.id) as { currency: Currency | null };
  return row.currency === null || cardPrice(s, row.currency) === null;
}

function updateKnown(
  ctx: Ctx,
  s: ListingSummary,
  searchIds: number[],
  fetched: Fetched | undefined,
  errors: string[],
): void {
  const row = ctx.db.prepare(`SELECT ${LISTING_COLUMNS} FROM listings WHERE id = ?`).get(s.id) as unknown as ListingRow;
  if (fetched && 'error' in fetched) errors.push(fetched.error);
  const seller = sellerPrice(row, s, fetched);

  // Card brand/model are null and card mileage is rounded: keep the ad-page values we stored.
  ctx.db
    .prepare(
      `UPDATE listings SET url = ?, title = ?, brand = COALESCE(brand, ?), model = COALESCE(model, ?),
                           year = COALESCE(year, ?), mileage_km = COALESCE(mileage_km, ?), city = COALESCE(city, ?),
                           last_seen_at = ?, price_usd = COALESCE(?, price_usd) WHERE id = ?`,
    )
    .run(s.url, s.title, s.brand, s.model, s.year, s.mileageKm, s.city, ctx.now, s.priceUsd, s.id);
  linkSearches(ctx, s.id, searchIds);

  if (seller && (seller.price !== row.price || seller.currency !== row.currency)) {
    const now: Price = { ...seller, usd: s.priceUsd };
    ctx.db.prepare('UPDATE listings SET price = ?, currency = ? WHERE id = ?').run(seller.price, seller.currency, s.id);
    recordPrice(ctx, s.id, now);
    if (row.currency === seller.currency && isDrop(row.price, seller.price)) {
      const drop: Drop = { currency: seller.currency!, old: row.price!, new: seller.price!, oldUsd: row.price_usd, newUsd: s.priceUsd };
      addEvent(ctx, s.id, 'price_drop', drop);
    }
  }
  if (row.status !== 'active') {
    ctx.db.prepare("UPDATE listings SET status = 'active', closed_at = NULL WHERE id = ?").run(s.id);
    addEvent(ctx, s.id, 'back');
  }
}

/** Current price in the seller's currency: from the card when possible, else from the ad page. */
function sellerPrice(row: ListingRow, s: ListingSummary, fetched: Fetched | undefined): Price | null {
  if (row.currency) {
    const price = cardPrice(s, row.currency);
    if (price !== null) return { price, currency: row.currency, usd: s.priceUsd };
  }
  if (fetched && 'details' in fetched && fetched.details.price !== null && fetched.details.currency) {
    return { price: fetched.details.price, currency: fetched.details.currency, usd: s.priceUsd };
  }
  return null;
}

// ---------- phase 5: disappeared ----------

function closeDisappeared(ctx: Ctx, row: ListingRow, fetched: Fetched, errors: string[]): void {
  if ('error' in fetched) {
    errors.push(fetched.error);
    return;
  }
  if (fetched.details.status === 'active') {
    setStatus(ctx, row.id, 'out_of_filter');
    addEvent(ctx, row.id, 'out_of_filter');
    return;
  }
  const other = ctx.db
    .prepare("SELECT 1 FROM listings WHERE vehicle_id = ? AND id != ? AND status = 'active'")
    .get(row.vehicle_id, row.id);
  if (other) {
    setStatus(ctx, row.id, 'relisted');
  } else {
    setStatus(ctx, row.id, 'sold');
    addEvent(ctx, row.id, 'sold');
  }
}

function setStatus(ctx: Ctx, id: number, status: ListingStatus): void {
  ctx.db.prepare('UPDATE listings SET status = ?, closed_at = ? WHERE id = ?').run(status, ctx.now, id);
}

// ---------- shared helpers ----------

function isDrop(oldPrice: number | null, newPrice: number | null): boolean {
  return oldPrice !== null && newPrice !== null && newPrice < oldPrice;
}

function recordPrice(ctx: Ctx, listingId: number, p: Price): void {
  if (p.price === null || p.currency === null) return;
  ctx.db
    .prepare('INSERT OR REPLACE INTO price_history (listing_id, observed_at, price_usd, price, currency) VALUES (?, ?, ?, ?, ?)')
    .run(listingId, ctx.now, p.usd, p.price, p.currency);
}

function linkSearches(ctx: Ctx, listingId: number, searchIds: number[]): void {
  const stmt = ctx.db.prepare(
    `INSERT INTO listing_searches (listing_id, search_id, last_seen_at) VALUES (?, ?, ?)
     ON CONFLICT(listing_id, search_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  );
  for (const searchId of searchIds) stmt.run(listingId, searchId, ctx.now);
}

function addEvent(ctx: Ctx, listingId: number, type: EventType, payload?: object): void {
  ctx.db
    .prepare('INSERT INTO events (run_id, listing_id, type, created_at, payload) VALUES (?, ?, ?, ?, ?)')
    .run(ctx.runId, listingId, type, ctx.now, payload ? JSON.stringify(payload) : null);
}

function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------- phase 7: report ----------

function buildSearchReport(ctx: Ctx, state: SearchState): SearchReport {
  const ok = state.result !== undefined;
  const events = ctx.db
    .prepare(
      `SELECT e.type, e.listing_id, e.payload FROM events e
       JOIN listing_searches ls ON ls.listing_id = e.listing_id
       WHERE e.run_id = ? AND ls.search_id = ?
         AND (e.type IN ('sold', 'out_of_filter') OR ls.last_seen_at = ?)
       ORDER BY e.id`,
    )
    .all(ctx.runId, state.id, ctx.now) as unknown as { type: EventType; listing_id: number; payload: string | null }[];

  const ofType = (type: EventType) => events.filter((e) => e.type === type);
  const views = (type: EventType) => ofType(type).map((e) => listingView(ctx, e.listing_id));
  const priceDrops: PriceDrop[] = ofType('price_drop').map((e) => {
    const d = JSON.parse(e.payload!) as Drop;
    return {
      listing: listingView(ctx, e.listing_id),
      currency: d.currency,
      oldPrice: d.old,
      newPrice: d.new,
      oldPriceUsd: d.oldUsd,
      newPriceUsd: d.newUsd,
    };
  });

  // Current membership for a collected search; last known membership if it failed.
  const activeCount = (ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM listings l JOIN listing_searches ls ON ls.listing_id = l.id
       WHERE ls.search_id = ? AND l.status = 'active' AND (? = 0 OR ls.last_seen_at = ?)`,
    )
    .get(state.id, ok ? 1 : 0, ctx.now) as { n: number }).n;

  return {
    search: state.config.name,
    url: state.config.url,
    ok,
    ...(state.error ? { error: state.error } : {}),
    baseline: ok && state.baseline,
    activeCount,
    newListings: views('new'),
    reposts: views('repost'),
    priceDrops,
    soldCount: ofType('sold').length,
    outOfFilterCount: ofType('out_of_filter').length,
    backCount: ofType('back').length,
  };
}

function listingView(ctx: Ctx, id: number): ListingView {
  const r = ctx.db
    .prepare(
      `SELECT l.*, v.first_seen_at AS vehicle_first_seen FROM listings l
       JOIN vehicles v ON v.id = l.vehicle_id WHERE l.id = ?`,
    )
    .get(id) as Record<string, any>;
  const days = Math.floor((Date.parse(ctx.now) - Date.parse(r.vehicle_first_seen)) / DAY_MS);
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    brand: r.brand,
    model: r.model,
    year: r.year,
    mileageKm: r.mileage_km,
    city: r.city,
    priceUsd: r.price_usd,
    daysOnMarket: Math.max(0, days),
  };
}
