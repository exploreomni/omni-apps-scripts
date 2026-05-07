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
 *   | sheet | cell | dashboard_id | tile | include_headers | dashboard_url | last_synced_at | last_status |
 *   | Sales | A1   | 1a2b3c4d-... | Rev. | TRUE            | (auto)        | (auto)         | (auto)      |
 *
 *   Inputs:
 *   - sheet:           target sheet name (created if missing)
 *   - cell:            top-left anchor for the paste, e.g. "A1" or "C5"
 *   - dashboard_id:    Omni document ID (UUID from the dashboard URL)
 *   - tile:            tile title as shown on the dashboard
 *   - include_headers: TRUE to write column headers as the first row
 *
 *   Outputs (written by the script after each sync, leave blank):
 *   - dashboard_url:   HYPERLINK formula pointing back to the dashboard
 *   - last_synced_at:  timestamp of the last attempt
 *   - last_status:     "OK" on success, otherwise the error message
 *
 * Run via the Omni menu, or call syncAll() / syncRow(rowNumber) directly.
 */

const CONFIG_SHEET = 'OmniSync';
const INPUT_HEADERS = ['sheet', 'cell', 'dashboard_id', 'tile', 'include_headers'];
const OUTPUT_HEADERS = ['dashboard_url', 'last_synced_at', 'last_status'];
const CONFIG_HEADERS = INPUT_HEADERS.concat(OUTPUT_HEADERS);

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
    return sheet;
  }
  const lastCol = Math.max(1, sheet.getLastColumn());
  const existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const missing = CONFIG_HEADERS.filter(h => existing.indexOf(h) === -1);
  if (missing.length) {
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
  }
  return sheet;
}

function configColumnIndex_(sheet) {
  const lastCol = Math.max(1, sheet.getLastColumn());
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const idx = {};
  CONFIG_HEADERS.forEach(h => { idx[h] = headers.indexOf(h); });
  return idx;
}

function syncAll() {
  const sheet = ensureConfigSheet();
  const rows = readConfigRows_(sheet);
  if (!rows.length) {
    SpreadsheetApp.getUi().alert('No config rows found in "' + CONFIG_SHEET + '".');
    return;
  }
  let ok = 0;
  rows.forEach(r => { if (executeRow_(sheet, r)) ok++; });
  const errs = rows.length - ok;
  const msg = 'Synced ' + ok + ' / ' + rows.length + ' tile(s)' + (errs ? ' — ' + errs + ' failed (see last_status)' : '');
  SpreadsheetApp.getActive().toast(msg, 'Omni', 6);
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
  const sheet = ensureConfigSheet();
  const rows = readConfigRows_(sheet).filter(r => r._row === rowNumber);
  if (!rows.length) throw new Error('No config row at row ' + rowNumber);
  const ok = executeRow_(sheet, rows[0]);
  SpreadsheetApp.getActive().toast(ok ? 'Synced row ' + rowNumber : 'Row ' + rowNumber + ' failed — see last_status', 'Omni', 6);
}

function executeRow_(sheet, cfg) {
  try {
    const query = findTileQuery_(cfg.dashboard_id, cfg.tile);
    const csv = runQueryCsv_(query);
    writeCsvToSheet_(csv, cfg.sheet, cfg.cell, cfg.include_headers);
    writeRowStatus_(sheet, cfg, 'OK');
    return true;
  } catch (e) {
    writeRowStatus_(sheet, cfg, String(e && e.message ? e.message : e));
    return false;
  }
}

function writeRowStatus_(sheet, cfg, status) {
  const idx = configColumnIndex_(sheet);
  if (idx.last_synced_at >= 0) {
    sheet.getRange(cfg._row, idx.last_synced_at + 1).setValue(new Date());
  }
  if (idx.last_status >= 0) {
    sheet.getRange(cfg._row, idx.last_status + 1).setValue(status.length > 500 ? status.slice(0, 497) + '...' : status);
  }
  if (idx.dashboard_url >= 0 && cfg.dashboard_id) {
    const url = baseUrl_() + '/dashboards/' + encodeURIComponent(cfg.dashboard_id);
    sheet.getRange(cfg._row, idx.dashboard_url + 1)
      .setFormula('=HYPERLINK("' + url + '","Open dashboard")');
  }
}

function readConfigRows_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(String);
  const idx = {};
  INPUT_HEADERS.forEach(h => {
    idx[h] = headers.indexOf(h);
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
