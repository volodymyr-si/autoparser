import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { exportData } from '../src/dashboard/build.js';

const schema = readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8');

function scenario() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  db.exec(`
  INSERT INTO searches(id,name,url) VALUES (1,'A','http://a'),(2,'B','http://b');
  INSERT INTO vehicles(id,first_seen_at) VALUES (1,'2026-10-01T00:00:00Z'),(2,'2026-10-20T12:00:00Z'),(3,'2026-09-15T00:00:00Z');
  INSERT INTO listings(id,vehicle_id,url,title,brand,model,year,mileage_km,city,price_usd,price,currency,status,first_seen_at,last_seen_at,closed_at) VALUES
   (10,1,'u10','Camry 2018','Toyota','Camry',2018,90000,'Kyiv',14500,14500,'USD','active','2026-10-01T00:00:00Z','2026-10-25T00:00:00Z',NULL),
   (11,2,'u11','Rav4','Toyota','RAV4',2019,50000,'Lviv',20000,840000,'UAH','active','2026-10-20T12:00:00Z','2026-10-25T00:00:00Z',NULL),
   (12,3,'u12','Accord','Honda','Accord',2017,120000,'Odesa',12000,12000,'USD','sold','2026-09-15T00:00:00Z','2026-10-10T00:00:00Z','2026-10-15T00:00:00Z');
  INSERT INTO listing_searches VALUES (10,2,'x'),(10,1,'x'),(11,1,'x'),(12,2,'x');
  INSERT INTO price_history(listing_id,observed_at,price_usd,price,currency) VALUES (10,'2026-10-10T00:00:00Z',14500,14500,'USD'),(10,'2026-10-01T00:00:00Z',15000,15000,'USD'),(11,'2026-10-20T12:00:00Z',20000,880000,'UAH'),(11,'2026-10-22T12:00:00Z',20000,840000,'UAH'),(12,'2026-09-15T00:00:00Z',12000,12000,'USD');
  INSERT INTO runs(id,started_at,finished_at,ok,requests) VALUES (1,'2026-10-24T09:00:00Z','2026-10-24T09:05:00Z',0,5),(2,'2026-10-25T09:00:00Z','2026-10-25T09:05:00Z',1,7);
  `);
  return db;
}

describe('exportData', () => {
  const d = exportData(scenario(), '2026-10-25T09:00:00Z');
  it('lists searches and last run', () => {
    expect(d.generatedAt).toBe('2026-10-25T09:00:00Z');
    expect(d.searches.map((s) => s.name)).toEqual(['A', 'B']);
    expect(d.lastRun).toEqual({ startedAt: '2026-10-25T09:00:00Z', finishedAt: '2026-10-25T09:05:00Z', ok: true, requests: 7 });
  });
  it('active listings', () => {
    expect(d.active.map((a) => a.id)).toEqual([10, 11]);
    const a = d.active[0]!;
    expect(a.daysOnMarket).toBe(24);
    expect(a.firstPrice).toBe(15000);
    expect(a.currency).toBe('USD');
    expect(a.priceUsd).toBe(14500);
    expect(a.searchIds).toEqual([1, 2]);
    expect(a.priceHistory.map((p) => p.price)).toEqual([15000, 14500]);
    expect(d.active[1]!.daysOnMarket).toBe(4);
    const u = d.active[1]!;
    expect([u.currency, u.price, u.firstPrice, u.priceUsd]).toEqual(['UAH', 840000, 880000, 20000]);
    expect(u.priceHistory[0]).toEqual({ at: '2026-10-20T12:00:00Z', price: 880000, currency: 'UAH', priceUsd: 20000 });
  });
  it('sold listings', () => {
    expect(d.sold).toEqual([expect.objectContaining({
      id: 12, url: 'u12', title: 'Accord', brand: 'Honda', model: 'Accord', year: 2017, mileageKm: 120000, city: 'Odesa',
      priceUsd: 12000, price: 12000, currency: 'USD', firstPrice: 12000, daysOnMarket: 30,
      closedAt: '2026-10-15T00:00:00Z', searchIds: [2],
    })]);
    expect(d.sold[0]!.priceHistory).toHaveLength(1);
  });
  it('empty db gives lastRun null', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(schema);
    expect(exportData(db, 'x').lastRun).toBeNull();
  });
});
