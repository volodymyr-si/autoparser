# Design

Implements `SPEC.md`. Contracts: `src/types.ts`, DB schema: `src/schema.sql`.

## Modules

| File | Responsibility |
|---|---|
| `src/types.ts` | shared types (contracts) |
| `src/schema.sql` | SQLite schema (single source of truth) |
| `src/config.ts` | load & validate `searches.yaml` → `SearchConfig[]` |
| `src/db.ts` | open DB (`node:sqlite` `DatabaseSync`), apply schema, small helpers |
| `src/source/http.ts` | polite HTTP client: UA, delays w/ jitter, retries, block detection |
| `src/source/autoria.ts` | `Source` implementation: search pagination + ad page parsing |
| `src/tracker.ts` | the run algorithm below → `RunReport` |
| `src/report/telegram.ts` | format `RunReport` → Telegram HTML messages (≤4096 chars), send |
| `src/dashboard/build.ts` | DB → `site/data.json` + copy `dashboard/` static files to `site/` |
| `src/main.ts` | CLI: config → tracker → telegram → exit code |

Runtime: Node 24, TypeScript run via `tsx`. SQLite via built-in `node:sqlite` (no native deps).
Tests: vitest, offline (fixtures in `test/fixtures/`, a fake `Source` for tracker tests).

## Run algorithm (`runTracker(db, source, searches, now)`)

`now` is injected (ISO string) for testability. Everything for one run happens in one
transaction per phase; a crash mid-run must not leave half-applied state (wrap the apply phase
in a single transaction).

1. **Sync searches**: upsert config searches by `name` (update url/enabled). Disabled ones are
   skipped entirely (their listings are not touched).
2. **Collect**: for each enabled search call `source.search(url)`. Sanity check: if
   `listings.length < 0.9 * total` or (`total > 0` and `listings.length === 0`) treat as failure.
   A failed search: `ok=false`, error recorded, nothing derived from it.
   `seen` = union of ids from successful searches; remember per-search membership.
3. **New ids** (in `seen`, not in `listings`): call `source.details(id, url)` to get VIN/plate/
   publishedAt. Find vehicle by VIN (exact), else by plate (only if plate non-null). If found and
   the vehicle has any other listing → this is a **repost**: link to that vehicle, event `repost`
   (not `new`); if its price is lower than the vehicle's most recent listing's last price, also
   `price_drop` (payload old/new). Otherwise create vehicle (`first_seen_at = min(publishedAt, now)`)
   and event `new`. Insert listing `active`, first price_history row.
   If details fail for an id: still insert the listing with a fresh vehicle (vin/plate null),
   record error in `RunReport.errors`; do not fail the run.
   **Baseline**: if *every* search that returned this id has `baseline_at IS NULL`, the id is
   baseline: insert normally (incl. details) but emit no `new`/`repost` events.
4. **Known ids in `seen`**: update summary fields, `last_seen_at`, `listing_searches.last_seen_at`.
   If price changed vs `listings.price_usd` → insert price_history; if lower (both non-null) →
   event `price_drop`. If status was `out_of_filter` (or anything non-active) → set `active`,
   clear `closed_at`, event `back`.
5. **Disappeared**: listings with status `active` not in `seen`, where **all** searches linked in
   `listing_searches` are enabled-and-succeeded this run (if any linked search failed or is
   disabled, skip — no conclusions). For each: `source.details(id, url)`:
   - `active` → status `out_of_filter`, event `out_of_filter`.
   - `sold` / `removed` → if the vehicle has another listing currently `active` → `relisted`
     (no sold event); else `sold`, event `sold`. Set `closed_at = now`.
   - details throws → leave as is, record error.
   Process step 3 before step 5 so a same-day repost is detected.
6. Mark successful searches `baseline_at = now` if null. Finish `runs` row
   (`ok` = all searches ok and no errors, `requests = source.requestCount`).
7. Build `RunReport`: per search, events whose listing is linked to that search
   (via listing_searches). `activeCount` = active listings linked to that search.
   `daysOnMarket` = floor((now - vehicle.first_seen_at) / 1 day).

Prices are compared only in USD. A `null` price never produces a drop.

## Prices and currencies (from docs/recon.md)

AutoRia stores the price in the seller's currency and shows USD/UAH converted at today's FX
rate, so the USD value of a UAH-priced ad drifts daily. Rules:

- The seller's currency + price come from the ad page (`ListingDetails.currency/price`), fetched
  for every new id anyway. Stored in `listings.currency/price`.
- On later runs the current seller-currency price is read from the search card:
  `USD → card.priceUsd`, `UAH → card.priceUah`, `EUR → card.priceEur`. If that value is null
  (EUR is usually absent on used-car cards) or `listings.currency` is still unknown (details
  failed earlier), call `source.details()` for that listing to get it. These extra calls are
  rare; budget them like other details calls (outside transactions).
- A price change = change of `price` in the seller's currency → price_history row
  (`price`, `currency`, `price_usd` from the card). `price_drop` only when it decreased.
  `listings.price_usd` is refreshed every run silently (display only, no history, no event).
- Repost price comparison: compare `price` when both listings share a currency, else compare
  `price_usd`.
- Card fields brand/model/year/mileage are approximate (title parsing, mileage rounded to
  thousands); for new ids prefer the ad page values from `ListingDetails`.
