#!/usr/bin/env bash
# ============================================================
# DIC ALUMNI PLATFORM — nightly operations, VPS deployment
#
# The Vercel path uses the "crons" block in vercel.json instead. Enable ONE of
# the two, never both: two schedulers pointed at the same jobs is how a system
# ends up unsure which one ran.
#
# Install (as the deploy user, not root):
#   crontab -e
#   10 2 * * *  /srv/dic-alumni/ops/cron-dic.sh >> /var/log/dic-alumni-cron.log 2>&1
#
# Times are the server's local clock. 02:10 keeps it clear of working hours.
# The order matters: back up first, so the night's backup predates the purge
# that permanently erases accounts.
#
# Required in the environment (see /srv/dic-alumni/.env):
#   APP_URL       https://alumni.<domain>
#   CRON_SECRET   the same value the application has
# ============================================================
set -uo pipefail

APP_DIR="${APP_DIR:-/srv/dic-alumni}"
cd "$APP_DIR" || { echo "$(date -Is) FATAL: $APP_DIR not found"; exit 1; }

# shellcheck disable=SC1091
set -a; [ -f .env ] && . ./.env; set +a

APP_URL="${APP_URL:-http://localhost:8000}"
log() { echo "$(date -Is) $*"; }
fail=0

# ── 1. BACKUP ───────────────────────────────────────────────
# First, and before anything destructive. A purge without a backup taken
# beforehand is unrecoverable if it turns out to have been a mistake.
log "backup: starting"
if node backup.js; then
  log "backup: ok"
else
  log "backup: FAILED — this is an incident, see OPERATIONS_RUNBOOK.md section D"
  fail=1
fi

# ── 2. OFF-SITE COPY ─────────────────────────────────
# Immediately after the backup, so the window in which the only copy of the
# institution's data lives on this one machine is as short as possible. A no-op
# when OFFSITE_CMD is unset, which it records rather than passing over in
# silence.
log "offsite: starting"
if node offsite.js; then
  log "offsite: ok"
else
  log "offsite: FAILED — the only copy is on this machine, see OPERATIONS_RUNBOOK.md section D"
  fail=1
fi

# ── 3. SCHEDULED JOBS ────────────────────────────────
# Through scheduler.js rather than over HTTP. It talks to the database
# directly, so the nightly purge still runs when the web process is down —
# which is exactly when nobody is watching. Each job is idempotent, so a retry
# after a transient failure is safe.
#
# On Vercel this file is not used at all: vercel.json's crons call the HTTP
# endpoint instead. Exactly one of the two is ever enabled — see
# OPERATIONS_RUNBOOK.md section F.
log "jobs: starting"
if node scheduler.js; then
  log "jobs: ok"
else
  log "jobs: FAILED — see OPERATIONS_RUNBOOK.md section F"
  fail=1
fi


# ── 4. WEEKLY RESTORE DRILL (Sundays) ───────────────────────
# A backup nobody has restored is a hypothesis. Once a week it gets tested
# against a disposable database.
if [ "$(date +%u)" = "7" ]; then
  log "restore drill: starting"
  if node restore.js --drill; then log "restore drill: PASSED"
  else log "restore drill: FAILED — the backups are not trustworthy"; fail=1; fi
fi

if [ "$fail" -ne 0 ]; then
  log "FINISHED WITH FAILURES — alert the operator on call"
  exit 1
fi
log "finished cleanly"
