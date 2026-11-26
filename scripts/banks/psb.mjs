// ПСБ: product pages are Angular SSR with <script id="serverApp-state"> whose keys are base64 backend URLs;
// "/back/api/v1/content/tableData?id=…" entries hold the rate grids. Researched 2026-11-26.
// Orange Premium Club has no separate deposit rate card — OPC clients get the public rates
// (OPC perk: «Акцент на процент» bonus on up to 3 mln ₽ instead of 1.5 mln). A browser UA is required (WAF 403s "node"/"curl").
import { getText, sleep } from "../lib.mjs";

const BASE = "https://www.psbank.ru";
const TIER = { tier: "premium", tierName: "Orange Premium Club" };

const strip = s => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
const num = s => { const m = strip(s).replace(/\s/g, "").match(/^(\d{1,2}(?:[.,]\d{1,2})?)%?$/); return m ? +m[1].replace(",", ".") : null; };
const termDays = s => { const m = strip(s).match(/^(\d{2,4})\s*(дн|день|дня|дней)/i); return m ? +m[1] : null; };
export const daysToMonths = d => Math.max(1, Math.round(d / 30.42));
const amountOf = s => { // "От 3 млн. ₽" / "От 3 000 000 ₽" / "От 50 тыс. ₽" → number
  const t = strip(s).toLowerCase().replace(/\s(?=\d{3}\b)/g, "");
  const m = t.match(/от\s*([\d.,]+)\s*(млн|тыс)?/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(",", "."));
  return m[2] === "млн" ? v * 1e6 : m[2] === "тыс" ? v * 1e3 : v;
};

function state(html) {
  const m = html.match(/<script id="serverApp-state" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("serverApp-state not found (layout changed or anti-bot page)");
  const raw = m[1].replace(/&q;/g, '"').replace(/&s;/g, "'").replace(/&l;/g, "<").replace(/&g;/g, ">").replace(/&a;/g, "&");
  const byUrl = {};
  for (const [k, v] of Object.entries(JSON.parse(raw))) {
    let u = k; try { const d = Buffer.from(k, "base64").toString("utf8"); if (d.startsWith("/")) u = d; } catch {}
    byUrl[u] = v;
  }
  return byUrl;
}
function walk(o, fn) { if (o && typeof o === "object") { fn(o); for (const v of Object.values(o)) walk(v, fn); } }

async function page(path) {
  const byUrl = state(await getText(BASE + path, { tries: 4, timeout: 45000, headers: { Accept: "text/html,application/xhtml+xml" } }));
  const tabLabel = {}, tableZone = {};
  walk(byUrl, o => {
    if (o.tabItem?.tabs) for (const t of o.tabItem.tabs) tabLabel[t.zoneName] = strip(t.label);
    if (o.nodeType === "rates-container-widget" && o.details?.ratestable?.value) tableZone[o.details.ratestable.value] = o.zone;
  });
  const tables = [];
  for (const [u, v] of Object.entries(byUrl)) {
    const m = u.match(/\/content\/tableData\?id=(\d+)/);
    if (!m) continue;
    const z = tableZone[+m[1]];
    tables.push({
      id: +m[1], tab: z && tabLabel[z] ? tabLabel[z] : "",
      header: (v.headerRow?.cells || []).sort((a, b) => a.order - b.order).map(c => strip(c.content)),
      rows: (v.rows || []).sort((a, b) => a.order - b.order).map(r => r.cells.sort((a, b) => a.order - b.order).map(c => strip(c.content))),
    });
  }
  return tables;
}

/** Grid {months: rate} from a term-header table row. */
function gridOf(t, row) {
  const terms = t.header.map(termDays), n = terms.filter(Boolean).length;
  const vals = row.slice(-n), cols = terms.filter(Boolean), g = {};
  vals.forEach((v, i) => { const r = num(v); if (r != null && cols[i] <= 400) g[String(daysToMonths(cols[i]))] = r; });
  return g;
}
const pickByAmount = (items, amt, get) => items.filter(x => (get(x) ?? 0) <= amt).sort((a, b) => get(b) - get(a))[0] || items[0];

// One entry per deposit shown on the dashboard. Народный вклад (≤150k, new depositors only) is deliberately skipped.
const DEPOSITS = [
  { path: "/personal/saving/strong_bid", name: "Сильная ставка", variant: "Новые деньги", payout: "end", topup: "нет", withdraw: "нет", minAmount: 50000,
    choose: (ts, amt) => { const t = pickByAmount(ts, amt, x => amountOf(x.tab)); const hi = t.rows.find(r => /Повыш/i.test(r[0])); const lo = t.rows.find(r => /Базов/i.test(r[0])); return { t, row: hi, base: lo && gridOf(t, lo) }; },
    note: "Повышенная ставка — на «новые деньги» (прирост к максимальному остатку за 3 мес.); остальное по базовой. Один вклад на клиента, до 10 млн ₽" },
  { path: "/personal/saving/myincome", name: "Мой доход", variant: "В офисе", payout: "end", topup: "30 дней", withdraw: "нет", minAmount: 50000,
    choose: ts => { const t = ts.find(x => /Офис/i.test(x.tab)) || ts[0]; return { t, row: t.rows[0] }; },
    note: "Без условия новых денег. Онлайн на 0,2 п.п. ниже. Досрочно после 90 дней — половина ставки" },
  { path: "/personal/saving/stabilnyi-dokhod", name: "Стабильный доход", variant: "Выплата ежемесячно", payout: "monthly", topup: "нет", withdraw: "нет", minAmount: 50000,
    choose: (ts, amt) => { const t = ts[0]; return { t, row: pickByAmount(t.rows, amt, r => amountOf(r[0])) }; } },
  { path: "/personal/saving/vklad-v-pobedu", name: "Вклад в Победу", variant: "Новые деньги · акция", payout: "end", topup: "нет", withdraw: "нет", minAmount: 50000, promo: true,
    choose: ts => { const t = ts[0]; return { t, row: t.rows.find(r => /Повыш/i.test(r[0])) || t.rows[0], base: (r => r && gridOf(t, r))(t.rows.find(r => /Базов/i.test(r[0]))) }; } },
  { path: "/personal/saving/mymoneybox", name: "Моя копилка", variant: "Пополнение", payout: "monthly", capitalization: "monthly", topup: "да", withdraw: "нет", minAmount: 50000,
    choose: ts => { const t = ts[0]; return { t, row: t.rows.find(r => /договор/i.test(r.join(" "))) || t.rows[0] }; } },
  { path: "/personal/saving/mypossiblities", name: "Мои возможности", variant: "Пополнение и снятие", payout: "monthly", capitalization: "monthly", topup: "да", withdraw: "да", minAmount: 50000,
    choose: ts => { const t = ts[0]; return { t, row: t.rows.find(r => /договор/i.test(r.join(" "))) || t.rows[0] }; } },
];

export async function fetchPsb({ refAmount = 3e6 } = {}) {
  const out = [], errors = [];
  for (const d of DEPOSITS) {
    try {
      const ts = (await page(d.path)).filter(t => t.header.some(termDays));
      if (!ts.length) throw new Error("no rate table");
      const { t, row, base } = d.choose(ts, refAmount);
      const rates = gridOf(t, row);
      if (!Object.keys(rates).length) throw new Error("empty grid");
      out.push({ bank: "psb", ...TIER, type: "deposit", name: d.name, variant: d.variant, rates, baseRates: base || null,
        payout: d.payout, capitalization: d.capitalization || null, topup: d.topup, withdraw: d.withdraw, minAmount: d.minAmount,
        promo: !!d.promo, note: d.note || null, source: BASE + d.path });
    } catch (e) { errors.push(`${d.name}: ${e.message}`); }
    await sleep(700);
  }

  // Savings accounts
  const sa = async (path, fn) => { try { const r = fn(await page(path)); if (r) out.push({ bank: "psb", ...TIER, type: "savings", source: BASE + path, ...r }); } catch (e) { errors.push(`${path}: ${e.message}`); } await sleep(700); };
  await sa("/personal/savingsaccount/vektor", ts => {
    const row = ts.flatMap(t => t.rows).find(r => /\d/.test(r[1] || "") && num(r[1]) != null);
    return row && { name: "Вектор", rate: num(row[1]), altRate: num(row[2]), accrual: "на минимальный месячный остаток (на ежедневный — " + num(row[2]) + "%)", capitalization: "monthly", conditions: "без условий и лимитов" };
  });
  await sa("/personal/savingsaccount/impuls", ts => {
    const rows = ts.flatMap(t => t.rows);
    const promo = rows.find(r => /первые/i.test(r[0])), base = rows.find(r => /Базов/i.test(r[0]));
    const p = promo && num(promo[2]), b = base && num(base.at(-1));
    return p && { name: "Импульс", rate: p, baseRate: b, promoMonths: 2, newClientsOnly: true, accrual: "ежемесячно с капитализацией", capitalization: "monthly",
      conditions: `${p}% первые 2 мес. на сумму до 5 млн ₽ — только новым клиентам (без счетов и вкладов в ПСБ 180 дней), далее ${b}%` };
  });
  await sa("/personal/savingsaccount/accentpercent", ts => {
    const t = ts.find(x => x.rows.some(r => /Итогов/i.test(r[0])));
    if (!t) return null;
    const tot = t.rows.find(r => /Итогов/i.test(r[0])).slice(1).map(num).filter(v => v != null);
    return { name: "Акцент на процент", rate: Math.max(...tot), baseRate: 5, accrual: "на ежедневный остаток", capitalization: "monthly",
      conditions: `${Math.min(...tot)}–${Math.max(...tot)}% при тратах по картам ПСБ от 10 тыс. ₽ в мес. (максимум — от 250 тыс. ₽); для OPC надбавка на остаток до 3 млн ₽; без трат 5%` };
  });
  return { products: out, errors };
}
