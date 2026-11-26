// Т-Банк: public JSON used by tbank.ru calculators (no auth). Researched 2026-11-26.
//   deposits: /api/common/v1/actual_deposit_rates → product TPDMC3.0 (СмартВклад), RUB, subsData per tier
//   savings:  /api/common/v1/sa_products_info      → RUB product, rates.{base,pro,premium,private}
// Deposit tier bonus is 0 today (all tiers identical) — rows are split per tier only when the grids differ.
import { getJSON } from "../lib.mjs";

const HOSTS = ["https://www.tbank.ru/api/common/v1/", "https://www.tinkoff.ru/api/common/v1/"];
const SRC_DEP = "https://www.tbank.ru/savings/deposit/";
const SRC_SA = "https://www.tbank.ru/savings/saving-account/";
const TIERS = { PREMIUM: "Premium", PRIVATE: "Private" };

async function call(method, q = "") {
  let last;
  for (const h of HOSTS) {
    try {
      const j = await getJSON(h + method + q, { headers: { Accept: "application/json", Referer: SRC_DEP }, timeout: 25000 });
      if (j.resultCode !== "OK" || !Array.isArray(j.payload)) throw new Error(`${method}: resultCode ${j.resultCode}`);
      return j.payload;
    } catch (e) { last = e; }
  }
  throw last;
}
const expand = arr => Object.fromEntries((arr || []).flatMap(r =>
  Array.from({ length: r.endPeriod - r.begPeriod + 1 }, (_, i) => [String(r.begPeriod + i), r.rate])));
const pick = (grid, max = 12) => Object.fromEntries(Object.entries(grid).filter(([m]) => +m <= max));

export async function fetchTbank() {
  const [dep, sa] = await Promise.all([
    call("actual_deposit_rates", "?appName=web&origin=web,ib5,platform&platform=web"),
    call("sa_products_info"),
  ]);
  const out = [];

  const prod = dep.find(p => p.product === "TPDMC3.0") || dep.find(p => /^TPD/.test(p.product));
  if (!prod) throw new Error("T-Bank: СмартВклад product not found");
  const rub = prod.currencyData.find(c => c.currency?.name === "RUB");
  const caps = (prod.capRules || []).filter(c => c.appliesTo?.currencies?.includes("RUB"));
  const grids = {};
  for (const t of Object.keys(TIERS)) {
    const s = rub.subsData.find(x => x.subs === t);
    if (s) grids[t] = { nr: pick(expand(s.increasedRateData)), r: pick(expand(s.standardRateData)) };
  }
  const same = JSON.stringify(grids.PREMIUM) === JSON.stringify(grids.PRIVATE);
  const tierRows = same ? [["premium", "Premium · Private", grids.PREMIUM]] : Object.entries(TIERS).map(([k, n]) => [k.toLowerCase(), n, grids[k]]);
  const capNote = (nr, term) => {
    const c = caps.find(c => c.appliesTo.isRateIncreased === nr && c.appliesTo.terms.includes(String(term)));
    if (!c) return null;
    return c.calculation.type === "fixed" ? `не более ${(c.calculation.amount / 1e6).toLocaleString("ru-RU")} млн ₽` : `не более ×${c.calculation.multiplier} от остатка на 30-й день`;
  };
  for (const [tier, tierName, g] of tierRows) {
    if (!g) continue;
    const limits = {};
    for (const m of Object.keys(g.nr)) { const n = capNote(true, m); if (n) limits[m] = n; }
    out.push({
      bank: "tbank", tier, tierName, type: "deposit", name: "СмартВклад", variant: "Пополнение 30 дней",
      rates: g.nr, limits, payout: "monthly", capitalization: "optional", topup: "30 дней", withdraw: "с 61-го дня, ≥15 тыс. ₽",
      minAmount: rub.minDepositSum, source: SRC_DEP,
      note: same ? "Надбавки за Premium/Private на вклады сейчас нет — ставки одинаковы для всех уровней" : null,
    });
    const r = Object.fromEntries(Object.entries(g.r).filter(([, v]) => v != null));
    if (Object.keys(r).length) out.push({
      bank: "tbank", tier, tierName, type: "deposit", name: "СмартВклад", variant: "Пополнение в любое время",
      rates: r, limits: {}, payout: "monthly", capitalization: "optional", topup: "всегда", withdraw: "с 61-го дня, ≥15 тыс. ₽",
      minAmount: rub.minDepositSum, source: SRC_DEP,
    });
  }

  const sar = sa.find(p => p.currency?.name === "RUB");
  if (!sar) throw new Error("T-Bank: RUB savings product not found");
  for (const [k, name] of Object.entries(TIERS)) {
    const v = sar.rates?.[k.toLowerCase()];
    if (v == null) continue;
    out.push({
      bank: "tbank", tier: k.toLowerCase(), tierName: name, type: "savings", name: sar.marketingName || "Накопительный счёт",
      rate: v, baseRate: sar.rates.base, accrual: "на ежедневный остаток, выплата раз в месяц", capitalization: "monthly",
      conditions: "без лимита суммы, снятие без потери процентов", source: SRC_SA,
    });
  }
  return out;
}
