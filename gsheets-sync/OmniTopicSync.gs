/**
 * Omni Topics → Google Sheets
 *
 * Lets a Google Sheets user browse the Omni topics *they* are entitled to, pick
 * fields, add filters, and pull the results into the sheet — without ever
 * holding an Omni credential of their own.
 *
 * Scope: one topic, one dataset, one tab. Results land in "<topic>-[SOURCE]",
 * which is CLEARED AND REWRITTEN on every run. This is not a multi-tab sync —
 * build downstream work on separate tabs that reference the source tab, or give
 * each topic its own workbook and combine them with IMPORTRANGE. See the README.
 *
 * Setup (one time):
 *   1. Extensions → Apps Script, paste this file in, and add OmniTopicSidebar.html
 *      (File → New → HTML file, named "OmniTopicSidebar").
 *   2. Project Settings → Script Properties, add:
 *        OMNI_BASE_URL        e.g. https://yourorg.omniapp.co
 *        OMNI_API_KEY         an ORGANIZATION API key (not a personal token)
 *        OMNI_MODEL_ID        shared model UUID to read topics from
 *        OMNI_DEFAULT_TOPIC   (optional) topic preselected in the picker
 *        OMNI_BRANCH_ID       (optional) model branch UUID to read instead of
 *                             the shared model — for testing model changes,
 *                             including access_grants, before they are merged
 *   3. Reload the sheet, then run "Omni Topics → Refresh my topic list" once to
 *      authorize the script and populate the menu.
 *
 * Why an org key: Omni has no API for minting a personal access token, so end
 * users cannot be asked to bring their own. This script instead authenticates
 * with an org key and *scopes every call to the signed-in Google user*:
 *
 *   1. Session.getEffectiveUser().getEmail() — the Google identity, which the
 *      user cannot spoof from inside the sheet.
 *   2. GET /api/scim/v2/Users?filter=userName eq "<email>" — resolves that
 *      email to an Omni userId. No match means no access (fail closed).
 *   3. GET /api/v1/models/{modelId}/topic — every topic in the model.
 *   4. POST /api/v1/ai/pick-topic with {userId, potentialTopicNames:[topic]} —
 *      Omni intersects the candidate list against the topics that user may see.
 *      200 means entitled; 422 "No topics available" means not. This is the only
 *      user-aware topic endpoint: the topic endpoints themselves accept only
 *      branch_id, so listing cannot be scoped server-side any other way.
 *   5. POST /api/v1/query/run?userId=... — Omni applies that user's access
 *      grants, access_filters and row-level security when the query executes.
 *
 * SECURITY: the org key lives in Script Properties, which anyone who can open
 * the Apps Script editor on this spreadsheet can read. Only share this sheet
 * with people you would trust with the key itself. For wider rollout, move this
 * code into a private Workspace add-on or a Cloud Run proxy so end users never
 * reach the script project — see OmniTopicSync.README.md.
 *
 * Run via the "Omni Topics" menu, or call refreshMyTopics() / openPicker().
 */

const MENU_NAME = 'Omni Topics';

/** Omni caps extracts at 50,000 rows. */
const ROW_LIMIT = 50000;

/** Query payload version Omni's own query builder emits. */
const QUERY_VERSION = 9;

/** Menu items reserved for topics; extras stay reachable from the picker dropdown. */
const TOPIC_SLOT_COUNT = 15;

/** Rows per setValues() call when writing results. */
const WRITE_CHUNK_ROWS = 2000;

/**
 * Appended to every result tab name. Marks the tab as generated source data
 * that each run clears and rewrites — see the README on intended use.
 */
const SOURCE_TAB_SUFFIX = '-[SOURCE]';

const PROP_BASE_URL = 'OMNI_BASE_URL';
const PROP_API_KEY = 'OMNI_API_KEY';
const PROP_MODEL_ID = 'OMNI_MODEL_ID';
const PROP_DEFAULT_TOPIC = 'OMNI_DEFAULT_TOPIC';
const PROP_BRANCH_ID = 'OMNI_BRANCH_ID';

const UP_USER_ID = 'omniUserId';
const UP_TOPICS = 'omniAllowedTopics';
const UP_TOPICS_AT = 'omniAllowedTopicsAt';

/** How long a user's entitled-topic list is trusted before re-probing. */
const TOPICS_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Filter kinds accepted per value type, taken from the CompositeFilter schema in
 * {OMNI_BASE_URL}/openapi.json. Sending a kind outside these lists fails with
 * "No enum constant ... FilterKind.X".
 */
const FILTER_KINDS = {
  string: ['EQUALS', 'CONTAINS', 'STARTS_WITH', 'ENDS_WITH', 'SQL_LIKE', 'IS_EMPTY'],
  number: ['EQUALS', 'GREATER_THAN', 'LESS_THAN', 'BETWEEN'],
  date: ['BETWEEN', 'ON_OR_AFTER', 'BEFORE'],
  boolean: ['EQUALS'],
  'null': []
};

/** Timeframe suffixes Omni exposes as separate dimensions, coarsest last. */
const GRAIN_ORDER = ['date', 'week', 'month', 'quarter', 'year', 'hour', 'minute'];

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

/**
 * Simple onOpen triggers may not call services that need authorization, so the
 * menu is built from the cached topic list only. installAutoRefresh() adds an
 * installable trigger that can re-probe on open.
 */
function onOpen() {
  buildMenu_();
}

function onOpenAuthorized() {
  try {
    refreshMyTopics_(false);
  } catch (e) {
    // Never block the sheet from opening.
  }
  buildMenu_();
}

function buildMenu_() {
  const ui = SpreadsheetApp.getUi();
  const menu = ui.createMenu(MENU_NAME);

  let topics = [];
  try {
    topics = cachedTopics_();
  } catch (e) {
    topics = [];
  }

  if (topics.length) {
    topics.slice(0, TOPIC_SLOT_COUNT).forEach((t, i) => {
      menu.addItem(t.label || t.name, 'openTopicSlot' + i);
    });
    if (topics.length > TOPIC_SLOT_COUNT) {
      menu.addItem('More topics (' + (topics.length - TOPIC_SLOT_COUNT) + ')…', 'openPicker');
    }
  } else {
    menu.addItem('Refresh my topic list to begin…', 'refreshMyTopics');
  }

  menu.addSeparator()
    .addItem('Open field picker…', 'openPicker')
    .addItem('Refresh my topic list', 'refreshMyTopics')
    .addSeparator()
    .addItem('Show my Omni identity', 'showMyIdentity')
    .addItem('Install refresh-on-open', 'installAutoRefresh')
    .addItem('Remove refresh-on-open', 'removeAutoRefresh')
    .addToUi();
}

// Menu items cannot take arguments, so each topic gets a fixed slot function.
function openTopicSlot0() { openTopicBySlot_(0); }
function openTopicSlot1() { openTopicBySlot_(1); }
function openTopicSlot2() { openTopicBySlot_(2); }
function openTopicSlot3() { openTopicBySlot_(3); }
function openTopicSlot4() { openTopicBySlot_(4); }
function openTopicSlot5() { openTopicBySlot_(5); }
function openTopicSlot6() { openTopicBySlot_(6); }
function openTopicSlot7() { openTopicBySlot_(7); }
function openTopicSlot8() { openTopicBySlot_(8); }
function openTopicSlot9() { openTopicBySlot_(9); }
function openTopicSlot10() { openTopicBySlot_(10); }
function openTopicSlot11() { openTopicBySlot_(11); }
function openTopicSlot12() { openTopicBySlot_(12); }
function openTopicSlot13() { openTopicBySlot_(13); }
function openTopicSlot14() { openTopicBySlot_(14); }

function openTopicBySlot_(index) {
  const topics = cachedTopics_();
  const topic = topics[index];
  if (!topic) {
    refreshMyTopics();
    return;
  }
  showSidebar_(topic.name);
}

function openPicker() {
  showSidebar_(null);
}

function showSidebar_(preselectTopic) {
  const tpl = HtmlService.createTemplateFromFile('OmniTopicSidebar');
  tpl.preselectTopic = preselectTopic || scriptProp_(PROP_DEFAULT_TOPIC, '');
  const html = tpl.evaluate().setTitle('Omni Topics').setWidth(360);
  SpreadsheetApp.getUi().showSidebar(html);
}

function showMyIdentity() {
  const ui = SpreadsheetApp.getUi();
  try {
    const email = activeEmail_();
    const userId = resolveOmniUserId_(email);
    const topics = cachedTopics_();
    const at = PropertiesService.getUserProperties().getProperty(UP_TOPICS_AT);
    ui.alert(
      'Omni identity',
      'Google user: ' + email +
      '\nOmni userId: ' + userId +
      '\nModel: ' + modelId_() +
      (branchId_() ? '\nBranch: ' + branchId_() : '') +
      '\nEntitled topics cached: ' + topics.length +
      '\nLast probed: ' + (at ? new Date(Number(at)).toString() : 'never'),
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Omni identity', String(e && e.message ? e.message : e), ui.ButtonSet.OK);
  }
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

function installAutoRefresh() {
  removeAutoRefresh_();
  ScriptApp.newTrigger('onOpenAuthorized')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onOpen()
    .create();
  SpreadsheetApp.getActive().toast('Refresh-on-open installed for ' + activeEmail_(), MENU_NAME, 6);
}

function removeAutoRefresh() {
  const n = removeAutoRefresh_();
  SpreadsheetApp.getActive().toast(n ? 'Removed ' + n + ' trigger(s)' : 'No trigger installed', MENU_NAME, 6);
}

function removeAutoRefresh_() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'onOpenAuthorized') {
      ScriptApp.deleteTrigger(t);
      n++;
    }
  });
  return n;
}

// ---------------------------------------------------------------------------
// Entitlement: which topics may this user see?
// ---------------------------------------------------------------------------

function refreshMyTopics() {
  const topics = refreshMyTopics_(true);
  buildMenu_();
  SpreadsheetApp.getActive().toast(
    'You have access to ' + topics.length + ' topic(s). Reload the sheet if the menu looks stale.',
    MENU_NAME, 8);
}

/**
 * Probes every topic in the model against the signed-in user and caches the
 * entitled subset. Pass force=false to reuse a cache newer than TOPICS_TTL_MS.
 */
function refreshMyTopics_(force) {
  const props = PropertiesService.getUserProperties();
  if (!force) {
    const at = Number(props.getProperty(UP_TOPICS_AT) || 0);
    if (at && (Date.now() - at) < TOPICS_TTL_MS) return cachedTopics_();
  }

  const email = activeEmail_();
  const userId = resolveOmniUserId_(email);
  const all = listModelTopics_();
  const allowed = all.filter(t => userMaySeeTopic_(userId, t.name));

  props.setProperty(UP_TOPICS, JSON.stringify(allowed));
  props.setProperty(UP_TOPICS_AT, String(Date.now()));
  return allowed;
}

function cachedTopics_() {
  const raw = PropertiesService.getUserProperties().getProperty(UP_TOPICS);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

/**
 * Every topic defined in the model, from the YAML endpoint.
 *
 * Deliberately NOT `GET /{modelId}/topic`. That endpoint filters by
 * `required_access_grants` against the *API key's own* identity, and an
 * organization key is a service identity with no user attributes and no way to
 * be given any — so every grant-restricted topic disappears from it. Listing
 * that way would hide a topic from a user who is genuinely entitled to it.
 *
 * The YAML endpoint is not access-filtered, so it yields the true inventory.
 * Topic file names are the topic names, so no YAML parsing is needed to
 * enumerate; labels and descriptions are read from top-level keys for display.
 */
function listModelTopics_() {
  const files = modelYamlFiles_();
  return Object.keys(files)
    .filter(k => /\.topic$/.test(k))
    .map(k => {
      const name = k.replace(/\.topic$/, '');
      const yaml = String(files[k] || '');
      return {
        name: name,
        label: topLevelYaml_(yaml, 'label') || humanize_(name),
        description: topLevelYaml_(yaml, 'description') || '',
        baseView: topLevelYaml_(yaml, 'base_view') || topLevelYaml_(yaml, 'semantic_view') || ''
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The model's YAML files, keyed by file name. Honours OMNI_BRANCH_ID. */
function modelYamlFiles_() {
  // The YAML endpoint takes camelCase branchId, unlike the topic endpoints.
  let url = baseUrl_() + '/api/v1/models/' + encodeURIComponent(modelId_()) + '/yaml';
  if (branchId_()) url += '?branchId=' + encodeURIComponent(branchId_());
  const body = JSON.parse(omniFetch_(url, { method: 'get' }).getContentText());
  return body.files || {};
}

/** Reads a top-level (column-zero) scalar key out of a YAML document. */
function topLevelYaml_(yaml, key) {
  const m = new RegExp('^' + key + ':[ \\t]*(.*)$', 'm').exec(yaml);
  if (!m) return '';
  let v = String(m[1]).trim();
  if (!v) return '';
  v = v.replace(/^["']/, '').replace(/["']$/, '');
  return v;
}

/**
 * True when Omni will let this user query this topic.
 *
 * pick-topic intersects potentialTopicNames with the topics the userId may
 * access: a list containing only inaccessible names returns 422 "No topics
 * available in this model" rather than echoing the name back, which makes a
 * single-candidate call a reliable entitlement probe. An unknown userId returns
 * 400, so errors fail closed.
 */
function userMaySeeTopic_(userId, topicName) {
  const url = baseUrl_() + '/api/v1/ai/pick-topic';
  const body = {
    modelId: modelId_(),
    userId: userId,
    prompt: 'Which data does this topic describe?',
    potentialTopicNames: [topicName]
  };
  // pick-topic takes camelCase branchId, unlike the topic endpoints' branch_id.
  if (branchId_()) body.branchId = branchId_();

  const resp = omniFetch_(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body)
  }, true);

  if (resp.getResponseCode() !== 200) return false;
  try {
    return JSON.parse(resp.getContentText()).topicId === topicName;
  } catch (e) {
    return false;
  }
}

function activeEmail_() {
  const email = Session.getEffectiveUser().getEmail();
  if (!email) {
    throw new Error('Could not determine your Google account. Run "Refresh my topic list" from the menu to authorize the script.');
  }
  return email;
}

/** Resolves a Google email to an Omni userId via SCIM, cached per user. */
function resolveOmniUserId_(email) {
  const props = PropertiesService.getUserProperties();
  const cached = props.getProperty(UP_USER_ID);
  if (cached) {
    const parts = cached.split('|');
    if (parts[0] === email && parts[1]) return parts[1];
  }

  const url = baseUrl_() + '/api/scim/v2/Users?filter=' +
    encodeURIComponent('userName eq "' + email + '"');
  const body = JSON.parse(omniFetch_(url, { method: 'get' }).getContentText());
  const found = (body.Resources || [])[0];
  if (!found || !found.id) {
    throw new Error('No Omni user matches ' + email + '. Ask an Omni admin to add you, then refresh your topic list.');
  }
  if (found.active === false) {
    throw new Error('Your Omni account (' + email + ') is deactivated.');
  }

  props.setProperty(UP_USER_ID, email + '|' + found.id);
  return found.id;
}

// ---------------------------------------------------------------------------
// Sidebar server API
// ---------------------------------------------------------------------------

/** Topic list plus the initial selection for the picker. */
function getPickerBootstrap(preselectTopic) {
  const topics = refreshMyTopics_(false);
  let selected = preselectTopic || scriptProp_(PROP_DEFAULT_TOPIC, '');
  if (!topics.some(t => t.name === selected)) {
    selected = topics.length ? topics[0].name : '';
  }
  return { topics: topics, selected: selected, rowLimit: ROW_LIMIT };
}

/**
 * Fields for a topic, grouped by view and ready for the picker.
 *
 * Omni exposes each timeframe of a time dimension as its own field
 * (created_at, created_at[date], created_at[week]...). Those are collapsed into
 * one entry carrying a `grains` list so the picker shows a grain dropdown
 * instead of dozens of near-duplicate checkboxes.
 */
function getTopicFieldGroups(topicName) {
  const userId = resolveOmniUserId_(activeEmail_());
  if (!userMaySeeTopic_(userId, topicName)) {
    throw new Error('You do not have access to "' + topicName + '" in Omni.');
  }

  const url = withBranch_(baseUrl_() + '/api/v1/models/' + encodeURIComponent(modelId_()) +
    '/topic/' + encodeURIComponent(topicName));
  const resp = omniFetch_(url, { method: 'get' }, true);

  // The detail endpoint is filtered by the API key's identity, exactly like the
  // topic list, so a grant-restricted topic 404s here even for a user who is
  // entitled to it. No model endpoint accepts a userId, so there is no way to
  // ask for it as them — fall back to the topic's YAML, which is not filtered.
  if (resp.getResponseCode() === 404 || resp.getResponseCode() === 403) {
    return topicGroupsFromYaml_(topicName);
  }
  if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) {
    throw new Error('Omni API ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 300));
  }
  const topic = JSON.parse(resp.getContentText()).topic;

  const groups = (topic.views || []).map(view => {
    const byBase = {};
    const order = [];

    (view.dimensions || []).forEach(d => {
      const parsed = splitGrain_(d.field_name);
      if (!byBase[parsed.base]) {
        byBase[parsed.base] = {
          ref: view.name + '.' + parsed.base,
          name: parsed.base,
          label: humanize_(parsed.base),
          dataType: d.data_type || '',
          filterType: filterTypeFor_(d.data_type),
          description: d.description || '',
          isDimension: true,
          hasRaw: false,
          grains: []
        };
        order.push(parsed.base);
      }
      if (parsed.grain) {
        if (byBase[parsed.base].grains.indexOf(parsed.grain) === -1) {
          byBase[parsed.base].grains.push(parsed.grain);
        }
      } else {
        byBase[parsed.base].hasRaw = true;
      }
    });

    order.forEach(b => {
      byBase[b].grains.sort((x, y) => grainRank_(x) - grainRank_(y));
    });

    const measures = (view.measures || []).map(m => ({
      ref: view.name + '.' + m.field_name,
      name: m.field_name,
      label: humanize_(m.field_name),
      dataType: m.data_type || '',
      filterType: filterTypeFor_(m.data_type),
      description: m.description || '',
      isDimension: false,
      hasRaw: true,
      grains: []
    }));

    return {
      view: view.name,
      label: view.label || humanize_(view.name),
      dimensions: order.map(b => byBase[b]),
      measures: measures
    };
  }).filter(g => g.dimensions.length || g.measures.length);

  return {
    topic: topicName,
    label: topic.label || topicName,
    description: topic.description || '',
    filterKinds: FILTER_KINDS,
    defaultFilters: normalizeDefaultFilters_(topic.default_filters),
    alwaysFilters: alwaysFilterRefs_(topic),
    groups: groups
  };
}

/**
 * Builds the semantic query from the picker's selection, runs it as the
 * signed-in user, and writes the CSV to a tab named for the topic.
 */
function runTopicExtract(payload) {
  const started = Date.now();
  const topicName = payload && payload.topic;
  const fields = (payload && payload.fields) || [];
  if (!topicName) throw new Error('No topic selected.');
  if (!fields.length) throw new Error('Select at least one field.');

  const userId = resolveOmniUserId_(activeEmail_());
  if (!userMaySeeTopic_(userId, topicName)) {
    throw new Error('You do not have access to "' + topicName + '" in Omni.');
  }

  const query = {
    modelId: modelId_(),
    // An empty table plus join_paths_from_topic_name is how Omni's own query
    // builder targets a topic. It resolves both plain-view and Snowflake
    // semantic-view topics, whose sub-views are not addressable as model views.
    table: '',
    join_paths_from_topic_name: topicName,
    fields: fields,
    filters: buildFilters_((payload && payload.filters) || []),
    sorts: [],
    limit: ROW_LIMIT,
    default_group_by: true,
    version: QUERY_VERSION
  };
  // formatResults:false keeps numbers unformatted — otherwise 216704 arrives as
  // "216,704" and lands in the sheet as text. branchId must sit beside `query`,
  // not inside it, or the API rejects the body.
  const runBody = { query: query, resultType: 'csv', formatResults: false };
  if (branchId_()) runBody.branchId = branchId_();

  const resp = omniFetch_(
    baseUrl_() + '/api/v1/query/run?userId=' + encodeURIComponent(userId),
    { method: 'post', contentType: 'application/json', payload: JSON.stringify(runBody) });

  const rows = Utilities.parseCsv(extractCsv_(resp));
  const written = writeResults_(topicName, payload.label || topicName, rows, fields.length);

  return {
    sheetName: written.sheetName,
    dataRows: written.dataRows,
    columns: written.columns,
    truncated: written.dataRows >= ROW_LIMIT,
    elapsedMs: Date.now() - started
  };
}

/**
 * Field groups built from a topic's YAML, for topics the API key may not read.
 *
 * YAML carries view names, field names, labels and descriptions, but not
 * `data_type` or timeframes — those exist only in the detail endpoint's
 * response. Fields are therefore marked `typeUnknown`, and the sidebar asks for
 * a filter type when one is used in a filter. Field selection and query
 * execution are unaffected: `query/run?userId=` enforces the grant itself.
 */
function topicGroupsFromYaml_(topicName) {
  const files = modelYamlFiles_();
  const yaml = files[topicName + '.topic'];
  if (!yaml) {
    throw new Error('Omni did not return "' + topicName + '" and it has no YAML file in this model.');
  }

  const tree = yamlKeyTree_(String(yaml));
  const viewsNode = tree.children.filter(n => n.key === 'views')[0];
  if (!viewsNode) {
    throw new Error('Could not read the fields for "' + topicName +
      '" — the API key cannot see this topic and its YAML declares no views.');
  }

  const groups = viewsNode.children.map(viewNode => {
    const label = yamlScalarChild_(viewNode, 'label') || humanize_(viewNode.key);
    function fieldsUnder(section, isDimension) {
      const node = viewNode.children.filter(n => n.key === section)[0];
      if (!node) return [];
      return node.children
        .filter(f => /^[a-z_][a-z0-9_]*$/.test(f.key))
        // The detail endpoint omits hidden and ignored fields; match it so the
        // fallback offers the same set a user would see in Omni itself.
        .filter(f => yamlScalarChild_(f, 'hidden') !== 'true' &&
                     yamlScalarChild_(f, 'ignored') !== 'true')
        .map(f => ({
          ref: viewNode.key + '.' + f.key,
          name: f.key,
          label: yamlScalarChild_(f, 'label') || humanize_(f.key),
          dataType: '',
          filterType: 'string',
          typeUnknown: true,
          description: yamlScalarChild_(f, 'description') || '',
          isDimension: isDimension,
          hasRaw: true,
          grains: []
        }));
    }
    return {
      view: viewNode.key,
      label: label,
      dimensions: fieldsUnder('dimensions', true),
      measures: fieldsUnder('measures', false)
    };
  }).filter(g => g.dimensions.length || g.measures.length);

  return {
    topic: topicName,
    label: topLevelYaml_(String(yaml), 'label') || topicName,
    description: topLevelYaml_(String(yaml), 'description') || '',
    filterKinds: FILTER_KINDS,
    limitedMetadata: true,
    defaultFilters: defaultFiltersFromYamlTree_(tree),
    alwaysFilters: [],
    groups: groups
  };
}

/**
 * Parses `key:` lines into a tree by indentation. Enough to walk
 * views → dimensions/measures → field names; not a general YAML parser.
 */
function yamlKeyTree_(yaml) {
  const root = { key: null, indent: -1, value: '', children: [] };
  const stack = [root];
  yaml.split(/\r?\n/).forEach(line => {
    if (!line.trim() || /^\s*#/.test(line)) return;
    const m = /^(\s*)([A-Za-z_][A-Za-z0-9_\-.\[\]]*):(?:[ \t]+(.*))?$/.exec(line);
    if (!m) return;
    const indent = m[1].length;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const node = { key: m[2], indent: indent, value: (m[3] || '').trim(), children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  });
  return root;
}

function yamlScalarChild_(node, key) {
  const hit = node.children.filter(n => n.key === key)[0];
  if (!hit || !hit.value) return '';
  return hit.value.replace(/^["']/, '').replace(/["']$/, '');
}

/**
 * Converts a topic's `default_filters` into picker rows.
 *
 * The detail endpoint resolves the YAML authoring shorthand (`not: Returned`)
 * into the same shape queries use — {type, kind, values, is_negative} — so this
 * is a straight mapping. These are *defaults*, not constraints: `query/run`
 * does not apply them on its own, so the sidebar sends whatever rows survive
 * and removing a row genuinely removes the filter.
 */
function normalizeDefaultFilters_(filters) {
  if (!filters || typeof filters !== 'object') return [];
  return Object.keys(filters).map(ref => {
    const f = filters[ref] || {};
    const type = f.type === 'null' ? 'null' : (f.type || 'string');
    return {
      ref: ref,
      filterType: type === 'null' ? 'string' : type,
      kind: type === 'null' ? (f.is_negative ? 'IS_NOT_NULL' : 'IS_NULL') : (f.kind || 'EQUALS'),
      values: (f.values || []).map(String),
      negate: type === 'null' ? false : !!f.is_negative,
      caseInsensitive: f.case_insensitive !== false,
      inclusive: f.is_inclusive !== false,
      fromTopic: true
    };
  }).filter(r => r.ref);
}

/** Field refs Omni always applies server-side, shown read-only for context. */
function alwaysFilterRefs_(topic) {
  const out = [];
  ['always_where_filters', 'always_having_filters'].forEach(k => {
    const v = topic[k];
    if (v && typeof v === 'object') Object.keys(v).forEach(ref => out.push(ref));
  });
  return out;
}

/**
 * Reads `default_filters` from a topic's YAML, for topics the API key cannot
 * read. YAML holds the authoring shorthand rather than the resolved shape, so
 * the common operators are mapped here; anything unrecognised is skipped rather
 * than guessed at.
 */
function defaultFiltersFromYamlTree_(tree) {
  const node = tree.children.filter(n => n.key === 'default_filters')[0];
  if (!node) return [];

  const SHORTHAND = {
    is: { kind: 'EQUALS', negate: false },
    not: { kind: 'EQUALS', negate: true },
    contains: { kind: 'CONTAINS', negate: false },
    starts_with: { kind: 'STARTS_WITH', negate: false },
    ends_with: { kind: 'ENDS_WITH', negate: false },
    greater_than: { kind: 'GREATER_THAN', negate: false, type: 'number' },
    less_than: { kind: 'LESS_THAN', negate: false, type: 'number' },
    between: { kind: 'BETWEEN', negate: false, type: 'number' }
  };

  const out = [];
  node.children.forEach(fieldNode => {
    for (let i = 0; i < fieldNode.children.length; i++) {
      const op = fieldNode.children[i];
      const spec = SHORTHAND[op.key];
      if (!spec) continue;
      const values = splitYamlList_(op.value);
      if (!values.length) continue;
      const numeric = values.every(v => /^-?\d+(\.\d+)?$/.test(v));
      out.push({
        ref: fieldNode.key,
        filterType: spec.type === 'number' && numeric ? 'number' : 'string',
        kind: spec.kind,
        values: values,
        negate: spec.negate,
        caseInsensitive: true,
        inclusive: true,
        fromTopic: true
      });
      break;
    }
  });
  return out;
}

/** "[a, b]" or "a" -> ["a","b"] / ["a"], quotes stripped. */
function splitYamlList_(raw) {
  let v = String(raw == null ? '' : raw).trim();
  if (!v) return [];
  const list = /^\[(.*)\]$/.exec(v);
  const parts = list ? list[1].split(',') : [v];
  return parts
    .map(x => x.trim().replace(/^["']/, '').replace(/["']$/, '').trim())
    .filter(x => x !== '');
}

// ---------------------------------------------------------------------------
// Query construction
// ---------------------------------------------------------------------------

/**
 * Turns picker filter rows into Omni's filters map. Shapes follow the
 * CompositeFilter variants: string filters take case_insensitive, number
 * filters take is_inclusive, "is null" is expressed as type "null" with no
 * kind, and is_negative inverts any of them.
 */
function buildFilters_(rows) {
  const out = {};
  rows.forEach(r => {
    if (!r || !r.ref || !r.kind) return;
    const values = (r.values || []).filter(v => v !== '' && v !== null && v !== undefined);

    if (r.kind === 'IS_NULL' || r.kind === 'IS_NOT_NULL') {
      out[r.ref] = { type: 'null', is_negative: r.kind === 'IS_NOT_NULL' };
      return;
    }

    // For YAML-sourced fields the data type is unknown, so the sidebar sends the
    // type the user picked.
    const type = r.filterType || 'string';
    if (type === 'number') {
      const nums = values.map(Number).filter(n => !isNaN(n));
      if (!nums.length) return;
      if (r.kind === 'BETWEEN' && nums.length < 2) return;
      out[r.ref] = {
        kind: r.kind,
        type: 'number',
        values: r.kind === 'BETWEEN' ? [nums[0], nums[1]] : [nums[0]],
        is_negative: !!r.negate,
        is_inclusive: r.inclusive !== false
      };
      return;
    }

    if (type === 'date') {
      if (r.kind === 'BETWEEN' && values.length < 2) return;
      if (!values.length) return;
      out[r.ref] = {
        kind: r.kind,
        type: 'date',
        values: r.kind === 'BETWEEN' ? [values[0], values[1]] : [values[0]],
        is_negative: !!r.negate
      };
      return;
    }

    if (type === 'boolean') {
      out[r.ref] = {
        kind: 'EQUALS',
        type: 'boolean',
        values: [String(values[0]).toLowerCase() === 'true'],
        is_negative: !!r.negate
      };
      return;
    }

    if (r.kind === 'IS_EMPTY') {
      out[r.ref] = { kind: 'IS_EMPTY', type: 'string', values: [], is_negative: !!r.negate };
      return;
    }
    if (!values.length) return;
    out[r.ref] = {
      kind: r.kind,
      type: 'string',
      values: values.map(String),
      is_negative: !!r.negate,
      // Omni's string matching is case-sensitive unless told otherwise, which
      // surprises people filtering CONTAINS "ship" against "Shipped".
      case_insensitive: r.caseInsensitive !== false
    };
  });
  return out;
}

function splitGrain_(fieldName) {
  const m = /^(.*)\[([^\]]+)\]$/.exec(fieldName);
  return m ? { base: m[1], grain: m[2] } : { base: fieldName, grain: null };
}

/** Orders timeframes coarsest-last; unknown grains sort to the end. */
function grainRank_(grain) {
  const i = GRAIN_ORDER.indexOf(grain);
  return i === -1 ? GRAIN_ORDER.length : i;
}

function filterTypeFor_(dataType) {
  const t = String(dataType || '').toUpperCase();
  if (t === 'NUMBER' || t === 'INTEGER' || t === 'FLOAT' || t === 'DOUBLE' || t === 'DECIMAL') return 'number';
  if (t === 'BOOLEAN') return 'boolean';
  if (t === 'TIMESTAMP' || t === 'DATE' || t === 'DATETIME' || t === 'TIME') return 'date';
  return 'string';
}

function humanize_(name) {
  return String(name)
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Writing results
// ---------------------------------------------------------------------------

function writeResults_(topicName, topicLabel, rows, expectedCols) {
  const sheet = resultSheet_(topicLabel || topicName);
  const sheetName = sheet.getName();
  sheet.clear();

  const info = 'SOURCE TAB — cleared and rewritten on every run, do not edit. Omni topic "' +
    (topicLabel || topicName) + '" · ' + activeEmail_() +
    ' · ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss') +
    ' · row limit ' + ROW_LIMIT;
  sheet.getRange(1, 1).setValue(info).setFontStyle('italic');

  if (!rows.length) {
    sheet.getRange(3, 1).setValue('Query returned no rows.');
    return { sheetName: sheetName, dataRows: 0, columns: 0 };
  }

  const width = Math.max.apply(null, rows.map(r => r.length).concat([expectedCols || 1]));
  const normalized = rows.map(r => {
    const padded = r.slice();
    while (padded.length < width) padded.push('');
    return padded;
  });

  sheet.getRange(3, 1, 1, width).setValues([normalized[0]]).setFontWeight('bold');
  sheet.setFrozenRows(3);

  const data = normalized.slice(1).map(coerceRow_);
  for (let i = 0; i < data.length; i += WRITE_CHUNK_ROWS) {
    const chunk = data.slice(i, i + WRITE_CHUNK_ROWS);
    sheet.getRange(4 + i, 1, chunk.length, width).setValues(chunk);
  }

  sheet.autoResizeColumns(1, Math.min(width, 20));
  return { sheetName: sheetName, dataRows: data.length, columns: width };
}

/** Numeric-looking CSV cells become numbers so the sheet can aggregate them. */
function coerceRow_(row) {
  return row.map(v => {
    if (v === '' || v === null) return '';
    if (typeof v !== 'string') return v;
    if (!/^-?\d+(\.\d+)?$/.test(v)) return v;
    // Leave long digit strings (IDs, zip codes) alone — Number() would lose
    // precision or strip leading zeros.
    if (v.length > 15 || /^-?0\d/.test(v)) return v;
    return Number(v);
  });
}

/**
 * Result tabs are named "<topic>-[SOURCE]" to mark them as generated source
 * data that gets overwritten, not a sheet to hand-edit.
 */
function resultSheetName_(label) {
  const clean = String(label).replace(/[\*\/\\\?:]/g, ' ').replace(/\s+/g, ' ').trim();
  const base = (clean || 'Omni Results').slice(0, 100 - SOURCE_TAB_SUFFIX.length);
  return base + SOURCE_TAB_SUFFIX;
}

/**
 * Finds or creates the result tab. Brackets are legal in Google Sheets tab
 * names, but fall back to a bracket-free name rather than fail the whole run.
 */
function resultSheet_(label) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const name = resultSheetName_(label);
  const existing = ss.getSheetByName(name);
  if (existing) return existing;
  try {
    return ss.insertSheet(name);
  } catch (e) {
    const alt = name.replace(/[\[\]]/g, '');
    return ss.getSheetByName(alt) || ss.insertSheet(alt);
  }
}

// ---------------------------------------------------------------------------
// HTTP + config
// ---------------------------------------------------------------------------

/**
 * Omni returns CSV either raw or wrapped in {data, remaining_job_ids}. Long
 * queries hand back job ids to poll.
 */
function extractCsv_(resp) {
  const text = resp.getContentText();
  const trimmed = text.replace(/^﻿/, '').trimStart();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return text;

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
  if (body && typeof body.result === 'string') return body.result;
  if (body && body.detail) throw new Error('Omni: ' + body.detail);
  throw new Error('Unexpected query response shape: ' + text.slice(0, 300));
}

function waitForJobs_(jobIds) {
  const url = baseUrl_() + '/api/v1/query/wait?job_ids=' + encodeURIComponent(jobIds.join(','));
  return extractCsv_(omniFetch_(url, { method: 'get' }));
}

/** Pass allowNonOk=true to inspect the status yourself instead of throwing. */
function omniFetch_(url, opts, allowNonOk) {
  const options = Object.assign({ muteHttpExceptions: true, followRedirects: true }, opts || {});
  options.headers = Object.assign({}, options.headers, {
    Authorization: 'Bearer ' + apiKey_(),
    Accept: 'application/json'
  });
  const resp = UrlFetchApp.fetch(url, options);
  const code = resp.getResponseCode();
  if (allowNonOk) return resp;
  if (code < 200 || code >= 300) {
    let detail = resp.getContentText();
    try {
      const parsed = JSON.parse(detail);
      if (parsed && parsed.detail) detail = parsed.detail;
    } catch (e) {
      // keep the raw body
    }
    throw new Error('Omni API ' + code + ': ' + String(detail).slice(0, 500));
  }
  return resp;
}

function scriptProp_(key, fallback) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return v === null || v === '' ? fallback : v;
}

function baseUrl_() {
  const v = scriptProp_(PROP_BASE_URL, '');
  if (!v) throw new Error('Set ' + PROP_BASE_URL + ' in Script Properties.');
  return v.replace(/\/+$/, '');
}

function apiKey_() {
  const v = scriptProp_(PROP_API_KEY, '');
  if (!v) throw new Error('Set ' + PROP_API_KEY + ' in Script Properties.');
  return v;
}

function modelId_() {
  const v = scriptProp_(PROP_MODEL_ID, '');
  if (!v) throw new Error('Set ' + PROP_MODEL_ID + ' in Script Properties.');
  return v;
}

/** Optional branch UUID; '' means read the shared model. */
function branchId_() {
  return scriptProp_(PROP_BRANCH_ID, '').trim();
}

/** Appends Omni's snake_case branch_id query parameter when a branch is set. */
function withBranch_(url) {
  const b = branchId_();
  if (!b) return url;
  return url + (url.indexOf('?') === -1 ? '?' : '&') + 'branch_id=' + encodeURIComponent(b);
}
