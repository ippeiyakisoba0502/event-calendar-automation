#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_SEARCH_URL =
  "https://peatix.com/search?type=physical&dr=upcoming&loc=%E6%9D%B1%E4%BA%AC&lat=35.6803997&lng=139.7690174";
const DEFAULT_SPREADSHEET_ID =
  process.env.PEATIX_SPREADSHEET_ID || "1td2ieTUl2Xkdojma-um5ZQrY4MgFBd1JdgJTBS-J0ug";
const DEFAULT_GOOGLE_KEY_FILE =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  "/root/.config/openclaw/secrets/google-sheets-service-account.json";
const DEFAULT_INSERT_AFTER_TITLE = "クローリング結果→";

const DEFAULT_HEADERS = {
  "Accept": "application/json,text/plain,*/*",
  "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  "X-Requested-With": "XMLHttpRequest",
};

function usage() {
  return `Usage:
  node scripts/peatix_crawler.js --url "<peatix search url>" --start YYYY-MM-DD --end YYYY-MM-DD [options]

Options:
  --url URL             Peatix search URL. Defaults to the Tokyo physical search.
  --start YYYY-MM-DD    Start date for dr range.
  --end YYYY-MM-DD      End date for dr range.
  --dr VALUE            Peatix preset date range: today, this_week, this_weekend, next_week, upcoming.
  --pages N             Max result pages to fetch. Default: 3.
  --size N              Page size to request. Peatix may cap/ignore this. Default: 12.
  --keyword TEXT        Search keyword. Maps to q.
  --keywords LIST       Comma-separated extra keywords. Crawls the base search plus each keyword.
  --details             Fetch each event page and extract a short description/price metadata.
  --details-for-targets Fetch detail pages only for rows that look like 対象 before detail enrichment.
  --within-km N         Locally keep events within N km from the URL lat/lng center.
  --delay-ms N          Delay between requests. Default: 700.
  --format json|csv     Output format. Default: json.
  --out PATH            Output path. Default: tmp/peatix-events-<range>.<format>
  --sheet               Write events to a new Google Sheets tab.
  --sheet-id ID         Spreadsheet ID. Defaults to PEATIX_SPREADSHEET_ID or the event-candidate sheet.
  --sheet-title TITLE   Base sheet tab title. Defaults to Peatix候補_<range>.
  --replace-existing    Replace values in an existing sheet title instead of creating a suffixed tab.
  --insert-after TITLE  Place created sheet after this tab. Default: クローリング結果→.
  --sheet-index N       Place created sheet at this exact tab index.
  --screen              Prefill screening columns when writing a sheet.
  --screen-sheet-title TITLE
                         Screen an existing sheet tab and update columns A:D.
  --overwrite-screening Overwrite existing screening columns in --screen-sheet-title mode.
  --no-file             Skip local file output when using --sheet.
  --no-local-date-filter
                         Do not locally filter events by --start/--end.
  --help                Show this help.

Examples:
  node scripts/peatix_crawler.js \\
  --url "https://peatix.com/search?type=physical&dr=2026-08-09:2026-08-10&loc=%E6%9D%B1%E4%BA%AC&lat=35.6803997&lng=139.7690174" \\
    --start 2026-08-09 --end 2026-08-10 --pages 2 --within-km 50 --sheet
`;
}

function parseArgs(argv) {
  const args = {
    url: DEFAULT_SEARCH_URL,
    pages: 3,
    size: 12,
    delayMs: 700,
    format: "json",
    details: false,
    localDateFilter: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--details") {
      args.details = true;
    } else if (arg === "--details-for-targets") {
      args.detailsForTargets = true;
    } else if (arg === "--sheet") {
      args.sheet = true;
    } else if (arg === "--screen") {
      args.screen = true;
    } else if (arg === "--overwrite-screening") {
      args.overwriteScreening = true;
    } else if (arg === "--replace-existing") {
      args.replaceExisting = true;
    } else if (arg === "--no-file") {
      args.noFile = true;
    } else if (arg === "--no-local-date-filter") {
      args.localDateFilter = false;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = argv[++i];
      if (value == null || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      args[key] = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.pages = toPositiveInt(args.pages, "pages");
  args.size = toPositiveInt(args.size, "size");
  args.delayMs = toNonNegativeInt(args.delayMs, "delay-ms");
  if (args.sheetIndex != null) args.sheetIndex = toNonNegativeInt(args.sheetIndex, "sheet-index");
  args.format = String(args.format).toLowerCase();
  if (args.withinKm != null) {
    args.withinKm = Number(args.withinKm);
    if (!Number.isFinite(args.withinKm) || args.withinKm <= 0) {
      throw new Error("--within-km must be a positive number");
    }
  }

  if (!["json", "csv"].includes(args.format)) {
    throw new Error("--format must be json or csv");
  }
  if (args.noFile && !args.sheet) {
    throw new Error("--no-file can only be used with --sheet");
  }
  if (args.start && !isDateOnly(args.start)) {
    throw new Error("--start must be YYYY-MM-DD");
  }
  if (args.end && !isDateOnly(args.end)) {
    throw new Error("--end must be YYYY-MM-DD");
  }
  if ((args.start && !args.end) || (!args.start && args.end)) {
    throw new Error("--start and --end must be provided together");
  }

  return args;
}

function toPositiveInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return number;
}

function toNonNegativeInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return number;
}

function isDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value));
}

function buildApiUrl(searchUrl, args, page, keyword = args.keyword) {
  const source = new URL(searchUrl);
  const apiUrl = new URL("https://peatix.com/search/events");

  for (const [key, value] of source.searchParams.entries()) {
    if (!["dr_from", "dr_to", "p", "size"].includes(key)) {
      apiUrl.searchParams.append(key, value);
    }
  }

  if (keyword != null) {
    apiUrl.searchParams.set("q", keyword);
  }

  if (args.start && args.end) {
    apiUrl.searchParams.set("dr", "range");
    apiUrl.searchParams.set("dr_from", args.start);
    apiUrl.searchParams.set("dr_to", args.end);
  } else if (args.dr) {
    apiUrl.searchParams.set("dr", args.dr);
  } else {
    normalizeDateRangeParam(apiUrl.searchParams);
  }

  apiUrl.searchParams.set("p", String(page));
  apiUrl.searchParams.set("size", String(args.size));
  return apiUrl;
}

function normalizeDateRangeParam(params) {
  const dr = params.get("dr");
  if (!dr) return;
  const match = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(dr);
  if (!match) return;
  params.set("dr", "range");
  params.set("dr_from", match[1]);
  params.set("dr_to", match[2]);
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: DEFAULT_HEADERS });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 300)}`);
  }
}

async function fetchText(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(url, { headers: DEFAULT_HEADERS });
    const text = await response.text();
    if (response.ok) return text;
    lastError = new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 300)}`);
    await sleep(400 * attempt);
  }
  throw lastError;
}

async function crawl(args) {
  const pages = [];
  const seen = new Map();

  for (const keyword of searchKeywords(args)) {
    for (let page = 1; page <= args.pages; page++) {
      const apiUrl = buildApiUrl(args.url, args, page, keyword);
      const payload = await fetchJson(apiUrl);
      const data = payload.json_data;
      if (!data || !Array.isArray(data.events)) {
        throw new Error(`Unexpected Peatix response shape for page ${page}`);
      }
      pages.push({
        keyword: keyword || "",
        page,
        requestUrl: apiUrl.toString(),
        numFound: data.numFound,
        resultCount: data.events.length,
        query: data.query,
      });
      for (const event of data.events) {
        const sourceKeyword = keyword || "通常検索";
        if (!seen.has(event.id)) {
          seen.set(event.id, { ...normalizeEvent(event), sourceKeywords: [sourceKeyword] });
        } else {
          const existing = seen.get(event.id);
          if (!existing.sourceKeywords.includes(sourceKeyword)) {
            existing.sourceKeywords.push(sourceKeyword);
          }
        }
      }
      if (data.events.length === 0) break;
      await sleep(args.delayMs);
    }
  }

  let events = [...seen.values()];
  if (args.localDateFilter && args.start && args.end) {
    events = events.filter((event) => isWithinDateRange(event.date, args.start, args.end));
  }
  if (args.withinKm != null) {
    const center = getSearchCenter(args.url);
    if (!center) {
      throw new Error("--within-km requires lat/lng or l.ll in the search URL");
    }
    events = events
      .map((event) => ({ ...event, distanceKm: distanceFromCenter(event.latlng, center) }))
      .filter((event) => event.distanceKm != null && event.distanceKm <= args.withinKm);
  }

  if (args.details || args.detailsForTargets) {
    const detailTargets = args.detailsForTargets
      ? events.filter((event) => screenEvent(event).decision === "対象")
      : events;
    for (const event of detailTargets) {
      await sleep(args.delayMs);
      Object.assign(event, await fetchEventDetails(event.url));
    }
  }

  return {
    crawledAt: new Date().toISOString(),
    sourceUrl: args.url,
    requestedRange:
      args.start && args.end ? { start: args.start, end: args.end } : { dr: args.dr || null },
    pages,
    count: events.length,
    events,
  };
}

function searchKeywords(args) {
  if (args.keywords) {
    const keywords = String(args.keywords)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return [null, ...keywords];
  }
  if (args.keyword != null) return [args.keyword];
  return [null];
}

function normalizeEvent(event) {
  const date = parsePeatixDate(event.datetime);
  return {
    id: event.id,
    name: event.name,
    url: `https://peatix.com/event/${event.id}`,
    trackingUrl: event.tracking_url,
    datetime: event.datetime,
    date,
    formattedDateTime: event.datetime_format_weekdate_time_days,
    timezone: event.timezone_id,
    venueName: event.venue_name,
    address: event.address,
    thumbVenue: event.thumb_venue,
    latlng: event.latlng,
    organizerName: event.organizer?.nickname || "",
    organizerId: event.organizer?.id || event.organizer?.rawId || "",
    groupName: event.pod?.name || "",
    groupId: event.pod?.id || event.pod?.rawId || "",
    cover: event.cover,
    days: event.days,
    boosted: Boolean(event.boost_flg),
  };
}

function parsePeatixDate(value) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ""));
  return match ? match[1] : "";
}

function isWithinDateRange(date, start, end) {
  return Boolean(date) && date >= start && date <= end;
}

async function fetchEventDetails(url) {
  const html = await fetchText(url);
  const priceMetadata = extractPeatixPriceMetadata(html);
  return {
    description: cleanText(
      extractMeta(html, "og:description") || extractMeta(html, "description") || ""
    ),
    price: priceMetadata.price || "",
    priceCurrency: priceMetadata.priceCurrency || "",
  };
}

function extractPeatixPriceMetadata(html) {
  const candidates = [];
  const priceMetaPatterns = [
    /<meta[^>]+itemprop=["']price["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+itemprop=["']price["'][^>]*>/gi,
  ];
  for (const pattern of priceMetaPatterns) {
    let match;
    while ((match = pattern.exec(html))) {
      const value = parsePriceNumber(match[1], false);
      if (Number.isFinite(value)) candidates.push(value);
    }
  }
  const offerNames = html.match(/<meta[^>]+itemprop=["']name["'][^>]+content=["'][^"']*円[^"']*["'][^>]*>/gi) || [];
  for (const tag of offerNames) {
    candidates.push(...extractPriceCandidates(decodeHtml(attr(tag, "content"))));
  }
  const priceCurrency = extractPeatixPriceCurrency(html) || (candidates.length ? "JPY" : "");
  const paidCandidates = candidates.filter((value) => value > 0);
  return {
    price: paidCandidates.length ? String(Math.max(...paidCandidates)) : "",
    priceCurrency,
  };
}

function extractPeatixPriceCurrency(html) {
  const patterns = [
    /<meta[^>]+itemprop=["']priceCurrency["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+itemprop=["']priceCurrency["'][^>]*>/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) return decodeHtml(match[1]);
  }
  return "";
}

function extractMeta(html, name) {
  const escaped = escapeRegex(name);
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) return decodeHtml(match[1]);
  }
  return "";
}

function extractAttrNear(html, marker, attr) {
  const index = html.indexOf(marker);
  if (index < 0) return "";
  const snippet = html.slice(Math.max(0, index - 200), index + 300);
  const match = new RegExp(`${attr}=["']([^"']*)["']`, "i").exec(snippet);
  return match ? decodeHtml(match[1]) : "";
}

function attr(tag, name) {
  const match = new RegExp(`${name}=["']([^"']*)["']`, "i").exec(tag || "");
  return match ? decodeHtml(match[1]) : "";
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanText(value) {
  return decodeHtml(value).replace(/\s+/g, " ").trim();
}

function toCsv(rows) {
  const columns = [
    "id",
    "name",
    "url",
    "datetime",
    "date",
    "formattedDateTime",
    "venueName",
    "address",
    "organizerName",
    "groupName",
    "latlng",
    "distanceKm",
    "boosted",
    "description",
    "price",
    "priceCurrency",
  ];
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function toSheetValues(rows, args = {}) {
  const columns = [
    { header: "判定", value: (row) => (args.screen ? screenEvent(row, args.screeningMasters).decision : "") },
    { header: "優先度", value: (row) => (args.screen ? screenEvent(row, args.screeningMasters).priority : "") },
    { header: "除外理由", value: (row) => (args.screen ? screenEvent(row, args.screeningMasters).reason : "") },
    { header: "精査メモ", value: (row) => (args.screen ? screenEvent(row, args.screeningMasters).memo : "") },
    { header: "イベント名", value: (row) => row.name },
    { header: "URL", value: (row) => row.url },
    { header: "日時", value: (row) => row.datetime },
    { header: "日付", value: (row) => row.date },
    { header: "表示日時", value: (row) => row.formattedDateTime },
    { header: "会場", value: (row) => row.venueName },
    { header: "住所", value: (row) => row.address },
    { header: "距離km", value: (row) => row.distanceKm ?? "" },
    { header: "主催者", value: (row) => row.organizerName },
    { header: "グループ", value: (row) => row.groupName },
    { header: "緯度経度", value: (row) => row.latlng },
    { header: "Peatix ID", value: (row) => row.id },
    { header: "詳細説明", value: (row) => row.description || "" },
    { header: "価格", value: (row) => row.price || "" },
    { header: "通貨", value: (row) => row.priceCurrency || "" },
    { header: "検索キーワード", value: (row) => (row.sourceKeywords || []).join(", ") },
    { header: "画像", value: (row) => row.cover || "" },
    { header: "検索URL", value: (row) => row.trackingUrl || "" },
  ];
  return [
    columns.map((column) => column.header),
    ...rows.map((row) => columns.map((column) => column.value(row))),
  ];
}

async function writeToGoogleSheet(result, args) {
  const { google } = require("googleapis");
  const spreadsheetId = args.sheetId || DEFAULT_SPREADSHEET_ID;
  const keyFile = args.googleKeyFile || DEFAULT_GOOGLE_KEY_FILE;
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const sheetArgs = {
    ...args,
    screeningMasters: args.screen ? await loadScreeningMasters(sheets, spreadsheetId) : null,
  };
  const values = toSheetValues(result.events, sheetArgs);
  const baseTitle = args.sheetTitle || defaultSheetTitle(args);
  const title = args.replaceExisting
    ? baseTitle
    : await uniqueSheetTitle(sheets, spreadsheetId, baseTitle);
  const sheetIndex = await desiredSheetIndex(sheets, spreadsheetId, args);
  const existing = args.replaceExisting ? await findSheetByTitle(sheets, spreadsheetId, title) : null;

  if (existing) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${quoteSheetName(title)}!A:Z`,
    });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId: existing.properties.sheetId,
                ...(sheetIndex == null ? {} : { index: sheetIndex }),
                gridProperties: {
                  rowCount: Math.max(values.length + 20, 80),
                  columnCount: values[0].length,
                  frozenRowCount: 1,
                },
              },
              fields: `${sheetIndex == null ? "" : "index,"}gridProperties(rowCount,columnCount,frozenRowCount)`,
            },
          },
        ],
      },
    });
  } else {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title,
                ...(sheetIndex == null ? {} : { index: sheetIndex }),
                gridProperties: {
                  rowCount: Math.max(values.length + 20, 80),
                  columnCount: values[0].length,
                  frozenRowCount: 1,
                },
              },
            },
          },
        ],
      },
    });
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteSheetName(title)}!A1:${columnName(values[0].length)}${values.length}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });

  const meta = await sheets.spreadsheets.get({ spreadsheetId, includeGridData: false });
  const sheet = meta.data.sheets.find((item) => item.properties.title === title);
  const sheetId = sheet.properties.sheetId;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 0,
              endRowIndex: 1,
              startColumnIndex: 0,
              endColumnIndex: values[0].length,
            },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: { red: 0.9, green: 0.95, blue: 1 },
              },
            },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        },
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId,
              dimension: "COLUMNS",
              startIndex: 0,
              endIndex: values[0].length,
            },
          },
        },
        {
          setDataValidation: {
            range: {
              sheetId,
              startRowIndex: 1,
              endRowIndex: Math.max(values.length, 2),
              startColumnIndex: 0,
              endColumnIndex: 1,
            },
            rule: {
              condition: {
                type: "ONE_OF_LIST",
                values: ["対象", "要確認", "除外"].map((userEnteredValue) => ({
                  userEnteredValue,
                })),
              },
              showCustomUi: true,
              strict: false,
            },
          },
        },
        {
          setDataValidation: {
            range: {
              sheetId,
              startRowIndex: 1,
              endRowIndex: Math.max(values.length, 2),
              startColumnIndex: 1,
              endColumnIndex: 2,
            },
            rule: {
              condition: {
                type: "ONE_OF_LIST",
                values: ["最優先", "高", "中", "低"].map((userEnteredValue) => ({
                  userEnteredValue,
                })),
              },
              showCustomUi: true,
              strict: false,
            },
          },
        },
      ],
    },
  });

  const verify = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteSheetName(title)}!A1:${columnName(values[0].length)}${values.length}`,
  });

  return {
    spreadsheetId,
    title,
    rowsWritten: (verify.data.values || []).length,
    dataRows: Math.max((verify.data.values || []).length - 1, 0),
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}`,
  };
}

async function findSheetByTitle(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, includeGridData: false });
  return meta.data.sheets.find((item) => item.properties.title === title) || null;
}

async function desiredSheetIndex(sheets, spreadsheetId, args) {
  if (args.sheetIndex != null) return args.sheetIndex;
  const insertAfter = args.insertAfter || DEFAULT_INSERT_AFTER_TITLE;
  if (!insertAfter) return null;
  const meta = await sheets.spreadsheets.get({ spreadsheetId, includeGridData: false });
  const target = meta.data.sheets.find((sheet) => sheet.properties.title === insertAfter);
  return target ? target.properties.index + 1 : null;
}

async function screenExistingSheet(args) {
  const { google } = require("googleapis");
  const spreadsheetId = args.sheetId || DEFAULT_SPREADSHEET_ID;
  const keyFile = args.googleKeyFile || DEFAULT_GOOGLE_KEY_FILE;
  const title = args.screenSheetTitle;
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteSheetName(title)}!A1:U`,
  });
  const values = res.data.values || [];
  if (values.length < 2) {
    throw new Error(`No data rows found in sheet: ${title}`);
  }
  const header = values[0];
  const required = ["判定", "優先度", "除外理由", "精査メモ", "イベント名", "URL"];
  for (const name of required) {
    if (!header.includes(name)) {
      throw new Error(`Missing required column "${name}" in sheet: ${title}`);
    }
  }

  const updates = [];
  const summary = { target: 0, review: 0, excluded: 0, preserved: 0 };
  const masters = await loadScreeningMasters(sheets, spreadsheetId);
  for (const row of values.slice(1)) {
    const existing = row.slice(0, 4).some((cell) => String(cell || "").trim());
    if (existing && !args.overwriteScreening) {
      updates.push([row[0] || "", row[1] || "", row[2] || "", row[3] || ""]);
      summary.preserved++;
      continue;
    }
    const event = eventFromSheetRow(header, row);
    const screening = screenEvent(event, masters);
    updates.push([screening.decision, screening.priority, screening.reason, screening.memo]);
    if (screening.decision === "対象") summary.target++;
    else if (screening.decision === "要確認") summary.review++;
    else summary.excluded++;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteSheetName(title)}!A2:D${values.length}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: updates },
  });

  return {
    spreadsheetId,
    title,
    rowsUpdated: updates.length,
    summary,
    url: await sheetUrl(sheets, spreadsheetId, title),
  };
}

function eventFromSheetRow(header, row) {
  const get = (name) => row[header.indexOf(name)] || "";
  return {
    name: get("イベント名"),
    url: get("URL"),
    datetime: get("日時"),
    date: get("日付"),
    formattedDateTime: get("表示日時"),
    venueName: get("会場"),
    address: get("住所"),
    distanceKm: get("距離km") === "" ? null : Number(get("距離km")),
    organizerName: get("主催者"),
    groupName: get("グループ"),
    latlng: get("緯度経度"),
    id: get("Peatix ID"),
    description: get("詳細説明"),
  };
}

function screenEvent(event, masters = null) {
  const text = [
    event.name,
    event.venueName,
    event.address,
    event.organizerName,
    event.groupName,
    event.description,
    event.price,
  ]
    .filter(Boolean)
    .join(" ");
  const venueText = [event.venueName, event.address].filter(Boolean).join(" ");

  if (!venueText.trim()) {
    return {
      decision: "除外",
      priority: "低",
      reason: "会場・住所が確認できず、会場開催として扱えないため",
      memo: distanceMemo(event),
    };
  }

  const hardExclusions = [
    {
      pattern: /(こども|子ども|子供|親子|家族|ファミリー|キッズ|小学生|中学生|高校生|未就学|学生限定|ねんど|粘土|住宅展示場)/,
      reason: "親子・こども向け色が強く、20代社会人の交流候補から外れるため",
    },
    {
      pattern: /(寺|神社|仏教|宗教|法話|供養|布薩|坐禅|円覚寺|老師|管長)/,
      reason: "宗教・儀式色が強く、交流候補としては優先度が低いため",
    },
    {
      pattern: /(上映会|上映|映画|ライブ|コンサート|個展|展覧会|鑑賞会|公演|観劇)/,
      reason: "鑑賞・視聴中心で参加者同士の交流が主目的ではなさそうなため",
    },
    {
      pattern: /(起業家限定|経営者限定|Founder|ファウンダー|資金調達|ピッチ|VC|投資家|エンジェル投資家|IPO)/i,
      reason: "既に起業している人・投資家向けの色が強そうなため",
    },
    {
      pattern: /(美容ケア|住宅|展示場|整理券|物販|販売会|採用説明会|会社説明会|インターン|就活|新卒|転職フェア)/,
      reason: "販促・体験/販売寄りで、会話目的のイベントではなさそうなため",
    },
    {
      pattern: /(異業種交流(?:会)?|街コン|合コン|飲み会|朝活|婚活|恋活|縁結び|出会い|マッチング)/,
      reason: "異業種交流会・街コン・合コン・飲み会・朝活・恋活系は今回の対象外のため",
    },
  ];
  for (const rule of hardExclusions) {
    if (rule.pattern.test(text)) {
      return {
        decision: "除外",
        priority: "低",
        reason: rule.reason,
        memo: matchedMemo(text, rule.pattern),
      };
    }
  }

  const excludedOrganizer = masterMatch(
    [event.organizerName, event.groupName].filter(Boolean).join(" "),
    masters?.excludedOrganizers
  );
  if (excludedOrganizer) {
    return {
      decision: "除外",
      priority: "低",
      reason: "対象外の主催に該当するため",
      memo: `対象外の主催: ${excludedOrganizer}`,
    };
  }

  const excludedVenue = masterMatch(
    [event.venueName, event.address].filter(Boolean).join(" "),
    masters?.excludedVenues
  );
  if (excludedVenue) {
    return {
      decision: "除外",
      priority: "低",
      reason: "対象外の会場に該当するため",
      memo: `対象外の会場: ${excludedVenue}`,
    };
  }

  const lowPriorityWord = masterMatch(text, masters?.lowPriorityWords);
  if (lowPriorityWord) {
    return {
      decision: "要確認",
      priority: "低",
      reason: "優先度低いワードに該当するため",
      memo: `優先度低いワード: ${lowPriorityWord}`,
    };
  }

  const maxPrice = Math.max(maxPriceYen(event, text), manualPriceYen(event, masters?.priceOverrides));
  if (maxPrice >= 10000) {
    return {
      decision: "要確認",
      priority: "低",
      reason: "参加費が1万円以上のため",
      memo: `検出価格: ${maxPrice.toLocaleString("ja-JP")}円`,
    };
  }

  const strongTargets = [
    /(交流会|MBTI|友達作り|友だち作り|人脈|懇親会|コミュニティ|越境|社会人)/,
    /(哲学対話|対話|読書会|勉強会|ワークショップ|キャリア|ビジネス|AI|生成AI|マーケ|マーケティング|人事|HR|採用|営業|セールス|広報|PR|デザイン|UX|PM|PdM|決算|財務|法務|マネジメント|リーダーシップ)/,
  ];
  if (strongTargets.some((pattern) => pattern.test(text))) {
    const isVeryStrong = /(交流会|MBTI|人脈|懇親会|越境|社会人)/.test(text);
    return {
      decision: "対象",
      priority: isVeryStrong ? "高" : "中",
      reason: isVeryStrong
        ? "20代会社員が外のつながりを作りに来やすい交流文脈があるため"
        : "会社員の学び・越境参加につながるテーマで、候補として残す価値があるため",
      memo: distanceMemo(event),
    };
  }

  if (Number.isFinite(event.distanceKm) && event.distanceKm > 30) {
    return {
      decision: "要確認",
      priority: "低",
      reason: "東京中心からやや距離があり、内容も対象条件との一致が弱いため",
      memo: distanceMemo(event),
    };
  }

  return {
    decision: "要確認",
    priority: "低",
    reason: "タイトル・主催情報だけでは対象条件に合うか判断しきれないため",
    memo: distanceMemo(event),
  };
}

async function loadScreeningMasters(sheets, spreadsheetId) {
  const [excludedOrganizers, excludedVenues, lowPriorityWords, priceOverrides] = await Promise.all([
    readMasterColumn(sheets, spreadsheetId, "対象外の主催"),
    readMasterColumn(sheets, spreadsheetId, "対象外の会場"),
    readMasterColumn(sheets, spreadsheetId, "優先度低いワード"),
    readPriceOverrides(sheets, spreadsheetId, "価格手動確認"),
  ]);
  return { excludedOrganizers, excludedVenues, lowPriorityWords, priceOverrides };
}

async function readMasterColumn(sheets, spreadsheetId, title) {
  const res = await sheets.spreadsheets.values
    .get({
      spreadsheetId,
      range: `${quoteSheetName(title)}!A:A`,
      valueRenderOption: "FORMATTED_VALUE",
    })
    .catch(() => ({ data: { values: [] } }));
  return (res.data.values || [])
    .flat()
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function masterMatch(text, values = []) {
  const normalizedText = normalizeForMatch(text);
  return values.find((value) => normalizedText.includes(normalizeForMatch(value))) || "";
}

async function readPriceOverrides(sheets, spreadsheetId, title) {
  const res = await sheets.spreadsheets.values
    .get({
      spreadsheetId,
      range: `${quoteSheetName(title)}!A:C`,
      valueRenderOption: "FORMATTED_VALUE",
    })
    .catch(() => ({ data: { values: [] } }));
  return (res.data.values || [])
    .slice(1)
    .map((row) => ({
      match: String(row[0] || "").trim(),
      price: parsePriceNumber(String(row[1] || "").replace(/[^\d０-９,，.]/g, ""), false),
      memo: String(row[2] || "").trim(),
    }))
    .filter((row) => row.match && row.price);
}

function normalizeForMatch(value) {
  return String(value || "").trim().toLowerCase();
}

function matchedMemo(text, pattern) {
  const match = pattern.exec(text);
  return match ? `検出語: ${match[0]}` : "";
}

function maxPriceYen(event, text) {
  const candidates = [];
  const priceText = String(event.price || "");
  candidates.push(...extractPriceCandidates(priceText));
  const feeSnippets = String(text || "").match(
    /(参加費|料金|価格|費用|チケット|受講料|会費|参加枠|一般|通常|早割)[^。\n\r]{0,80}/g
  ) || [];
  for (const snippet of feeSnippets) candidates.push(...extractPriceCandidates(snippet));
  return candidates.length ? Math.max(...candidates) : 0;
}

function manualPriceYen(event, overrides = []) {
  const text = normalizeForMatch([event.url, event.name, event.id].filter(Boolean).join(" "));
  const match = overrides.find((override) => text.includes(normalizeForMatch(override.match)));
  return match ? match.price : 0;
}

function extractPriceCandidates(priceText) {
  const candidates = [];
  const patterns = [
    { pattern: /(?:¥|￥)\s*([0-9０-９][0-9０-９,，]*)/g, isManYen: false },
    { pattern: /([0-9０-９][0-9０-９,，]*)\s*円/g, isManYen: false },
    { pattern: /([0-9０-９]+(?:\.[0-9０-９]+)?)\s*万円/g, isManYen: true },
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.pattern.exec(priceText))) {
      const value = parsePriceNumber(match[1], pattern.isManYen);
      if (Number.isFinite(value)) candidates.push(value);
    }
  }
  return candidates;
}

function parsePriceNumber(value, isManYen) {
  const normalized = String(value || "")
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[,，]/g, "");
  const number = Number(normalized);
  if (!Number.isFinite(number)) return 0;
  return isManYen ? number * 10000 : number;
}

function distanceMemo(event) {
  return Number.isFinite(event.distanceKm) ? `中心地から約${event.distanceKm}km` : "";
}

async function sheetUrl(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, includeGridData: false });
  const sheet = meta.data.sheets.find((item) => item.properties.title === title);
  if (!sheet) return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheet.properties.sheetId}`;
}

async function uniqueSheetTitle(sheets, spreadsheetId, baseTitle) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, includeGridData: false });
  const titles = new Set(meta.data.sheets.map((sheet) => sheet.properties.title));
  if (!titles.has(baseTitle)) return baseTitle;
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const suffix = `${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(
    now.getMinutes()
  )}`;
  let title = `${baseTitle}_${suffix}`;
  let index = 2;
  while (titles.has(title)) {
    title = `${baseTitle}_${suffix}_${index++}`;
  }
  return title;
}

function defaultSheetTitle(args) {
  const label = args.start ? sheetMonth(args.start, false) : args.dr || "upcoming";
  return `peatix_${label}`;
}

function compactDate(value) {
  return String(value).replace(/-/g, "");
}

function sheetMonth(date, padMonth) {
  const [year, month] = String(date).split("-");
  return `${year}/${padMonth ? month : String(Number(month))}`;
}

function columnName(count) {
  let name = "";
  let number = count;
  while (number > 0) {
    const remainder = (number - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    number = Math.floor((number - 1) / 26);
  }
  return name;
}

function quoteSheetName(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function defaultOutputPath(args) {
  const label = args.start && args.end ? `${args.start}_${args.end}` : args.dr || "upcoming";
  return path.join("tmp", `peatix-events-${label}.${args.format}`);
}

function getSearchCenter(searchUrl) {
  const params = new URL(searchUrl).searchParams;
  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { lat, lng };
  }
  const ll = params.get("l.ll");
  if (ll) {
    const [llLat, llLng] = ll.split(",").map(Number);
    if (Number.isFinite(llLat) && Number.isFinite(llLng)) {
      return { lat: llLat, lng: llLng };
    }
  }
  return null;
}

function distanceFromCenter(latlng, center) {
  const [lat, lng] = String(latlng || "").split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const radiusKm = 6371;
  const dLat = toRad(lat - center.lat);
  const dLng = toRad(lng - center.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(center.lat)) * Math.cos(toRad(lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(radiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

function toRad(degrees) {
  return (degrees * Math.PI) / 180;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  if (args.screenSheetTitle) {
    const screening = await screenExistingSheet(args);
    console.log(JSON.stringify({ screening }, null, 2));
    return;
  }

  const result = await crawl(args);
  let outPath = null;
  let sheet = null;
  if (!args.noFile) {
    outPath = args.out || defaultOutputPath(args);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const body =
      args.format === "csv" ? toCsv(result.events) : `${JSON.stringify(result, null, 2)}\n`;
    fs.writeFileSync(outPath, body);
  }
  if (args.sheet) {
    sheet = await writeToGoogleSheet(result, args);
  }

  console.log(
    JSON.stringify(
      {
        outPath,
        sheet,
        count: result.count,
        requestedRange: result.requestedRange,
        pagesFetched: result.pages.length,
        firstEvent: result.events[0] || null,
      },
      null,
      2
    )
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_SEARCH_URL,
  DEFAULT_SPREADSHEET_ID,
  DEFAULT_GOOGLE_KEY_FILE,
  crawl,
  screenEvent,
  loadScreeningMasters,
  quoteSheetName,
  columnName,
};
