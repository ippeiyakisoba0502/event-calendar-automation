# CRON-RUNBOOK

OpenClaw cron / scheduled task の復元・継承用メモ。

## Job: Monthly event participation calendar

### Purpose

毎月20日 09:00 JST に、翌月の Peatix / connpass イベントを収集・精査し、Google Sheets のイベント参加カレンダーを更新する。

### Helper Script

- Source: `scripts/monthly_event_calendar_job.sh`
- Manual dry-run for a fixed month:

```bash
npm run events:monthly -- --month 2026-09 --replace-existing --dry-run
```

- Manual execution for next month:

```bash
/root/projects/event-calendar-automation/scripts/monthly_event_calendar_job.sh
```

### Cron Schedule

- Current job id: `44e484db-65b7-42c5-bb4e-b6dc2a9929fc`
- Cron expression: `0 9 20 * *`
- Timezone: `Asia/Tokyo`
- Stagger: disabled via `--exact`
- Session: `isolated`
- Delivery:
  - channel: `discord`
  - destination: `channel:1532269252763975771` (`#peatixのイベント精査`)

### Creation Command

Use this command from `/root/projects/event-calendar-automation`:

```bash
PROMPT_FILE=/tmp/monthly-event-calendar-cron-prompt.txt
cat > "$PROMPT_FILE" <<'EOF'
毎月20日の翌月イベントカレンダー作成ジョブです。

やること:
1. `/root/projects/event-calendar-automation/scripts/monthly_event_calendar_job.sh` を実行する。
2. 実行結果のJSONから、作成/更新された Peatix, connpass, カレンダー のシートURLと件数を要約する。
3. 余計な実装ログは出さず、このチャンネル向けに短く完了報告する。
4. 失敗した場合は、失敗箇所とエラーメッセージを短く報告する。

重要:
- 対象月はスクリプト側で「翌月」にする。
- Google Calendarへの出力はしない。
- 詳細ページ取得は `--details-for-targets` の二段階取得を使う。
- 出力シートは `--replace-existing` で同月タブを更新する。
EOF

openclaw cron add \
  --name "Monthly event participation calendar" \
  --description "Every month on the 20th at 09:00 JST, crawl next-month Peatix/connpass events and update Google Sheets calendar." \
  --cron "0 9 20 * *" \
  --tz "Asia/Tokyo" \
  --exact \
  --session isolated \
  --message "$(cat "$PROMPT_FILE")" \
  --tools exec \
  --timeout-seconds 2400 \
  --announce \
  --channel discord \
  --to "channel:1532269252763975771" \
  --json
```

### Verification

```bash
openclaw cron list
openclaw cron get 44e484db-65b7-42c5-bb4e-b6dc2a9929fc
```
