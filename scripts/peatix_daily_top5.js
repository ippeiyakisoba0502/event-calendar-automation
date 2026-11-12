#!/usr/bin/env node

const {
  DEFAULT_SEARCH_URL,
  DEFAULT_SPREADSHEET_ID,
  DEFAULT_GOOGLE_KEY_FILE,
  crawl,
  loadScreeningMasters,
  screenEvent,
  quoteSheetName,
} = require("./peatix_crawler");

const DEFAULT_KEYWORDS = [
  "AI", "生成AI", "AI活用", "ABM", "BtoB", "DX", "SaaS", "LT会", "交流会",
  "懇親会", "コミュニティ", "キャリア", "セミナー", "セールス", "営業", "事例",
  "カンファレンス", "マーケター", "マーケティング", "HR", "新規事業", "事業開発",
  "ミートアップ", "Meetup", "現地開催",
];

const PREFERRED_COMPANY_TERMS = [
  "Ubie",
  "LinkedIn",
  "kubell",
  "サイボウズ",
  "Offers",
  "SmartHR",
  "LayerX",
  "freee",
  "マネーフォワード",
  "Sansan",
  "メルカリ",
  "DeNA",
  "LINEヤフー",
  "リクルート",
  "楽天",
  "GMO",
  "サイバーエージェント",
  "Google",
  "Microsoft",
  "AWS",
  "Amazon",
  "Salesforce",
  "Adobe",
  "NTT",
  "KDDI",
  "ソフトバンク",
  "富士通",
  "日立",
  "IBM",
];

function usage() {
  return `Usage:
  node scripts/peatix_daily_top5.js --start YYYY-MM-DD --end YYYY-MM-DD --target-sheet TITLE [options]

Options:
  --pages N           Pages per keyword for each date. Default: 5.
  --keywords CSV      Search keywords. Defaults to the monthly Peatix keyword set.
  --within-km N       Radius from Tokyo Station. Default: 50.
  --delay-ms N        Delay between Peatix requests. Default: 350.
  --sheet-id ID       Spreadsheet ID.
  --target-sheet TITLE Existing template sheet with 日付/時間/候補1..候補5.
  --dry-run           Crawl and print the selected events without writing.
`;
}

function parseArgs(argv) {
  const args = {
    pages: 5,
    keywords: DEFAULT_KEYWORDS.join(","),
    withinKm: 50,
    delayMs: 350,
    sheetId: DEFAULT_SPREADSHEET_ID,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = argv[++i];
      if (value == null || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      args[key] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.help) return args;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.start || "") || !/^\d{4}-\d{2}-\d{2}$/.test(args.end || "")) {
    throw new Error("--start and --end must be YYYY-MM-DD");
  }
  if (args.start > args.end) throw new Error("--start must be on or before --end");
  if (!args.targetSheet && !args.dryRun) throw new Error("--target-sheet is required unless --dry-run is used");
  args.pages = positiveInt(args.pages, "pages");
  args.withinKm = positiveNumber(args.withinKm, "within-km");
  args.delayMs = nonNegativeInt(args.delayMs, "delay-ms");
  return args;
}

function positiveInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`--${name} must be a positive integer`);
  return number;
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`--${name} must be positive`);
  return number;
}

function nonNegativeInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`--${name} must be a non-negative integer`);
  return number;
}

function datesBetween(start, end) {
  const dates = [];
  let current = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (current <= last) {
    dates.push(current.toISOString().slice(0, 10));
    current = new Date(current.getTime() + 86400000);
  }
  return dates;
}

function tokyoTime(event) {
  const date = new Date(event.datetime);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${value.year}-${value.month}-${value.day}`,
    hour: Number(value.hour),
    minute: Number(value.minute),
  };
}

function isNightEvent(event, expectedDate) {
  const time = tokyoTime(event);
  return Boolean(
    time &&
    time.date === expectedDate &&
    time.hour >= 18 &&
    time.hour <= 22 &&
    isSingleDayEvent(event)
  );
}

function isSingleDayEvent(event) {
  const days = Number(event.days);
  if (Number.isFinite(days) && days > 1) return false;
  return !/\(\s*\d+\s*日間\s*\)/.test(String(event.formattedDateTime || ""));
}

function priorityRank(priority) {
  return { "最優先": 0, "高": 1, "中": 2, "低": 3 }[priority] ?? 9;
}

function eventSort(a, b) {
  const aTime = tokyoTime(a.event) || { hour: 99, minute: 99 };
  const bTime = tokyoTime(b.event) || { hour: 99, minute: 99 };
  return (
    relevanceScore(b.event) - relevanceScore(a.event) ||
    priorityRank(a.screening.priority) - priorityRank(b.screening.priority) ||
    aTime.hour - bTime.hour ||
    aTime.minute - bTime.minute ||
    String(a.event.name).localeCompare(String(b.event.name), "ja")
  );
}

function relevanceScore(event) {
  const text = [event.name, event.organizerName, event.groupName, event.description]
    .filter(Boolean)
    .join(" ");
  let score = 0;
  if (PREFERRED_COMPANY_TERMS.some((term) => text.toLowerCase().includes(term.toLowerCase()))) {
    score += 10;
  }
  if (/(参加費)?無料|free\s*(event|seminar|workshop)?/i.test(text)) score += 4;
  if (/(20代|20歳|25歳|30歳|35歳|若手|U30|第二新卒)/i.test(text)) score += 5;
  if (/(AI|生成AI|DX|SaaS|エンジニア|プロダクト|新規事業|事業開発)/i.test(text)) score += 4;
  if (/(キャリア|人事|HR|採用|営業|セールス|マーケ|広報|PR|デザイン|UX|PM|PdM|財務|法務|マネジメント)/i.test(text)) score += 3;
  const hasLearning = /(勉強会|セミナー|ワークショップ|研究会|講座|事例|実践|学ぶ|LT|登壇|セッション)/i.test(text);
  const hasInteraction = /(交流会|懇親会|コミュニティ|対話|ネットワーキング|ミートアップ|Meetup)/i.test(text);
  if (hasLearning) score += 2;
  if (hasInteraction) score += 1;
  if (hasLearning && hasInteraction) score += 6;
  const attendanceNumbers = [...text.matchAll(/(?:定員|先着|最大)?\s*([1-9][0-9]{1,3})\s*(?:名|人)/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  const maxAttendance = attendanceNumbers.length ? Math.max(...attendanceNumbers) : 0;
  if (maxAttendance >= 100) score += 6;
  else if (maxAttendance >= 50) score += 4;
  else if (maxAttendance >= 20) score += 2;
  if (/(大規模|大型|カンファレンス|conference|満席)/i.test(text)) score += 3;
  return score;
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  return candidates.filter(({ event }) => {
    const key = String(event.name || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s　【】\[\]（）()「」『』・!！?？:：\-—–_]/g, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function placeLabel(event) {
  const text = String(event.address || event.venueName || "")
    .trim()
    .replace(/^日本[、,\s　]*/, "");
  const tokyoWard = text.match(/東京都([^\s　、,]{1,8}区)/);
  if (tokyoWard) return tokyoWard[1];
  const localText = text.replace(/^(?:東京都|神奈川県|千葉県|埼玉県)/, "");
  const cityWard = localText.match(/([^\s　、,]{1,8}市[^\s　、,]{1,8}区)/);
  if (cityWard) return cityWard[1];
  const ward = localText.match(/(?:^|[\s　、,])([^\s　、,]{1,8}区)/);
  if (ward) return ward[1];
  const city = text.match(/(?:東京都|神奈川県|千葉県|埼玉県)?([^\s　]{1,12}市)/);
  if (city) return city[1];
  return String(event.venueName || event.address || "不明").trim();
}

function priceLabel(event) {
  const text = `${event.price || ""} ${event.description || ""}`;
  const amounts = [];
  for (const match of text.matchAll(/(?:¥|￥)\s*([\d,]+)|([\d,]+)\s*円/g)) {
    const amount = Number(String(match[1] || match[2]).replace(/,/g, ""));
    if (Number.isFinite(amount)) amounts.push(amount);
  }
  const positive = amounts.filter((amount) => amount > 0);
  const amount = positive.length ? Math.max(...positive) : Number(event.price || 0);
  return `${Number.isFinite(amount) && amount > 0 ? amount.toLocaleString("ja-JP") : 0}円`;
}

function candidateCell(candidate) {
  if (!candidate) return { userEnteredValue: { stringValue: "" } };
  const { event } = candidate;
  const title = String(event.name || "名称未取得").trim();
  const value = `${title}\n開催場所 : ${placeLabel(event)}\n金額 : ${priceLabel(event)}`;
  return {
    userEnteredValue: { stringValue: value },
    textFormatRuns: [
      {
        startIndex: 0,
        format: {
          bold: true,
          foregroundColor: { blue: 0.72 },
          link: { uri: event.url },
        },
      },
      { startIndex: title.length, format: { foregroundColor: { red: 0, green: 0, blue: 0 } } },
    ],
    userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP" },
  };
}

async function sheetsClient() {
  const { google } = require("googleapis");
  const auth = new google.auth.GoogleAuth({
    keyFile: DEFAULT_GOOGLE_KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

function normalizeSheetDate(value) {
  const match = String(value || "").match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (!match) return "";
  return `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`;
}

async function writeSelections(sheets, args, selections) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: args.sheetId, includeGridData: false });
  const target = meta.data.sheets.find((sheet) => sheet.properties.title === args.targetSheet);
  if (!target) throw new Error(`Target sheet not found: ${args.targetSheet}`);
  const values = await sheets.spreadsheets.values.get({
    spreadsheetId: args.sheetId,
    range: `${quoteSheetName(args.targetSheet)}!A:B`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  const requests = [];
  for (let index = 1; index < (values.data.values || []).length; index++) {
    const date = normalizeSheetDate(values.data.values[index][0]);
    if (!selections.has(date)) continue;
    requests.push({
      updateCells: {
        range: {
          sheetId: target.properties.sheetId,
          startRowIndex: index,
          endRowIndex: index + 1,
          startColumnIndex: 2,
          endColumnIndex: 7,
        },
        rows: [{ values: selections.get(date).map(candidateCell) }],
        fields: "userEnteredValue,textFormatRuns,userEnteredFormat(wrapStrategy,verticalAlignment)",
      },
    });
  }
  if (requests.length !== selections.size) {
    throw new Error(`Template date mismatch: expected ${selections.size} rows, found ${requests.length}`);
  }
  requests.push({
    updateDimensionProperties: {
      range: {
        sheetId: target.properties.sheetId,
        dimension: "ROWS",
        startIndex: 1,
        endIndex: (values.data.values || []).length,
      },
      properties: { pixelSize: 90 },
      fields: "pixelSize",
    },
  });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: args.sheetId,
    requestBody: { requests },
  });
  return { title: args.targetSheet, sheetId: target.properties.sheetId, updatedDates: requests.length - 1 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return process.stdout.write(usage());
  const sheets = await sheetsClient();
  const masters = await loadScreeningMasters(sheets, args.sheetId);
  const selections = new Map();
  const stats = [];
  for (const date of datesBetween(args.start, args.end)) {
    const result = await crawl({
      url: DEFAULT_SEARCH_URL,
      start: date,
      end: date,
      pages: args.pages,
      size: 12,
      keywords: args.keywords,
      delayMs: args.delayMs,
      withinKm: args.withinKm,
      localDateFilter: true,
      detailsForTargets: true,
    });
    const screened = dedupeCandidates(result.events
      .filter((event) => isNightEvent(event, date))
      .map((event) => ({ event, screening: screenEvent(event, masters) }))
      .filter(({ screening }) => screening.decision === "対象")
      .sort(eventSort));
    const selected = screened.slice(0, 5);
    while (selected.length < 5) selected.push(null);
    selections.set(date, selected);
    stats.push({
      date,
      raw: result.count,
      pagesFetched: result.pages.length,
      nightTargets: screened.length,
      selected: selected.filter(Boolean).map(({ event, screening }) => ({
        priority: screening.priority,
        time: event.formattedDateTime || event.datetime,
        name: event.name,
        url: event.url,
      })),
    });
  }
  const sheet = args.dryRun ? null : await writeSelections(sheets, args, selections);
  console.log(JSON.stringify({ sheet, stats }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  });
}

module.exports = {
  isNightEvent,
  isSingleDayEvent,
  placeLabel,
  priceLabel,
  relevanceScore,
  PREFERRED_COMPANY_TERMS,
  dedupeCandidates,
  eventSort,
  candidateCell,
};
