/**
 * PerformDDS month-end pipeline — Apps Script web app.
 *
 * Sheet is the source of truth; dashboards are regenerated snapshots.
 * Date conversion bidirectional: sheet stores "Mar-26", dashboard RAW uses
 * "2026-03", form submits ISO "2026-03". Apps Script mediates both ways.
 *
 * Pivot lives here (not in the GitHub Action) because the sheet schema
 * (flat: Tag|Date|Meeting|Dimension|Value) and the dashboard RAW schema
 * (rich per-category) are intentionally different. JS-side pivot keeps the
 * Action a dumb file-swap.
 */

// ===== CONFIG =====

// Sheet IDs live in `dashboard raw data` Drive folder, owned by Dave.
// Missing practices return a clear error rather than crashing — add the ID
// here once the Copy-of template exists.
const PRACTICE_SHEET_IDS = {
  murray:   '1565Y7OkqbLjF5NmdAeFavXqsNQjj5E1xNMyg-kh9w68',
  abas:     '1_kUWXh5bYyOdPlvoPZPrOkKORQo0qo6Zy4XyZlF4W1Q',
  pigneri:  '1gn6Y5cWak0W53mnPTmwarNoD1VQtiiMVGzZYoUoDhY4',
  bilbeisi: '1bsmMUIQzOw0v4mtVGOahnxpSZ8HTf9RIGD8bCXJe8zo',
  vanek:    '1GQDX2U9aLaQH1LbRZ9wv9-BvQRfhMYGGVbZ9WLZiEh8',
};

// Map sheet tab name → dashboard RAW category key.
// Tab names assumed identical across practices (confirmed Murray/Abas/Pigneri
// per default). If drift appears, add an override in readAndPivot_.
const TAB_TO_RAW_KEY = {
  'Days':      'days',
  'Crowns':    'crowns',
  'Doctor':    'doctor',
  'Hygiene':   'hygiene',
  'Visits':    'visits',
  'Exams':     'exams',
  'Imaging':   'imaging',
  'Specialty': 'specialty',
  'Results':   'results',
};

// How to pivot each RAW category from flat rows into the dashboard shape.
//   dimensionless — collapse to { date, value }. Days tab.
//   providerMerge — rows like "Dr. Murray production" + "Dr. Murray days"
//                   merged into { date, name, production, days }. Doctor/Hygiene.
//   countValue    — value key renamed to 'count'. Visits/Exams/Imaging.
//   productionValue — value key renamed to 'production'. Specialty.
//   default       — { date, dimension, value }.
const RAW_PIVOT_RULES = {
  days:      { mode: 'dimensionless' },
  doctor:    { mode: 'providerMerge',    metrics: ['production', 'days'] },
  hygiene:   { mode: 'providerMerge',    metrics: ['production', 'days'] },
  visits:    { mode: 'countValue' },
  exams:     { mode: 'countValue' },
  imaging:   { mode: 'countValue' },
  specialty: { mode: 'productionValue' },
  results:   { mode: 'default' },
  crowns:    { mode: 'default' },
};

const COL = { TAG: 1, DATE: 2, MEETING: 3, DIMENSION: 4, VALUE: 5 };

// ===== ENTRY POINT =====

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    validateRequest_(payload);
    const writeResult = upsertSubmission_(payload);
    const raw = readAndPivot_(payload.practice);
    dispatchToGitHub_(payload.practice, raw);
    return jsonResponse_({ ok: true, ...writeResult });
  } catch (err) {
    console.error('doPost failed:', err && err.stack || err);
    return jsonResponse_({ ok: false, error: String(err && err.message || err) });
  }
}

// ===== VALIDATION =====

function validateRequest_(payload) {
  const props = PropertiesService.getScriptProperties();
  const expected = props.getProperty('SHARED_SECRET');
  if (!expected) throw new Error('SHARED_SECRET not configured');
  if (!payload || payload.secret !== expected) throw new Error('Unauthorized');
  if (!payload.practice) throw new Error('Missing practice');
  if (!PRACTICE_SHEET_IDS[payload.practice]) {
    throw new Error(
      'Practice "' + payload.practice + '" has no sheet configured yet. ' +
      'Add it to PRACTICE_SHEET_IDS in Code.gs once the template exists.'
    );
  }
  if (!Array.isArray(payload.values)) throw new Error('Missing values[]');
  if (!payload.date) throw new Error('Missing date');
}

// ===== UPSERT =====

function upsertSubmission_(payload) {
  const ss = SpreadsheetApp.openById(PRACTICE_SHEET_IDS[payload.practice]);
  const sheetDate = isoToSheet_(payload.date);
  if (!sheetDate) throw new Error('Cannot parse date: ' + payload.date);
  const meeting = payload.meeting || 'Month End';

  const byTag = {};
  for (const v of payload.values) {
    if (!v || !v.tag || !v.dimension) continue;
    (byTag[v.tag] = byTag[v.tag] || []).push(v);
  }

  let inserted = 0, updated = 0;
  const unknownTabs = [];

  for (const tag of Object.keys(byTag)) {
    const sheet = ss.getSheetByName(tag);
    if (!sheet) { unknownTabs.push(tag); continue; }

    const data = sheet.getDataRange().getValues();
    const rowIndex = new Map();
    for (let i = 1; i < data.length; i++) {
      const key = String(data[i][COL.DATE - 1]) + '|' +
                  String(data[i][COL.MEETING - 1]) + '|' +
                  String(data[i][COL.DIMENSION - 1]);
      rowIndex.set(key, i + 1);
    }

    for (const v of byTag[tag]) {
      const key = sheetDate + '|' + meeting + '|' + String(v.dimension);
      const existingRow = rowIndex.get(key);
      if (existingRow) {
        sheet.getRange(existingRow, COL.VALUE).setValue(v.value);
        updated++;
      } else {
        sheet.appendRow([tag, sheetDate, meeting, v.dimension, v.value]);
        inserted++;
      }
    }
  }

  SpreadsheetApp.flush();
  return { inserted: inserted, updated: updated, unknownTabs: unknownTabs };
}

// ===== READ + PIVOT =====

function readAndPivot_(practice) {
  const ss = SpreadsheetApp.openById(PRACTICE_SHEET_IDS[practice]);
  const raw = {};

  // Pre-seed every known category with [] so dashboard `.forEach()` calls
  // don't crash on a missing tab.
  for (const cat of Object.values(TAB_TO_RAW_KEY)) raw[cat] = [];

  for (const sheet of ss.getSheets()) {
    const rawKey = TAB_TO_RAW_KEY[sheet.getName()];
    if (!rawKey) continue;
    const data = sheet.getDataRange().getValues();
    const rule = RAW_PIVOT_RULES[rawKey] || { mode: 'default' };
    raw[rawKey] = pivotRows_(data, rule);
  }
  return raw;
}

function pivotRows_(data, rule) {
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    const date = sheetToIso_(r[COL.DATE - 1]);
    const dimension = r[COL.DIMENSION - 1];
    const value = r[COL.VALUE - 1];
    if (!date) continue;
    if (dimension === '' || dimension == null) continue;
    rows.push({ date: date, dimension: String(dimension), value: value });
  }

  switch (rule.mode) {
    case 'dimensionless': {
      // Days tab collapses to one value per date. Upsert guarantees one row
      // per (date, meeting, dimension) so we're safe to take the last seen.
      const seen = new Map();
      for (const r of rows) seen.set(r.date, num_(r.value));
      return Array.from(seen, function(pair) { return { date: pair[0], value: pair[1] }; });
    }

    case 'countValue':
      return rows.map(function(r) { return { date: r.date, dimension: r.dimension, count: num_(r.value) }; });

    case 'productionValue':
      return rows.map(function(r) { return { date: r.date, dimension: r.dimension, production: num_(r.value) }; });

    case 'providerMerge': {
      // "Dr. Murray production" + "Dr. Murray days" → { name, production, days }.
      // If the sheet uses different suffixes (e.g. "prod"/"days" or
      // capitalization drift), adjust rule.metrics.
      const metrics = rule.metrics || ['production', 'days'];
      const suffix = new RegExp('^(.*?)\\s+(' + metrics.join('|') + ')\\s*$', 'i');
      const merged = new Map();
      for (const r of rows) {
        const m = suffix.exec(r.dimension.trim());
        if (!m) continue;
        const name = m[1].trim();
        const metric = m[2].toLowerCase();
        const k = r.date + '|' + name;
        if (!merged.has(k)) merged.set(k, { date: r.date, name: name, production: null, days: null });
        merged.get(k)[metric] = num_(r.value);
      }
      return Array.from(merged.values());
    }

    default:
      return rows.map(function(r) { return { date: r.date, dimension: r.dimension, value: num_(r.value) }; });
  }
}

function num_(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

// ===== DATE CONVERSION =====

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** "Mar-26" (or an auto-parsed Date cell) → "2026-03". null on parse failure. */
function sheetToIso_(label) {
  if (label instanceof Date) {
    // Some column formats cause Sheets to coerce "Mar-26" into a Date.
    return Utilities.formatDate(label, Session.getScriptTimeZone(), 'yyyy-MM');
  }
  const s = String(label || '').trim();
  const m = /^([A-Za-z]{3})-(\d{2})$/.exec(s);
  if (!m) return null;
  const mon = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  const idx = MONTH_ABBR.indexOf(mon);
  if (idx < 0) return null;
  return '20' + m[2] + '-' + String(idx + 1).padStart(2, '0');
}

/** "2026-03" or "2026-03-01" → "Mar-26". null on parse failure. */
function isoToSheet_(iso) {
  const s = String(iso || '').trim();
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(s);
  if (!m) return null;
  const mon = parseInt(m[2], 10);
  if (mon < 1 || mon > 12) return null;
  return MONTH_ABBR[mon - 1] + '-' + m[1].slice(2);
}

// ===== GITHUB DISPATCH =====

function dispatchToGitHub_(practice, raw) {
  const props = PropertiesService.getScriptProperties();
  const pat = props.getProperty('GITHUB_PAT');
  const repo = props.getProperty('GITHUB_REPO');
  if (!pat) throw new Error('GITHUB_PAT not configured');
  if (!repo) throw new Error('GITHUB_REPO not configured');

  const body = {
    event_type: 'dashboard_update',
    client_payload: { practice: practice, raw: raw },
  };
  const bodyJson = JSON.stringify(body);
  if (bodyJson.length > 50000) {
    console.warn('dispatch body ' + bodyJson.length + ' bytes — approaching GitHub 64KB cap');
  }

  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/dispatches', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + pat,
      'Accept': 'application/vnd.github+json',
    },
    payload: bodyJson,
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('GitHub dispatch failed (' + res.getResponseCode() + '): ' + res.getContentText());
  }
}

// ===== RESPONSE =====

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
