# Deposits & Savings Dashboard (RU, premium tiers)

Apple-style static dashboard of deposit (≤ 12 months, focus 2–6) and savings-account rates for premium clients of Сбер, ВТБ, Т-Банк, Альфа, Газпромбанк and ПСБ, plus Sema's 5 positions and the money-market funds. Same design system as `~/ru-portfolio-dashboard`. Russian UI. Static `index.html` + `data.json`, no build step.

## Live / paths

| | |
|---|---|
| Live | https://lopushokbot.github.io/ru-deposits-dashboard/ (GitHub Pages, `main`, root) |
| GitHub | https://github.com/lopushokbot/ru-deposits-dashboard (**public**, by Sema's choice 2026-11-26; positions are names + stated rates only, no amounts) |
| Local | `/Users/iibot/ru-deposits-dashboard/` (outside ~/Documents — TCC blocks launchd there) |
| Schedule | LaunchAgent `com.lopushokbot.ru-deposits` → `run.sh`: 08:30 Dubai + hourly catch-up, one success/day |

## Files

```
index.html            page (CSS + JS); everything derived from data.json (highlights, best cells, position verdicts)
data.json             written by scripts/update.mjs; notes[] is the only hand-edited part
config.json           banks, funds, positions (user's stated rates), refAmount (3 mln ₽), terms
manual/alfa.json      Альфа rates, maintained BY HAND (see below)
scripts/lib.mjs       HTTP with system roots + Russian Trusted Root CA, MOEX ISS (funds, RUSFAR), cbr.ru key rate
scripts/banks/*.mjs   one module per bank → normalised products
scripts/pdf_ocr.swift Apple Vision OCR for the Sber leaflet (compiled to bin/pdf_ocr by run.sh; bin/ gitignored)
raw/                  Sber leaflet + OCR cache (gitignored)
```

## Sources (researched 2026-11-26)

| Bank | Tier on page | Source |
|---|---|---|
| Сбер | СберПервый | Premium leaflet PDF `SB_VIP_Leaflet_vkladi.pdf` on static storage; text is rasterised → OCR, re-run only when sha256 changes. HTML/API are behind an F5 JS challenge. |
| ВТБ | Привилегия (+ level «Изумруд») | Tariff book XLSX `t_vklady.xlsx` (zero-dep unzip/parse). Chrome UA required. |
| Т-Банк | Premium · Private | Public JSON `api/common/v1/actual_deposit_rates` + `sa_products_info`. Deposit tier bonus is 0 today → one row; split automatically if grids differ. |
| Альфа | Alfa Only (= former Премиум) | **Manual**: alfabank.ru is behind ServicePipe anti-bot and robots.txt disallows `/api/*`. Do NOT bypass. Update `manual/alfa.json` from the tariff PDFs; page flags it after 14 days. Floating «Ключевой» auto-shifts with the key rate. |
| ГПБ | Премиум (+3 п.п. «В Плюсе») | JSON backend `/rest/page/.../deposits/detail/?id=&cityId=617`, `/api/v1/gazprombank/content/?url=`; ids re-read from listing. |
| ПСБ | Orange Premium Club (no separate deposit grid) | `serverApp-state` JSON in product pages (base64 keys → `tableData`). Browser UA required. |
| Funds | SBMM, AKMM, TMON, LQDT | MOEX ISS history, annualised simple return 7/30/90 d. |

iss.moex.com switched to the Russian state CA around 2026-11-24 — the CA bundle in `certs/` is used for every request.

## Rules

- A failing bank keeps its previous products (`stale`) and shows an error; < 3 fresh banks → no publish.
- Sanity checks throw rather than publish implausible numbers (OCR, XLSX layout).
- Don't hardcode rates in index.html. Positions' stated rates live in config.json.
- Update RUNBOOK.md log after changes.
