# Event Calendar Automation

Peatix / connpass の翌月イベントを収集・精査し、Google Sheets に参加候補カレンダーを作る自動化です。

## Monthly Job

OpenClaw cron から毎月20日 09:00 JST に `scripts/monthly_event_calendar_job.sh` を実行します。

```bash
npm run events:monthly -- --replace-existing
```

固定月の dry-run:

```bash
npm run events:monthly -- --month 2026-09 --replace-existing --dry-run
```

## Environment

Google Sheets への書き込みにはサービスアカウント認証が必要です。

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/root/.config/openclaw/secrets/google-sheets-service-account.json
```

`scripts/monthly_event_calendar_job.sh` は未設定時に上記パスを既定値として使います。

## Main Scripts

- `scripts/monthly_event_workflow.js`: Peatix / connpass 収集からカレンダー作成までの月次ワークフロー
- `scripts/monthly_event_calendar_job.sh`: cron 用ラッパー
- `scripts/peatix_crawler.js`: Peatix 収集・精査・Sheets出力
- `scripts/connpass_crawler.js`: connpass 収集・精査・Sheets出力
- `scripts/event_calendar_sheet.js`: イベント参加カレンダー生成

## Docs

- `docs/event-participation-calendar-requirements.md`
- `runbooks/CRON-RUNBOOK.md`
