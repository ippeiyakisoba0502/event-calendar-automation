#!/usr/bin/env node

const DEFAULT_SPREADSHEET_ID =
  process.env.EVENT_SPREADSHEET_ID ||
  process.env.PEATIX_SPREADSHEET_ID ||
  "1td2ieTUl2Xkdojma-um5ZQrY4MgFBd1JdgJTBS-J0ug";
const DEFAULT_GOOGLE_KEY_FILE =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  "/root/.config/openclaw/secrets/google-sheets-service-account.json";
const DEFAULT_STYLE_SOURCE_GID = Number(process.env.EVENT_CALENDAR_STYLE_GID || 1795095556);

function usage() {
  return `Usage:
  node scripts/event_calendar_sheet.js --source-sheets "peatix_YYYY/M,connpass_YYYY/MM" [options]

Options:
  --source-sheets LIST  Comma-separated source sheet titles.
  --sheet-id ID         Spreadsheet ID.
  --target-title TITLE  Output tab title. Default: カレンダー_YYYY/M.
  --start YYYY-MM-DD    Calendar display start date.
  --end YYYY-MM-DD      Calendar display end date.
  --replace-existing    Replace values in an existing target tab instead of creating a suffixed tab.
  --style-from-gid GID Copy visual formatting from a reference sheet. Default: 1795095556.
  --no-style-copy      Disable reference style copying.
  --calendar-index N   Insert output tab at this index. Default: 0.
  --include-review      Include 要確認 rows as well as 対象 rows.
  --min-priority LEVEL Include only events at or above this priority: 最優先, 高, 中, 低.
  --peatix-min-priority LEVEL
                         Peatix-specific priority threshold.
  --connpass-min-priority LEVEL
                         connpass-specific priority threshold.
  --help                Show this help.
`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--include-review") args.includeReview = true;
    else if (arg === "--no-style-copy") args.noStyleCopy = true;
    else if (arg === "--replace-existing") args.replaceExisting = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = argv[++i];
      if (value == null || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      args[key] = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.help && !args.sourceSheets) throw new Error("--source-sheets is required");
  if (args.start && !isDateOnly(args.start)) throw new Error("--start must be YYYY-MM-DD");
  if (args.end && !isDateOnly(args.end)) throw new Error("--end must be YYYY-MM-DD");
  if ((args.start && !args.end) || (!args.start && args.end)) {
    throw new Error("--start and --end must be provided together");
  }
  if (args.styleFromGid != null) args.styleFromGid = positiveInt(args.styleFromGid, "style-from-gid");
  if (args.calendarIndex != null) args.calendarIndex = nonNegativeInt(args.calendarIndex, "calendar-index");
  if (args.minPriority && !["最優先", "高", "中", "低"].includes(args.minPriority)) {
    throw new Error("--min-priority must be one of 最優先, 高, 中, 低");
  }
  if (args.peatixMinPriority && !["最優先", "高", "中", "低"].includes(args.peatixMinPriority)) {
    throw new Error("--peatix-min-priority must be one of 最優先, 高, 中, 低");
  }
  if (args.connpassMinPriority && !["最優先", "高", "中", "低"].includes(args.connpassMinPriority)) {
    throw new Error("--connpass-min-priority must be one of 最優先, 高, 中, 低");
  }
  return args;
}

function positiveInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`--${name} must be a positive integer`);
  return number;
}

function nonNegativeInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`--${name} must be a non-negative integer`);
  return number;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const { google } = require("googleapis");
  const spreadsheetId = args.sheetId || DEFAULT_SPREADSHEET_ID;
  const auth = new google.auth.GoogleAuth({
    keyFile: args.googleKeyFile || DEFAULT_GOOGLE_KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const sourceTitles = args.sourceSheets.split(",").map((item) => item.trim()).filter(Boolean);
  const events = [];

  for (const title of sourceTitles) {
    const rows = await readSheet(sheets, spreadsheetId, title);
    events.push(...normalizeRows(title, rows, args));
  }

  events.sort(compareEvents);
  const baseTargetTitle = args.targetTitle || defaultTargetTitle(events);
  const targetTitle = args.replaceExisting
    ? baseTargetTitle
    : await uniqueSheetTitle(sheets, spreadsheetId, baseTargetTitle);
  const values = toCalendarValues(events, args);
  const sheet = await writeSheet(sheets, spreadsheetId, targetTitle, values, args);

  console.log(
    JSON.stringify(
      {
        spreadsheetId,
        sourceTitles,
        targetTitle,
        count: events.length,
        url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheet.properties.sheetId}`,
      },
      null,
      2
    )
  );
}

async function readSheet(sheets, spreadsheetId, title) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteSheetName(title)}!A1:Z`,
  });
  return res.data.values || [];
}

function normalizeRows(sourceTitle, rows, args) {
  if (rows.length < 2) return [];
  const header = rows[0];
  return rows
    .slice(1)
    .map((row) => normalizeRow(sourceTitle, header, row))
    .filter((event) => event.decision === "対象" || (args.includeReview && event.decision === "要確認"))
    .filter((event) => meetsPriorityThreshold(event, priorityThresholdFor(event, args)));
}

function normalizeRow(sourceTitle, header, row) {
  const get = (...names) => {
    for (const name of names) {
      const index = header.indexOf(name);
      if (index >= 0 && row[index] != null) return row[index];
    }
    return "";
  };
  return {
    source: sourceTitle.startsWith("connpass") ? "connpass" : sourceTitle.toLowerCase().startsWith("peatix") ? "peatix" : sourceTitle,
    decision: get("判定"),
    priority: get("優先度"),
    reason: get("除外理由"),
    memo: get("精査メモ"),
    name: get("イベント名"),
    url: get("URL"),
    date: get("日付"),
    time: get("時間", "表示日時", "日時"),
    venue: get("会場"),
    address: get("住所"),
    organizer: get("主催者"),
    group: get("グループ"),
    price: get("価格"),
  };
}

function compareEvents(a, b) {
  const dateCompare = String(a.date).localeCompare(String(b.date));
  if (dateCompare) return dateCompare;
  const timeCompare = eventMinutes(a) - eventMinutes(b);
  if (timeCompare) return timeCompare;
  return priorityRank(a.priority) - priorityRank(b.priority);
}

function priorityRank(priority) {
  return { "最優先": 0, "高": 1, "中": 2, "低": 3 }[priority] ?? 9;
}

function meetsPriorityThreshold(event, minPriority) {
  if (!minPriority) return true;
  return priorityRank(event.priority) <= priorityRank(minPriority);
}

function priorityThresholdFor(event, args) {
  if (event.source === "peatix") return args.peatixMinPriority || args.minPriority;
  if (event.source === "connpass") return args.connpassMinPriority || args.minPriority;
  return args.minPriority;
}

function toCalendarValues(events, args = {}) {
  const header = ["週", "時間帯", "月", "火", "水", "木", "金", "土", "日"];
  const period = calendarPeriod(events, args);
  if (!period) return [header];
  const weeks = period.weeks;
  const grouped = groupEvents(events);
  const rows = [header];
  weeks.forEach((week, weekIndex) => {
    const weekName = `第${weekIndex + 1}週`;
    rows.push([weekName, "日付", ...week.map((date) => (isInPeriod(date, period) ? sheetDate(date) : ""))]);
    for (const slot of timeSlots()) {
      const dayCells = week.map((date) => {
        const key = `${dateOnly(date)}|${slot.label}`;
        return grouped.get(key) || [];
      });
      const rowCount = Math.max(1, ...dayCells.map((items) => items.length));
      for (let index = 0; index < rowCount; index++) {
        rows.push([
          index === 0 ? weekName : "",
          index === 0 ? slot.label : "",
          ...dayCells.map((items) => items[index] || ""),
        ]);
      }
    }
  });
  return rows;
}

async function writeSheet(sheets, spreadsheetId, title, values, args = {}) {
  const existing = args.replaceExisting
    ? await findSheetByTitle(sheets, spreadsheetId, title)
    : null;
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
                index: args.calendarIndex ?? 0,
                gridProperties: {
                  rowCount: Math.max(values.length + 20, 80),
                  columnCount: values[0].length,
                  frozenRowCount: 1,
                  frozenColumnCount: 2,
                },
              },
              fields: "index,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)",
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
                index: args.calendarIndex ?? 0,
                gridProperties: {
                  rowCount: Math.max(values.length + 20, 80),
                  columnCount: values[0].length,
                  frozenRowCount: 1,
                  frozenColumnCount: 2,
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
  if (!args.noStyleCopy) {
    const copied = await copyReferenceStyle(
      sheets,
      spreadsheetId,
      args.styleFromGid || DEFAULT_STYLE_SOURCE_GID,
      sheet.properties.sheetId,
      values.length,
      values[0].length
    );
    if (!copied) await applyBasicCalendarStyle(sheets, spreadsheetId, sheet.properties.sheetId, values);
  } else {
    await applyBasicCalendarStyle(sheets, spreadsheetId, sheet.properties.sheetId, values);
  }
  await applyCalendarOverrides(sheets, spreadsheetId, sheet.properties.sheetId, values);
  return sheet;
}

async function applyCalendarOverrides(sheets, spreadsheetId, sheetId, values) {
  const requests = [
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: values.length,
          startColumnIndex: 0,
          endColumnIndex: 9,
        },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
            wrapStrategy: "WRAP",
          },
        },
        fields: "userEnteredFormat(horizontalAlignment,verticalAlignment,wrapStrategy)",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 9 },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
            backgroundColor: { red: 0.8784314, green: 0.9372549, blue: 1 },
          },
        },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 1,
          endRowIndex: values.length,
          startColumnIndex: 0,
          endColumnIndex: 9,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 1, green: 1, blue: 1 },
            textFormat: { foregroundColor: { red: 0, green: 0, blue: 0 } },
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat.foregroundColor)",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: values.length, startColumnIndex: 0, endColumnIndex: 2 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: "userEnteredFormat.textFormat",
      },
    },
    ...fixedDimensionRequests(sheetId, values.length),
  ];
  values.forEach((row, index) => {
    if (row[1] !== "日付") return;
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: index,
          endRowIndex: index + 1,
          startColumnIndex: 0,
          endColumnIndex: 9,
        },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
            backgroundColor: { red: 0.8509804, green: 0.8509804, blue: 0.8509804 },
          },
        },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    });
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: index,
          endRowIndex: index + 1,
          startColumnIndex: 2,
          endColumnIndex: 9,
        },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: "DATE", pattern: "yyyy/mm/dd" },
          },
        },
        fields: "userEnteredFormat.numberFormat",
      },
    });
  });
  values.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      if (columnIndex < 2 || !String(cell || "").includes("[A]")) return;
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: rowIndex,
            endRowIndex: rowIndex + 1,
            startColumnIndex: columnIndex,
            endColumnIndex: columnIndex + 1,
          },
          cell: {
            userEnteredFormat: {
              textFormat: { foregroundColor: { red: 0.8, green: 0, blue: 0 } },
            },
          },
          fields: "userEnteredFormat.textFormat.foregroundColor",
        },
      });
    });
  });
  if (!requests.length) return;
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

function fixedDimensionRequests(sheetId, rowCount) {
  const columnWidths = [70, 110, 230, 230, 230, 230, 230, 230, 230];
  return [
    ...columnWidths.map((pixelSize, index) => ({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + 1 },
        properties: { pixelSize },
        fields: "pixelSize",
      },
    })),
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 21 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "ROWS", startIndex: 1, endIndex: Math.max(rowCount, 2) },
        properties: { pixelSize: 56 },
        fields: "pixelSize",
      },
    },
  ];
}

async function findSheetByTitle(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, includeGridData: false });
  return meta.data.sheets.find((item) => item.properties.title === title) || null;
}

async function applyBasicCalendarStyle(sheets, spreadsheetId, sheetId, values) {
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
      ],
    },
  });
}

async function copyReferenceStyle(sheets, spreadsheetId, sourceSheetId, targetSheetId, rowCount, columnCount) {
  const ref = await referenceSheetDimensions(
    sheets,
    spreadsheetId,
    sourceSheetId,
    rowCount,
    columnCount
  ).catch(() => null);
  if (!ref) return false;
  const requests = [
    {
      copyPaste: {
        source: {
          sheetId: sourceSheetId,
          startRowIndex: 0,
          endRowIndex: Math.max(rowCount, 1),
          startColumnIndex: 0,
          endColumnIndex: columnCount,
        },
        destination: {
          sheetId: targetSheetId,
          startRowIndex: 0,
          endRowIndex: Math.max(rowCount, 1),
          startColumnIndex: 0,
          endColumnIndex: columnCount,
        },
        pasteType: "PASTE_FORMAT",
        pasteOrientation: "NORMAL",
      },
    },
  ];
  requests.push(...dimensionRequests(targetSheetId, "COLUMNS", ref.columns, columnCount));
  requests.push(...dimensionRequests(targetSheetId, "ROWS", ref.rows, rowCount));
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  return true;
}

async function referenceSheetDimensions(sheets, spreadsheetId, sheetId, rowCount, columnCount) {
  const sheetMeta = await sheets.spreadsheets.get({
    spreadsheetId,
    includeGridData: false,
    fields: "sheets.properties(sheetId,title)",
  });
  const source = sheetMeta.data.sheets.find((item) => item.properties.sheetId === Number(sheetId));
  if (!source) return null;
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    includeGridData: true,
    ranges: [
      `${quoteSheetName(source.properties.title)}!A1:${columnName(columnCount)}${Math.max(rowCount, 1)}`,
    ],
    fields: "sheets(properties(sheetId),data(rowMetadata(pixelSize),columnMetadata(pixelSize)))",
  });
  const sheet = meta.data.sheets.find((item) => item.properties.sheetId === Number(sheetId));
  if (!sheet) return null;
  return {
    rows: sheet.data?.[0]?.rowMetadata || [],
    columns: sheet.data?.[0]?.columnMetadata || [],
  };
}

function dimensionRequests(sheetId, dimension, metadata, count) {
  const requests = [];
  for (let index = 0; index < count; index++) {
    const pixelSize = metadata[index]?.pixelSize;
    if (!pixelSize) continue;
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension, startIndex: index, endIndex: index + 1 },
        properties: { pixelSize },
        fields: "pixelSize",
      },
    });
  }
  return requests;
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

function defaultTargetTitle(events) {
  const month = inferMonth(events);
  return month ? `カレンダー_${month.year}/${month.month}` : "カレンダー_events";
}

function weekday(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return "";
  return ["日", "月", "火", "水", "木", "金", "土"][new Date(`${date}T00:00:00+09:00`).getDay()];
}

function inferMonth(events) {
  const date = events.map((event) => event.date).find((value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value)));
  if (!date) return null;
  const [year, month] = date.split("-").map(Number);
  return { year, month };
}

function calendarPeriod(events, args) {
  if (args.start && args.end) {
    const start = dateFromDateOnly(args.start);
    const end = dateFromDateOnly(args.end);
    if (start > end) throw new Error("--start must be before or equal to --end");
    return { start, end, weeks: rangeWeeks(start, end) };
  }
  const month = inferMonth(events);
  if (!month) return null;
  const start = new Date(`${month.year}-${String(month.month).padStart(2, "0")}-01T00:00:00+09:00`);
  const end = new Date(month.year, month.month, 0);
  return { start, end, weeks: monthWeeks(month.year, month.month) };
}

function monthWeeks(monthYear, monthNumber) {
  const first = new Date(`${monthYear}-${String(monthNumber).padStart(2, "0")}-01T00:00:00+09:00`);
  const last = new Date(monthYear, monthNumber, 0);
  const start = new Date(first);
  start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const weeks = [];
  for (let cursor = new Date(start); cursor <= last || cursor.getDay() !== 1; cursor.setDate(cursor.getDate() + 7)) {
    const week = [];
    for (let offset = 0; offset < 7; offset++) {
      const date = new Date(cursor);
      date.setDate(cursor.getDate() + offset);
      week.push(date);
    }
    weeks.push(week);
    if (weeks.length > 6) break;
  }
  return weeks;
}

function isSameMonth(date, month) {
  return date.getFullYear() === month.year && date.getMonth() + 1 === month.month;
}

function sheetDate(date) {
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

function dateOnly(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateFromDateOnly(value) {
  return new Date(`${value}T00:00:00+09:00`);
}

function isDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value));
}

function isInPeriod(date, period) {
  const current = dateOnly(date);
  return current >= dateOnly(period.start) && current <= dateOnly(period.end);
}

function rangeWeeks(startDate, endDate) {
  const start = new Date(startDate);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const weeks = [];
  for (let cursor = new Date(start); cursor <= endDate; cursor.setDate(cursor.getDate() + 7)) {
    const week = [];
    for (let offset = 0; offset < 7; offset++) {
      const date = new Date(cursor);
      date.setDate(cursor.getDate() + offset);
      week.push(date);
    }
    weeks.push(week);
    if (weeks.length > 20) break;
  }
  return weeks;
}

function timeSlots() {
  return [
    { label: "9時以前", min: -Infinity, max: 9 * 60 },
    { label: "9時〜12時", min: 9 * 60, max: 12 * 60 },
    { label: "12時〜19時", min: 12 * 60, max: 19 * 60 },
    { label: "19時〜21時", min: 19 * 60, max: 21 * 60 },
    { label: "21時以降", min: 21 * 60, max: Infinity },
  ];
}

function groupEvents(events) {
  const grouped = new Map();
  for (const event of events) {
    const minutes = eventMinutes(event);
    const slot = timeSlots().find((item) => minutes >= item.min && minutes < item.max) || timeSlots()[2];
    const key = `${event.date}|${slot.label}`;
    const items = grouped.get(key) || [];
    items.push(calendarCell(event));
    grouped.set(key, items);
  }
  return grouped;
}

function eventMinutes(event) {
  const text = [event.time, event.name].join(" ");
  const match = String(text).match(/(\d{1,2})[:：](\d{2})/);
  if (!match) return 12 * 60;
  return Number(match[1]) * 60 + Number(match[2]);
}

function calendarCell(event) {
  const time = String(event.time || "").match(/(\d{1,2})[:：](\d{2})/);
  const prefix = time ? `${time[1].padStart(2, "0")}:${time[2]} ` : "";
  const label = `${prefix}[${priorityCode(event.priority)}] ${event.name}`;
  return event.url ? `=HYPERLINK("${formulaText(event.url)}","${formulaText(label)}")` : label;
}

function formulaText(value) {
  return String(value || "").replace(/"/g, '""').replace(/\r?\n/g, " ");
}

function priorityCode(priority) {
  if (priority === "最優先" || priority === "高") return "A";
  if (priority === "中") return "B";
  return "C";
}

function quoteSheetName(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
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

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
