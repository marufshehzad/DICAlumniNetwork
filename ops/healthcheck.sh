#!/usr/bin/env bash
# ============================================================
# DIC ALUMNI PLATFORM — health probe and alert path
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
#    whether the off-site copy happened, and whether a scheduled job is failing
#    or has stopped running:
#
#       */5 * * * *  /srv/dic-alumni/ops/healthcheck.sh
#
# ALERTING. Set ALERT_CMD and this script calls it whenever the result is not
# healthy. It is provider-agnostic, like OFFSITE_CMD: {severity} becomes DOWN
# or DEGRADED and {message} the one-line reason. Configure whatever DIC
# actually uses —
#
#   ALERT_CMD='curl -sS -X POST -H "Content-type: application/json" \
#              --data "{\"text\":\"DIC alumni {severity}: {message}\"}" "$SLACK_WEBHOOK"'
#   ALERT_CMD='mail -s "DIC alumni {severity}" oncall@dic.edu.bd <<< "{message}"'
#   ALERT_CMD='/usr/local/bin/page-oncall {severity} "{message}"'
#
# With ALERT_CMD unset the script still exits non-zero, so the classic
# `... || /usr/local/bin/alert-oncall` in a crontab line works unchanged.
#
# Exit codes: 0 healthy · 1 application or database down · 2 degraded
# (backup stale, off-site failing, or a job failing) — worth waking someone in
# the morning, not at 3am.
# ============================================================
set -uo pipefail

APP_URL="${APP_URL:-http://localhost:8000}"
BACKUP_DIR="${BACKUP_DIR:-/srv/dic-alumni/backups}"
MAX_BACKUP_AGE_HOURS="${MAX_BACKUP_AGE_HOURS:-36}"
ALERT_CMD="${ALERT_CMD:-}"

problems=0
degraded=0
reasons=""
say() { echo "$(date -Is) $*"; }
note() { reasons="${reasons:+$reasons; }$1"; }

# ── application and database ────────────────────────────────
body=$(curl -sS --max-time 10 -w '\n%{http_code}' "$APP_URL/api/health" 2>/dev/null) || body=$'\n000'
code=$(printf '%s' "$body" | tail -n1)
payload=$(printf '%s' "$body" | sed '$d')

case "$code" in
  200) say "health: ok  $payload" ;;
  503) say "health: DATABASE UNREACHABLE  $payload"; problems=1; note "database unreachable" ;;
  000) say "health: NO RESPONSE from $APP_URL — application is down"; problems=1
       note "application not responding" ;;
  *)   say "health: unexpected http=$code  $payload"; problems=1; note "unexpected http $code" ;;
esac

# ── operational health, which an HTTP probe cannot see ──────
# /api/health returns 200 while the purge has been failing for a fortnight and
# the backups stopped a week ago. The monitor endpoint answers that, and takes
# the scheduler credential rather than an administrator session so a script can
# hold it. Skipped when CRON_SECRET is not in the environment.
if [ -n "${CRON_SECRET:-}" ] && [ "$code" = "200" ]; then
  mbody=$(curl -sS --max-time 15 -w '\n%{http_code}' \
          -H "X-Cron-Key: $CRON_SECRET" "$APP_URL/api/internal/monitor" 2>/dev/null) || mbody=$'\n000'
  mcode=$(printf '%s' "$mbody" | tail -n1)
  mpayload=$(printf '%s' "$mbody" | sed '$d')
  case "$mcode" in
    200) say "monitor: ok" ;;
    503) # Pull the problems array out without needing jq.
         probs=$(printf '%s' "$mpayload" | sed -n 's/.*"problems":\[\([^]]*\)\].*/\1/p' | tr -d '"')
         say "monitor: DEGRADED — ${probs:-see $APP_URL/api/internal/monitor}"
         degraded=1; note "${probs:-operational degradation}" ;;
    401) say "monitor: credential rejected — CRON_SECRET does not match the application"
         degraded=1; note "monitor credential rejected" ;;
    *)   say "monitor: unexpected http=$mcode"; degraded=1; note "monitor http $mcode" ;;
  esac
elif [ "$code" != "200" ]; then
  say "monitor: skipped — the application is not answering, so there is nothing to ask"
else
  say "monitor: skipped (CRON_SECRET not set in this environment)"
fi

# ── last night's backup ─────────────────────────────────────
# Checked from the receipt backup.js leaves, so a backup that failed loudly and
# a backup that never ran are both visible. Kept here as well as in the monitor
# endpoint, because this check still works when the application is down.
receipt="$BACKUP_DIR/last-backup.json"
if [ ! -f "$receipt" ]; then
  say "backup: NO RECEIPT at $receipt — has the backup ever run?"
  degraded=1; note "no backup receipt"
else
  status=$(grep -o '"status"[^,]*' "$receipt" | head -1 | cut -d'"' -f4)
  age_s=$(( $(date +%s) - $(date -r "$receipt" +%s) ))
  age_h=$(( age_s / 3600 ))
  if [ "$status" != "ok" ]; then
    say "backup: LAST RUN FAILED (status=$status)"; degraded=1; note "last backup failed"
  elif [ "$age_h" -gt "$MAX_BACKUP_AGE_HOURS" ]; then
    say "backup: STALE — ${age_h}h old, limit ${MAX_BACKUP_AGE_HOURS}h"
    degraded=1; note "backup ${age_h}h old"
  else
    say "backup: ok — ${age_h}h old"
  fi
fi

# ── the off-site copy ───────────────────────────────────────
offsite="$BACKUP_DIR/last-offsite.json"
if [ -f "$offsite" ]; then
  ostatus=$(grep -o '"status"[^,]*' "$offsite" | head -1 | cut -d'"' -f4)
  case "$ostatus" in
    ok)              say "offsite: ok" ;;
    not-configured)  say "offsite: not configured — this deployment keeps one copy of its data" ;;
    *)               say "offsite: LAST COPY FAILED (status=$ostatus)"
                     degraded=1; note "off-site copy failed" ;;
  esac
fi

# ── raise it ────────────────────────────────────────────────
alert() {
  local severity="$1" message="$2"
  say "ALERT $severity: $message"
  if [ -n "$ALERT_CMD" ]; then
    # Substituted, then run through the shell — this is operator-written
    # configuration, like a crontab line. Nothing from a request reaches it.
    local cmd="${ALERT_CMD//\{severity\}/$severity}"
    cmd="${cmd//\{message\}/$message}"
    if sh -c "$cmd"; then say "alert delivered"
    else say "ALERT DELIVERY FAILED — the alert path itself is broken"; fi
  else
    say "no ALERT_CMD configured — relying on this script's exit code"
  fi
}

if [ "$problems" -ne 0 ]; then
  say "RESULT: DOWN"
  alert "DOWN" "$reasons"
  exit 1
fi
if [ "$degraded" -ne 0 ]; then
  say "RESULT: DEGRADED"
  alert "DEGRADED" "$reasons"
  exit 2
fi
say "RESULT: healthy"
exit 0
