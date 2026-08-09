#!/usr/bin/env node

const { spawnSync } = require("child_process");

const PEATIX_URL =
  "https://peatix.com/search?type=physical&dr=2026-08-09:2026-08-10&loc=%E6%9D%B1%E4%BA%AC&lat=35.6803997&lng=139.7690174";
const CONNPASS_URL =
  "https://connpass.com/search/?q=&start_from=2026%2F09%2F01&start_to=2026%2F09%2F30&prefectures=tokyo&selectItem=tokyo&sort=";
const DEFAULT_PEATIX_KEYWORDS = [
  "AI",
  "生成AI",
  "AI活用",
  "LT会",
  "交流会",
  "懇親会",
  "コミュニティ",
  "キャリア",
  "マーケター",
  "マーケティング",
  "HR",
  "新規事業",
  "事業開発",
  "ミートアップ",
  "Meetup",
  "現地開催",
];
const DEFAULT_CONNPASS_KEYWORDS = [
  "AI",
  "生成AI",
  "AI活用",
  "LT会",
  "交流会",
  "懇親会",
  "コミュニティ",
  "キャリア",
  "若手",
  "マーケター",
  "マーケティング",
  "人事",
  "HR",
  "人と組織",
  "新規事業",
  "事業開発",
  "ミートアップ",
  "Meetup",
  "オフライン",
];

function usage() {
  return `Usage:
  node scripts/monthly_event_workflow.js [options]

Options:
  --month YYYY-MM       Target month. Default: next calendar month.
  --peatix-pages N      Peatix pages per keyword. Default: 1.
  --peatix-keywords CSV Extra Peatix keywords to merge into the base search. Defaults to the refined set.
  --no-peatix-keywords  Use only the broad Peatix search.
  --connpass-pages N    connpass pages per keyword. Default: 1.
  --connpass-keywords CSV
                         Extra connpass keywords to merge into the base search. Defaults to the refined set.
  --no-connpass-keywords
                         Use only the broad connpass search.
  --calendar-min-priority LEVEL
                         Global calendar priority threshold.
  --peatix-min-priority LEVEL
                         Peatix calendar priority threshold. Default: 中.
  --connpass-min-priority LEVEL
                         connpass calendar priority threshold. Default: 高.
  --within-km N         Peatix radius filter. Default: 50.
  --replace-existing    Replace existing monthly output sheets instead of creating suffixed tabs.
  --dry-run             Print commands without running.
  --help                Show this help.
`;
}

function parseArgs(argv) {
  const args = {
    peatixPages: 1,
    connpassPages: 1,
    withinKm: 50,
    peatixMinPriority: "中",
    connpassMinPriority: "高",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--replace-existing") args.replaceExisting = true;
    else if (arg === "--no-peatix-keywords") args.noPeatixKeywords = true;
    else if (arg === "--no-connpass-keywords") args.noConnpassKeywords = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = argv[++i];
      if (value == null || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      args[key] = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  args.peatixPages = positiveInt(args.peatixPages, "peatix-pages");
  args.connpassPages = positiveInt(args.connpassPages, "connpass-pages");
  args.withinKm = positiveNumber(args.withinKm, "within-km");
  if (args.month && !/^\d{4}-\d{2}$/.test(args.month)) throw new Error("--month must be YYYY-MM");
  return args;
}

function positiveInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`--${name} must be positive`);
  return number;
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`--${name} must be positive`);
  return number;
}

function monthRange(month) {
  const now = new Date();
  const base = month
    ? new Date(`${month}-01T00:00:00+09:00`)
    : new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const year = base.getFullYear();
  const monthIndex = base.getMonth();
  const start = new Date(year, monthIndex, 1);
  const end = new Date(year, monthIndex + 1, 0);
  return {
    start: dateOnly(start),
    end: dateOnly(end),
    labelCompact: `${year}${String(monthIndex + 1).padStart(2, "0")}`,
    labelSlash: `${year}/${monthIndex + 1}`,
    labelSlashPadded: `${year}/${String(monthIndex + 1).padStart(2, "0")}`,
  };
}

function dateOnly(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function runScript(script, args, dryRun) {
  const command = [process.execPath, script, ...args];
  if (dryRun) {
    return { dryRun: command.join(" ") };
  }
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${script} failed:\n${result.stdout}\n${result.stderr}`);
  }
  const jsonStart = result.stdout.indexOf("{");
  return JSON.parse(result.stdout.slice(jsonStart));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  const range = monthRange(args.month);
  const peatixTitle = `peatix_${range.labelSlash}`;
  const connpassTitle = `connpass_${range.labelSlashPadded}`;
  const calendarTitle = `カレンダー_${range.labelSlash}`;
  const peatixKeywords = args.noPeatixKeywords
    ? ""
    : args.peatixKeywords || DEFAULT_PEATIX_KEYWORDS.join(",");
  const connpassKeywords = args.noConnpassKeywords
    ? ""
    : args.connpassKeywords || DEFAULT_CONNPASS_KEYWORDS.join(",");

  const connpass = runScript(
    "scripts/connpass_crawler.js",
    [
      "--url",
      CONNPASS_URL,
      "--start",
      range.start,
      "--end",
      range.end,
      "--pages",
      String(args.connpassPages),
      ...(connpassKeywords ? ["--keywords", connpassKeywords] : []),
      "--details-for-targets",
      "--screen",
      "--sheet",
      "--no-file",
      "--sheet-title",
      connpassTitle,
      ...(args.replaceExisting ? ["--replace-existing"] : []),
    ],
    args.dryRun
  );

  const peatix = runScript(
    "scripts/peatix_crawler.js",
    [
      "--url",
      PEATIX_URL,
      "--start",
      range.start,
      "--end",
      range.end,
      "--pages",
      String(args.peatixPages),
      "--within-km",
      String(args.withinKm),
      ...(peatixKeywords ? ["--keywords", peatixKeywords] : []),
      "--details-for-targets",
      "--screen",
      "--sheet",
      "--no-file",
      "--sheet-title",
      peatixTitle,
      ...(args.replaceExisting ? ["--replace-existing"] : []),
    ],
    args.dryRun
  );

  const sourceTitles = args.dryRun
    ? `${peatixTitle},${connpassTitle}`
    : `${peatix.sheet.title},${connpass.sheet.title}`;
  const calendar = runScript(
    "scripts/event_calendar_sheet.js",
    [
      "--source-sheets",
      sourceTitles,
      "--target-title",
      calendarTitle,
      ...(args.calendarMinPriority ? ["--min-priority", args.calendarMinPriority] : []),
      "--peatix-min-priority",
      args.peatixMinPriority,
      "--connpass-min-priority",
      args.connpassMinPriority,
      ...(args.replaceExisting ? ["--replace-existing"] : []),
    ],
    args.dryRun
  );

  console.log(JSON.stringify({ range, peatix, connpass, calendar }, null, 2));
}

main();
