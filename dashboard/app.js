(function () {
'use strict';
var $ = function (id) { return document.getElementById(id); };
var TZ = 'Europe/Kyiv';
var data = null;
var sorts = { active: { k: 'daysOnMarket', dir: -1 }, sold: { k: 'closedAt', dir: -1 } };
var expanded = {};

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function fmtNum(n) { return n == null ? '—' : Math.round(n).toLocaleString('uk-UA').replace(/ /g, ' '); }
function fmtDT(iso) {
  try { return new Date(iso).toLocaleString('uk-UA', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }); } catch (e) { return iso; }
}
function fmtD(iso) {
  try { return new Date(iso).toLocaleDateString('uk-UA', { timeZone: TZ }); } catch (e) { return iso; }
}
function median(a) {
  if (!a.length) return null;
  var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function avg(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
function uniq(a) { return a.filter(function (v, i) { return v != null && a.indexOf(v) === i; }).sort(); }
function setOptions(sel, items, allLabel, keep) {
  var cur = keep ? sel.value : '';
  sel.innerHTML = '<option value="">' + allLabel + '</option>' + items.map(function (i) {
    return '<option value="' + esc(i.v) + '">' + esc(i.t) + '</option>';
  }).join('');
  if (items.some(function (i) { return String(i.v) === cur; })) sel.value = cur;
}
function num(id) { var v = $(id).value; return v === '' ? null : Number(v); }
function inSearch(item, sid) { return !sid || item.searchIds.indexOf(Number(sid)) >= 0; }

var SYM = { USD: '$', UAH: '₴', EUR: '€' };
function money(v, cur) {
  var c = cur || 'USD';
  return c === 'USD' ? '$' + fmtNum(v) : fmtNum(v) + ' ' + (SYM[c] || c);
}
// Seller-currency change (first vs current); USD fallback for legacy rows without currency.
function delta(l) {
  if (l.price == null || l.firstPrice == null) return null;
  return l.price - l.firstPrice;
}
function deltaPct(l) {
  var d = delta(l);
  return d == null || !l.firstPrice ? null : d / l.firstPrice * 100;
}
function deltaHtml(l) {
  var d = delta(l);
  if (d == null) return '<span class="flat">—</span>';
  if (d === 0) return '<span class="flat">без змін</span>';
  var pct = deltaPct(l) || 0;
  var sign = d < 0 ? '−' : '+';
  return '<span class="' + (d < 0 ? 'down' : 'up') + '">' + sign + money(Math.abs(d), l.currency) + ' (' + sign + Math.abs(pct).toFixed(1).replace('.', ',') + '%)</span>';
}

function filtered() {
  var sid = $('f-search').value, brand = $('f-brand').value, model = $('f-model').value;
  var yf = num('f-yfrom'), yt = num('f-yto'), pf = num('f-pfrom'), pt = num('f-pto');
  var q = $('f-text').value.trim().toLowerCase();
  return data.active.filter(function (l) {
    if (!inSearch(l, sid)) return false;
    if (brand && l.brand !== brand) return false;
    if (model && l.model !== model) return false;
    if (yf != null && (l.year == null || l.year < yf)) return false;
    if (yt != null && (l.year == null || l.year > yt)) return false;
    if (pf != null && (l.priceUsd == null || l.priceUsd < pf)) return false;
    if (pt != null && (l.priceUsd == null || l.priceUsd > pt)) return false;
    if (q && (l.title + ' ' + (l.city || '') + ' ' + (l.brand || '') + ' ' + (l.model || '')).toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
}
function sortVal(l, k) { return k === 'delta' ? deltaPct(l) : l[k]; }
function sorted(list, st) {
  var k = st.k, dir = st.dir;
  return list.slice().sort(function (a, b) {
    var x = sortVal(a, k), y = sortVal(b, k);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'string') return dir * x.localeCompare(y, 'uk');
    return dir * (x - y);
  });
}

function historySvg(h) {
  if (h.length < 2 || h.some(function (x) { return x.currency !== h[0].currency; })) return '';
  var W = 260, H = 90, p = 8;
  var t0 = Date.parse(h[0].at), t1 = Date.parse(h[h.length - 1].at) || t0 + 1;
  var ps = h.map(function (x) { return x.price; });
  var lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps);
  if (hi === lo) { hi += 1; lo -= 1; }
  var X = function (t) { return p + (t1 === t0 ? 0 : (t - t0) / (t1 - t0)) * (W - 2 * p); };
  var Y = function (v) { return H - p - (v - lo) / (hi - lo) * (H - 2 * p); };
  var d = '', dots = '';
  h.forEach(function (x, i) {
    var px = X(Date.parse(x.at)), py = Y(x.price);
    d += (i ? ' H' + px.toFixed(1) + ' V' : 'M' + px.toFixed(1) + ' ') + py.toFixed(1) + (i ? '' : '');
    dots += '<circle class="dot" cx="' + px.toFixed(1) + '" cy="' + py.toFixed(1) + '" r="2.5"><title>' + fmtD(x.at) + ': ' + money(x.price, x.currency) + '</title></circle>';
  });
  return '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Історія цін"><path class="ln" d="' + d + '"/>' + dots + '</svg>';
}
function historyHtml(l) {
  var h = l.priceHistory;
  if (!h.length) return '<em class="flat">Немає історії цін</em>';
  var items = h.map(function (x, i) {
    var ch = i && x.currency === h[i - 1].currency ? x.price - h[i - 1].price : 0;
    var c = ch ? ' <span class="' + (ch < 0 ? 'down' : 'up') + '">(' + (ch < 0 ? '−' : '+') + money(Math.abs(ch), x.currency) + ')</span>' : '';
    return '<li>' + fmtD(x.at) + ' — <b>' + money(x.price, x.currency) + '</b>' + (x.currency !== 'USD' && x.priceUsd != null ? ' <span class="flat">≈$' + fmtNum(x.priceUsd) + '</span>' : '') + c + '</li>';
  }).join('');
  return '<div class="hist-in"><ul>' + items + '</ul>' + historySvg(h) + '</div>';
}

function priceCell(l) {
  if (l.priceUsd == null) return '—';
  var s = '$' + fmtNum(l.priceUsd);
  return l.currency && l.currency !== 'USD' && l.price != null ? s + '<br><span class="flat">' + money(l.price, l.currency) + '</span>' : s;
}
// Rows for the active and sold tables; sold ones get an extra "left the market" date column.
function renderRows(tbody, table, list, st, withClosed) {
  var cols = withClosed ? 8 : 7, html = '';
  list.forEach(function (l) {
    html += '<tr class="row" data-id="' + l.id + '"><td class="title"><a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.title) + '</a></td>' +
      '<td class="n">' + (l.year || '—') + '</td><td class="n">' + (l.mileageKm == null ? '—' : fmtNum(l.mileageKm / 1000)) + '</td>' +
      '<td>' + esc(l.city || '—') + '</td><td class="n">' + priceCell(l) + '</td>' +
      '<td class="n">' + deltaHtml(l) + '</td><td class="n">' + l.daysOnMarket + '</td>' +
      (withClosed ? '<td class="n">' + fmtD(l.closedAt) + '</td>' : '') + '</tr>';
    if (expanded[l.id]) html += '<tr class="hist"><td colspan="' + cols + '">' + historyHtml(l) + '</td></tr>';
  });
  if (!list.length) html = '<tr><td colspan="' + cols + '" class="flat" style="text-align:center;padding:24px">Нічого не знайдено</td></tr>';
  $(tbody).innerHTML = html;
  Array.prototype.forEach.call(document.querySelectorAll('#' + table + ' th'), function (th) {
    th.className = th.className.replace(/\s*(asc|desc)/g, '');
    if (th.dataset.k === st.k) th.className += ' ' + (st.dir > 0 ? 'asc' : 'desc');
  });
}

function renderActive() {
  var list = sorted(filtered(), sorts.active);
  $('count').textContent = 'Показано ' + list.length + ' з ' + data.active.length;
  renderRows('rows', 'tbl', list, sorts.active, false);
}

function refreshModelOptions() {
  var sid = $('f-search').value, brand = $('f-brand').value;
  var models = uniq(data.active.filter(function (l) { return inSearch(l, sid) && (!brand || l.brand === brand); }).map(function (l) { return l.model; }));
  setOptions($('f-model'), models.map(function (m) { return { v: m, t: m }; }), 'Усі моделі', true);
}
function refreshBrandOptions() {
  var sid = $('f-search').value;
  var brands = uniq(data.active.filter(function (l) { return inSearch(l, sid); }).map(function (l) { return l.brand; }));
  setOptions($('f-brand'), brands.map(function (m) { return { v: m, t: m }; }), 'Усі марки', true);
}

var BUCKETS = [['$0–5k', 0, 5000], ['$5–10k', 5000, 10000], ['$10–15k', 10000, 15000], ['$15–20k', 15000, 20000], ['$20–30k', 20000, 30000], ['$30k+', 30000, Infinity]];

function barChart(rows) {
  var W = 640, rowH = 24, left = 150, right = 110, H = rows.length * rowH + 24;
  var max = Math.max.apply(null, rows.map(function (r) { return r.v; }).concat([1]));
  var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Медіана днів до продажу">';
  rows.forEach(function (r, i) {
    var y = 8 + i * rowH, w = Math.max(1, r.v / max * (W - left - right));
    s += '<text x="' + (left - 8) + '" y="' + (y + 14) + '" text-anchor="end">' + esc(r.label.length > 22 ? r.label.slice(0, 21) + '…' : r.label) + '</text>' +
      '<rect class="bar" x="' + left + '" y="' + y + '" width="' + w.toFixed(1) + '" height="16" rx="3"><title>' + esc(r.label) + ': ' + fmtNum(r.v) + ' дн., продано ' + r.n + '</title></rect>' +
      '<text class="m" x="' + (left + w + 6).toFixed(1) + '" y="' + (y + 13) + '">' + fmtNum(r.v) + ' дн. (' + r.n + ')</text>';
  });
  return s + '<line class="ax" x1="' + left + '" y1="4" x2="' + left + '" y2="' + (H - 4) + '"/></svg>';
}

function soldFiltered() {
  var sid = $('s-search').value, period = Number($('s-period').value) || 0;
  var since = period ? Date.parse(data.generatedAt) - period * 86400000 : 0;
  var q = $('s-text').value.trim().toLowerCase();
  return data.sold.filter(function (l) {
    if (!inSearch(l, sid)) return false;
    if (since && Date.parse(l.closedAt) < since) return false;
    if (q && (l.title + ' ' + (l.city || '') + ' ' + (l.brand || '') + ' ' + (l.model || '')).toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
}
function renderSoldList() {
  var list = sorted(soldFiltered(), sorts.sold);
  $('s-count').textContent = 'Показано ' + list.length + ' з ' + data.sold.length;
  renderRows('s-rows', 't-sold', list, sorts.sold, true);
}
function discounts(list) {
  return list.map(deltaPct).filter(function (p) { return p != null && p < 0; }).map(function (p) { return -p; });
}
function pct(v) { return v == null ? '—' : '−' + v.toFixed(1).replace('.', ',') + '%'; }
function usdMedian(list) { return median(list.filter(function (x) { return x.priceUsd != null; }).map(function (x) { return x.priceUsd; })); }
function kyivMonth(iso) {
  try { return new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }); } catch (e) { return iso.slice(0, 7); }
}

function renderSold() {
  var sold = soldFiltered();
  $('sold-empty').hidden = sold.length > 0;
  $('sold-body').hidden = sold.length === 0;
  if (!sold.length) return;
  renderSoldList();
  var disc = discounts(sold);
  var tiles = [
    [String(sold.length), 'продано / знято'],
    [usdMedian(sold) == null ? '—' : '$' + fmtNum(usdMedian(sold)), 'медіана останньої ціни'],
    [fmtNum(median(sold.map(function (x) { return x.daysOnMarket; }))) + ' дн.', 'медіана днів на ринку'],
    [disc.length + ' з ' + sold.length, 'знижували ціну'],
    [pct(median(disc)), 'медіана знижки (серед тих, хто знижував)'],
  ];
  $('s-tiles').innerHTML = tiles.map(function (t) { return '<div class="tile"><b>' + esc(t[0]) + '</b><span>' + esc(t[1]) + '</span></div>'; }).join('');
  var months = {};
  sold.forEach(function (s) { var m = kyivMonth(s.closedAt); (months[m] = months[m] || []).push(s); });
  $('t-months').tBodies[0].innerHTML = Object.keys(months).sort().reverse().map(function (m) {
    var g = months[m], d = discounts(g), p = usdMedian(g);
    var label = new Date(m + '-15T12:00:00Z').toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' });
    return '<tr><td>' + esc(label) + '</td><td class="n">' + g.length + '</td><td class="n">' + (p == null ? '—' : '$' + fmtNum(p)) + '</td><td class="n">' +
      fmtNum(median(g.map(function (x) { return x.daysOnMarket; }))) + '</td><td class="n">' + d.length + '</td><td class="n">' + pct(median(d)) + '</td></tr>';
  }).join('');
  var groups = {};
  sold.forEach(function (s) {
    var k = ((s.brand || '') + ' ' + (s.model || '')).trim() || 'Невідомо';
    (groups[k] = groups[k] || []).push(s);
  });
  var models = Object.keys(groups).map(function (k) {
    var g = groups[k], d = g.map(function (x) { return x.daysOnMarket; });
    return { k: k, n: g.length, med: median(d), avg: avg(d), price: median(g.filter(function (x) { return x.priceUsd != null; }).map(function (x) { return x.priceUsd; })) };
  }).sort(function (a, b) { return b.n - a.n || a.k.localeCompare(b.k, 'uk'); });
  $('t-models').tBodies[0].innerHTML = models.map(function (m) {
    return '<tr><td>' + esc(m.k) + '</td><td class="n">' + m.n + '</td><td class="n">' + fmtNum(m.med) + '</td><td class="n">' + fmtNum(m.avg) + '</td><td class="n">' + (m.price == null ? '—' : '$' + fmtNum(m.price)) + '</td></tr>';
  }).join('');
  $('t-buckets').tBodies[0].innerHTML = BUCKETS.map(function (b) {
    var g = sold.filter(function (s) { return s.priceUsd != null && s.priceUsd >= b[1] && s.priceUsd < b[2]; });
    return '<tr><td>' + b[0] + '</td><td class="n">' + g.length + '</td><td class="n">' + (g.length ? fmtNum(median(g.map(function (x) { return x.daysOnMarket; }))) : '—') + '</td></tr>';
  }).join('');
  $('chart').innerHTML = barChart(models.slice(0, 15).map(function (m) { return { label: m.k, v: m.med, n: m.n }; }));
}

function renderHeader() {
  $('updated').textContent = 'Оновлено: ' + fmtDT(data.generatedAt) + ' (Київ)';
  var b = $('runstatus'), r = data.lastRun;
  if (!r) { b.textContent = 'Запусків ще не було'; b.className = 'badge'; return; }
  b.className = 'badge ' + (r.ok ? 'ok' : 'fail');
  b.textContent = 'Останній запуск: ' + fmtDT(r.finishedAt || r.startedAt) + ' — ' + (r.ok ? 'успішно' : 'з помилками') + (r.requests != null ? ', запитів: ' + r.requests : '');
}

function init() {
  var opts = data.searches.map(function (s) { return { v: s.id, t: s.name }; });
  setOptions($('f-search'), opts, 'Усі пошуки');
  setOptions($('s-search'), opts, 'Усі пошуки');
  refreshBrandOptions(); refreshModelOptions();
  renderHeader(); renderActive(); renderSold();

  $('f-search').onchange = function () { refreshBrandOptions(); refreshModelOptions(); renderActive(); };
  $('f-brand').onchange = function () { refreshModelOptions(); renderActive(); };
  ['f-model', 'f-yfrom', 'f-yto', 'f-pfrom', 'f-pto'].forEach(function (id) { $(id).oninput = renderActive; });
  $('f-text').oninput = renderActive;
  $('s-search').onchange = $('s-period').onchange = renderSold;
  $('s-text').oninput = renderSold;
  function sortable(table, st, render) {
    $(table).tHead.onclick = function (e) {
      var th = e.target.closest('th'); if (!th) return;
      var k = th.dataset.k;
      if (st.k === k) st.dir = -st.dir; else { st.k = k; st.dir = (k === 'title' || k === 'city') ? 1 : -1; }
      render();
    };
  }
  function expandable(tbody, render) {
    $(tbody).onclick = function (e) {
      if (e.target.closest('a')) return;
      var tr = e.target.closest('tr.row'); if (!tr) return;
      var id = tr.dataset.id;
      if (expanded[id]) delete expanded[id]; else expanded[id] = true;
      render();
    };
  }
  sortable('tbl', sorts.active, renderActive);
  sortable('t-sold', sorts.sold, renderSoldList);
  expandable('rows', renderActive);
  expandable('s-rows', renderSoldList);
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (x) { x.classList.toggle('active', x === t); });
      $('tab-active').hidden = t.dataset.tab !== 'active';
      $('tab-sold').hidden = t.dataset.tab !== 'sold';
    };
  });
}

fetch('./data.json', { cache: 'no-cache' }).then(function (r) {
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}).then(function (d) { data = d; init(); }).catch(function (e) {
  var el = $('error'); el.hidden = false; el.textContent = 'Не вдалося завантажити data.json: ' + e.message;
  $('tab-active').hidden = true;
});
})();
