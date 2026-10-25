-- All timestamps are ISO-8601 UTC strings.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS searches (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  url           TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  -- set after the first fully successful collection; NULL means next run is a baseline
  baseline_at   TEXT
);

-- A physical car; several listings (reposts) can point to one vehicle.
CREATE TABLE IF NOT EXISTS vehicles (
  id            INTEGER PRIMARY KEY,
  vin           TEXT UNIQUE,
  plate         TEXT,
  -- min(first publication, first time we saw it); days-on-market counts from here
  first_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vehicles_plate ON vehicles(plate);

CREATE TABLE IF NOT EXISTS listings (
  id            INTEGER PRIMARY KEY,          -- AutoRia ad id
  vehicle_id    INTEGER NOT NULL REFERENCES vehicles(id),
  url           TEXT NOT NULL,
  title         TEXT NOT NULL,
  brand         TEXT,
  model         TEXT,
  year          INTEGER,
  mileage_km    INTEGER,
  city          TEXT,
  price_usd     INTEGER,                      -- last observed, display only (drifts with FX)
  price         INTEGER,                      -- last observed in the seller's currency
  currency      TEXT CHECK (currency IN ('USD','UAH','EUR')),  -- NULL until known from the ad page
  status        TEXT NOT NULL CHECK (status IN ('active','sold','relisted','out_of_filter')),
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,                -- last time present in a search result
  closed_at     TEXT                          -- when it left 'active'
);
CREATE INDEX IF NOT EXISTS listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS listings_vehicle ON listings(vehicle_id);

CREATE TABLE IF NOT EXISTS listing_searches (
  listing_id    INTEGER NOT NULL REFERENCES listings(id),
  search_id     INTEGER NOT NULL REFERENCES searches(id),
  last_seen_at  TEXT NOT NULL,
  PRIMARY KEY (listing_id, search_id)
);

-- One row per change of the price in the seller's currency (first observation included).
CREATE TABLE IF NOT EXISTS price_history (
  listing_id    INTEGER NOT NULL REFERENCES listings(id),
  observed_at   TEXT NOT NULL,
  price_usd     INTEGER,
  price         INTEGER NOT NULL,
  currency      TEXT NOT NULL,
  PRIMARY KEY (listing_id, observed_at)
);

CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  ok            INTEGER,
  requests      INTEGER,
  error         TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY,
  run_id        INTEGER NOT NULL REFERENCES runs(id),
  listing_id    INTEGER NOT NULL REFERENCES listings(id),
  type          TEXT NOT NULL CHECK (type IN ('new','repost','sold','price_drop','out_of_filter','back')),
  created_at    TEXT NOT NULL,
  payload       TEXT                          -- JSON, e.g. {"currency":"USD","old":15000,"new":14500,"oldUsd":15000,"newUsd":14500}
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id);
