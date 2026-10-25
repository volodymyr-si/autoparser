# auto.ria.com reconnaissance (2026-10-25)

All findings verified with plain `curl -g` (desktop Chrome UA, `Accept-Language: uk-UA,uk;q=0.9`, no cookies, home IP, 2 s between requests, about 42 requests total). The site is a Vue 3 SSR app. Fixtures are in `test/fixtures/` (raw responses, nothing stripped; `*.headers` hold the response headers).

| Fixture | What it is |
|---|---|
| `search-page1.html` | `?categories.main.id=1&brand.id[0]=79&size=20` (page 0), 200, 1.5 MB |
| `search-page2.html` | same with `&page=2`, 200 |
| `ad-active.html` | `/uk/auto_toyota_camry_37456649.html`, active, USD price |
| `ad-uah-price.html` | `/uk/auto___40606269.html`, active, seller price in UAH |
| `ad-sold.html` | `/uk/auto___40300000.html`, inactive ("deleted") ad still served with 200 |
| `ad-deleted.html` (+`.headers`) | `/uk/auto___30000000.html`, old removed ad: 301 (body is 71 bytes) |
| `ad-nonexistent-404.html` | `/uk/auto___99999999999.html`: 404 with full HTML body |
| `bff-search-onlyitems.json` | `/bff/search/public/search?...` JSON endpoint (see section 6) |

## 1. Search page

### Where the JSON lives
The first big inline `<script>` (no `id`, no `type`) of the document contains:

```
window.cacheState = false;
window.__PINIA__ = {...one JSON object...};
</script>
```

Only 3 other plain scripts exist (loadCSS, one module, set_ui.js). No `__NEXT_DATA__`, no `application/json` script, no ld+json on the search page.

Robust extraction: find `window.__PINIA__ = `, take everything up to the next `</script>`, trim, strip one trailing `;`, `JSON.parse`. (A brace-balancing scanner also works; I tested both. Plain `indexOf('</script>')` is safe because `</script>` does not appear inside the JSON.) Throw if the marker is missing.

The object has top-level keys `page, user, device, lang, favorites, popup, toast, subscribe, auth, form, searchPage, analytic, actionBus, list`. Most of it is UI templates (about 1 MB); ignore it.

### Paths (relative to the parsed `__PINIA__`)

| Data | Path | Example |
|---|---|---|
| Total count | `searchPage.searchResultData.count` (string!) | `"12309"` |
| Max page | `searchPage.searchResultData.maxPage` (string) | `"616"` |
| Echo of effective query | `searchPage.searchResultData.searchString` | `search_type=1&category=1&all[0].any[0].brand=79&abroad=0&customs_cleared=1&page=0&limit=20` |
| Current page (0-based) | `list.lists.items.page` (number) | `0` |
| Total pages | `list.lists.items.totalPage` | `616` |
| Items | `list.lists.items.items[]` | 22 entries for limit 20 |
| Ad card | `items[i].component.advertisementCard.data` | see below |

`count` also appears as `"count":12309` in several other places in the HTML, so a plain regex works as a cross-check, but use the path above.

`items[]` is mixed: ad cards have `type: "AdvertisementCardTemplate"`; other entries are layout fillers (`ColumnTemplate id=OFTD0`, `RowTemplate id=NewAutoMarketplaceInformer0`) with no `component.advertisementCard`. Filter on `x.component?.advertisementCard?.data`. With `size=20` I got exactly 20 cards + 2 fillers.

Careful: other `"autoId"` strings in the HTML belong to the video-stories block (`page.structures[...]...actionData.autoId`, 6 entries, duplicated in `page.templates.videoBlock`). They are NOT search results. Do not regex `"autoId"` for IDs.

### Card fields (`...advertisementCard.data`)

| Field | Path | Example | Notes |
|---|---|---|---|
| autoria id | `id` (number) | `37456649` | |
| kind | `type` | `"Auto"` or `"NewAuto"` | see caveat below |
| title | `title.content` | `"Toyota Camry 2018"` | brand + model + year, one string |
| subtitle | `subtitle` | `"VIII покоління/XV70  •  2.5 АТ (203 к.с.)"` | optional (missing on some) |
| price | `price` | `{"UAH":831369,"USD":18300}` | numbers |
| old price | `discountPrice` | `{"USD":30500}` | only on some cards, see below |
| url | `link` | `https://auto.ria.com/uk/auto_toyota_camry_37456649.html` | slug is `auto_<brand>_<model>_<id>` |
| published | `publishTime` | `"2 дні тому"` | relative, Ukrainian, not parseable to a date |
| basic info | `basicInfo[]` of `{icon, content}` | see below | always 4 entries in my sample |
| badges | `photoContainer.leftTopBadges[]`, `...badges[]` | `"KA 3747 MK"` (plate badge, optional) | |
| last verified | `lastVerified` | optional | |

`basicInfo` is positional: `[0]` mileage, `[1]` transmission, `[2]` fuel and engine volume, `[3]` city. Example: `["121 тис. км","Автомат","Газ/Бензин, 2.49 л","Київ"]`. Mileage icon style is `ic_16_speedometer`, which is a more stable anchor than position. City can carry the region: `"Львів (Львівська)"`, `"Дніпро (Дніпропетровськ)"`.

There are no separate brand, model or year fields in the card. Options: parse the title with `/^(.*) (\d{4})$/` (year is the last token), and take brand/model from the ad page (`ldJSON.brand.name`, `ldJSON.model`). The URL slug is ambiguous because brands and models contain hyphens (`mercedes-benz`, `land-cruiser`, `c-hr`).

Mileage units: the card string is `"121 тис. км"` meaning thousands of km (rounded), so `121000` km, approximate. Variants seen in 200 cards: `N тис. км` (154), `Без пробігу` (46, new cars), `N км` (3, small exact values). The exact value is on the ad page: `ldJSON.mileageFromOdometer.value` (121000, unit KMT).

### Price currency
Every card in all fetched pages had both `price.USD` and `price.UAH` (200 of 200 cards in the size=200 sample, 154 `Auto` + 46 `NewAuto`). `NewAuto` cards also have `price.EUR` and `price.mainCurrency` (3 = EUR). So a USD value is always present, but it is derived from the original currency at the current FX rate when the seller set UAH/EUR.

Evidence: ad 40606269 has the seller price 1 300 000 UAH. Search card says `{"UAH":1300000,"USD":28615}`; the ad page said USD `28 609` a few minutes later. So the USD value of UAH-priced ads drifts with the exchange rate and would produce fake "price drops" if compared as USD (conflicts with the SPEC rule in section 3). The search card does NOT say which currency the seller chose. Heuristic only: UAH is a round number (multiple of 1000) while USD is not. Reliable source: ad page `ldJSON.offers.priceCurrency` (`"UAH"`) and `ldJSON.offers.price` (`1300000`). `additionalParams.currencyId` was `1` for both the USD and the UAH ad, so it is not reliable.

`discountPrice` (`{"USD":30500}` on ad 40522200 where `price.USD` is 29500) appears on about a quarter of the cards. Its meaning (old struck-through price vs. promo) was not verified. `price` is the current price.

### Caveat: new cars in the results
`categories.main.id=1&brand.id[0]=79` yields `search_type=1` (mixed). 46 of 200 cards were `type: "NewAuto"` with ids in a different id space (e.g. 2090865), link `https://auto.ria.com/uk/newauto/auto-toyota-hilux-2090865.html`, mileage `Без пробігу`. The total `count` (12309) includes them. Add `indexName=auto` to get used cars only: the effective query becomes `search_type=2` and all 100 cards were `Auto` (count 11962). Alternatively filter `type === "Auto"` client-side (then `count` will not match the extracted number; the sanity check must account for that). The SPEC says used cars only, so the scraper should append `indexName=auto` or filter, and the user's copied URL may or may not contain it.

## 2. Pagination and sorting

All verified with `Accept-Language: uk-UA` on `/uk/search/`:

| Param | Behaviour |
|---|---|
| `page=N` | **0-based**. No param = `page=0`. `page=0` returned the same IDs as no param. `page=1` and `page=2` return disjoint ID sets (checked: p0, p1, p2 pairwise disjoint, 20 ids each). Beyond `maxPage-1` not tested. |
| `size=N` | Maps to `limit=N`. 20 and 100 and 200 all worked (200 returned 200 cards, totalPage 62, 6.5 MB HTML). Larger values not tested. `size=100` gives 3.7 MB per page; `size=20` about 1.5 MB. A fixed ~1 MB of every response is UI template noise, so bigger pages are much cheaper per ad. |
| `totalPage` | `ceil(count/size)`: 616 for size 20 (12309), 124 for size 100, 62 for size 200. |
| Sort by date | `sort[0].order=dates.created.desc` is accepted and mapped to `order=7` in `searchString`. The first page then contains the newest ads (ids around 40608098), but about 12 older promoted/pinned ads appear mixed in at the top (ids 40348225 ... 29788990) before the strictly recent ones. So it is not a pure descending-by-date order. `order_by=3` appeared as `order=3` (different ordering, meaning not verified). |
| Default order | Relevance/promotion (paid "ТОП" ads first), not by date. |

Filters from the old-style URL are honoured and rewritten server side. Verified: `year[0].gte=2017&year[0].lte=2020&price.USD.lte=20000&price.currency=1` produced count 636 with max price 20000 and years 2017 to 2020. `model.id[0]=2104` (an arbitrary model id I tried, not mapped to a name) produced count 1; the model filter is honoured as `all[0].any[0].any[0].model=2104`. The `searchString` shows the internal form: `all[0].any[0].brand=79&all[0].any[0].year[0]=2017&all[0].any[0].year[1]=2020&price[0]=1&price[2]=20000&abroad=0&customs_cleared=1&page=0&limit=100`. `abroad=0&customs_cleared=1` are added by default.

URL shape from the browser address bar: could not be verified (no browser available). The site's own `<link rel="canonical">` is plain `https://auto.ria.com/uk/search/`, so the canonical does not carry filters. The URL in SPEC.md (`categories.main.id=1&brand.id[0]=79&...`) is accepted as-is, and appending `page`/`size`/`sort[0].order` works. If the browser produces a different shape (`?search_type=...&all[0].any[0].brand=79...` is the internal form and may also be accepted), test that shape with the scraper's first run. Remember `curl -g` / do not percent-encode brackets blindly (fetch/undici accept raw `[0]` in the query).

Dedup: ads can legitimately move between pages while paging (promoted ads, new posts shifting the list). The scraper should dedupe by id across pages and compare the number of unique `Auto` ids with `count`.

## 3. Ad page

### URLs
- `https://auto.ria.com/uk/auto_<brand>_<model>_<id>.html`: 200 for an active ad.
- **`https://auto.ria.com/uk/auto___<id>.html` (three underscores, id only): 200 with the same full page for existing ads.** Verified for 37456649, 40606269, 40300000 and others. This is the form to use when only the id is known.
- `https://auto.ria.com/uk/auto_<id>.html`: 404 (nginx body). `https://auto.ria.com/auto_<id>.html`: 302 to the previous one, so also 404 in the end. Do not use them.
- The slug in the URL is ignored for lookup: `auto_toyota_camry_30000000.html` redirected to `/uk/car/jawa/350/`, i.e. the real brand/model of ad 30000000.

### Where the JSON lives
Same mechanism as search: `window.__PINIA__ = {...};` in the first big inline `<script>` (347 KB of JSON; 668 KB HTML). Plus three `<script type="application/ld+json">` (BreadcrumbList, Vehicle with details, Vehicle with images), which are also embedded inside the Pinia object. The Pinia key `page.structures` has exactly one entry whose key is the path, e.g. `"/uk/auto_toyota_camry_37456649.html/"` (for id-only URLs it is `"/uk/auto___40300000.html/"`; for a redirected ad it may differ). Use `Object.values(page.structures)[0]` and call it `R`.

### Paths (relative to `R = Object.values(__PINIA__.page.structures)[0]`)

| Data | Path | Example |
|---|---|---|
| autoria id | `R.additionalParams.autoId` (string) | `"37456649"` |
| VIN | `R.ldJSON.vehicleIdentificationNumber` | `"4T1B11HK7JU136181"` |
| plate | template `badgesPlateNumber`: `__PINIA__.page.templates.mvs...` (search with `"id":"badgesPlateNumber"` then first `"content"`), text has spaces | `"KA 3747 MK"` |
| plate (alt) | `R.seo.title` contains `(KA3747MK)` | regex `\(([A-ZА-Я0-9]{6,9})\)` |
| price (original currency) | `R.ldJSON.offers.price` + `R.ldJSON.offers.priceCurrency` | `18300` / `"USD"`; `1300000` / `"UAH"` |
| prices all | `R.additionalParams.prices` (strings with NBSP) | `{"UAH":"831 369","USD":"18 300","EUR":"16 178"}` (the thousands separator is ` `) |
| brand | `R.ldJSON.brand.name` | `"Toyota"` |
| model | `R.ldJSON.model` | `"Camry"` (`"C-HR"`, `"Crafter"`) |
| year | `R.ldJSON.productionDate` | `2018` |
| mileage km | `R.ldJSON.mileageFromOdometer.value` | `121000` |
| title | `R.additionalParams.title` | `"Toyota Camry 2018"` |
| city | `R.breadcrumbsLD.itemListElement[3].item.name` (position 4 in the breadcrumb list) | `"Київ"`; also in `R.seo.title` (`в Києві`) |
| created date | text in `__PINIA__.page.templates.advertStatistic`: `"Оголошення створене 23.10.2026"` | regex `створене (\d{2}\.\d{2}\.\d{4})` -> `23.10.2026` (dd.mm.yyyy) |
| active flag | `R.additionalParams.isActive` (boolean) | `true` / `false` |
| availability | `R.ldJSON.offers.availability` | `https://schema.org/InStock` / `https://schema.org/SoldOut` |
| status | `R.status` | `200` (always 200 in my samples, even for the inactive ad) |
| seller | `R.additionalParams.owner` | `{id,name,photo}` |
| views, favorites | `advertStatistic` texts | `"Переглядів авто 1 040"`, `"Додано в Обране 24"` |

Publication date: only the **creation date** exists, at day resolution, in `advertStatistic`. No "updated/republished" date, and no `datePublished` anywhere in the HTML. The search card only has the relative `publishTime`. For an inactive ad (`ad-sold.html`) the `advertStatistic` block is absent, so there is no date.

Plate may be missing: ad 40606269 had no `badgesPlateNumber`, nor a plate in `seo.title` (plate is optional; `plate: null`). VIN was present everywhere I looked, but VIN can also be hidden/absent on some ads (not seen, treat as nullable).

## 4. Status detection (active / removed / not found)

Observed responses for `https://auto.ria.com/uk/auto___<id>.html` (do NOT follow redirects, use `redirect: 'manual'`):

| Case | Example id | HTTP | Body / markers |
|---|---|---|---|
| Active | 37456649, 40606269, 40580000, 39000000 | 200 | `isActive: true`, `availability` `InStock`, no `bannerStatus` template, `advertStatistic` present |
| Removed, recent (days to ~weeks) | 40300000, 40100000, 40200000, 40350000, 40400000, 40450000, 40500000, 39800000 | **200** | `R.additionalParams.isActive === false`, `ldJSON.offers.availability` ends with `SoldOut`, `R.templates` contains `{id:"bannerStatus"}` with text `Оголошення <title> видалене і не бере участі в пошуку` ("the ad is deleted and does not participate in search"). VIN, plate, price, brand etc. are still present. `advertStatistic` missing. Page is smaller (~175-570 KB). |
| Removed, old | 30000000, 35000000, 38000000, 39500000 | **301** | `Location: https://auto.ria.com/uk/car/<brand>/<model>/` (e.g. `/uk/car/jawa/350/`, `/uk/car/audi/a6/`), body `Moved Permanently. Redirecting to ...`. Following it gives the 200 model listing page, which would look like a valid page. |
| Id never existed | 99999999999 | **404** | 179 KB HTML 404 page, no `__PINIA__` |
| Wrong URL shape | `auto_<id>.html` | 404 | 552-byte nginx page |

The 200 -> 301 cut-off for removed ads lies between ids 39500000 (301) and 39800000 (200), i.e. removed ads stay viewable for a while (I did not measure how long; the ids correspond to roughly some months back, cannot date them exactly). Ads of that age that are still alive exist (39000000 active), so age alone does not matter.

Detection rules (proposed):
1. HTTP 404 -> gone (not found).
2. HTTP 301/302 with `Location` matching `/uk/car/...` (not an `auto_` URL) -> removed (archived).
3. HTTP 200 and no `__PINIA__` -> parse error, abort (do not guess).
4. HTTP 200 and `isActive === false` (or `availability` ends with `SoldOut`, or `bannerStatus` present) -> removed, still viewable.
5. HTTP 200 and `isActive === true` -> active.

**Not determined: a true "sold" marker.** I found no "Продано" / "Авто продано" banner, no `isSold`, `soldDate`, `stateId` field in any ad page or search card. Every inactive ad I sampled (8 of 8) uses the same wording "видалене" (deleted), and `availability: SoldOut` is just schema.org's term used for all inactive ads. So on this site "sold" and "deleted by owner" are indistinguishable from the HTML, which matches the SPEC decision to treat both as `sold`. Also not found: a search filter or section for sold ads (I did not find any param in the search data; not exhaustively tested).

Note on the "out_of_filter" status: for an ad that left the results but is still active, rule 5 applies (200 + `isActive: true`).

## 5. Anti-bot, headers, rate limiting

- No captcha, no challenge page, no JS challenge. About 42 requests in about 10 minutes with 2 s gaps, all 200/301/404 as expected. No 403/429.
- Response headers: `server: openresty`, `x-powered-by: Express`, `set-cookie: ab_redesign=1`, `ab_test_new_pages=1` (A/B test cookies, not required; I never sent cookies back), `x-custom-is-ukraine: 1`, `x-custom-need-to-redirect-uk/ru: 0`, `x-custom-redirect-type: 7`. No `x-ratelimit-*`, no `retry-after`.
- `x-custom-is-ukraine: 1` suggests geo-awareness. Requests from a non-Ukrainian datacenter IP (GitHub Actions) were NOT tested (open question 1 in SPEC.md). The `x-custom-need-to-redirect-*` headers hint that foreign IPs may get redirected or a different language.
- The 301 for a removed ad also sets a cookie `viewalertnoadv=<id>` (not needed). An error body (404) has no Pinia.

## 6. Other: JSON endpoint (unverified for use)

The page itself loads data from `GET https://auto.ria.com/bff/search/public/search?search_type=1&category=1&all[0].any[0].brand=79&abroad=0&customs_cleared=1&onlyItems=1&limit=5` (see `list.lists.items.apiData`). Without cookies it returned 200 JSON (124 KB for limit=5, fixture `bff-search-onlyitems.json`). Shape: `{templates:[{type:"WrapperTemplate",id:"Auto37456649", templates:[{type:"ProductCardTemplate", component:{productCard:{autoId:"37456649",...}}}, ...]}], additionalParams:{count,maxPage,nextPage}}`. It is a different (mobile-style) template tree than the page's card data, I did not map price/mileage in it. It is an undocumented internal API; the HTML route is the verified one. Might be worth a look later because a page is ~25 KB per ad instead of ~75 KB.

## 7. Illustrative extraction (not committed code)

Search page (`search-page1.html`):

```js
const fs = require('fs');
function pinia(html) {
  const marker = 'window.__PINIA__ = ';
  const a = html.indexOf(marker);
  if (a < 0) throw new Error('__PINIA__ not found');
  const start = a + marker.length;
  const end = html.indexOf('</script>', start);
  return JSON.parse(html.slice(start, end).trim().replace(/;$/, ''));
}
function searchAds(html) {
  const p = pinia(html);
  const count = Number(p.searchPage.searchResultData.count);
  const maxPage = Number(p.searchPage.searchResultData.maxPage);
  const ads = p.list.lists.items.items
    .map(x => x.component && x.component.advertisementCard && x.component.advertisementCard.data)
    .filter(Boolean)
    .filter(d => d.type === 'Auto')
    .map(d => {
      const m = d.title.content.match(/^(.*) (\d{4})$/);
      const km = d.basicInfo.map(b => b.content).find(c => /км$/.test(c));
      const mileageKm = km ? (/тис\./.test(km) ? parseInt(km) * 1000 : parseInt(km)) : null;
      return { id: d.id, priceUsd: d.price.USD, priceUah: d.price.UAH, title: m ? m[1] : d.title.content,
        year: m ? +m[2] : null, mileageKm, city: d.basicInfo[d.basicInfo.length - 1].content,
        url: d.link, publishTime: d.publishTime };
    });
  return { count, maxPage, ads };
}
```

Run with `node` on `test/fixtures/search-page1.html`:

```
{"count":12309,"maxPage":616,"extracted":20}
[
  {
    "id": 37456649,
    "priceUsd": 18300,
    "priceUah": 831369,
    "title": "Toyota Camry",
    "year": 2018,
    "mileageKm": 121000,
    "city": "Київ",
    "url": "https://auto.ria.com/uk/auto_toyota_camry_37456649.html",
    "publishTime": "2 дні тому"
  },
  {
    "id": 40522200,
    "priceUsd": 29500,
    "priceUah": 1340185,
    "title": "Toyota Camry",
    "year": 2021,
    "mileageKm": 98000,
    "city": "Київ",
    "url": "https://auto.ria.com/uk/auto_toyota_camry_40522200.html",
    "publishTime": "3 дні тому"
  },
  {
    "id": 40597534,
    "priceUsd": 30999,
    "priceUah": 1408285,
    "title": "Toyota Camry",
    "year": 2025,
    "mileageKm": 29000,
    "city": "Львів (Львівська)",
    "url": "https://auto.ria.com/uk/auto_toyota_camry_40597534.html",
    "publishTime": "2 дні тому"
  }
]
```

Result: `count=12309`, `maxPage=616`, **20 ads extracted** (20 cards, all `type: "Auto"`). `title` here is brand + model (year stripped).

Ad page (run on `ad-active.html`, `ad-sold.html`, `ad-uah-price.html`):

```js
function adInfo(html) {
  const p = pinia(html);                                   // same pinia() as above
  const R = Object.values(p.page.structures)[0];
  const ap = R.additionalParams, ld = R.ldJSON;
  const texts = [];
  (function w(o) { if (o && typeof o === 'object') { if (o.type === 'Text' && typeof o.content === 'string') texts.push(o.content); Object.values(o).forEach(w); } })(p.page.templates.advertStatistic);
  const created = (texts.join('|').match(/створене (\d{2}\.\d{2}\.\d{4})/) || [])[1] || null;
  const plateM = html.match(/"id":"badgesPlateNumber"[^]*?"content":"([^"]+)"/);
  return { autoId: +ap.autoId, isActive: ap.isActive, availability: ld.offers.availability.split('/').pop(),
    vin: ld.vehicleIdentificationNumber, plate: plateM ? plateM[1].replace(/\s/g, '') : null,
    priceCurrency: ld.offers.priceCurrency, price: ld.offers.price, brand: ld.brand.name, model: ld.model,
    year: +ld.productionDate, mileageKm: ld.mileageFromOdometer.value, created,
    hasBanner: !!R.templates.find(t => t.id === 'bannerStatus') };
}
```

Output (verified with node; `advertStatistic` is undefined for inactive ads and the walker tolerates that, giving `created: null`; the plate regex is a hack on the raw HTML, the real code should walk the template tree):

```
ad-active.html {"autoId":37456649,"isActive":true,"status":200,"availability":"InStock","vin":"4T1B11HK7JU136181","plate":"KA3747MK","priceCurrency":"USD","price":18300,"prices":{"UAH":"831 369","USD":"18 300","EUR":"16 178"},"brand":"Toyota","model":"Camry","year":2018,"mileageKm":121000,"created":"23.10.2026","hasBanner":false}
ad-sold.html {"autoId":40300000,"isActive":false,"status":200,"availability":"SoldOut","vin":"WV1ZZZ2EZG6015990","plate":"AX2973PA","priceCurrency":"USD","price":15000,"prices":{"UAH":"681 450","USD":"15 000","EUR":"13 260"},"brand":"Volkswagen","model":"Crafter","year":2015,"mileageKm":637000,"created":null,"hasBanner":true}
ad-uah-price.html {"autoId":40606269,"isActive":true,"status":200,"availability":"InStock","vin":"NMTK54BX40R066784","plate":null,"priceCurrency":"UAH","price":1300000,"prices":{"UAH":"1 300 000","USD":"28 609","EUR":"25 292"},"brand":"Toyota","model":"C-HR","year":2021,"mileageKm":50000,"created":"25.10.2026","hasBanner":false}
```

## 8. Caveats and unknowns

- No true "sold" marker exists in HTML; removed ads (sold or deleted) look identical. Not verified whether a different banner exists for ads sold via some AUTO.RIA flow (for example "Авто продано" for dealer cars). 8 of 8 inactive samples had the same text.
- The 200 -> 301 transition for removed ads: ids <= 39500000 gave 301, >= 39800000 gave 200. How long a removed ad stays at 200 is unknown (could be time-based, not id-based). The scraper must handle both, plus 404.
- A scraper using fetch must use `redirect: 'manual'`, otherwise a removed ad silently resolves to a 200 category page without `__PINIA__` for the ad.
- `count` includes `NewAuto` unless `indexName=auto` is used; ids from `NewAuto` are in a different id space.
- USD price of UAH/EUR-priced ads is FX-derived and drifts (28615 vs 28609 within minutes). Spec's "compare USD only" would create noise; use `ld.offers.priceCurrency/price` from the ad page (or compare with a tolerance, or only compare when the seller currency is USD).
- Search card `publishTime` is relative text; only the ad page has a created date (dd.mm.yyyy, creation not repost).
- `discountPrice` semantics not verified.
- Brand/model are not separate fields on search cards; city may include the region in brackets.
- Browser address-bar URL shape not verified. Behaviour for `page` beyond `maxPage-1` and `size` over 200 not tested.
- Not tested: requests from GitHub Actions IPs, behaviour under sustained load (>50 requests), Russian-language pages, cookies/headers effects (A/B cookie `ab_redesign`, `ab_test_new_pages` may change the layout, so the Pinia structure could differ between variants; fail loudly when paths are missing).
- Pinia JSON is a UI-template tree, so field positions (`basicInfo` order, plate in a template) may change with front-end releases. Prefer `ldJSON`, `additionalParams`, `searchResultData` and the ad card `data` fields, which are data-like.
