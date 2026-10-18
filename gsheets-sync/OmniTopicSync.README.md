# Google Sheets ↔ Omni Topic Explorer

`OmniTopicSync.gs` + `OmniTopicSidebar.html` let a Google Sheets user browse the Omni **topics they are entitled to**, tick the fields they want, add filters, and pull up to 50,000 rows into the sheet — without ever holding an Omni credential of their own.

Where [`OmniSync.gs`](./OmniSync.gs) pulls a *known dashboard tile* into a *known cell*, this script is interactive and permission-aware: the topic list is different for each person who opens the sheet.

- [How it works](#how-it-works)
- [What you need from Omni](#what-you-need-from-omni)
- [What you need from Google](#what-you-need-from-google)
- [Setup](#setup)
- [Using it](#using-it)
- [Filter reference](#filter-reference)
- [Query shape](#query-shape)
- [Limits](#limits)
- [Beyond copy-paste: sharing one script across many sheets](#beyond-copy-paste-sharing-one-script-across-many-sheets)
- [Troubleshooting](#troubleshooting)

## How it works

Omni has **no API for minting a personal access token**, so end users can't be asked to bring their own credential. The script authenticates with a single **organization API key** and scopes everything to the signed-in Google user.

### The access-control model it relies on

Topic access in Omni is defined **in the model**, keyed off **user attributes** — there is no endpoint that maps a topic to a user. In the model file you declare grants:

```yaml
access_grants:
  media_team:
    user_attribute: gsheet_demo_dept
    allowed_values: [media]
```

and each topic requires the grants it needs:

```yaml
required_access_grants: [media_team]   # restrict
required_access_grants: []             # open to everyone, overriding any default
```

`default_topic_required_access_grants` at the model level applies to any topic that doesn't set its own. Row-level filtering is separate, via `access_filters`. The attribute values themselves come from your IdP or are stored in Omni; for embed users they're passed in the SSO call.

You pass `userId` on the API call, and **Omni enforces whatever that user's attributes allow**. This works with organization API keys only — a personal access token always acts as its own user and ignores `userId`.

### The chain

| # | Step | Call |
|---|------|------|
| 1 | Identify the Google user | `Session.getEffectiveUser().getEmail()` — set by Google, not spoofable from inside the sheet |
| 2 | Map email → Omni user | `GET /api/scim/v2/Users?filter=userName eq "<email>"` → `id`. No match = no access |
| 3 | Enumerate the topics that exist | `GET /api/v1/models/{modelId}/yaml` → file names ending `.topic` |
| 4 | Keep only topics this user may see | `POST /api/v1/ai/pick-topic` with `{userId, potentialTopicNames:[topic]}` |
| 5 | Load the topic's fields | `GET /api/v1/models/{modelId}/topic/{topicName}`, falling back to the topic's YAML |
| 6 | Run the query **as that user** | `POST /api/v1/query/run?userId={userId}` |

### Why step 3 reads YAML instead of the topic list

This is the non-obvious part, and getting it wrong silently hides data from the people entitled to it.

**`GET /{modelId}/topic` is filtered by `required_access_grants` against the API key's own identity** — not the user you're acting for. An organization key is a service identity with no user attributes, and it isn't a SCIM user, so it cannot be given any. Every grant-restricted topic therefore vanishes from that endpoint, and a user genuinely entitled to a topic would never be offered it.

The same applies to `GET /{modelId}/topic/{topicName}`, which returns **404** for a topic the key can't see.

`GET /{modelId}/yaml` is **not** access-filtered, so it yields the true inventory. Topic file names are the topic names, so enumeration needs no YAML parsing.

### Why `pick-topic` is the entitlement check

Of all the model-facing endpoints, only `pick-topic` accepts a `userId`, and its `potentialTopicNames` is intersected against the topics that user may actually see:

| Request | Response |
|---------|----------|
| `potentialTopicNames: ["<entitled topic>"]` | `200 {"topicId":"<that topic>"}` |
| `potentialTopicNames: ["<not entitled>"]` | `422 "No topics available in this model"` |
| `userId` that doesn't exist | `400 "Membership … not found in organization"` |

Because an inaccessible candidate list returns 422 rather than echoing the name back, a single-candidate call is a reliable probe. Anything other than a matching `200` is treated as denied, so errors **fail closed**.

### Verified against a real restricted user

With two grants declared (`media_team`, `ecommerce_team`) keyed to a `gsheet_demo_dept` attribute:

| User | `streaming`<br>needs `media_team` | `oi_atl`<br>needs `ecommerce_team` | `world_cup`<br>`[]` | `ecomm`<br>no grants |
|---|---|---|---|---|
| test user, `dept=media` | **ALLOW** | **DENY** | ALLOW | ALLOW |
| a user with no `dept` value | **DENY** | **DENY** | ALLOW | ALLOW |
| *control: no grants in the model* | ALLOW | ALLOW | ALLOW | ALLOW |

Two findings worth knowing:

- **`CONNECTION_ADMIN` does not bypass `access_grants`.** A connection admin with no matching attribute value is denied like anyone else. Don't count on an admin role as a fallback.
- **`query/run?userId=` enforces grants server-side.** An unentitled user gets `400 Access denied for grant "media_team"` even when the field list is known. The data path is secured by Omni, not by this script's checks.

### Where each layer of security actually applies

| Concern | Enforced by |
|---------|-------------|
| Which topics appear in the menu | `pick-topic` probe (step 4), re-checked on every field load and every run |
| Which fields a topic offers | The topic definition — identical whether read from the detail endpoint or YAML |
| Which rows come back | Omni, server-side, from `required_access_grants` and `access_filters` on `query/run?userId=` |

> **Note:** `pick-topic` is an AI endpoint. AI must be enabled for the organization, and each probe may consume AI credits. The entitled-topic list is cached per user for 12 hours (`TOPICS_TTL_MS`), so a model with *N* topics costs *N* calls twice a day, not per query.

### Field metadata for restricted topics

Step 5 prefers `GET /{modelId}/topic/{topicName}` because it carries `data_type`, timeframes and fully-qualified names. When the key can't read the topic, the script falls back to parsing the topic's YAML, which yields the **same field set** — verified field-for-field on a restricted topic, including Omni's exclusion of `hidden: true` fields.

What the fallback cannot recover is `data_type` and timeframe variants, since the YAML doesn't carry them. In that mode the sidebar flags the topic, drops the time-grain dropdown, and asks you to pick a type (text / number / date / boolean) when you add a filter. Field selection and query execution are unaffected.

## What you need from Omni

| Item | Where to get it | Example |
|------|-----------------|---------|
| **Instance URL** | Your Omni hostname | `https://jmg.omniapp.co` |
| **Organization API key** | Settings → API Keys (requires Organization Admin) | `omni_osk_…` |
| **Shared model ID** | `GET /api/v1/models?modelKind=SHARED`, or the model URL in the IDE | `09ac9e6d-759b-42e0-8170-623a1c7cc6a5` |
| **Default topic name** *(optional)* | A `.topic` file name from `GET /api/v1/models/{modelId}/yaml` | `analytics_prod_coco_demo__oi_atl_2026_sv` |
| **Branch ID** *(optional)* | `GET /api/v1/models?include=activeBranches` → `branches[].id` | for testing model changes pre-merge |

Requirements:

- The key must be an **organization** key. A personal access token always acts as its own user and ignores the `userId` parameter, which defeats the whole design.
- **AI must be enabled** for the org, since entitlement probing uses `/api/v1/ai/pick-topic`. A `403 "AI query generation is not enabled"` means it isn't.
- Users see a topic only if their **user attributes satisfy its `required_access_grants`**. A user with no relevant attribute value sees only topics with no grants or `required_access_grants: []`. Set attribute values per user via SCIM:
  ```bash
  curl -L -X PATCH "$OMNI_BASE_URL/api/scim/v2/Users/{userId}" \
    -H "Authorization: Bearer $OMNI_API_KEY" -H "Content-Type: application/json" \
    -d '{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],
         "Operations":[{"op":"replace","path":"urn:omni:params:1.0:UserAttribute:gsheet_demo_dept","value":"media"}]}'
  ```
  Creating the attribute definition itself needs Org Admin (`POST /api/v1/user-attributes`, and note `type` must be `"String"` or `"Number"` — exact casing).
- Every person using the sheet needs an **Omni user account** whose `userName` equals their Google email. Check with:
  ```bash
  curl -L "$OMNI_BASE_URL/api/scim/v2/Users?filter=userName%20eq%20%22user@company.com%22" \
    -H "Authorization: Bearer $OMNI_API_KEY"
  ```
- Only **SHARED** models expose topics worth listing. An instance accumulates hundreds of throwaway `QUERY` / `WORKBOOK` models with `name: null`; filter with `?modelKind=SHARED`. The models endpoint is paginated (default 20, `pageSize` up to 100) via `pageInfo.nextCursor`.

To confirm an endpoint or parameter, fetch the live spec — it is authoritative for your version:

```bash
curl -L "$OMNI_BASE_URL/openapi.json" -H "Authorization: Bearer $OMNI_API_KEY"
```

## What you need from Google

| Item | Detail |
|------|--------|
| **Editor access** to the target Sheet | Needed to open Extensions → Apps Script |
| **Apps Script runtime** | V8 (the default). The script uses `const`, arrow functions, and `Object.assign` |
| **OAuth scopes** | Granted on first authorization — nothing to configure by hand |

Scopes the script triggers:

| Scope | Why |
|-------|-----|
| `.../auth/spreadsheets.currentonly` | Read the config and write results |
| `.../auth/script.external_request` | `UrlFetchApp` calls to the Omni API |
| `.../auth/userinfo.email` | `Session.getEffectiveUser().getEmail()` for identity |
| `.../auth/script.scriptapp` | Install the optional refresh-on-open trigger |
| `.../auth/script.container.ui` | Show the menu and sidebar |

If you prefer to pin them, add to `appsscript.json` (View → Show manifest file):

```json
{
  "timeZone": "America/Los_Angeles",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets.currentonly",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/script.scriptapp",
    "https://www.googleapis.com/auth/script.container.ui"
  ]
}
```

## Setup

1. Open the target Sheet → **Extensions → Apps Script**.
2. Paste `OmniTopicSync.gs` into `Code.gs` (or add a new script file).
3. **File → New → HTML file**, name it exactly `OmniTopicSidebar`, and paste in `OmniTopicSidebar.html`. The name must match — `showSidebar_()` loads it by that name.
4. **Project Settings → Script Properties**, add:

   | Property | Required | Value |
   |----------|----------|-------|
   | `OMNI_BASE_URL` | yes | `https://jmg.omniapp.co` |
   | `OMNI_API_KEY` | yes | your organization API key |
   | `OMNI_MODEL_ID` | yes | `09ac9e6d-759b-42e0-8170-623a1c7cc6a5` |
   | `OMNI_DEFAULT_TOPIC` | no | `analytics_prod_coco_demo__oi_atl_2026_sv` |
   | `OMNI_BRANCH_ID` | no | a model branch UUID — reads that branch instead of the shared model, so you can test grants and model edits before merging |

5. Reload the Sheet. An **Omni Topics** menu appears to the right of **Help**.
6. Run **Omni Topics → Refresh my topic list** once. Google will prompt for authorization; accept it. This populates the menu with the topics you're entitled to.
7. *(Optional)* **Omni Topics → Install refresh-on-open** adds an installable trigger that re-probes entitlements when the sheet opens. Each user installs this for themselves.

> A *simple* `onOpen` trigger may not call services that require authorization, so it cannot reach the Omni API. That's why the menu is built from the cached list and step 6 exists. The installable trigger from step 7 runs with full authorization and refreshes automatically.

## Using it

**Omni Topics** menu:

| Item | Does |
|------|------|
| *(topic names)* | Opens the picker with that topic selected — up to 15 topics get their own menu entry |
| **Open field picker…** | Opens the picker with the full topic dropdown |
| **Refresh my topic list** | Re-probes entitlements now and rebuilds the menu |
| **Show my Omni identity** | Your Google email, resolved Omni `userId`, model, cached topic count, last probe time |
| **Install / Remove refresh-on-open** | Manages your personal auto-refresh trigger |

In the sidebar, top to bottom:

1. **Topic** — only topics you're entitled to.
2. **Filters** — sits above the field list, because the topic's own filters land here and you usually want to see them before picking fields.
   - Any `default_filters` on the topic are **pre-filled automatically**, marked with a blue left edge, and are fully editable — change the operator, change the value, or delete the row.
   - **+ Add filter**, choose a field, and the operator list adapts to its data type. `not` inverts any condition; `aA` makes string matching case-insensitive (on by default). For text operators other than `between`, commas separate multiple values.
   - Any `always_where_filters` / `always_having_filters` are listed read-only above the rows. Omni applies those itself; you can't change them here.
3. **Fields** — grouped by view, collapsible. Each view header shows **(n of N selected)** so you can see at a glance where your selection sits, and the **Fields** heading carries the overall tally. Search by name, tick individually, or use **Select all** / **Clear all** / **Measures only**; group headers have their own **all** / **none**. Bulk actions respect the search box, so you can search `revenue` then click **Select all** to take just those.
4. **Time grain** — time dimensions collapse into one row with a grain dropdown (`raw`, `date`, `week`, `month`, `quarter`, `year`) instead of one checkbox per variant. For the `oi_atl_2026_sv` topic this turns 98 checkboxes into 63 rows.
5. **Run & write to sheet** — runs as you and writes to the topic's `-[SOURCE]` tab. Row 1 is a run-info line (topic, your email, timestamp, row limit); row 3 is the header; data starts at row 4.

### About pre-filled filters

`default_filters` in Omni are a **starting point, not a constraint**. `query/run` does not apply them on its own — verified: a topic with `genre is True Crime` returned all 14 genres when the filter wasn't sent. So the sidebar sends exactly the rows you leave in place, and deleting a pre-filled row genuinely removes that filter from the query. That's deliberate: it matches what you see in Omni when you open the topic and clear a default.

Pre-fill works for both metadata paths. Via the detail endpoint, Omni has already resolved the YAML shorthand (`not: Returned`) into its query form, so it maps straight across. For a topic the API key can't read, the shorthand is parsed out of the YAML directly — `is`, `not`, `contains`, `starts_with`, `ends_with`, `greater_than`, `less_than` and `between` are handled; anything else is skipped rather than guessed at. A default filter on a hidden field is noted next to the **Filters** heading rather than shown as a row, since there's no field to attach it to.

## Source tabs and intended use

Each run writes to a tab named **`<topic>-[SOURCE]`** — for example `Oi Atl 2026 Sv-[SOURCE]`. The `-[SOURCE]` suffix marks it as generated data, and row 1 repeats the warning.

**That tab is cleared and completely rewritten on every run.** Anything you add to it — extra columns, notes, formatting, formulas beside the data — is destroyed the next time anyone runs that topic. There is no append mode and no merge.

This tool is built to **pull one dataset from one Omni topic into one tab**. That's the whole intended scope. It is deliberately *not* a multi-tab workbook sync: there's no manifest of topic-to-tab mappings, no partial refresh, and no attempt to keep several tabs consistent with each other.

### Build your own work alongside it, not inside it

Treat a `-[SOURCE]` tab the way you'd treat a database table: read from it, never write to it.

- **Within one workbook** — put your pivots, charts and formulas on *separate* tabs that reference the source tab. `='Oi Atl 2026 Sv-[SOURCE]'!A3:D` survives a refresh; a column you added inside the source tab does not. Quote the tab name in formulas — the brackets and spaces require it.
- **Across workbooks** — if you want several topics feeding one place, give each topic its **own workbook** with this script installed, then pull them together with [`IMPORTRANGE`](https://support.google.com/docs/answer/3093340):

  ```
  =IMPORTRANGE("https://docs.google.com/spreadsheets/d/<SOURCE_SHEET_ID>", "Oi Atl 2026 Sv-[SOURCE]!A3:Z")
  ```

  Run `IMPORTRANGE` once and approve the access prompt it raises, after which it refreshes on its own. This keeps each extract isolated — one topic's refresh can't disturb another's — and keeps your reporting workbook free of tabs that get wiped.

Starting at `A3` skips the run-info line in row 1 and picks up the header row.

## Filter reference

Operators come from the `CompositeFilter` schema in `openapi.json`. Sending anything outside these lists fails with `No enum constant … FilterKind.X`.

| Field type | Operators | Extras |
|-----------|-----------|--------|
| **string** | `EQUALS`, `CONTAINS`, `STARTS_WITH`, `ENDS_WITH`, `SQL_LIKE`, `IS_EMPTY` | `case_insensitive` |
| **number** | `EQUALS`, `GREATER_THAN`, `LESS_THAN`, `BETWEEN` | `is_inclusive` |
| **date / timestamp** | `BETWEEN`, `ON_OR_AFTER`, `BEFORE` | Omni also supports `IS_IN_THE_MONTH`, `IS_ON_DAY_OF_WEEK`, and other relative kinds not surfaced in this UI |
| **boolean** | `EQUALS` with `true` / `false` | `treat_nulls_as_false` |
| **any** | `IS_NULL` / `IS_NOT_NULL` — sent as `{"type":"null"}` with `is_negative` | |

`is_negative: true` inverts any filter, which is how the `not` checkbox works.

A topic's own `default_filters` arrive in exactly this shape from the detail endpoint and are pre-filled into the sidebar — see [About pre-filled filters](#about-pre-filled-filters).

**String matching is case-sensitive by default.** `CONTAINS "ship"` returns nothing against `Shipped`; `case_insensitive: true` fixes it, and the sidebar sets it on by default.

**One filter per field.** Omni's `filters` is a map keyed by field reference, so two filters on the same field can't coexist — the second silently replaces the first. Use `BETWEEN`, or a comma-separated `EQUALS` list, instead of two rows on one field.

## Query shape

The payload sent to `POST /api/v1/query/run?userId=…`:

```json
{
  "query": {
    "modelId": "09ac9e6d-759b-42e0-8170-623a1c7cc6a5",
    "table": "",
    "join_paths_from_topic_name": "analytics_prod_coco_demo__oi_atl_2026_sv",
    "fields": ["…__order_items.status", "…__order_items.order_count"],
    "filters": { "…__order_items.status": { "kind": "CONTAINS", "type": "string", "values": ["ship"], "case_insensitive": true } },
    "sorts": [],
    "limit": 50000,
    "default_group_by": true,
    "version": 9
  },
  "resultType": "csv",
  "formatResults": false
}
```

Two non-obvious details, both of which will waste your afternoon if you get them wrong:

- **`table: ""` with `join_paths_from_topic_name`** is how Omni's own query builder targets a topic, and it is the only shape that works for **Snowflake semantic-view topics**. Their sub-views (`…__oi_atl_2026_sv__order_items`) are *not* addressable model views, so `table: "<topic>"` and `table: "<sub-view>"` both fail with `No such view`. This shape also resolves plain single-view topics, so there's one code path for both. It handles joins across views within the topic automatically — you can select a dimension from `products` and a measure from `order_items` in the same query.
- **`branchId` is a sibling of `query`**, not a property inside it. Nesting it returns `Bad Request: query.branchId: 'branchId' must be a top-level property`. Note also that the topic endpoints take snake_case `branch_id` while `pick-topic`, `query/run` and the YAML endpoint take camelCase `branchId`.
- **`formatResults: false`** is required. Left on, Omni returns `"216,704"` and the sheet stores it as text. Field references use `fully_qualified_name` (`view_name.field_name`), with the timeframe suffix appended for a grain: `…order_items.created_at[month]`.

## Limits

| Limit | Value | Notes |
|-------|-------|-------|
| Omni extract rows | **50,000** | `ROW_LIMIT`. When the result hits it, the sidebar warns and `truncated` is reported — add filters to narrow |
| Apps Script execution | 6 min (consumer) / 30 min (Workspace) | A 50K-row write takes several seconds; results are written in 2,000-row chunks (`WRITE_CHUNK_ROWS`) |
| `UrlFetchApp` calls | 20,000/day (Workspace) | Each refresh costs 1 SCIM + 1 topic list + 1 probe per topic |
| Cells per spreadsheet | 10,000,000 | 50,000 rows × 20 columns is 1M cells — watch this in a sheet with many result tabs |
| Topics in the menu | 15 | `TOPIC_SLOT_COUNT`; the rest stay reachable from the sidebar dropdown, since Apps Script menu items can't take arguments |
| Entitlement cache | 12 h | `TOPICS_TTL_MS`. **Refresh my topic list** forces a re-probe |
| Field metadata on restricted topics | degraded | No `data_type` or time grains — the YAML fallback can't recover them. Filters ask for a type instead |
| Filters per field | 1 | Omni's `filters` is a map keyed by field reference, so a second filter on the same field replaces the first |
| Result tabs per topic | 1 | Named `<topic>-[SOURCE]`, cleared and rewritten every run. No append, no merge, no multi-tab sync — see [Source tabs and intended use](#source-tabs-and-intended-use) |

## Beyond copy-paste: sharing one script across many sheets

Pasting this into each sheet is fine for development, but it does not scale and — more importantly — **Script Properties are readable by anyone who can open the Apps Script editor**. In a container-bound script, every editor of the spreadsheet can read the organization API key and then call Omni as the whole org. Treat a sheet containing this script as being as sensitive as the key itself.

Three ways out, in increasing order of isolation:

### 1. Apps Script library

Publish this project as a versioned library. Each sheet keeps a small stub:

```javascript
function onOpen() { OmniTopics.onOpen(); }
function openPicker() { OmniTopics.openPicker(); }
function refreshMyTopics() { OmniTopics.refreshMyTopics(); }
```

One codebase, version-pinned per sheet. But the key still lives in a project that consumers can open, and every sheet still needs manual setup.

### 2. Private Workspace Editor add-on ← recommended for rollout

A standalone Apps Script project published privately to your domain through the Google Workspace Marketplace, then force-installed by a Workspace admin.

- **No code in any sheet.** The menu appears in every Sheet for every licensed user.
- **The key is sealed.** Users never reach the script project, so Script Properties are inaccessible to them.
- **Identity still works.** Editor add-ons execute as the end user, so `Session.getEffectiveUser()` and per-user `UserProperties` behave exactly as they do here.
- **Updates ship centrally** by pushing a new deployment.

Roughly: attach the script to a *standard* GCP project (not the auto-created one), set the OAuth consent screen to **Internal**, configure the Google Workspace Marketplace SDK, publish privately, and have a Workspace admin install it for the right OUs. Internal-only distribution does not require Google's OAuth verification review.

### 3. Cloud Run proxy

Move the Omni calls into a small service: the key lives in Secret Manager, the service verifies the caller's Google identity token, does the SCIM resolution and entitlement probing, and returns only what that user may see. The add-on or sheet then talks to your service instead of Omni.

Strongest isolation and the only option where the org key never sits in an Apps Script project at all. Costs you a service to deploy and monitor, and the sheet still needs a thin client. A fully headless variant — Cloud Scheduler writing to sheets via the Sheets API — additionally needs domain-wide delegation on a service account, which is a heavy grant, and it gives up the interactive picker entirely.

## Testing per-user scoping

To prove the scoping works you need a user who is denied something. Do it on a **branch** so the shared model is untouched — set `OMNI_BRANCH_ID` to the branch and the whole script reads from it.

```bash
# 1. Create the attribute the grants key off (type must be "String" or "Number")
curl -L -X POST "$OMNI_BASE_URL/api/v1/user-attributes" \
  -H "Authorization: Bearer $OMNI_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"gsheet_demo_dept","label":"GSheet Demo Dept","type":"String"}'

# 2. Create a test user holding one value
curl -L -X POST "$OMNI_BASE_URL/api/scim/v2/Users" \
  -H "Authorization: Bearer $OMNI_API_KEY" -H "Content-Type: application/json" \
  -d '{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User","urn:omni:params:1.0:UserAttribute"],
       "userName":"gsheet-topic-test@omni.co","displayName":"GSheet Topic Test","active":true,
       "urn:omni:params:1.0:UserAttribute":{"gsheet_demo_dept":"media"}}'

# 3. Create a branch (branches are models of kind BRANCH; the response id is the branchId)
curl -L -X POST "$OMNI_BASE_URL/api/v1/models" \
  -H "Authorization: Bearer $OMNI_API_KEY" -H "Content-Type: application/json" \
  -d '{"modelKind":"BRANCH","baseModelId":"{sharedModelId}","connectionId":"{connectionId}","modelName":"topic-access-test"}'

# 4. Declare the grants in the model file and set required_access_grants on topics,
#    via POST /api/v1/models/{modelId}/yaml with {"fileName","yaml","branchId"}

# 5. Probe one topic as one user — 200 means entitled, 422 means not
curl -L -X POST "$OMNI_BASE_URL/api/v1/ai/pick-topic" \
  -H "Authorization: Bearer $OMNI_API_KEY" -H "Content-Type: application/json" \
  -d '{"modelId":"{modelId}","branchId":"{branchId}","userId":"{userId}",
       "prompt":"what data is here","potentialTopicNames":["{topicName}"]}'
```

Then run the same probe for a user **without** a matching attribute value and confirm it returns 422, and run the same probes against the shared model as a control — if the control also denies, the cause is something other than your grants.

Clean-up when finished: `DELETE /api/v1/models/{modelId}/branch/{branchName}`, `DELETE /api/scim/v2/Users/{userId}`, `DELETE /api/v1/user-attributes/{id}`.

## Troubleshooting

Errors appear in the sidebar's status area, in red.

| Message | Cause |
|---------|-------|
| `No Omni user matches <email>` | No Omni account whose `userName` is that Google email. Add the user in Omni, then **Refresh my topic list** |
| `Omni reports no topics you can access in this model` | The probe denied every topic. Check the user's [access grants and user attributes](https://docs.omni.co/modeling/develop/data-access-control.md) and their model role |
| `You do not have access to "<topic>"` | Re-check at field-load or run time failed — usually entitlements changed since the cache was written |
| `Omni API 403: AI query generation is not enabled` | Entitlement probing needs AI enabled for the org |
| `Omni API 401` | Key missing, expired, or not an organization key |
| `Set OMNI_MODEL_ID in Script Properties` | Missing Script Property |
| `No enum constant … FilterKind.X` | An operator not valid for that field's type — see [Filter reference](#filter-reference) |
| `No such view "<name>"` | The query targeted a semantic view's sub-view directly. Should not happen via this script; see [Query shape](#query-shape) |
| `Table '<name>' not found` | The model view resolved but its underlying warehouse table is missing — a modelling problem, not a script problem |
| `Numeric value '62%' is not recognized` | Warehouse data doesn't match the column type in the model. Fix the model or the data |
| `Access denied for grant "<name>"` | Omni refused the query because the user's attributes don't satisfy the topic's `required_access_grants`. This is the server-side enforcement working |
| `Omni did not return "<topic>" and it has no YAML file` | The topic name doesn't exist in this model or branch |
| `Could not read the fields for "<topic>"` | The key can't see the topic and its YAML declares no `views:` — check the topic file |
| Topic listed but a `branchId` error on run | `branchId` belongs beside `query` in the request body, not inside it. Fixed in this script; only relevant if you modify `runTopicExtract` |
| `Could not determine your Google account` | Script not yet authorized. Run **Refresh my topic list** from the menu |
| Edits to a result tab keep disappearing | Expected — `-[SOURCE]` tabs are rewritten every run. Put your work on a separate tab that references it |
| A topic's default filter didn't appear | It's on a hidden field (noted beside the **Filters** heading), or it uses a shorthand operator the YAML fallback doesn't map |
| Menu shows only "Refresh my topic list to begin…" | No cached entitlements yet — that's the expected first-run state |
| Menu is missing a topic you expect | More than 15 entitled topics; use **Open field picker…** |
| Exceeded maximum execution time | Too many rows or columns. Add filters, or select fewer fields |

To reset a user's cached identity and topic list, run this once from the editor:

```javascript
function resetMyCache() { PropertiesService.getUserProperties().deleteAllProperties(); }
```

## Reference

- [Omni API authentication](https://docs.omni.co/api/authentication.md) · [Models](https://docs.omni.co/api/models.md) · [Topics](https://docs.omni.co/api/topics.md) · [Queries](https://docs.omni.co/api/queries.md) · [Users (SCIM)](https://docs.omni.co/api/users.md)
- [Omni data access control](https://docs.omni.co/modeling/develop/data-access-control.md) — `access_grants`, `required_access_grants`, `default_topic_required_access_grants`, `access_filters` · [Filter syntax](https://docs.omni.co/modeling/filters.md)
- [Apps Script triggers](https://developers.google.com/apps-script/guides/triggers) · [Quotas](https://developers.google.com/apps-script/guides/services/quotas) · [HtmlService](https://developers.google.com/apps-script/guides/html) · [Publishing add-ons](https://developers.google.com/workspace/marketplace/how-to-publish)
