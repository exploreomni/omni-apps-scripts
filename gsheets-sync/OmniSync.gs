/**
 * Omni → Google Sheets sync
 *
 * Setup (one time):
 *   1. Extensions → Apps Script, paste this file in.
 *   2. Project Settings → Script Properties, add:
 *        OMNI_BASE_URL   e.g. https://yourorg.omniapp.co
 *        OMNI_API_KEY    your Omni API key
 *   3. Reload the sheet — an "Omni" menu appears.
 *
 * Per-pull config: edit a row in the "OmniSync" sheet (auto-created on first run):
 *
 *   | sheet  | cell | dashboard_id          | tile          | include_headers |
 *   | Sales  | A1   | 1a2b3c4d-...          | Revenue by Mo | TRUE            |
 *
 *   - sheet:           target sheet name (created if missing)
 *   - cell:            top-left anchor for the paste, e.g. "A1" or "C5"
 *   - dashboard_id:    Omni document ID (UUID from the dashboard URL)
 *   - tile:            tile title as shown on the dashboard
 *   - include_headers: TRUE to write column headers as the first row
 *
 * Run via the Omni menu, or call syncAll() / syncRow(rowNumber) directly.
 */

const CONFIG_SHEET = 'OmniSync';
const CONFIG_HEADERS = ['sheet', 'cell', 'dashboard_id', 'tile', 'include_headers'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Omni')
    .addItem('Sync all rows', 'syncAll')
    .addItem('Sync active row', 'syncActiveRow')
    .addSeparator()
    .addItem('Initialize config sheet', 'ensureConfigSheet')
    .addToUi();
}

function ensureConfigSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG_SHEET);
    sheet.getRange(1, 1, 1, CONFIG_HEADERS.length).setValues([CONFIG_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function syncAll() {
  const rows = readConfigRows_();
  if (!rows.length) {
    SpreadsheetApp.getUi().alert('No config rows found in "' + CONFIG_SHEET + '".');
    return;
  }
  rows.forEach(r => runRow_(r));
  SpreadsheetApp.getActive().toast('Synced ' + rows.length + ' tile(s).', 'Omni', 5);
}

function syncActiveRow() {
  const sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== CONFIG_SHEET) {
    SpreadsheetApp.getUi().alert('Open the "' + CONFIG_SHEET + '" sheet and select the row to sync.');
    return;
  }
  syncRow(sheet.getActiveCell().getRow());
}

function syncRow(rowNumber) {
  const rows = readConfigRows_().filter(r => r._row === rowNumber);
  if (!rows.length) throw new Error('No config row at row ' + rowNumber);
  runRow_(rows[0]);
  SpreadsheetApp.getActive().toast('Synced row ' + rowNumber, 'Omni', 5);
}

function runRow_(cfg) {
  const query = findTileQuery_(cfg.dashboard_id, cfg.tile);
  const result = runQueryCsv_(query);
  writeCsvToSheet_(result, cfg.sheet, cfg.cell, cfg.include_headers);
}

function readConfigRows_() {
  const sheet = ensureConfigSheet();
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(String);
  const idx = Object.fromEntries(CONFIG_HEADERS.map(h => [h, headers.indexOf(h)]));
  CONFIG_HEADERS.forEach(h => {
    if (idx[h] === -1) throw new Error('Missing column "' + h + '" in ' + CONFIG_SHEET);
  });
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row[idx.dashboard_id] || !row[idx.tile]) continue;
    out.push({
      _row: i + 1,
      sheet: String(row[idx.sheet] || 'Sheet1'),
      cell: String(row[idx.cell] || 'A1'),
      dashboard_id: String(row[idx.dashboard_id]).trim(),
      tile: String(row[idx.tile]).trim(),
      include_headers: row[idx.include_headers] !== false && String(row[idx.include_headers]).toUpperCase() !== 'FALSE'
    });
  }
  return out;
}

function findTileQuery_(dashboardId, tileTitle) {
  const url = baseUrl_() + '/api/v1/documents/' + encodeURIComponent(dashboardId) + '/queries';
  const resp = omniFetch_(url, { method: 'get' });
  const body = JSON.parse(resp.getContentText());
  const queries = body.queries || body;
  if (!Array.isArray(queries)) {
    throw new Error('Unexpected response from /queries: ' + resp.getContentText().slice(0, 200));
  }
  const want = tileTitle.toLowerCase();
  const match = queries.find(q => {
    const title = (q.name || q.title || q.tile_name || (q.tile && q.tile.title) || '').toString().toLowerCase();
    return title === want;
  }) || queries.find(q => {
    const title = (q.name || q.title || q.tile_name || (q.tile && q.tile.title) || '').toString().toLowerCase();
    return title.includes(want);
  });
  if (!match) {
    const titles = queries.map(q => q.name || q.title || q.tile_name || (q.tile && q.tile.title)).filter(Boolean);
    throw new Error('Tile "' + tileTitle + '" not found. Available: ' + titles.join(' | '));
  }
  return match.query || match;
}

function runQueryCsv_(query) {
  const url = baseUrl_() + '/api/v1/query/run';
  const resp = omniFetch_(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ query: query, resultType: 'csv' })
  });
  return extractCsv_(resp);
}

function waitForJobs_(jobIds) {
  const url = baseUrl_() + '/api/v1/query/wait?job_ids=' + encodeURIComponent(jobIds.join(','));
  const resp = omniFetch_(url, { method: 'get' });
  return extractCsv_(resp);
}

/**
 * Omni may return CSV either as a raw body or wrapped in a JSON envelope
 * ({ data: "...csv...", remaining_job_ids: [...] }). Handle both.
 */
function extractCsv_(resp) {
  const text = resp.getContentText();
  const trimmed = text.replace(/^﻿/, '').trimStart();
  const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  if (!looksJson) return text;

  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return text;
  }
  if (body && body.remaining_job_ids && body.remaining_job_ids.length) {
    return waitForJobs_(body.remaining_job_ids);
  }
  if (body && typeof body.data === 'string') return body.data;
  if (body && body.result && typeof body.result === 'string') return body.result;
  throw new Error('Unexpected query response shape: ' + text.slice(0, 300));
}

function writeCsvToSheet_(csv, sheetName, anchorCell, includeHeaders) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  const rows = Utilities.parseCsv(csv);
  const data = includeHeaders ? rows : rows.slice(1);
  if (!data.length) return;

  const anchor = sheet.getRange(anchorCell);
  const startRow = anchor.getRow();
  const startCol = anchor.getColumn();
  const width = Math.max.apply(null, data.map(r => r.length));
  const normalized = data.map(r => {
    const padded = r.slice();
    while (padded.length < width) padded.push('');
    return padded;
  });

  sheet.getRange(startRow, startCol, normalized.length, width).setValues(normalized);
}

function omniFetch_(url, opts) {
  const options = Object.assign({ muteHttpExceptions: true, followRedirects: true }, opts || {});
  options.headers = Object.assign({}, options.headers, {
    Authorization: 'Bearer ' + apiKey_(),
    Accept: 'application/json'
  });
  const resp = UrlFetchApp.fetch(url, options);
  const code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Omni API ' + code + ' ' + url + ': ' + resp.getContentText().slice(0, 500));
  }
  return resp;
}

function baseUrl_() {
  const v = PropertiesService.getScriptProperties().getProperty('OMNI_BASE_URL');
  if (!v) throw new Error('Set OMNI_BASE_URL in Script Properties.');
  return v.replace(/\/+$/, '');
}

function apiKey_() {
  const v = PropertiesService.getScriptProperties().getProperty('OMNI_API_KEY');
  if (!v) throw new Error('Set OMNI_API_KEY in Script Properties.');
  return v;
}
