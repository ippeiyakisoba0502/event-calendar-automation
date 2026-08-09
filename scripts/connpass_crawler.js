#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_SEARCH_URL =
  "https://connpass.com/search/?q=&start_from=2026%2F09%2F01&start_to=2026%2F09%2F30&prefectures=tokyo&selectItem=tokyo&sort=";
const DEFAULT_SPREADSHEET_ID =
  process.env.EVENT_SPREADSHEET_ID ||
  process.env.PEATIX_SPREADSHEET_ID ||
  "1td2ieTUl2Xkdojma-um5ZQrY4MgFBd1JdgJTBS-J0ug";
const DEFAULT_GOOGLE_KEY_FILE =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  "/root/.config/openclaw/secrets/google-sheets-service-account.json";
const DEFAULT_INSERT_AFTER_TITLE = "クローリング結果→";
const DEFAULT_HEADERS = {
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
};

function usage() {
  return `Usage:
  node scripts/connpass_crawler.js --start YYYY-MM-DD --end YYYY-MM-DD [options]

Options:
  --url URL             connpass search URL.
  --start YYYY-MM-DD    Start date. Maps to start_from=YYYY/MM/DD.
  --end YYYY-MM-DD      End date. Maps to start_to=YYYY/MM/DD.
  --pages N             Max pages to fetch. Default: 3.
  --keyword TEXT        Search keyword. Maps to q.
  --keywords LIST       Comma-separated extra keywords. Crawls the base search plus each keyword.
  --details             Fetch each event page and extract description/price.
  --details-for-targets Fetch detail pages only for rows that look like 対象 before detail enrichment.
  --delay-ms N          Delay between requests. Default: 700.
  --format json|csv     Local output format. Default: json.
  --out PATH            Local output path.
  --sheet               Write events to a new Google Sheets tab.
  --sheet-id ID         Spreadsheet ID.
  --sheet-title TITLE   Base sheet tab title. Defaults to connpass候補_<range>.
  --replace-existing    Replace values in an existing sheet title instead of creating a suffixed tab.
  --insert-after TITLE  Place created sheet after this tab. Default: クローリング結果→.
  --sheet-index N       Place created sheet at this exact tab index.
  --screen              Prefill screening columns when writing a sheet.
  --screen-sheet-title TITLE
                         Screen an existing sheet tab and update columns A:D.
  --overwrite-screening Overwrite existing screening columns in --screen-sheet-title mode.
  --no-file             Skip local file output when using --sheet.
  --help                Show this help.
`;
}

function parseArgs(argv) {
  const args = {
    url: DEFAULT_SEARCH_URL,
    pages: 3,
    delayMs: 700,
    format: "json",
    details: false,
    screen: false,
    sheet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--details") args.details = true;
    else if (arg === "--details-for-targets") args.detailsForTargets = true;
    else if (arg === "--sheet") args.sheet = true;
    else if (arg === "--screen") args.screen = true;
    else if (arg === "--overwrite-screening") args.overwriteScreening = true;
    else if (arg === "--replace-existing") args.replaceExisting = true;
    else if (arg === "--no-file") args.noFile = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = argv[++i];
      if (value == null || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      args[key] = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  args.pages = positiveInt(args.pages, "pages");
  args.delayMs = nonNegativeInt(args.delayMs, "delay-ms");
  if (args.sheetIndex != null) args.sheetIndex = nonNegativeInt(args.sheetIndex, "sheet-index");
  args.format = String(args.format).toLowerCase();
  if (!["json", "csv"].includes(args.format)) throw new Error("--format must be json or csv");
  if (args.start && !isDateOnly(args.start)) throw new Error("--start must be YYYY-MM-DD");
  if (args.end && !isDateOnly(args.end)) throw new Error("--end must be YYYY-MM-DD");
  if ((args.start && !args.end) || (!args.start && args.end)) {
    throw new Error("--start and --end must be provided together");
  }
  if (args.noFile && !args.sheet) throw new Error("--no-file can only be used with --sheet");
  if (args.screenSheetTitle && args.noFile) throw new Error("--no-file is not used with --screen-sheet-title");
  return args;
}

function positiveInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`--${name} must be positive`);
  return number;
}

function nonNegativeInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`--${name} must be non-negative`);
  }
  return number;
}

function isDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value));
}

async function crawl(args) {
  const pages = [];
  const seen = new Map();
  for (const keyword of searchKeywords(args)) {
    for (let page = 1; page <= args.pages; page++) {
      const url = buildSearchUrl(args, page, keyword);
      const html = await fetchText(url);
      const events = parseSearchEvents(html);
      pages.push({ keyword: keyword || "", page, requestUrl: url.toString(), resultCount: events.length });
      const sourceKeyword = keyword || "通常検索";
      for (const event of events) {
        if (!seen.has(event.id)) {
          seen.set(event.id, { ...event, sourceKeywords: [sourceKeyword] });
        } else {
          const existing = seen.get(event.id);
          if (!existing.sourceKeywords.includes(sourceKeyword)) existing.sourceKeywords.push(sourceKeyword);
        }
      }
      if (events.length === 0) break;
      await sleep(args.delayMs);
    }
  }
  const events = [...seen.values()];
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
    source: "connpass",
    sourceUrl: args.url,
    requestedRange:
      args.start && args.end ? { start: args.start, end: args.end } : rangeFromUrl(args.url),
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

function buildSearchUrl(args, page, keyword = args.keyword) {
  const url = new URL(args.url);
  if (args.start && args.end) {
    url.searchParams.set("start_from", args.start.replace(/-/g, "/"));
    url.searchParams.set("start_to", args.end.replace(/-/g, "/"));
  }
  if (keyword != null) url.searchParams.set("q", keyword);
  if (page > 1) url.searchParams.set("page", String(page));
  else url.searchParams.delete("page");
  return url;
}

function rangeFromUrl(searchUrl) {
  const params = new URL(searchUrl).searchParams;
  return {
    start: (params.get("start_from") || "").replace(/\//g, "-"),
    end: (params.get("start_to") || "").replace(/\//g, "-"),
  };
}

async function fetchText(url) {
  const response = await fetch(url, { headers: DEFAULT_HEADERS });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 300)}`);
  return text;
}

function parseSearchEvents(html) {
  const blocks = [];
  const marker = '<div class="event_list vevent">';
  let index = html.indexOf(marker);
  while (index >= 0) {
    const next = html.indexOf(marker, index + marker.length);
    blocks.push(html.slice(index, next >= 0 ? next : html.length));
    index = next;
  }
  return blocks.map(parseEventBlock).filter(Boolean);
}

function parseEventBlock(block) {
  const url = attr(matchTag(block, /<a class="url summary"[^>]*>/i), "href");
  const title = cleanText(innerHtml(block, /<a class="url summary"[^>]*>([\s\S]*?)<\/a>/i));
  if (!url || !title) return null;
  const id = (url.match(/\/event\/(\d+)\//) || [])[1] || url;
  const year = cleanText(innerHtml(block, /<p class="year">([\s\S]*?)<\/p>/i));
  const md = cleanText(innerHtml(block, /<p class="date">([\s\S]*?)<\/p>/i));
  const timeText = cleanText(innerHtml(block, /<p class="time">([\s\S]*?)<\/p>/i));
  const date = year && md ? `${year}-${md.replace("/", "-")}` : "";
  const startUtc = attr(matchTag(block, /<span class="value-title" title="[^"]*"><\/span>/i), "title");
  const groupName = cleanText(innerHtml(block, /<span class="series_title">([\s\S]*?)<\/span>/i));
  const organizerName = cleanText(innerHtml(block, /<p class="event_owner">([\s\S]*?)<\/p>/i));
  const address = cleanText(innerHtml(block, /<p class="event_place location">([\s\S]*?)<\/p>/i));
  const participants = cleanText(innerHtml(block, /<p class="event_participants">([\s\S]*?)<\/p>/i));
  const cover = attr(matchTag(block, /<img class="photo"[^>]*>/i), "src");
  return {
    id,
    name: title,
    url,
    trackingUrl: url,
    datetime: date ? `${date} ${timeText}`.trim() : timeText,
    date,
    formattedDateTime: timeText,
    timezone: "Asia/Tokyo",
    venueName: "",
    address,
    organizerName: stripOwnerPrefix(organizerName),
    groupName,
    latlng: "",
    cover,
    price: "",
    priceCurrency: "JPY",
    participants,
    description: "",
  };
}

async function fetchEventDetails(url) {
  const html = await fetchText(url);
  const venueName = cleanText(innerHtml(html, /<p class="place_name[^"]*"[^>]*>([\s\S]*?)<\/p>/i));
  const address =
    attr(matchTag(html, /<span class="value-title" title="[^"]*"><\/span>\s*[^<]*\s*<\/p>/i), "title") ||
    cleanText(innerHtml(html, /<p class="adr">([\s\S]*?)<\/p>/i));
  const organizerName = cleanText(
    (html.match(/<p class="event_owner">主催\s*:\s*([^<]+)<\/p>/) || [])[1] || ""
  );
  return {
    description: cleanText(extractMeta(html, "description") || extractMeta(html, "og:description")),
    venueName,
    address,
    organizerName,
    price: extractPrice(html),
  };
}

function extractPrice(html) {
  const text = stripTags(html);
  const match = text.match(/参加費[：:\s]*([^\n。<]{1,40})/);
  if (!match) return "";
  return cleanText(match[1]).replace(/定員.*$/, "").trim();
}

function toSheetValues(rows, args = {}) {
  const columns = [
    { header: "判定", value: (row) => (args.screen ? screenEvent(row, args.screeningMasters).decision : "") },
    { header: "優先度", value: (row) => (args.screen ? screenEvent(row, args.screeningMasters).priority : "") },
    { header: "除外理由", value: (row) => (args.screen ? screenEvent(row, args.screeningMasters).reason : "") },
    { header: "精査メモ", value: (row) => (args.screen ? screenEvent(row, args.screeningMasters).memo : "") },
    { header: "イベント名", value: (row) => row.name },
    { header: "URL", value: (row) => row.url },
    { header: "日付", value: (row) => row.date },
    { header: "会場", value: (row) => row.venueName },
    { header: "住所", value: (row) => row.address },
    { header: "主催者", value: (row) => row.organizerName },
    { header: "グループ", value: (row) => row.groupName },
    { header: "価格", value: (row) => row.price || "" },
    { header: "時間", value: (row) => row.formattedDateTime },
    { header: "参加者", value: (row) => row.participants },
    { header: "詳細説明", value: (row) => row.description || "" },
    { header: "イベントID", value: (row) => row.id },
    { header: "検索キーワード", value: (row) => (row.sourceKeywords || []).join(", ") },
    { header: "画像", value: (row) => row.cover || "" },
  ];
  return [
    columns.map((column) => column.header),
    ...rows.map((row) => columns.map((column) => column.value(row))),
  ];
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
      memo: "",
    };
  }

  const excludeRules = [
    { pattern: /(こども|子ども|子供|親子|家族|ファミリー|キッズ|小学生|中学生|高校生|学生限定|初心者向けスクール)/, reason: "20代の普通の会社員との接点が弱そうなため" },
    { pattern: /(採用説明会|会社説明会|インターン|就活|新卒|転職フェア|合同説明会)/, reason: "採用・就活色が強く、対等な外部接点を作る場とは少し違うため" },
    { pattern: /(起業家限定|経営者限定|Founder|ファウンダー|資金調達|ピッチ|VC|投資家|エンジェル投資家|IPO)/i, reason: "既に起業している人・投資家向けの色が強そうなため" },
    { pattern: /(ウェビナー|オンラインのみ|録画配信)/, reason: "現地での人脈形成につながりにくいため" },
  ];
  for (const rule of excludeRules) {
    if (rule.pattern.test(text)) {
      return { decision: "除外", priority: "低", reason: rule.reason, memo: matchedMemo(text, rule.pattern) };
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

  const specificTech = /(Python|JavaScript|TypeScript|Ruby|Golang|Go言語|\bGo\b|Rust|Java\b|PHP|C\+\+|C#|Kotlin|Swift|Scala|React|Vue|Angular|Next\.?js|Nuxt|Svelte|Rails|Ruby on Rails|Laravel|Django|Flask|FastAPI|Node\.?js|NestJS|Spring|Flutter|Unity|Unreal|Docker|Kubernetes|k8s|Terraform|Ansible|AWS|GCP|Azure|Linux|PostgreSQL|MySQL|MongoDB|Redis|GraphQL)/i;
  if (specificTech.test(text)) {
    return {
      decision: "対象",
      priority: "中",
      reason: "具体的な技術・言語・フレームワーク特化で、対象ペルソナとの接点はあるが優先度は一段下げるため",
      memo: matchedMemo(text, specificTech),
    };
  }

  const strongest = /(交流会|懇親会|Meetup|ミートアップ|LT|コミュニティ|もくもく会|読書会|朝活|勉強会|ワークショップ|越境|異業種|社会人)/i;
  if (strongest.test(text)) {
    return {
      decision: "対象",
      priority: "高",
      reason: "20代会社員が学びや外のつながりを求めて参加しやすい場に見えるため",
      memo: matchedMemo(text, strongest),
    };
  }

  const good = /(AI|生成AI|エージェント|プロダクト|事業|開発|データ|セキュリティ|カフェ|デザイン|UX|PM|PdM|マーケ|マーケティング|人事|HR|採用|営業|セールス|広報|PR|経理|財務|法務|キャリア|リーダーシップ|マネジメント)/i;
  if (good.test(text)) {
    return {
      decision: "対象",
      priority: "中",
      reason: "会社員の学び・越境参加につながるテーマで、職種を問わず候補になりそうなため",
      memo: matchedMemo(text, good),
    };
  }

  return {
    decision: "要確認",
    priority: "低",
    reason: "タイトル・主催情報だけでは目的との一致を判断しきれないため",
    memo: "",
  };
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
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: values[0].length },
            cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.95, blue: 1 } } },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        },
        {
          autoResizeDimensions: {
            dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: values[0].length },
          },
        },
        validationRequest(sheetId, 0, ["対象", "要確認", "除外"], values.length),
        validationRequest(sheetId, 1, ["最優先", "高", "中", "低"], values.length),
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
    range: `${quoteSheetName(title)}!A1:R`,
  });
  const values = res.data.values || [];
  if (values.length < 2) throw new Error(`No data rows found in sheet: ${title}`);
  const header = values[0];
  const required = ["判定", "優先度", "除外理由", "精査メモ", "イベント名", "URL"];
  for (const name of required) {
    if (!header.includes(name)) throw new Error(`Missing required column in ${title}: ${name}`);
  }

  const masters = await loadScreeningMasters(sheets, spreadsheetId);
  const get = (row, name) => row[header.indexOf(name)] || "";
  const updates = [];
  const summary = { target: 0, review: 0, excluded: 0, skipped: 0 };
  for (const row of values.slice(1)) {
    const hasExisting = ["判定", "優先度", "除外理由", "精査メモ"].some((name) =>
      String(get(row, name)).trim()
    );
    if (hasExisting && !args.overwriteScreening) {
      updates.push([get(row, "判定"), get(row, "優先度"), get(row, "除外理由"), get(row, "精査メモ")]);
      summary.skipped++;
      continue;
    }
    const screening = screenEvent(
      {
        name: get(row, "イベント名"),
        url: get(row, "URL"),
        date: get(row, "日付"),
        venueName: get(row, "会場"),
        address: get(row, "住所"),
        organizerName: get(row, "主催者"),
        groupName: get(row, "グループ"),
        price: get(row, "価格"),
        formattedDateTime: get(row, "時間"),
        participants: get(row, "参加者"),
        description: get(row, "詳細説明"),
        id: get(row, "イベントID"),
        cover: get(row, "画像"),
      },
      masters
    );
    if (screening.decision === "対象") summary.target++;
    else if (screening.decision === "要確認") summary.review++;
    else if (screening.decision === "除外") summary.excluded++;
    updates.push([screening.decision, screening.priority, screening.reason, screening.memo]);
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteSheetName(title)}!A2:D${updates.length + 1}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: updates },
  });
  return { spreadsheetId, title, rowsUpdated: updates.length, ...summary };
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

function validationRequest(sheetId, columnIndex, values, rowCount) {
  return {
    setDataValidation: {
      range: { sheetId, startRowIndex: 1, endRowIndex: Math.max(rowCount, 2), startColumnIndex: columnIndex, endColumnIndex: columnIndex + 1 },
      rule: {
        condition: { type: "ONE_OF_LIST", values: values.map((userEnteredValue) => ({ userEnteredValue })) },
        showCustomUi: true,
        strict: false,
      },
    },
  };
}

function toCsv(rows) {
  const values = toSheetValues(rows, {});
  return `${values.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function uniqueSheetTitle(sheets, spreadsheetId, baseTitle) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, includeGridData: false });
  const titles = new Set(meta.data.sheets.map((sheet) => sheet.properties.title));
  if (!titles.has(baseTitle)) return baseTitle;
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const suffix = `${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  let title = `${baseTitle}_${suffix}`;
  let index = 2;
  while (titles.has(title)) title = `${baseTitle}_${suffix}_${index++}`;
  return title;
}

function defaultSheetTitle(args) {
  const month = args.start ? sheetMonth(args.start, true) : "range";
  return `connpass_${month}`;
}

function defaultOutputPath(args) {
  const range = args.start && args.end ? `${args.start}_${args.end}` : "range";
  return path.join("tmp", `connpass-events-${range}.${args.format}`);
}

function compact(value) {
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

function matchTag(html, pattern) {
  const match = pattern.exec(html);
  return match ? match[0] : "";
}

function innerHtml(html, pattern) {
  const match = pattern.exec(html);
  return match ? match[1] : "";
}

function attr(tag, name) {
  const match = new RegExp(`${name}=["']([^"']*)["']`, "i").exec(tag || "");
  return match ? decodeHtml(match[1]) : "";
}

function extractMeta(html, name) {
  const escaped = escapeRegex(name);
  const patterns = [
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) return decodeHtml(match[1]);
  }
  return "";
}

function stripOwnerPrefix(value) {
  return cleanText(value).replace(/^主催\s*:\s*/, "").replace(/\s+他$/, " 他");
}

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
}

function cleanText(value) {
  return stripTags(value).replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    const body = args.format === "csv" ? toCsv(result.events) : `${JSON.stringify(result, null, 2)}\n`;
    fs.writeFileSync(outPath, body);
  }
  if (args.sheet) sheet = await writeToGoogleSheet(result, args);
  console.log(JSON.stringify({ outPath, sheet, count: result.count, pagesFetched: result.pages.length, firstEvent: result.events[0] || null }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_GOOGLE_KEY_FILE,
  DEFAULT_SEARCH_URL,
  DEFAULT_SPREADSHEET_ID,
  crawl,
  loadScreeningMasters,
  quoteSheetName,
  screenEvent,
};
