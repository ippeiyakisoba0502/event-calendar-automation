# Event Participation Calendar Requirements

## Purpose

Find events where ippei can meet potential co-founders and build relationships with the target persona.

The workflow should collect next-month events from Peatix and connpass, screen them for strategic value, and create an event participation calendar ordered by priority.

## Monthly Workflow

- Run every month on the 20th.
- Collect events for the following calendar month.
- Write Peatix and connpass raw/screened results to separate Google Sheets tabs.
- Screen events using title, organizer, group, venue, address, price, and detail-page information.
- Use a two-stage crawl by default: first collect/search-list data, pre-screen it, then fetch detail pages only for rows that preliminarily look like `対象`.
- Build a participation calendar from high-priority events.

## Sources

### Peatix

Base URL:

```text
https://peatix.com/search?type=physical&dr=2026-08-09:2026-08-10&loc=%E6%9D%B1%E4%BA%AC&lat=35.6803997&lng=139.7690174
```

Date control:

- Use `dr` in the public search URL.
- Internally convert custom ranges to `dr=range&dr_from=YYYY-MM-DD&dr_to=YYYY-MM-DD`.
- Peatix's broad search ranking can miss relevant events even within the date/location range.
- Support keyword expansion so the base search can be merged with target keywords or known event IDs.
- Current refined Peatix keyword set:
  `AI,生成AI,AI活用,LT会,交流会,懇親会,コミュニティ,キャリア,マーケター,マーケティング,HR,新規事業,事業開発,ミートアップ,Meetup,現地開催`
- Hold-out keywords after the August 2026 check:
  `オフライン,人事,人と組織,若手,Lightning Talk`

### connpass

Base URL:

```text
https://connpass.com/search/?q=&start_from=2026%2F09%2F01&start_to=2026%2F09%2F30&prefectures=tokyo&selectItem=tokyo&sort=
```

Date control:

- Use `start_from=YYYY/MM/DD`.
- Use `start_to=YYYY/MM/DD`.
- Use keyword expansion with a connpass-specific keyword set because connpass search responds differently from Peatix.
- Current refined connpass keyword set:
  `AI,生成AI,AI活用,LT会,交流会,懇親会,コミュニティ,キャリア,若手,マーケター,マーケティング,人事,HR,人と組織,新規事業,事業開発,ミートアップ,Meetup,オフライン`

## Output

Spreadsheet:

```text
https://docs.google.com/spreadsheets/d/1td2ieTUl2Xkdojma-um5ZQrY4MgFBd1JdgJTBS-J0ug
```

Sheet structure:

- Peatix output and connpass output should be separate tabs.
- A calendar tab should summarize screened high-priority events.

Required columns:

- 判定
- 優先度
- 除外理由
- 精査メモ
- イベント名
- URL
- 日付
- 会場
- 住所
- 主催者
- グループ
- 価格

## Screening

Screening should fetch detail pages when useful and fill:

- `判定`: 対象 / 要確認 / 除外
- `優先度`: 最優先 / 高 / 中 / 低
- `除外理由`
- `精査メモ`

Target persona:

- 20代の普通の会社員。
- Already-founded entrepreneurs are not the target.
- 起業願望の有無は問わない。
- Prefer events where ordinary working professionals join to learn, meet people outside work, or broaden perspective.
- Topic can be broad: engineering, marketing, HR, sales, design, product, business, career, finance, legal, and other professional learning areas are all valid.

Rule direction:

- Prefer offline events with learning plus interaction: 交流会, 懇親会, Meetup, LT, コミュニティ, もくもく会, 読書会, 朝活, 勉強会, ワークショップ, 異業種交流, 越境学習.
- Require a physical venue/address. Hybrid events can remain if a real venue is available; online-only/no-venue events should be excluded.
- Prefer broad professional themes over founder-only/startup-only themes.
- Exclude or deprioritize child/family, religious/ceremony, pure viewing/performance, promo/sales-heavy, recruitment/job-hunting, online-only, founder-only, investor/VC, funding, and pitch-heavy events.
- Exclude events matching the `対象外の主催` or `対象外の会場` master tabs.
- Downgrade events matching `優先度低いワード` to `要確認` / `低`.
- Downgrade events with detected or manually confirmed participation price of 10,000 yen or more to `要確認` / `低`.
- Use the `価格手動確認` sheet for known events where the platform page does not expose a reliable machine-readable price.
- For connpass, downgrade events focused on a specific programming language, framework, or infrastructure tool to `対象` / `中` rather than `高`.
- Keep ambiguous but plausible adult/professional events as `要確認`.

## Calendar

The first safe version should create a Google Sheets calendar tab.

Sheet title format:

- `カレンダー_YYYY/M`

The calendar tab should follow the reference grid format:

- Columns: `週`, `時間帯`, `月`, `火`, `水`, `木`, `金`, `土`, `日`
- Weekly date rows followed by time-band rows.
- Time bands: `9時以前`, `9時〜12時`, `12時〜19時`, `19時〜21時`, `21時以降`
- Event cell format: `HH:MM [A/B/C] イベント名`
- Date cell format: `YYYY/MM/DD`
- Event cells should link to the event detail URL.
- Only date rows should have a gray background; regular time-band/event rows should stay white.
- High-priority event cells (`[A]`) should use red text; other priorities should use normal black text.
- Calendar output should include only events at or above the configured priority threshold.
- Current default thresholds are source-specific:
  - Peatix: `中` or higher.
  - connpass: `高` or higher.
- `低` priority rows stay in crawling result sheets but are not shown on the participation calendar.
- Copy visual formatting from reference sheet `カレンダー_2026/8` by default.

Crawling result tabs should use:

- `peatix_YYYY/M`
- `connpass_YYYY/MM`

Sheet placement:

- Calendar tabs should be inserted at the beginning of the workbook.
- Crawling result tabs should be inserted immediately after `クローリング結果→`.

Google Calendar event creation should require explicit confirmation before writing external calendar events.

## Current Implementation State

- Peatix crawler exists: `scripts/peatix_crawler.js`.
- Peatix supports JSON/CSV output, Google Sheets tab output, radius filtering, and auto-screening.
- Peatix supports `--details-for-targets` so detail pages are fetched only for preliminary target rows.
- Peatix result sheets include `検索キーワード` so false positives/false negatives can be traced back to the keyword source.
- Peatix keyword refinement exists: `scripts/peatix_keyword_refinement.js`.
- connpass crawler exists: `scripts/connpass_crawler.js`.
- connpass supports HTML search crawling, keyword expansion, optional detail-page fetching, Google Sheets tab output, and auto-screening.
- connpass supports `--details-for-targets` so detail pages are fetched only for preliminary target rows.
- connpass result sheets include `検索キーワード` so false positives/false negatives can be traced back to the keyword source.
- connpass keyword refinement exists: `scripts/connpass_keyword_refinement.js`.
- Google Sheets participation calendar generator exists: `scripts/event_calendar_sheet.js`.
- Calendar generation supports `--min-priority` to exclude low-priority events from the calendar.
- Monthly manual workflow command exists: `scripts/monthly_event_workflow.js`.
- Monthly cron helper exists: `scripts/monthly_event_calendar_job.sh`.
- Existing npm scripts:
  - `npm run peatix:crawl`
  - `npm run peatix:crawl:sheet`
  - `npm run connpass:crawl`
  - `npm run connpass:crawl:sheet`
  - `npm run connpass:keywords`
  - `npm run events:calendar`
  - `npm run events:monthly`
  - `npm run peatix:keywords`

## Next Implementation Steps

1. Inspect the refined August keyword sheet and manually mark obvious false positives/false negatives.
2. Tune screening rules based on false positives/false negatives.
3. Move screening rules and keyword sets into a shared config/module if they continue to grow.
4. Review the first scheduled run result and tune screening rules based on false positives/false negatives.
