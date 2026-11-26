#!/bin/zsh
# Weekly refresh of the Deposits & Savings dashboard → GitHub Pages → Telegram digest.
# Due once a week from Thursday 08:30 Dubai (scripts/schedule.mjs). launchd fires at Thu 08:30, at login and every
# hour; each tick asks schedule.mjs what is due ("update" → scrape + publish + send, "send" → retry delivery only,
# "none" → exit). Runs only 08:00–22:59 Dubai, at most 4 attempts a day.
#   FORCE_RUN=1 ./run.sh               refresh + publish now (no Telegram)
#   FORCE_RUN=1 FORCE_SEND=1 ./run.sh  refresh + publish + send now
set -u
cd "$(dirname "$0")"
mkdir -p logs
NODE=/opt/homebrew/bin/node
TODAY=$(TZ=Asia/Dubai date +%Y-%m-%d)
HOUR=$(TZ=Asia/Dubai date +%H)
LOG="logs/run-$TODAY.log"
if [ "${FORCE_RUN:-0}" = 1 ]; then
  ACTION=update
else
  if [ "$HOUR" -lt 8 ] || [ "$HOUR" -ge 23 ]; then exit 0; fi
  ACTION=$("$NODE" scripts/schedule.mjs check 2>/dev/null || echo none)
  [ "$ACTION" = none ] && exit 0
  ATTEMPTS=$(grep -c "^=== Run" "$LOG" 2>/dev/null) || true
  if [ "${ATTEMPTS:-0}" -ge 4 ]; then exit 0; fi
fi
SEND=1
if [ "${FORCE_RUN:-0}" = 1 ] && [ "${FORCE_SEND:-0}" != 1 ]; then SEND=0; fi
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
CA=certs/russian_trusted_root_ca.pem
{
  echo "=== Run $(date) — $ACTION ==="
  for i in {1..20}; do
    curl -s -m 10 --cacert $CA -o /dev/null https://iss.moex.com/iss/index.json && curl -s -m 10 -o /dev/null https://api.telegram.org && break
    echo "Network not ready ($i/20); waiting 30s."
    sleep 30
  done
  if [ "$ACTION" = update ]; then
    git pull -q --rebase --autostash || echo "git pull failed; running with local code."
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
      git pull -q --rebase --autostash && git push -q || { echo "=== Failed $(date): push ==="; exit 1; }
    fi
    "$NODE" scripts/schedule.mjs mark update
    echo "Published."
  fi
  if [ "$SEND" = 1 ]; then
    if "$NODE" scripts/notify.mjs; then
      "$NODE" scripts/schedule.mjs mark send
    else
      echo "=== Failed $(date): Telegram — retrying send only at the next hourly tick ==="
      exit 1
    fi
  fi
  echo "=== Done $(date) ==="
} >> "$LOG" 2>&1
find logs -name 'run-*.log' -mtime +90 -delete 2>/dev/null
exit 0
