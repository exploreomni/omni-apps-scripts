# Google Sheets ↔ Omni Tile Sync

`OmniSync.gs` is a Google Apps Script that pulls data from one or more Omni dashboard tiles into specific cells of a Google Sheet. Refresh on demand from the **Omni** menu, or on a schedule via a time-driven trigger.

## Setup

1. Open the target Google Sheet → **Extensions → Apps Script**, paste `OmniSync.gs` into the editor, and save.
2. **Project Settings → Script Properties**, add:
   - `OMNI_BASE_URL` — e.g. `https://yourorg.omniapp.co`
   - `OMNI_API_KEY` — an Omni API key with access to the dashboard
3. Reload the sheet. An **Omni** menu appears.

## Configure your syncs

The script auto-creates an `OmniSync` tab. Each row defines one tile-to-cell mapping. The first five columns are inputs you fill in; the last three are written by the script after each sync.

| sheet  | cell | dashboard_id | tile             | include_headers | dashboard_url | last_synced_at | last_status |
|--------|------|--------------|------------------|-----------------|---------------|----------------|-------------|
| Sales  | A1   | 1a2b3c4d-... | Revenue by Month | TRUE            | _(auto)_      | _(auto)_       | _(auto)_    |
| Funnel | C5   | 9f8e7d6c-... | Top accounts     | FALSE           | _(auto)_      | _(auto)_       | _(auto)_    |

**Inputs**

- `sheet` — target sheet name (created if missing)
- `cell` — top-left anchor for the paste (e.g. `A1`, `C5`)
- `dashboard_id` — Omni document ID (the UUID in the dashboard URL)
- `tile` — tile title as shown on the dashboard
- `include_headers` — `TRUE` writes column headers as the first row

**Outputs (leave blank — overwritten on each sync)**

- `dashboard_url` — clickable `HYPERLINK` back to the source dashboard
- `last_synced_at` — timestamp of the most recent attempt
- `last_status` — `OK` on success, otherwise the error message (truncated to 500 chars)

If you've used a previous version of this script, the new output columns are added automatically the next time you run a sync — no manual migration needed.

## Run

- **Omni → Sync all rows** — refresh every configured tile
- **Omni → Sync active row** — refresh the row your cursor is on (must be on the `OmniSync` tab)
- To run on a schedule, add a [time-driven trigger](https://developers.google.com/apps-script/guides/triggers/installable) on `syncAll`.

## How it works

1. `GET /api/v1/documents/{dashboardId}/queries` — fetch the queries powering the dashboard's tiles
2. Match the requested tile by title (exact match, then substring fallback)
3. `POST /api/v1/query/run` with `resultType: "csv"` — run it
4. Poll `/api/v1/query/wait` if the query is still running
5. Parse the CSV and write it to the target cell

## Troubleshooting

When a sync fails, the row's `last_status` column contains the error and `last_synced_at` contains the time it happened — `syncAll` records errors per-row and continues, so one bad config row won't stop the rest.

- **`Tile "..." not found. Available: ...`** — the tile title in the config doesn't match. Use a value from the `Available:` list.
- **`Set OMNI_BASE_URL in Script Properties`** — add Script Properties under Project Settings.
- **`Omni API 401 ...`** — the API key is missing, expired, or lacks access to the dashboard.
