#!/usr/bin/env node

const {
  DEFAULT_GOOGLE_KEY_FILE,
  DEFAULT_SEARCH_URL,
  DEFAULT_SPREADSHEET_ID,
  crawl,
  loadScreeningMasters,
  quoteSheetName,
  screenEvent,
} = require("./connpass_crawler");

const DEFAULT_SOURCE_SHEET = "Peatix検索キーワード_過去参加ベース";
const DEFAULT_INSERT_AFTER_TITLE = "クローリング結果→";

function usage() {
  return `Usage:
  node scripts/connpass_keyword_refinement.js --start YYYY-MM-DD --end YYYY-MM-DD [options]

Options:
  --source-sheet TITLE    Keyword source sheet. Default: ${DEFAULT_SOURCE_SHEET}
  --target-sheet TITLE    Output analysis sheet.
  --baseline-sheet TITLE  Existing connpass result sheet used to count incremental results.
  --priority VALUE        高, 中, or all. Default: 高.
  --pages N              Pages per keyword. Default: 1.
  --min-target-rate N    Adopt when target rate is at least N. Default: 0.45.
  --min-target-count N   Adopt when target count is at least N. Default: 2.
  --sheet-id ID          Spreadsheet ID.
  --insert-after TITLE   Place output after this tab. Default: クローリング結果→.
  --replace-existing     Replace an existing target sheet.
  --dry-run              Print analysis without writing a sheet.
`;
}

function parseArgs(argv) {
  const args = {
    sourceSheet: DEFAULT_SOURCE_SHEET,
    priority: "高",
    pages: 1,
    minTargetRate: 0.45,
    minTargetCount: 2,
    delayMs: 350,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--replace-existing") args.replaceExisting = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = argv[++i];
      if (value == null || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      args[key] = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.start || !args.end) throw new Error("--start and --end are required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.start) || !/^\d{4}-\d{2}-\d{2}$/.test(args.end)) {
    throw new Error("--start and --end must be YYYY-MM-DD");
  }
  args.pages = positiveInt(args.pages, "pages");
  args.minTargetRate = positiveNumber(args.minTargetRate, "min-target-rate");
  args.minTargetCount = positiveInt(args.minTargetCount, "min-target-count");
  return args;
}

function positiveInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`--${name} must be positive`);
  return number;
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`--${name} must be positive`);
  return number;
}

async function googleSheets(args) {
  const { google } = require("googleapis");
  const auth = new google.auth.GoogleAuth({
    keyFile: args.googleKeyFile || DEFAULT_GOOGLE_KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function readSheet(sheets, spreadsheetId, title) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteSheetName(title)}!A:Z`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  return res.data.values || [];
}

async function readKeywords(sheets, spreadsheetId, args) {
  const values = await readSheet(sheets, spreadsheetId, args.sourceSheet);
  if (values.length < 2) throw new Error(`No keyword rows in ${args.sourceSheet}`);
  const header = values[0];
  const keywordIndex = header.indexOf("キーワード");
  const priorityIndex = header.indexOf("優先度");
  const purposeIndex = header.indexOf("用途");
  const exampleIndex = header.indexOf("元イベント例");
  if (keywordIndex < 0 || priorityIndex < 0) {
    throw new Error(`${args.sourceSheet} must include キーワード and 優先度 columns`);
  }
  return values
    .slice(1)
    .map((row) => ({
      keyword: String(row[keywordIndex] || "").trim(),
      priority: String(row[priorityIndex] || "").trim(),
      purpose: String(row[purposeIndex] || "").trim(),
      example: String(row[exampleIndex] || "").trim(),
    }))
    .filter((row) => row.keyword)
    .filter((row) => args.priority === "all" || row.priority === args.priority);
}

async function baselineIds(sheets, spreadsheetId, title) {
  if (!title) return new Set();
  const values = await readSheet(sheets, spreadsheetId, title);
  if (values.length < 2) return new Set();
  const header = values[0];
  const idIndex = header.indexOf("イベントID");
  const urlIndex = header.indexOf("URL");
  return new Set(
    values.slice(1).map((row) => String(row[idIndex] || row[urlIndex] || "").trim()).filter(Boolean)
  );
}

async function analyzeKeywords(keywords, masters, baseline, args) {
  const rows = [];
  const adopted = [];
  const excludedCandidates = [];
  for (const keywordRow of keywords) {
    const result = await crawl({
      url: DEFAULT_SEARCH_URL,
      start: args.start,
      end: args.end,
      pages: args.pages,
      keyword: keywordRow.keyword,
      delayMs: args.delayMs,
      details: false,
    });
    const screened = result.events.map((event) => ({ event, screening: screenEvent(event, masters) }));
    const counts = countByDecision(screened);
    const targetRate = result.count ? counts.target / result.count : 0;
    const newRows = screened.filter(({ event }) => !baseline.has(String(event.id)));
    const newTargetRows = newRows.filter(({ screening }) => screening.decision === "対象");
    const sampleTargets = screened
      .filter(({ screening }) => screening.decision === "対象")
      .slice(0, 3)
      .map(({ event }) => event.name)
      .join(" / ");
    const recommendation = recommend(counts, result.count, targetRate, args);
    if (recommendation === "採用") adopted.push(keywordRow.keyword);
    if (recommendation === "除外候補") excludedCandidates.push(keywordRow.keyword);
    rows.push({
      recommendation,
      keyword: keywordRow.keyword,
      sourcePriority: keywordRow.priority,
      target: counts.target,
      review: counts.review,
      excluded: counts.excluded,
      total: result.count,
      targetRate,
      newTarget: newTargetRows.length,
      newTotal: newRows.length,
      sampleTargets,
      purpose: keywordRow.purpose,
      example: keywordRow.example,
      memo: memoFor(recommendation, counts, result.count, targetRate),
    });
  }
  rows.sort((a, b) => {
    const rank = { 採用: 0, 保留: 1, 除外候補: 2 };
    return (
      rank[a.recommendation] - rank[b.recommendation] ||
      b.newTarget - a.newTarget ||
      b.target - a.target ||
      b.targetRate - a.targetRate
    );
  });
  return { rows, adopted, excludedCandidates };
}

function countByDecision(screened) {
  const counts = { target: 0, review: 0, excluded: 0 };
  for (const { screening } of screened) {
    if (screening.decision === "対象") counts.target++;
    else if (screening.decision === "要確認") counts.review++;
    else counts.excluded++;
  }
  return counts;
}

function recommend(counts, total, targetRate, args) {
  if (counts.target >= args.minTargetCount && targetRate >= args.minTargetRate) return "採用";
  if (counts.target > 0 && targetRate >= 0.25) return "保留";
  if (counts.excluded >= Math.max(4, counts.target + counts.review)) return "除外候補";
  return "保留";
}

function memoFor(recommendation, counts, total, targetRate) {
  if (recommendation === "採用") return `対象率${formatPercent(targetRate)}、対象${counts.target}/${total}で継続候補`;
  if (recommendation === "除外候補") return `除外${counts.excluded}/${total}でノイズが多い`;
  return `対象${counts.target}/${total}、対象率${formatPercent(targetRate)}のため様子見`;
}

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function toValues(analysis, args) {
  const rows = [
    ["採用キーワードCSV", analysis.adopted.join(",")],
    ["集計条件", `${args.start}〜${args.end} / priority=${args.priority} / pages=${args.pages}`],
    [],
    [
      "採用判定",
      "キーワード",
      "元優先度",
      "対象件数",
      "要確認件数",
      "除外件数",
      "合計件数",
      "対象率",
      "新規対象件数",
      "新規合計件数",
      "代表対象イベント",
      "用途",
      "元イベント例",
      "運用メモ",
    ],
  ];
  for (const row of analysis.rows) {
    rows.push([
      row.recommendation,
      row.keyword,
      row.sourcePriority,
      row.target,
      row.review,
      row.excluded,
      row.total,
      formatPercent(row.targetRate),
      row.newTarget,
      row.newTotal,
      row.sampleTargets,
      row.purpose,
      row.example,
      row.memo,
    ]);
  }
  return rows;
}

async function writeAnalysisSheet(sheets, spreadsheetId, title, values, args) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, includeGridData: false });
  const existing = meta.data.sheets.find((sheet) => sheet.properties.title === title);
  const insertAfter = args.insertAfter || DEFAULT_INSERT_AFTER_TITLE;
  const after = meta.data.sheets.find((sheet) => sheet.properties.title === insertAfter);
  const index = after ? after.properties.index + 1 : undefined;
  let sheetId = existing?.properties.sheetId;
  if (existing && !args.replaceExisting) {
    throw new Error(`${title} already exists. Use --replace-existing to overwrite it.`);
  }
  if (existing) {
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${quoteSheetName(title)}!A:Z` });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId,
                ...(index == null ? {} : { index }),
                gridProperties: { rowCount: Math.max(values.length + 20, 80), columnCount: 14, frozenRowCount: 4 },
              },
              fields: `${index == null ? "" : "index,"}gridProperties(rowCount,columnCount,frozenRowCount)`,
            },
          },
        ],
      },
    });
  } else {
    const add = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title,
                ...(index == null ? {} : { index }),
                gridProperties: { rowCount: Math.max(values.length + 20, 80), columnCount: 14, frozenRowCount: 4 },
              },
            },
          },
        ],
      },
    });
    sheetId = add.data.replies[0].addSheet.properties.sheetId;
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteSheetName(title)}!A1:N${values.length}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 },
            cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.82, green: 0.92, blue: 0.82 } } },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 14 },
            cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.95, blue: 1 } } },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        },
        { autoResizeDimensions: { dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 14 } } },
      ],
    },
  });
  return { title, rowsWritten: values.length, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}` };
}

function sheetMonth(date) {
  const [year, month] = String(date).split("-");
  return `${year}/${month}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  const spreadsheetId = args.sheetId || DEFAULT_SPREADSHEET_ID;
  const sheets = await googleSheets(args);
  const keywords = await readKeywords(sheets, spreadsheetId, args);
  const masters = await loadScreeningMasters(sheets, spreadsheetId);
  const baseline = await baselineIds(sheets, spreadsheetId, args.baselineSheet);
  const analysis = await analyzeKeywords(keywords, masters, baseline, args);
  const values = toValues(analysis, args);
  const targetTitle = args.targetSheet || `connpassキーワード精査_${sheetMonth(args.start)}`;
  const sheet = args.dryRun ? null : await writeAnalysisSheet(sheets, spreadsheetId, targetTitle, values, args);
  console.log(
    JSON.stringify(
      {
        sheet,
        keywordCount: keywords.length,
        adoptedCount: analysis.adopted.length,
        adopted: analysis.adopted,
        excludedCandidates: analysis.excludedCandidates,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
