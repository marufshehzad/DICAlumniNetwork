#!/usr/bin/env bash
# ============================================================
# DIC ALUMNI PLATFORM — health probe
#
# Two ways to use this.
#
# 1. Point an external monitor at the URL directly. This is the arrangement to
#    prefer, because a monitor running on the same box as the application
#    cannot tell you the box is unreachable. Any uptime service works; the
#    contract is simply:
#
#       GET  https://alumni.<domain>/api/health
#       200  {"status":"ok","database":"ok","latencyMs":n}   healthy
#       503  {"status":"degraded","database":"unreachable"}  database is down
#       anything else / no answer                            application is down
#
#    Alert on: two consecutive failures, at a 60-second interval.
#
# 2. Run this script from cron as a local fallback, which also checks the
#    things an HTTP probe cannot see — whether last night's backup happened,
#    and whether a scheduled job failed:
#
#       */5 * * * *  /srv/dic-alumni/ops/healthcheck.sh || /usr/local/bin/alert-oncall
#
# Exit codes: 0 healthy · 1 application or database down · 2 degraded
# (backup stale or a job failing) — worth waking someone in the morning, not
# at 3am.
# ============================================================
set -uo pipefail

APP_URL="${APP_URL:-http://localhost:8000}"
BACKUP_DIR="${BACKUP_DIR:-/srv/dic-alumni/backups}"
MAX_BACKUP_AGE_HOURS="${MAX_BACKUP_AGE_HOURS:-36}"

problems=0
degraded=0
say() { echo "$(date -Is) $*"; }

# ── application and database ────────────────────────────────
body=$(curl -sS --max-time 10 -w '\n%{http_code}' "$APP_URL/api/health" 2>/dev/null) || body=$'\n000'
code=$(printf '%s' "$body" | tail -n1)
payload=$(printf '%s' "$body" | sed '$d')

case "$code" in
  200) say "health: ok  $payload" ;;
  503) say "health: DATABASE UNREACHABLE  $payload"; problems=1 ;;
  000) say "health: NO RESPONSE from $APP_URL — application is down"; problems=1 ;;
  *)   say "health: unexpected http=$code  $payload"; problems=1 ;;
esac

# ── last night's backup ─────────────────────────────────────
# Checked from the receipt backup.js leaves, so a backup that failed loudly and
# a backup that never ran are both visible.
receipt="$BACKUP_DIR/last-backup.json"
if [ ! -f "$receipt" ]; then
  say "backup: NO RECEIPT at $receipt — has the backup ever run?"
  degraded=1
else
  status=$(grep -o '"status"[^,]*' "$receipt" | head -1 | cut -d'"' -f4)
  age_s=$(( $(date +%s) - $(date -r "$receipt" +%s) ))
  age_h=$(( age_s / 3600 ))
  if [ "$status" != "ok" ]; then
    say "backup: LAST RUN FAILED (status=$status)"; degraded=1
  elif [ "$age_h" -gt "$MAX_BACKUP_AGE_HOURS" ]; then
    say "backup: STALE — ${age_h}h old, limit ${MAX_BACKUP_AGE_HOURS}h"; degraded=1
  else
    say "backup: ok — ${age_h}h old"
  fi
fi

if [ "$problems" -ne 0 ]; then say "RESULT: DOWN"; exit 1; fi
if [ "$degraded" -ne 0 ]; then say "RESULT: DEGRADED"; exit 2; fi
say "RESULT: healthy"
exit 0
