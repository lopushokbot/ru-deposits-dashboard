// Daily orchestrator: key rate + RUSFAR + money-market funds + six banks → data.json.
// Every bank is isolated: if one fails, its previous products are kept (stale: true) and the error is shown on the page.
import fs from "node:fs";
import { DATA_PATH, CONFIG_PATH, readJSON, writeJSON, log, todayMoscow, keyRate, rusfar, moexHistory, annualised } from "./lib.mjs";
import { fetchSber } from "./banks/sber.mjs";
import { fetchVtb } from "./banks/vtb.mjs";
import { fetchTbank } from "./banks/tbank.mjs";
import { fetchAlfa } from "./banks/alfa.mjs";
import { fetchGpb } from "./banks/gpb.mjs";
import { fetchPsb } from "./banks/psb.mjs";
import { highlights, positionViews } from "./derive.mjs";

const cfg = readJSON(CONFIG_PATH);
const prev = fs.existsSync(DATA_PATH) ? readJSON(DATA_PATH) : null;
const today = todayMoscow();
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`${what}: timeout ${ms / 1000}s`)), ms).unref())]);

const slug = s => String(s || "").toLowerCase().replace(/[«»"']/g, "").replace(/[^a-zа-яё0-9]+/gi, "-").replace(/^-|-$/g, "");
const pid = p => [p.bank, p.type, slug(p.name), slug(p.variant), p.tier].filter(Boolean).join("|");

async function main() {
  log("Key rate, RUSFAR, funds…");
  const [kr, rf] = await Promise.all([keyRate(), rusfar()]);
  log(`key ${kr.value}% (since ${kr.since}), RUSFAR ${rf.value}%`);

  const funds = [];
  for (const f of cfg.funds) {
    try {
      const h = await moexHistory(f.ticker, 130);
      const last = h.at(-1);
      funds.push({ ...f, price: last.p, date: last.d, y7: annualised(h, 7)?.rate ?? null, y30: annualised(h, 30)?.rate ?? null, y90: annualised(h, 90)?.rate ?? null,
        turnover: Math.round(h.slice(-20).reduce((s, x) => s + (x.v || 0), 0) / Math.min(20, h.length)),
        spark: h.slice(-60).map(x => [x.d, x.p]) });
    } catch (e) {
      const old = prev?.funds?.find(x => x.ticker === f.ticker);
      if (old) funds.push({ ...old, stale: true, error: e.message }); else throw e;
    }
  }

  const ref = cfg.refAmount;
  const jobs = {
    sber: () => fetchSber({ refAmount: ref, keyRate: kr.value, today }),
    vtb: () => fetchVtb({ refAmount: ref, keyRate: kr.value }),
    tbank: async () => ({ products: await fetchTbank() }),
    alfa: () => fetchAlfa({ refAmount: ref, keyRate: kr.value }),
    gpb: () => fetchGpb({ keyRate: kr.value }),
    psb: () => fetchPsb({ refAmount: ref }),
  };
  const status = {};
  let products = [];
  await Promise.all(Object.entries(jobs).map(async ([bank, fn]) => {
    const t0 = Date.now();
    try {
      const r = await withTimeout(fn(), 240e3, bank);
      if (!r.products?.length) throw new Error("no products parsed");
      products.push(...r.products);
      status[bank] = { ok: true, at: new Date().toISOString(), count: r.products.length, warnings: r.errors?.length ? r.errors : undefined, lastOk: today };
      log(`${bank}: ${r.products.length} products in ${((Date.now() - t0) / 1000).toFixed(1)}s${r.errors?.length ? " — partial: " + r.errors.join("; ") : ""}`);
    } catch (e) {
      const old = (prev?.products || []).filter(p => p.bank === bank).map(p => ({ ...p, stale: true }));
      products.push(...old);
      status[bank] = { ok: false, at: new Date().toISOString(), error: String(e.message || e).slice(0, 300), lastOk: prev?.status?.[bank]?.lastOk ?? null, count: old.length };
      log(`${bank}: FAILED — ${e.message}${old.length ? ` (kept ${old.length} products from ${status[bank].lastOk})` : ""}`);
    }
  }));

  // normalise
  const order = Object.fromEntries(cfg.banks.map((b, i) => [b.id, i]));
  products = products.map(p => {
    const q = { ...p };
    if (q.type === "savings" && q.guaranteed == null) q.guaranteed = q.rate;
    if (q.type === "deposit") q.rates = Object.fromEntries(Object.entries(q.rates || {}).filter(([m, v]) => +m <= 12 && v != null).sort((a, b) => a[0] - b[0]));
    for (const k of ["conditions", "note", "accrual"]) if (typeof q[k] === "string") q[k] = q[k].replace(/(\d)\.(\d+)(?=\s?%)/g, "$1,$2"); // ru decimal comma
    q.id = pid(q);
    return q;
  }).sort((a, b) => order[a.bank] - order[b.bank] || (a.type > b.type ? 1 : -1));

  // first-seen + rate-change tracking
  const seen = { ...(prev?.seen || {}) };
  const baseline = !prev;
  for (const p of products) if (!seen[p.id]) seen[p.id] = baseline ? "baseline" : today;
  const changes = [...(prev?.changes || [])].filter(c => c.date !== today);
  if (prev) {
    const old = Object.fromEntries((prev.products || []).map(p => [p.id, p]));
    for (const p of products) {
      const o = old[p.id];
      if (!o || p.stale) continue;
      if (p.type === "deposit") for (const [m, v] of Object.entries(p.rates)) { const ov = o.rates?.[m]; if (ov != null && ov !== v) changes.push({ date: today, id: p.id, bank: p.bank, name: `${p.name} · ${p.variant}`, term: +m, from: ov, to: v }); }
      else if (o.rate !== p.rate || o.guaranteed !== p.guaranteed) changes.push({ date: today, id: p.id, bank: p.bank, name: p.name, term: null, from: o.guaranteed ?? o.rate, to: p.guaranteed ?? p.rate });
    }
  }

  const data = {
    updated: new Date().toISOString(), date: today, refAmount: ref, terms: cfg.terms, focusTerms: cfg.focusTerms,
    banks: cfg.banks, positions: cfg.positions,
    keyRate: kr, rusfar: rf, funds, products, status, seen, baselineDate: prev?.baselineDate || today,
    changes: changes.filter(c => (Date.parse(today) - Date.parse(c.date)) / 864e5 <= 45).slice(-200),
    notes: prev?.notes || [],
  };
  data.highlights = highlights(data);
  data.positionViews = positionViews(data);
  const okBanks = Object.values(status).filter(s => s.ok).length;
  if (okBanks < 3) throw new Error(`only ${okBanks}/6 banks fetched — not publishing`);
  writeJSON(DATA_PATH, data);
  log(`Wrote data.json: ${products.length} products, ${okBanks}/6 banks fresh, ${changes.filter(c => c.date === today).length} rate changes today`);
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
