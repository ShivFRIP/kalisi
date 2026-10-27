/**
 * Kalisi commute survey: receives answers from survey.html and appends them to this Google Sheet.
 * Setup steps: see SURVEY_SETUP.md (Extensions > Apps Script, paste this file, Deploy > New deployment > Web app).
 *
 * Tabs created automatically on the first response:
 *   responses : one row per response. Home and office are stored as H3 hexagon cells, never raw coordinates;
 *               no names or phone numbers.
 *   contacts  : only for people who asked to hear about a pilot (linked by responseId)
 *
 * Summary tabs (menu "Kalisi > Refresh summaries", or a time-driven trigger on refreshSummaries):
 *   summary_od_r7        demand per home-zone > office-zone pair (H3 resolution 7, about 5 km² each)
 *   summary_home_cells   responses per home hexagon (resolution set in survey.html, default 9, about 0.1 km²)
 *   summary_home_r8      the same rolled up to resolution 8 (about 0.7 km²), better for maps shared outside the team
 *   summary_office_r8    responses per office hexagon at resolution 8
 *   Rows with fewer than K_MIN responses are marked publishable_k5 = "no": keep them out of anything shared outside the team.
 *
 * Participant results: survey.html calls this web app with ?action=stats after a response is sent, to show live totals.
 * Only groups of K_MIN or more are returned; smaller ones are indistinguishable from empty. Totals are cached for 5 minutes.
 */
const RESPONSES_SHEET = 'responses';
const CONTACTS_SHEET = 'contacts';
const META = ['responseId', 'submittedAt', 'receivedAt', 'formVersion', 'consentVersion', 'source', 'durationSec'];
const K_MIN = 5;
const ANSWERS = ['location_method', 'home_h3', 'home_h3_res', 'home_h3_r8', 'home_h3_r7', 'home_h3_r6', 'home_cell_lat', 'home_cell_lon', 'home_area',
  'office_name', 'office_h3', 'office_h3_res', 'office_h3_r8', 'office_h3_r7', 'office_cell_lat', 'office_cell_lon', 'office_area', 'od_h3_r7',
  'address_search',
  'arrive_window', 'ride_home', 'leave_window', 'days', 'mode', 'oneway_time', 'monthly_spend', 'employer_transport', 'would_use',
  'max_monthly_pass', 'prefs', 'concerns', 'employer_contribution', 'gender', 'age_band'];
const CONTACT_COLS = ['responseId', 'receivedAt', 'name', 'phone', 'email'];

function doPost(e) {
  let data;
  try { data = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'invalid JSON' }); }
  if (!data || data.formVersion !== 1 || !/^[A-Z0-9-]{6,12}$/.test(String(data.responseId || ''))) {
    return json_({ ok: false, error: 'invalid request' });
  }
  if (data.hp) return json_({ ok: true });   // hidden "honeypot" field was filled: probably a bot, so store nothing

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);                       // one write at a time, so rows never interleave
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const now = new Date().toISOString();
    const a = data.answers || {};
    const row = [data.responseId, clean_(data.submittedAt), now, data.formVersion, clean_(data.consentVersion), clean_(data.source), Number(data.durationSec) || ''];
    ANSWERS.forEach(function (k) { row.push(clean_(a[k])); });
    sheet_(ss, RESPONSES_SHEET, META.concat(ANSWERS)).appendRow(row);

    const c = data.contact;
    if (c && (c.phone || c.email)) {
      sheet_(ss, CONTACTS_SHEET, CONTACT_COLS).appendRow([data.responseId, now, clean_(c.name), clean_(c.phone), clean_(c.email)]);
    }
    return json_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

// Adds a "Kalisi" menu to the Sheet.
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Kalisi').addItem('Refresh summaries', 'refreshSummaries').addToUi();
}

// Rebuilds the summary tabs from the responses tab.
function refreshSummaries() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(RESPONSES_SHEET);
  if (!sh || sh.getLastRow() < 2) return;
  const values = sh.getDataRange().getValues();
  const col = {};
  values[0].forEach(function (h, i) { col[h] = i; });
  const rows = values.slice(1).filter(function (r) { return r[col.location_method] === 'h3'; });
  const likely = function (r) { return Number(r[col.would_use]) >= 4; };                       // "Definitely" or "Probably"
  const fromPrivate = function (r) { return ['car', '2w', 'cab'].indexOf(String(r[col.mode])) >= 0; };

  const group = function (keyCol, extra) {
    const out = {};
    rows.forEach(function (r) {
      const k = r[col[keyCol]];
      if (!k) return;
      const g = out[k] || (out[k] = { first: r, n: 0, likely: 0, priv: 0, tallies: {} });
      g.n++;
      if (likely(r)) g.likely++;
      if (fromPrivate(r)) g.priv++;
      (extra || []).forEach(function (c) { tally_(g.tallies, c, r[col[c]]); });
    });
    return out;
  };
  const byLikely = function (a, b) { return b[1] - a[1]; };

  const od = group('od_h3_r7', ['home_area', 'office_area', 'arrive_window']);
  write_(ss, 'summary_od_r7',
    ['od_h3_r7', 'likely_users', 'responses', 'from_car_2w_cab', 'home_h3_r7', 'office_h3_r7', 'home_area', 'office_area', 'top_arrival_window', 'publishable_k5'],
    Object.keys(od).map(function (k) { const g = od[k];
      return [k, g.likely, g.n, g.priv, g.first[col.home_h3_r7], g.first[col.office_h3_r7], top_(g.tallies.home_area), top_(g.tallies.office_area), top_(g.tallies.arrive_window), g.n >= K_MIN ? 'yes' : 'no']; }).sort(byLikely));

  const home = group('home_h3', ['home_area']);
  write_(ss, 'summary_home_cells',
    ['home_h3', 'likely_users', 'responses', 'from_car_2w_cab', 'resolution', 'cell_lat', 'cell_lon', 'home_area', 'publishable_k5'],
    Object.keys(home).map(function (k) { const g = home[k];
      return [k, g.likely, g.n, g.priv, g.first[col.home_h3_res], g.first[col.home_cell_lat], g.first[col.home_cell_lon], top_(g.tallies.home_area), g.n >= K_MIN ? 'yes' : 'no']; }).sort(byLikely));

  const home8 = group('home_h3_r8', ['home_area']);
  write_(ss, 'summary_home_r8',
    ['home_h3_r8', 'likely_users', 'responses', 'from_car_2w_cab', 'home_area', 'publishable_k5'],
    Object.keys(home8).map(function (k) { const g = home8[k];
      return [k, g.likely, g.n, g.priv, top_(g.tallies.home_area), g.n >= K_MIN ? 'yes' : 'no']; }).sort(byLikely));

  const office = group('office_h3_r8', ['office_area', 'office_name']);
  write_(ss, 'summary_office_r8',
    ['office_h3_r8', 'likely_users', 'responses', 'from_car_2w_cab', 'office_area', 'top_office_name', 'publishable_k5'],
    Object.keys(office).map(function (k) { const g = office[k];
      return [k, g.likely, g.n, g.priv, top_(g.tallies.office_area), top_(g.tallies.office_name), g.n >= K_MIN ? 'yes' : 'no']; }).sort(byLikely));
}

function tally_(t, c, v) { if (v === '' || v === undefined) return; t[c] = t[c] || {}; t[c][v] = (t[c][v] || 0) + 1; }
function top_(m) { if (!m) return ''; let best = '', n = 0; Object.keys(m).forEach(function (k) { if (m[k] > n) { best = k; n = m[k]; } }); return best; }
function write_(ss, name, header, data) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  sh.getRange(1, 1, 1, header.length).setValues([header]);
  if (data.length) sh.getRange(2, 1, data.length, header.length).setValues(data);
}

// Open the web app URL in a browser to check the deployment is live.
// survey.html also calls ?action=stats&home=<home zone>&od=<route> to show participants live totals.
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'stats') return json_(stats_(String(p.home || ''), String(p.od || '')));
  return json_({ ok: true, service: 'Kalisi survey endpoint' });
}

function stats_(homeZone, od) {
  const agg = aggregates_();
  const z = agg.zones[homeZone], r = agg.od[od];
  return {
    ok: true, asOf: agg.asOf, k: K_MIN, total: agg.total,
    likelyPct: agg.total >= K_MIN ? Math.round(100 * agg.likely / agg.total) : null,
    // Zones and routes with fewer than K_MIN responses were dropped in aggregates_(), so a missing one
    // looks the same as one with no responses: the endpoint never reveals whether a small group exists.
    zone: z ? { name: z.name, n: z.n, toOffice: r ? r.n : null, officeName: r ? r.officeName : '', topArrival: r ? r.topArrival : '' }
            : { name: null, n: null, toOffice: null, officeName: '', topArrival: '' },
    top: agg.top
  };
}

// Totals across all responses, cached for 5 minutes so many participants don't each re-read the Sheet.
function aggregates_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('agg_v1');
  if (hit) return JSON.parse(hit);
  const agg = { asOf: new Date().toISOString(), total: 0, likely: 0, zones: {}, od: {}, top: [] };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RESPONSES_SHEET);
  if (sh && sh.getLastRow() >= 2) {
    const values = sh.getDataRange().getValues();
    const col = {};
    values[0].forEach(function (h, i) { col[h] = i; });
    const zoneNames = {}, odT = {};
    values.slice(1).forEach(function (row) {
      agg.total++;
      if (Number(row[col.would_use]) >= 4) agg.likely++;
      if (row[col.location_method] !== 'h3') return;
      const hz = row[col.home_h3_r7], k = row[col.od_h3_r7];
      if (hz) { agg.zones[hz] = agg.zones[hz] || { n: 0 }; agg.zones[hz].n++; tally_(zoneNames, hz, row[col.home_area]); }
      if (k) {
        const o = agg.od[k] || (agg.od[k] = { n: 0 });
        o.n++;
        tally_(odT, k + '|office', row[col.office_area]);
        tally_(odT, k + '|from', row[col.home_area]);
        tally_(odT, k + '|arrive', row[col.arrive_window]);
      }
    });
    Object.keys(agg.zones).forEach(function (z) { agg.zones[z].name = top_(zoneNames[z]) || 'your area'; });
    Object.keys(agg.od).forEach(function (k) {
      agg.od[k].officeName = top_(odT[k + '|office']) || 'your office';
      agg.od[k].topArrival = top_(odT[k + '|arrive']);
    });
    Object.keys(agg.zones).forEach(function (z) { if (agg.zones[z].n < K_MIN) delete agg.zones[z]; });
    Object.keys(agg.od).forEach(function (k) { if (agg.od[k].n < K_MIN) delete agg.od[k]; });
    agg.top = Object.keys(agg.od)
      .sort(function (a, b) { return agg.od[b].n - agg.od[a].n; }).slice(0, 5)
      .map(function (k) { return { from: top_(odT[k + '|from']) || '—', to: agg.od[k].officeName, n: agg.od[k].n }; });
  }
  try { cache.put('agg_v1', JSON.stringify(agg), 300); } catch (err) { /* too large to cache: computed fresh next time */ }
  return agg;
}

function sheet_(ss, name, header) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.appendRow(header);
  return sh;
}

// Trim length and stop text being read as a spreadsheet formula.
function clean_(v) {
  if (v === undefined || v === null) return '';
  let s = String(v).slice(0, 200);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
