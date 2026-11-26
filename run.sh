#!/bin/zsh
# Daily refresh of the Deposits & Savings dashboard → GitHub Pages.
# launchd fires at 08:30 Dubai, at login and every hour, so a Mac that was asleep or offline catches up:
# one successful run per day between 08:00 and 22:59 Dubai, at most 4 attempts a day. FORCE_RUN=1 skips the guards.
set -u
cd "$(dirname "$0")"
mkdir -p logs
TODAY=$(TZ=Asia/Dubai date +%Y-%m-%d)
HOUR=$(TZ=Asia/Dubai date +%H)
LOG="logs/run-$TODAY.log"
if [ "${FORCE_RUN:-0}" != 1 ]; then
  if [ "$HOUR" -lt 8 ] || [ "$HOUR" -ge 23 ]; then exit 0; fi
  if grep -q "^=== Done" "$LOG" 2>/dev/null; then exit 0; fi
  ATTEMPTS=$(grep -c "^=== Run" "$LOG" 2>/dev/null) || true
  if [ "${ATTEMPTS:-0}" -ge 4 ]; then exit 0; fi
fi
if [ -z "${RD_CAFFEINATED:-}" ]; then
  RD_CAFFEINATED=1 exec /usr/bin/caffeinate -i -s -m /bin/zsh "$PWD/run.sh" "$@"
fi
LOCK="$PWD/logs/run.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if test -f "$LOCK/pid" && kill -0 "$(cat "$LOCK/pid")" 2>/dev/null; then exit 0; fi
  rm -f "$LOCK/pid"; rmdir "$LOCK" 2>/dev/null; mkdir "$LOCK"
fi
echo $$ > "$LOCK/pid"
trap 'rm -f "$LOCK/pid"; rmdir "$LOCK" 2>/dev/null' EXIT
NODE=/opt/homebrew/bin/node
CA=certs/russian_trusted_root_ca.pem
{
  echo "=== Run $(date) ==="
  for i in {1..20}; do
    curl -s -m 10 --cacert $CA -o /dev/null https://iss.moex.com/iss/index.json && curl -s -m 10 -o /dev/null https://github.com && break
    echo "Network not ready ($i/20); waiting 30s."
    sleep 30
  done
  git pull -q --rebase --autostash || echo "git pull failed; running with local code."
  # Sber leaflet OCR helper (macOS Vision); rebuilt if missing or older than its source
  if [ ! -x bin/pdf_ocr ] || [ scripts/pdf_ocr.swift -nt bin/pdf_ocr ]; then
    mkdir -p bin && /usr/bin/swiftc -O scripts/pdf_ocr.swift -o bin/pdf_ocr || echo "pdf_ocr build failed — Sber will use cached/previous data."
  fi
  "$NODE" scripts/update.mjs
  RC=$?
  if [ $RC -ne 0 ]; then
    echo "=== Failed $(date): update.mjs exit $RC — retrying at the next hourly tick ==="
    exit 1
  fi
  git config user.name "lopushokbot"
  git config user.email "lopushokbot@users.noreply.github.com"
  git add data.json
  if git diff --cached --quiet; then
    echo "No data changes."
  else
    git commit -q -m "Data update $(TZ=Asia/Dubai date '+%Y-%m-%d %H:%M') Dubai"
    git pull -q --rebase && git push -q || { echo "=== Failed $(date): push ==="; exit 1; }
  fi
  echo "=== Done $(date) ==="
} >> "$LOG" 2>&1
find logs -name 'run-*.log' -mtime +60 -delete 2>/dev/null
exit 0
