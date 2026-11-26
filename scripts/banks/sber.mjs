// Сбербанк (СберПервый): sberbank.ru HTML pages and the deposit API sit behind an F5/TSPD JavaScript challenge,
// but the official premium leaflet PDF on static storage is fetchable. Its text is rasterised, so the numbers are
// read with Apple Vision OCR (bin/pdf_ocr, compiled from scripts/pdf_ocr.swift). Researched 2026-11-26.
// The OCR only re-runs when the PDF changes (ETag/sha256 cache in raw/). Two render scales; the second fills gaps.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { ROOT, getBuffer, readJSON, writeJSON, log } from "../lib.mjs";

const URLS = [
  "https://www.sberbank.ru/common/img/uploaded/sberbank1/public/SB_VIP_Leaflet_vkladi.pdf",
  "https://www.sberbank.com/common/img/uploaded/sberbank1/public/sb_vip_leaflet_vkladi.pdf",
];
const SRC = "https://www.sberbank.ru/ru/person/sberfirst/deposits";
const RAW = path.join(ROOT, "raw");
const CACHE = path.join(RAW, "sber-leaflet.json");
const OCR_BIN = path.join(ROOT, "bin/pdf_ocr");
const TIER = { tier: "premium", tierName: "СберПервый" };

const num = s => parseFloat(s.replace(",", "."));
const NUM_RE = /\b\d{1,2},\d{2}\b/g;

function cluster(items, tol = 0.007) {
  const rows = [];
  for (const o of [...items].sort((a, b) => a.y - b.y)) {
    const r = rows.find(r => Math.abs(r.y - o.y) <= tol);
    if (r) { r.items.push(o); r.y = (r.y * (r.items.length - 1) + o.y) / r.items.length; } else rows.push({ y: o.y, items: [o] });
  }
  rows.forEach(r => r.items.sort((a, b) => a.x - b.x));
  return rows;
}
function rowLabels(title, n) {
  if (/Управляй/.test(title)) return ["200k_min", "200k_max", "500k_min", "500k_max", "1m_min", "1m_max", "10m_min", "10m_max"].slice(0, n);
  if (/Ключев/.test(title)) return ["rate"];
  if (n === 4) return ["end_max", "end_min", "monthly_max", "monthly_min"];
  return Array.from({ length: n }, (_, i) => `row${i + 1}`);
}
function parsePage(obs) {
  const txt = o => o.text.replace(/\s+/g, " ").trim();
  const title = obs.filter(o => /«.+»/.test(o.text) && o.y < 0.2).sort((a, b) => a.y - b.y)[0];
  if (!title) return null;
  const titleText = txt(title), all = obs.map(txt).join(" | ");
  const eff = all.match(/[CС]\s?(\d{2}\.\d{2}\.\d{4})/);
  const promo = all.match(/Период\S*\s+действия.{0,40}?(\d{2}\.\d{2}\.\d{4}).{0,8}?(\d{2}\.\d{2}\.\d{4})/);
  const keyRate = all.match(/ключевой ставки ЦБ \((\d{1,2},\d{2})%\)/);
  const page = { page: obs[0].page, product: titleText, effective_from: eff?.[1] ?? null };
  if (promo) page.promo_period = [promo[1], promo[2]];
  if (keyRate) page.key_in_leaflet = num(keyRate[1]);
  if (/Без пополнения/.test(all)) page.variant = "без пополнения";
  if (/С пополнением/.test(all)) page.variant = "с пополнением";
  const hdr = obs.filter(o => /[мm]\s?[eе]\s?[cс]/i.test(o.text) && o.y > 0.12 && o.y < 0.45 && !/Первые|месяца/.test(o.text));
  const hr = cluster(hdr, 0.01).filter(r => r.items.length)[0];
  if (hr) {
    const terms = hr.items.flatMap(o => [...o.text.matchAll(/(\d{1,2})\s*[мm]/gi)].map(m => +m[1]));
    const stopY = Math.min(...obs.filter(o => /Минимальная сумма/.test(o.text) && o.y > hr.y).map(o => o.y), 1);
    const cells = obs.filter(o => o.y > hr.y + 0.01 && o.y < stopY && o.x > 0.15)
      .flatMap(o => (o.text.match(NUM_RE) || []).map((t, i, arr) => ({ ...o, x: o.x + (o.w * i) / arr.length, v: num(t) })));
    const rows = cluster(cells).filter(r => r.items.length >= Math.min(terms.length, 4));
    const labels = rowLabels(titleText, rows.length);
    const full = rows.filter(r => r.items.length === terms.length);
    const centres = terms.map((_, j) => full.length ? full.reduce((s, r) => s + r.items[j].x, 0) / full.length : null);
    page.table = {}; page.complete = {};
    rows.forEach((r, i) => {
      const vals = Array(terms.length).fill(null);
      if (r.items.length === terms.length || !full.length) r.items.forEach((c, j) => { if (j < vals.length) vals[j] = c.v; });
      else r.items.forEach(c => { let b = 0; centres.forEach((x, j) => { if (Math.abs(x - c.x) < Math.abs(centres[b] - c.x)) b = j; }); vals[b] = c.v; });
      const k = labels[i] ?? `row${i + 1}`;
      page.table[k] = Object.fromEntries(terms.map((t, j) => [String(t), vals[j]]));
      page.complete[k] = r.items.length === terms.length;
    });
  }
  if (/Накопительный/.test(titleText)) {
    const vals = obs.filter(o => /^(до|До)?\s*\d{1,2}(,\d{1,2})?%$/.test(txt(o)) && o.y > 0.2 && o.y < 0.25);
    page.components = vals.sort((a, b) => a.x - b.x).map(v => {
      const cap = obs.filter(o => o.y > v.y + 0.01 && o.y < v.y + 0.05 && Math.abs(o.x - v.x) < 0.06 && !/%/.test(o.text))
        .sort((a, b) => a.y - b.y).map(txt).join(" ").replace(/[\d'"?]+(?=\s|$)/g, "").trim();
      return { label: cap, value: num(txt(v).replace(/[^\d,]/g, "")) };
    });
  }
  return page;
}

function ocr(pdfPath) {
  const run = scale => Object.groupBy(JSON.parse(execFileSync(OCR_BIN, [pdfPath, "all", String(scale)], { maxBuffer: 64 << 20 }).toString()), o => o.page);
  const passes = [run(4), run(5.5)];
  return Object.keys(passes[0]).map(pg => {
    const [a, b] = passes.map(p => (p[pg] ? parsePage(p[pg]) : null));
    if (!a || !/^(Вклад|«)/.test(a.product) || /юан|дирхам|рупи/i.test(a.product)) return null;
    if (a.table && b?.table) for (const [row, cells] of Object.entries(a.table)) {
      if (!a.complete[row] && b.complete?.[row]) { a.table[row] = { ...b.table[row] }; continue; }
      for (const t of Object.keys(cells)) if (cells[t] == null && b.table[row]?.[t] != null) cells[t] = b.table[row][t];
    }
    delete a.complete;
    return a;
  }).filter(Boolean);
}

async function leaflet() {
  let pdf = null, src = null, last;
  for (const u of URLS) {
    try {
      const b = await getBuffer(u, { headers: { Accept: "application/pdf,*/*" }, timeout: 90000 });
      if (b.subarray(0, 5).toString() === "%PDF-") { pdf = b; src = u; break; }
      last = new Error(`${u}: not a PDF (${b.length} B) — WAF page?`);
    } catch (e) { last = e; }
  }
  if (!pdf) throw last;
  const sha = crypto.createHash("sha256").update(pdf).digest("hex");
  const cached = fs.existsSync(CACHE) ? readJSON(CACHE) : null;
  if (cached?.sha256 === sha) return cached;
  if (!fs.existsSync(OCR_BIN)) throw new Error("bin/pdf_ocr missing — run: swiftc -O scripts/pdf_ocr.swift -o bin/pdf_ocr");
  fs.mkdirSync(RAW, { recursive: true });
  const pdfPath = path.join(RAW, "sber-leaflet.pdf");
  fs.writeFileSync(pdfPath, pdf);
  log("Sber leaflet changed — running OCR");
  const products = ocr(pdfPath);
  const res = { sha256: sha, source: src, parsedAt: new Date().toISOString(), products };
  writeJSON(CACHE, res);
  return res;
}

const upTo12 = g => Object.fromEntries(Object.entries(g || {}).filter(([m, v]) => +m <= 12 && v != null));
const ruDate = s => s ? s.split(".").reverse().join("-") : null;
function check(grid, what) {
  const v = Object.values(grid);
  if (!v.length || v.some(x => !(x > 1 && x < 30))) throw new Error(`Sber OCR sanity check failed for ${what}: ${JSON.stringify(grid)}`);
  return grid;
}

export async function fetchSber({ refAmount = 3e6, keyRate = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const L = await leaflet();
  const P = re => L.products.filter(p => re.test(p.product));
  const out = [];
  const base = { bank: "sber", ...TIER, type: "deposit", source: SRC, leaflet: L.source };
  const live = p => !p.promo_period || ruDate(p.promo_period[1]) >= today;

  const best = P(/Лучший % Премиум/).filter(live)[0];
  if (best) out.push({ ...base, name: "Лучший % Премиум", variant: "Новые деньги", rates: check(upTo12(best.table.end_max), "Лучший %"),
    baseRates: upTo12(best.table.end_min), monthlyRates: upTo12(best.table.monthly_max), payout: "end", topup: "нет", withdraw: "только проценты", minAmount: 100000,
    note: "Повышенная ставка — на «новые деньги» (не были в Сбере последние 2 мес.); иначе на 1,5 п.п. ниже. С ежемесячной выплатой чуть ниже",
    effectiveFrom: ruDate(best.effective_from) });

  for (const p of P(/СберВклад Премиум/).filter(live)) {
    const topup = p.variant === "с пополнением";
    out.push({ ...base, name: "СберВклад Премиум", variant: topup ? "С пополнением" : "Без пополнения", rates: check(upTo12(p.table.end_max), "СберВклад"),
      baseRates: upTo12(p.table.end_min), payout: "end", topup: topup ? "да" : "нет", withdraw: "нет", minAmount: 100000, upTo: true,
      note: "Ставка «до»: включает надбавку за уровень Премиального обслуживания (до +1,7 п.п.); без надбавок — нижняя строка листовки",
      effectiveFrom: ruDate(p.effective_from) });
  }

  const mng = P(/Управляй Премиум/)[0];
  if (mng) {
    const tiers = [["10m", 1e7], ["1m", 1e6], ["500k", 5e5], ["200k", 2e5]];
    const [k] = tiers.find(([, a]) => a <= refAmount) || tiers.at(-1);
    out.push({ ...base, name: "Управляй Премиум", variant: "Пополнение и снятие", rates: check(upTo12(mng.table[`${k}_max`]), "Управляй"),
      payout: "end", topup: "да", withdraw: "до неснижаемого остатка", minAmount: 30000, upTo: true, effectiveFrom: ruDate(mng.effective_from) });
  }

  const key = P(/Ключевой Лидер/)[0];
  if (key?.table?.rate) {
    const g = upTo12(key.table.rate);
    const spread = key.key_in_leaflet ? Object.values(g)[0] - key.key_in_leaflet : -0.5;
    const r = keyRate != null ? Math.round((keyRate + spread) * 100) / 100 : Object.values(g)[0];
    out.push({ ...base, name: "Ключевой Лидер", variant: "Плавающая ставка", rates: Object.fromEntries(Object.keys(g).map(m => [m, r])),
      payout: "monthly", topup: "нет", withdraw: "нет", minAmount: 100000, floating: true,
      note: `Ставка = ключевая ${spread >= 0 ? "+" : "−"} ${Math.abs(spread).toLocaleString("ru-RU")} п.п., пересматривается при каждом решении ЦБ`, effectiveFrom: ruDate(key.effective_from) });
  }

  const sa = P(/Накопительный сч/)[0];
  if (sa?.components?.length) {
    const c = re => sa.components.find(x => re.test(x.label))?.value ?? null;
    const b = c(/Базов/), pkg = c(/СберПерв|пакет/i), card = c(/покуп|карт/i), inv = c(/инвест/i), wel = c(/Привет/i);
    if (!(b > 1 && b < 30)) throw new Error("Sber savings: base rate not parsed");
    const guaranteed = Math.round((b + (pkg || 0)) * 100) / 100;
    const max = Math.round((b + (pkg || 0) + (card || 0) + (inv || 0)) * 100) / 100;
    out.push({ bank: "sber", ...TIER, type: "savings", name: "Накопительный счёт Премиум", rate: Math.max(max, b + (wel || 0)), guaranteed,
      promoRate: wel ? Math.round((b + wel) * 100) / 100 : null, promoMonths: wel ? 2 : null,
      accrual: "на минимальный ежедневный остаток, выплата ежемесячно", capitalization: "monthly",
      conditions: `${b}% база + ${pkg}% за СберПервый = ${guaranteed}% без условий. До ${max}%: +${card}% за покупки картами от 100 тыс. ₽/мес и +${inv}% за инвестиции от 5 млн ₽. Первые 2 мес. — ${b + (wel || 0)}% для новых счетов`,
      source: SRC, leaflet: L.source, effectiveFrom: ruDate(sa.effective_from) });
  }
  if (!out.length) throw new Error("Sber leaflet: no products parsed");
  return { products: out, meta: { leafletSha: L.sha256, parsedAt: L.parsedAt } };
}
