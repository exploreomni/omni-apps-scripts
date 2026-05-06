# Omni Apps Scripts

A collection of [Google Apps Scripts](https://developers.google.com/apps-script) for working with [Omni Analytics](https://omni.co) from inside Google Workspace.

## Scripts

### `OmniSync.gs` — Pull dashboard tile data into a Google Sheet

Runs from a Google Sheet and pulls data from one or more Omni dashboard tiles into specified cells.

**Setup**

1. Open the target Google Sheet → **Extensions → Apps Script**, paste `OmniSync.gs` into the editor, and save.
2. **Project Settings → Script Properties**, add:
   - `OMNI_BASE_URL` — e.g. `https://yourorg.omniapp.co`
   - `OMNI_API_KEY` — an Omni API key with access to the dashboard
3. Reload the sheet. An **Omni** menu appears.

**Configure your syncs**

The script auto-creates an `OmniSync` tab. Each row defines one tile-to-cell mapping:

| sheet  | cell | dashboard_id            | tile             | include_headers |
|--------|------|-------------------------|------------------|-----------------|
| Sales  | A1   | 1a2b3c4d-...            | Revenue by Month | TRUE            |
| Funnel | C5   | 9f8e7d6c-...            | Top accounts     | FALSE           |

- `sheet` — target sheet name (created if missing)
- `cell` — top-left anchor for the paste (e.g. `A1`, `C5`)
- `dashboard_id` — Omni document ID (the UUID in the dashboard URL)
- `tile` — tile title as shown on the dashboard
- `include_headers` — `TRUE` writes column headers as the first row

**Run**

- **Omni → Sync all rows** — refresh every configured tile
- **Omni → Sync active row** — refresh the row your cursor is on (must be on the `OmniSync` tab)
- To run on a schedule, add a [time-driven trigger](https://developers.google.com/apps-script/guides/triggers/installable) on `syncAll`.

**How it works**

1. `GET /api/v1/documents/{dashboardId}/queries` — fetch the queries powering the dashboard's tiles
2. Match the requested tile by title (exact, then substring fallback)
3. `POST /api/v1/query/run` with `resultType: "csv"` — run it
4. Poll `/api/v1/query/wait` if the query is still running
5. Parse the CSV and write it to the target cell

## Contributing

PRs welcome. Each script should be self-contained in a single `.gs` file and documented in this README.

## License

MIT
