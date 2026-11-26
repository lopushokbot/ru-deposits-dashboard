// Weekly Telegram digest → Sema's DM via the shared bot (same bot and chat as airbnb-pricing-watch / defi-smm).
// Token: ~/.claude/channels/telegram/.env (TELEGRAM_BOT_TOKEN). Chat: ./.env TELEGRAM_CHAT_ID (gitignored, chmod 600).
// Usage: node scripts/notify.mjs [--dry]   (--dry prints the message instead of sending)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ROOT, DATA_PATH, readJSON, sleep, log } from "./lib.mjs";
import { highlights, positionViews, realistic, isNewMoney } from "./derive.mjs";

const URL_PAGE = "https://lopushokbot.github.io/ru-deposits-dashboard/";
const readEnv = p => Object.fromEntries((fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "").split("\n").map(x => x.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]));

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const nf = (v, max = 2) => v == null ? "—" : v.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: max });
const pct = (v, max = 2) => `${nf(v, max)}%`;
const months = m => m === 1 ? "1 мес" : `${m} мес`;
const dRu = iso => new Date(iso + "T12:00:00Z").toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });

export function buildMessage(d) {
  const bank = Object.fromEntries(d.banks.map(b => [b.id, b.name]));
  const byId = Object.fromEntries(d.products.map(p => [p.id, p]));
  const hl = d.highlights?.length ? d.highlights : highlights(d);
  const pv = d.positionViews?.length ? d.positionViews : positionViews(d);
  const bs = hl.find(h => h.kind === "savings");
  const L = [];
  L.push(`<b>Вклады и накопительные · ${dRu(d.date)}</b>`);
  L.push(`Ключевая ${pct(d.keyRate.value)} · RUSFAR ${pct(d.rusfar.value)}`);

  L.push("", "<b>Мои позиции</b>");
  const funds = [];
  for (const v of pv) {
    const pos = d.positions.find(p => p.id === v.id);
    if (v.kind === "fund") { funds.push(`${v.ticker} ${pct(v.current, 1)}`); continue; }
    const s = byId[v.productId];
    let line = `• ${esc(pos.label)} — ${pct(v.current)}`;
    if (s && v.userRate != null && v.userRate > s.rate + 0.01) line += ` (в тарифе ${esc(s.tierName)} сейчас ${pct(s.rate)})`;
    else if (s && v.userRate != null && v.userRate - v.guaranteed > 0.25) line += ` (без условий ${pct(v.guaranteed)})`;
    if (bs && bs.id !== v.productId && bs.rate - v.current >= 0.25) line += `\n   ↳ выгоднее без условий: ${esc(bank[byId[bs.id].bank])} «${esc(byId[bs.id].name)}» ${pct(bs.rate)}`;
    L.push(line);
  }
  if (funds.length) L.push(`• Фонды, за 30 дн.: ${funds.join(" · ")}`);

  L.push("", "<b>Интересное на рынке</b>");
  hl.forEach((h, i) => {
    const p = byId[h.id];
    if (!p) return;
    const tag = h.kind === "savings" ? "накопительный, без условий" : [months(h.term), isNewMoney(p) ? "новые деньги" : null, p.limits?.[h.term] || null].filter(Boolean).join(" · ");
    L.push(`${i + 1}. ${esc(bank[p.bank])} «${esc(p.name)}» — <b>${pct(h.rate)}</b> · ${esc(tag)}`);
  });

  const since = new Date(Date.parse(d.date) - 7 * 864e5).toISOString().slice(0, 10);
  const ch = (d.changes || []).filter(c => c.date > since);
  L.push("", "<b>Изменения за неделю</b>");
  if (!ch.length) L.push("Ставки не менялись.");
  else {
    // group by product, show the 4–6 month focus first
    const lines = ch.sort((a, b) => (a.term ?? 0) - (b.term ?? 0)).slice(0, 12).map(c =>
      `• ${esc(bank[c.bank])} · ${esc(c.name)}${c.term ? ` · ${months(c.term)}` : ""}: ${pct(c.from)} → ${pct(c.to)} ${c.to > c.from ? "▲" : "▼"}`);
    L.push(...lines);
    if (ch.length > 12) L.push(`…и ещё ${ch.length - 12}`);
  }

  const warn = [];
  for (const [b, s] of Object.entries(d.status || {})) {
    if (!s.ok) warn.push(`${bank[b]}: не обновилось (данные с ${s.lastOk ? dRu(s.lastOk) : "—"})`);
    else if (s.warnings?.some(w => /пора сверить/.test(w))) warn.push(`${bank[b]}: ${s.warnings.find(w => /пора сверить/.test(w))}`);
  }
  if (warn.length) L.push("", "⚠️ " + warn.map(esc).join("\n⚠️ "));
  L.push("", `<a href="${URL_PAGE}">Открыть дашборд</a>`);
  return L.join("\n");
}

async function send(text) {
  const shared = readEnv(path.join(os.homedir(), ".claude/channels/telegram/.env"));
  const local = readEnv(path.join(ROOT, ".env"));
  const token = local.TELEGRAM_BOT_TOKEN || shared.TELEGRAM_BOT_TOKEN;
  const chat = local.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error("Telegram token or TELEGRAM_CHAT_ID missing (.env)");
  let last;
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
      });
      const j = await r.json().catch(() => ({ ok: false, error_code: r.status }));
      if (j.ok) return j.result.message_id;
      const code = j.error_code || r.status;
      if (code !== 429 && code < 500) throw Object.assign(new Error(`Telegram ${code}: ${j.description || ""}`), { final: true });
      last = new Error(`Telegram ${code}`);
      if (j.parameters?.retry_after) await sleep(j.parameters.retry_after * 1000);
    } catch (e) { if (e.final) throw e; last = e; }
    await sleep(15000 * (i + 1));
  }
  throw last;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = buildMessage(readJSON(DATA_PATH));
  if (process.argv.includes("--dry")) { console.log(text); process.exit(0); }
  send(text).then(id => { log(`Telegram digest sent (message ${id})`); process.exit(0); }, e => { console.error("Telegram send failed:", e.message); process.exit(1); });
}
