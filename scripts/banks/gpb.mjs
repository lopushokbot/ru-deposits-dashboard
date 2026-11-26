// Газпромбанк: the site's own JSON backend (same data the Next.js SSR embeds). Researched 2026-11-26.
//   deposits: /rest/page/personal/increase/deposits/detail/?id=<id>&cityId=617 → calculators[].data[] {term, rates.default.base, rates.increase.base}
//   content:  /api/v1/gazprombank/content/?url=<path>  (listing, savings accounts, HTML rate tables)
// No separate Премиум rate card: the premium perk is +3 п.п. on «В Плюсе» (Газпром Бонус «Премиум» + опция «Накопления»).
// Deposit ids are re-read from the listing every run (they change on relaunch). Invite-only offers are skipped.
import { getJSON, getText } from "../lib.mjs";
import { daysToMonths } from "./psb.mjs";

const HOST = "https://www.gazprombank.ru";
const CITY = 617;
const H = { Accept: "application/json" };
const TIER = { tier: "premium", tierName: "Премиум" };
const clean = s => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
const num = v => (v == null || v === "" ? null : parseFloat(String(v).replace(",", ".").replace("%", "")));

async function nextData(path) {
  const html = await getText(HOST + path, { headers: { Accept: "text/html" }, timeout: 60000 });
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no __NEXT_DATA__ in " + path);
  return JSON.parse(m[1]).props.initialProps.pageProps;
}
const content = async path => { try { return await getJSON(`${HOST}/api/v1/gazprombank/content/?url=${encodeURIComponent(path)}`, { headers: H }); } catch { return nextData(path); } };
const deposit = async id => { try { return await getJSON(`${HOST}/rest/page/personal/increase/deposits/detail/?id=${id}&cityId=${CITY}`, { headers: H }); } catch { return nextData(`/personal/increase/deposits/detail/${id}/`); } };

function walk(o, fn, ctx = []) {
  if (Array.isArray(o)) return o.forEach(x => walk(x, fn, ctx));
  if (!o || typeof o !== "object") return;
  if (Array.isArray(o.tabs)) { for (const t of o.tabs) walk(t.blocks, fn, [...ctx, t.title].filter(Boolean)); return; }
  fn(o, ctx);
  Object.values(o).forEach(v => walk(v, fn, ctx));
}
const rowsOf = html => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(tr => [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(td => clean(td[1]))).filter(r => r.some(Boolean));
function tables(page) {
  const out = [];
  walk(page.blocks, (o, ctx) => {
    if (o.code === "rate_table_switcher") for (const t of o.block?.tables || []) out.push({ ctx: ctx.join(" / "), channel: t.code, rows: rowsOf(t.content || "") });
    else if (o.code === "tab_content" && /<table/i.test(o.block?.content || "")) out.push({ ctx: ctx.join(" / "), channel: null, rows: rowsOf(o.block.content) });
  });
  return out;
}
function calc(page) {
  const out = [];
  walk(page.blocks, o => {
    if (Array.isArray(o.calculators)) for (const c of o.calculators) for (const r of c.data || [])
      out.push({ ch: r.channelId, cur: r.currency, term: r.term, sumMin: r.sumMin, base: num(r.rates?.default?.base), inc: num(r.rates?.increase?.base), surcharge: (c.discounts || []).map(d => `${d.label} +${d.value}`).join("; ") });
  });
  return out;
}
function grid(rows, key) {
  const ch = rows.some(r => r.ch === 1) ? 1 : rows[0]?.ch; // 1 = app
  const g = {};
  for (const r of rows.filter(r => r.ch === ch && r.term <= 400 && (!r.cur || /RUB|RUR|643/.test(String(r.cur?.code ?? r.cur))))) if (r[key] != null) g[String(daysToMonths(r.term))] = r[key];
  return g;
}

export async function fetchGpb({ keyRate = null } = {}) {
  const out = [], errors = [];
  const ids = {};
  try {
    walk((await content("/personal/increase/deposits/")).blocks, o => {
      if (o.code === "productListing") for (const it of o.block?.items || []) { const m = (it.buttons?.sub?.href || "").match(/detail\/(\d+)/); if (m) ids[clean(it.title).replace(/^Вклад\s*/, "").replace(/[«»"]/g, "")] = +m[1]; }
    });
  } catch (e) { errors.push("listing: " + e.message); }
  const id = (name, fallback) => ids[name] ?? fallback;
  const base = { bank: "gpb", ...TIER, type: "deposit", payout: "end", topup: "нет", withdraw: "нет", minAmount: 15000 };

  const D = [
    { name: "В Плюсе", id: id("В Плюсе", 7476877), key: "inc", variant: "С Газпром Бонус «Премиум»", baseKey: "base",
      note: "+3 п.п. к ставке при подключённом Газпром Бонус «Премиум» и опции «Накопления» (100 ₽/мес) — или при остатке от 500 тыс. ₽ на накопительных счетах. Проверяется 1-го числа каждого месяца" },
    { name: "Новые деньги", id: id("Новые деньги", 7582023), key: "inc", variant: "Новые деньги", baseKey: "base",
      note: "+3 п.п. только на сумму сверх остатка в ГПБ 30 дней назад, до 10 млн ₽" },
    { name: "Копить", id: id("Копить", 2491), key: "base", variant: "Онлайн, без условий", note: "+0,2 п.п. для новых, зарплатных и пенсионных клиентов" },
  ];
  for (const d of D) {
    try {
      const rows = calc(await deposit(d.id));
      const rates = grid(rows, d.key);
      if (!Object.keys(rates).length) throw new Error("empty calculator grid");
      out.push({ ...base, name: d.name, variant: d.variant, rates, baseRates: d.baseKey ? grid(rows, d.baseKey) : null, note: d.note, source: `${HOST}/personal/increase/deposits/detail/${d.id}/` });
    } catch (e) { errors.push(`${d.name}: ${e.message}`); }
  }

  // Ключевой момент — floating: key rate + fixed spread per term (HTML table of spreads)
  try {
    const kid = id("Ключевой момент", 7937943);
    const ts = tables(await deposit(kid));
    const hdr = ts.find(t => t.rows[0]?.some(c => /дн/.test(c)) && t.rows[1]?.some(c => /^[-−]?\d+([.,]\d+)?%$/.test(c) && /^[-−]/.test(c)));
    const abs = ts.find(t => t.rows[0]?.some(c => /дн/.test(c)) && t !== hdr);
    const terms = (hdr || abs).rows[0].slice(1).map(c => parseInt(c));
    const rates = {}, spreads = {};
    terms.forEach((t, i) => {
      if (t > 400) return;
      const m = String(daysToMonths(t));
      const sp = hdr ? num(hdr.rows[1][i + 1].replace("−", "-")) : null;
      spreads[m] = sp;
      rates[m] = keyRate != null && sp != null ? Math.round((keyRate + sp) * 100) / 100 : num(abs.rows[1][i + 1]);
    });
    out.push({ ...base, name: "Ключевой момент", variant: "Плавающая ставка", rates, spreads, floating: true, minAmount: 100000,
      note: "Ставка = ключевая ставка ЦБ + фиксированная надбавка (по сроку), пересчитывается при каждом изменении ключевой", source: `${HOST}/personal/increase/deposits/detail/${kid}/` });
  } catch (e) { errors.push("Ключевой момент: " + e.message); }

  // ГПБ-счёт — pick the rate table for accounts opened today (tabs "Счет открыт с DD.MM.YYYY [по DD.MM.YYYY]")
  try {
    const p = "/accounts/nakopitelnyj-schet/";
    const ts = tables(await content(p)).filter(t => t.rows.some(r => /минимальный остаток/i.test(r[0])));
    const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
    const iso = s => s.split(".").reverse().join("-");
    const dated = ts.map(t => { const m = t.ctx.match(/с (\d\d\.\d\d\.\d{4})(?: по (\d\d\.\d\d\.\d{4}))?/); return { t, from: m ? iso(m[1]) : "0000", to: m?.[2] ? iso(m[2]) : "9999" }; })
      .filter(x => x.from <= today && x.to >= today).sort((a, b) => b.from.localeCompare(a.from));
    const t = (dated[0] || { t: ts[0] }).t;
    const minRow = t.rows.find(r => /минимальный/i.test(r[0])), dayRow = t.rows.find(r => /ежедневный/i.test(r[0]));
    const upcoming = ts.map(x => x.ctx.match(/с (\d\d\.\d\d\.\d{4})/)?.[1]).filter(Boolean).map(iso).filter(d => d > today).sort()[0];
    out.push({ bank: "gpb", ...TIER, type: "savings", name: "ГПБ-счёт", rate: num(minRow[1]), guaranteed: num(minRow[2]), promoRate: num(minRow[1]), promoMonths: 2,
      altRate: dayRow ? num(dayRow[2]) : null, accrual: "на минимальный остаток (на ежедневный — ниже)", capitalization: "monthly",
      conditions: `${num(minRow[1])}% первые 2 мес. на сумму до 10 млн ₽, если 90 дней не было вкладов/счетов в ГПБ; далее ${num(minRow[2])}%. На ежедневный остаток: ${dayRow ? `${num(dayRow[1])}% → ${num(dayRow[2])}%` : "—"}`,
      upcoming: upcoming ? `Новые ставки для счетов, открытых с ${upcoming.split("-").reverse().join(".")}` : null, source: HOST + p });
  } catch (e) { errors.push("ГПБ-счёт: " + e.message); }
  return { products: out, errors, catalog: Object.keys(ids) };
}
