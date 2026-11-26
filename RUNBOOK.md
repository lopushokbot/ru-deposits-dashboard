# Deposits & Savings Dashboard — Runbook

| Task | Command |
|------|---------|
| Refresh data (no publish) | `cd ~/ru-deposits-dashboard && node scripts/update.mjs` |
| Refresh + publish now | `cd ~/ru-deposits-dashboard && FORCE_RUN=1 ./run.sh; tail -30 logs/run-$(date +%F).log` |
| Refresh + publish + Telegram now | `FORCE_RUN=1 FORCE_SEND=1 ./run.sh` |
| Preview / resend digest | `node scripts/notify.mjs --dry` / `node scripts/notify.mjs` |
| What is due | `node scripts/schedule.mjs check` (update / send / none) |
| Today's log | `cat ~/ru-deposits-dashboard/logs/run-$(TZ=Asia/Dubai date +%F).log` |
| LaunchAgent status | `launchctl list \| grep ru-deposits` (2nd column = last exit code) |
| Install LaunchAgent | `cp com.lopushokbot.ru-deposits.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.lopushokbot.ru-deposits.plist` |
| Rebuild OCR helper | `swiftc -O scripts/pdf_ocr.swift -o bin/pdf_ocr` |
| Update Альфа | edit `manual/alfa.json` (rates + `asOf`), run update |

## When a bank fails

The page keeps the last good data for that bank, greys it out and names it in the header. Check the log line `<bank>: FAILED — …`:
- `HTTP 403` → WAF/User-Agent; `not a PDF/XLSX` → anti-bot page; `sanity check failed` → layout or OCR changed.
- Sber: if the leaflet moves, find the new URL on sberbank.ru/ru/person/sberfirst (manual browser) and update `URLS` in `scripts/banks/sber.mjs`.

## Log

- 2026-11-26 — Weekly schedule (Thu 08:30 Dubai) + Telegram digest to Sema's DM.
- 2026-11-26 — v1 built. Six banks, 34 products, ~20 s run. Альфа manual (anti-bot). Key rate 14%, RUSFAR 13.95%.
