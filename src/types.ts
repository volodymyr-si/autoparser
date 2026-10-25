// Shared contracts between modules. Change only with care: every module depends on these.

export interface SearchConfig {
  /** Stable human name; also the key in the `searches` table. */
  name: string;
  /** Search URL copied from the auto.ria.com address bar. */
  url: string;
  enabled: boolean;
}

/** One ad as seen on a search results page. */
export interface ListingSummary {
  /** AutoRia ad id. */
  id: number;
  url: string;
  title: string;
  brand: string | null;
  model: string | null;
  year: number | null;
  mileageKm: number | null;
  city: string | null;
  /**
   * Prices as shown on the card. AutoRia converts from the seller's currency at the current
   * FX rate, so only the value in the seller's original currency is stable.
   */
  priceUsd: number | null;
  priceUah: number | null;
  priceEur: number | null;
  /** Plate from the card badge, normalized like ListingDetails.plate. */
  plate: string | null;
}

export type Currency = 'USD' | 'UAH' | 'EUR';

export interface SearchResult {
  /** Total ads matching the search, as reported by the site. */
  total: number;
  /** All ads across all pages. */
  listings: ListingSummary[];
}

/** Status of an ad as determined by opening its page. */
export type AdPageStatus = 'active' | 'sold' | 'removed';

export interface ListingDetails {
  id: number;
  status: AdPageStatus;
  vin: string | null;
  /** Normalized: uppercase, no spaces, Cyrillic look-alikes mapped to Latin. */
  plate: string | null;
  /** ISO timestamp of publication if the page exposes it. */
  publishedAt: string | null;
  priceUsd: number | null;
  /** Price in the currency the seller set; the only value safe to compare over time. */
  price: number | null;
  currency: Currency | null;
  brand: string | null;
  model: string | null;
  year: number | null;
  /** Exact mileage (search cards only have it rounded to thousands). */
  mileageKm: number | null;
  city: string | null;
}

export interface Source {
  search(url: string): Promise<SearchResult>;
  details(id: number, url?: string): Promise<ListingDetails>;
  /** HTTP requests made so far (for run stats). */
  readonly requestCount: number;
}

/**
 * Listing lifecycle in our DB.
 * - active: present in at least one search
 * - sold: disappeared and the page says sold OR the ad was removed/not found
 * - relisted: disappeared, but the same vehicle (VIN/plate) has another live listing
 * - out_of_filter: disappeared from searches, but the ad is still active on the site
 */
export type ListingStatus = 'active' | 'sold' | 'relisted' | 'out_of_filter';

export type EventType = 'new' | 'repost' | 'sold' | 'price_drop' | 'out_of_filter' | 'back';

export interface ListingView {
  id: number;
  url: string;
  title: string;
  brand: string | null;
  model: string | null;
  year: number | null;
  mileageKm: number | null;
  city: string | null;
  priceUsd: number | null;
  /** Days since the vehicle was first seen/published (follows reposts). */
  daysOnMarket: number;
}

export interface PriceDrop {
  listing: ListingView;
  /** In the seller's currency; a drop is detected only in this currency. */
  currency: Currency;
  oldPrice: number;
  newPrice: number;
  /** USD equivalents for display (old one as observed back then). */
  oldPriceUsd: number | null;
  newPriceUsd: number | null;
}

export interface SearchReport {
  search: string;
  url: string;
  ok: boolean;
  error?: string;
  /** True on the first successful run of this search: everything is baseline, no events. */
  baseline: boolean;
  activeCount: number;
  newListings: ListingView[];
  reposts: ListingView[];
  priceDrops: PriceDrop[];
  soldCount: number;
  outOfFilterCount: number;
  backCount: number;
}

export interface RunReport {
  runId: number;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  requests: number;
  searches: SearchReport[];
  /** Errors not tied to a single search (e.g. details fetch failures). */
  errors: string[];
}
