#!/usr/bin/env bash
set -euo pipefail

cd /root/projects/event-calendar-automation

export TZ=Asia/Tokyo
export GOOGLE_APPLICATION_CREDENTIALS="${GOOGLE_APPLICATION_CREDENTIALS:-/root/.config/openclaw/secrets/google-sheets-service-account.json}"

mkdir -p logs

echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] monthly event calendar job start"
npm run events:monthly -- --replace-existing
echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] monthly event calendar job done"
