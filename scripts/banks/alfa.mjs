// Альфа-Банк (Alfa Only — бывший «Альфа Премиум»; отдельной сетки «Премиум» больше нет).
// alfabank.ru is behind a ServicePipe anti-bot challenge and robots.txt disallows /api/* — we do NOT work around it.
// Rates are maintained by hand in manual/alfa.json from the bank's official tariff PDFs (researched 2026-11-26).
// Floating «Ключевой» is re-priced from the live key rate; the page flags the data once it is older than staleAfterDays.
import path from "node:path";
import { ROOT, readJSON } from "../lib.mjs";

export async function fetchAlfa({ keyRate = null } = {}) {
  const m = readJSON(path.join(ROOT, "manual/alfa.json"));
  const age = Math.round((Date.now() - Date.parse(m.asOf)) / 864e5);
  const products = m.products.map(p => {
    const q = { bank: "alfa", tier: m.tier, tierName: m.tierName, manual: true, asOf: m.asOf, ...p };
    if (p.floating && keyRate != null && m.keyRateAtEntry != null) {
      const d = keyRate - m.keyRateAtEntry;
      q.rates = Object.fromEntries(Object.entries(p.rates).map(([k, v]) => [k, Math.round((v + d) * 100) / 100]));
    }
    return q;
  });
  const errors = [`ручное обновление от ${m.asOf.split("-").reverse().join(".")}`];
  if (age > (m.staleAfterDays ?? 14)) errors.push(`данным ${age} дн. — пора сверить с тарифами банка`);
  return { products, errors, manual: { asOf: m.asOf, age, stale: age > (m.staleAfterDays ?? 14) } };
}
