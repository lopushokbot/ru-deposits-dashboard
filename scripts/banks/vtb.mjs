// ВТБ (Привилегия): the official tariff book XLSX («Сборник условий, тарифов и процентных ставок по депозитам»)
// holds every rate — base grid + package / «Расти с ВТБ» level / salary / «новые деньги» bonuses. Researched 2026-11-26.
// Pages are SSR and the calculator API 404s from outside; a Chrome UA is required (403 otherwise). Zero-dependency XLSX reader.
// Privilegia rate = base + package bonus + level «Изумруд» (entry level of «Расти с ВТБ» for Привилегия).
import zlib from "node:zlib";
import { getBuffer } from "../lib.mjs";

const XLSX_URL = "https://www.vtb.ru/media-files/vtb.ru/sitepages/tarify/chastnim-licam/t_vklady.xlsx";
const SRC = "https://www.vtb.ru/personal/vklady-i-scheta/";
const TIER = { tier: "premium", tierName: "Привилегия" };

// ---------- Minimal ZIP reader (central directory) ----------
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const lnlen = buf.readUInt16LE(off + 26), lxlen = buf.readUInt16LE(off + 28);
    const data = buf.subarray(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
    files[name] = () => (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    p += 46 + nlen + xlen + clen;
  }
  return files;
}

// ---------- Minimal XLSX parsing ----------
const ent = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
const norm = (s) => ent(s).replace(/\s+/g, ' ').trim();
function readWorkbook(files) {
  const shared = [...files['xl/sharedStrings.xml']().matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    norm([...m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  const rels = Object.fromEntries([...files['xl/_rels/workbook.xml.rels']().matchAll(/<Relationship [^>]*>/g)].map((m) => [m[0].match(/Id="([^"]+)"/)[1], m[0].match(/Target="([^"]+)"/)[1]]));
  const sheets = {};
  for (const m of files['xl/workbook.xml']().matchAll(/<sheet [^>]*>/g)) {
    const name = norm(m[0].match(/name="([^"]+)"/)[1]);
    const rid = m[0].match(/r:id="([^"]+)"/)[1];
    const path = 'xl/' + rels[rid].replace(/^\/?xl\//, '');
    sheets[name] = () => parseSheet(files[path](), shared);
  }
  return sheets;
}
function parseSheet(xml, shared) {
  const rows = new Map();
  for (const m of xml.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, col, row, attrs, inner] = m;
    if (!inner) continue;
    let v;
    if (/t="s"/.test(attrs)) v = shared[+inner.match(/<v>([\s\S]*?)<\/v>/)[1]];
    else if (/t="inlineStr"/.test(attrs)) v = norm([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
    else { const vm = inner.match(/<v>([\s\S]*?)<\/v>/); if (!vm) continue; v = ent(vm[1]); }
    if (v === undefined || v === '') continue;
    if (!rows.has(+row)) rows.set(+row, {});
    rows.get(+row)[col] = v;
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]);
}
const colIdx = (c) => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const pct = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10000) / 100); // fraction -> % with 2 dp
const num = (v) => { if (v == null) return NaN; const s = String(v).replace(/\s/g, ''); return /%$/.test(s) ? parseFloat(s.replace(',', '.')) / 100 : parseFloat(s.replace(',', '.')); };

// ---------- ВТБ-Вклад sheet ----------
function parseVtbVklad(rows) {
  const effective = rows.map(([, r]) => Object.values(r).find((v) => /действует с/i.test(v))).find(Boolean);
  const GROUPS = ['noTopUp', 'topUp', 'topUpWithdraw'];
  let termCols = null, groupStart = null; // col -> {group, term}
  const base = []; // {payout, channel, currency, minAmount, group, term, rate}
  const bonus = { package: {}, salaryPension: {}, vtbPlus: {}, level: {}, newDepositor: {}, newMoney: {} };
  let payout = null, channel = null, currency = null, section = null, inBonuses = false, bonusSection = null;
  for (const [, r] of rows) {
    const B = r.B || '', C = r.C || '';
    // header row with term names (e.g. F="2 мес")
    const termHeads = Object.entries(r).filter(([, v]) => /^\d+ мес$/.test(v));
    if (termHeads.length >= 6) {
      termCols = {};
      const firsts = [];
      termHeads.forEach(([c]) => { termCols[c] = null; });
      const sorted = termHeads.map(([c, v]) => [colIdx(c), c, v]).sort((a, b) => a[0] - b[0]);
      let g = -1, prev = -10;
      for (const [i, c, v] of sorted) { if (i - prev > 1) g++; prev = i; termCols[c] = { group: GROUPS[g], term: v.replace(' мес', 'm') }; }
      continue;
    }
    if (/^Надбавки \(годовых\)/.test(B)) { inBonuses = true; continue; }
    if (/^\d+$/.test(r.A || '') && +r.A >= 9 && inBonuses) break; // end of bonuses section
    if (!inBonuses) {
      if (/Ежемесячная выплата процентов/.test(C)) payout = 'monthly';
      else if (/^Выплата процентов в конце срока/.test(C)) payout = 'atMaturity';
      if (/^Офисы банка$/.test(C)) channel = 'office';
      else if (/^ВТБ Онлайн и устройства/.test(C)) channel = 'online';
      else if (/^ВТБ Онлайн и Офисы/.test(C)) channel = 'online+office';
      if (/^Рубли$/.test(C)) currency = 'RUB'; else if (/^Китайские юани$/.test(C)) currency = 'CNY';
      if (termCols && payout && channel && r.D && /^[\d\s/]+$/.test(r.D)) {
        const minAmount = parseInt(String(r.D).split('/')[0].replace(/\s/g, ''), 10);
        for (const [c, t] of Object.entries(termCols)) if (r[c] != null) base.push({ payout, channel, currency, minAmount, group: t.group, term: t.term, rate: pct(num(r[c])) });
      }
      continue;
    }
    // bonuses
    if (/^Пакет услуг\d*:/.test(B)) bonusSection = 'package';
    else if (/^Сегментные надбавки|^Пенсионер\d* и\/или Зарплатный/.test(B)) bonusSection = 'salaryPension';
    else if (/^Клиент с Подпиской ВТБ Плюс/.test(B)) bonusSection = 'vtbPlus';
    else if (/^Надбавка за Уровень/.test(B)) bonusSection = 'level';
    else if (/^Новые деньги/.test(B)) bonusSection = 'newMoney';
    if (/^Рубли$/.test(C)) currency = 'RUB'; else if (/^Китайские юани$/.test(C)) currency = 'CNY';
    let key = null, target = null;
    if (/^Новый вкладчик/.test(B)) { target = bonus.newDepositor; key = 'all'; currency = 'RUB'; }
    else if (/^- Пакет услуг/.test(B)) { key = B.match(/«(.+?)»/)[1].replace(/\s+/g, ' '); target = bonus[bonusSection]; }
    else if (/^- Уровень/.test(B)) { key = B.replace(/^- Уровень\s*/, ''); target = bonus.level; }
    if (!target) continue;
    const vals = {};
    for (const [c, t] of Object.entries(termCols || {})) if (r[c] != null) (vals[t.group] ||= {})[t.term] = pct(num(r[c]));
    ((target[key] ||= {})[currency] = vals);
  }
  return { effective, base, bonus };
}

function privilegiaGrid(v, { level = 'Изумруд', pkg = 'Привилегия - Мультикарта' } = {}) {
  const out = [];
  const b = v.bonus, add = (o, cur, g, t) => (o?.[cur]?.[g]?.[t] ?? 0);
  for (const x of v.base) {
    const pk = add(b.package[pkg], x.currency, x.group, x.term);
    const lv = x.currency === 'RUB' ? add(b.level[level], 'RUB', x.group, x.term) : 0;
    const sal = add(b.salaryPension[pkg], x.currency, x.group, x.term);
    const nd = add(b.newDepositor.all, 'RUB', x.group, x.term);
    const nm = add(b.newMoney[pkg], x.currency, x.group, x.term);
    const r2 = (n) => Math.round(n * 100) / 100;
    out.push({ ...x, standard: x.rate, privBase: r2(x.rate + pk + lv), privSalary: r2(x.rate + pk + lv + sal), privNewDepositor: x.currency === 'RUB' ? r2(x.rate + nd) : null, privNewMoney: r2(x.rate + nm) });
  }
  return out;
}

// ---------- Накопительный ВТБ-Счет sheet ----------
function parseSavings(rows) {
  const flat = rows.map(([n, r]) => [n, r]);
  const effective = flat.map(([, r]) => Object.values(r).find((v) => /действует с/i.test(v))).find(Boolean);
  const res = { effective };
  let mode = null, pkg = null;
  for (const [, r] of flat) {
    const D = r.D || '', B = r.B || '';
    if (/ежедневный остаток/.test(D) && /ПРОЦЕНТНАЯ СТАВКА/.test(D)) mode = 'daily';
    if (/минимальный остаток/.test(D) && /ПРОЦЕНТНАЯ СТАВКА/.test(D)) mode = 'minBalance';
    if (/Привилегия - Мультикарта/.test(D)) pkg = 'privilegia'; else if (/^Пакет услуг "Мультикарта"/.test(D)) pkg = 'multicarta'; else if (/сегмента ВИП/.test(D) && /^Для клиентов/.test(D)) pkg = 'vip';
    const m = D.match(/([\d,]+)%\s*-\s*приветственная.*?([\d,]+)%\s*-\s*базовая/);
    if (mode && pkg && m && /^от 1 000,00 до/.test(B)) {
      (res[pkg] ||= {})[mode] = { welcome: parseFloat(m[1].replace(',', '.')), base: parseFloat(m[2].replace(',', '.')), capRub: B.replace(/^от 1 000,00 до /, '').replace(/ \(включительно\)/, '') };
    }
    if (/^5 Для клиентов/.test(B)) {
      const seg = B.split(/- для /).find((s) => /Привилегия/.test(s)) || '';
      res.purchaseBonusPrivilegia = [...seg.matchAll(/от ([\d\s]+),00 руб\.\d*\s*–\s*надбавка к базовой ставке \+\s*([\d,]+)%/g)].map((x) => ({ minSpendRub: +x[1].replace(/\s/g, ''), bonus: parseFloat(x[2].replace(',', '.')) }));
    }
    if (/^4 Для клиентов/.test(B)) { const x = B.match(/\+([\d,]+)% годовых к базовой ставке/); if (x) res.salaryPensionBonus = parseFloat(x[1].replace(',', '.')); }
    if (/^6 Надбавка за уровень/.test(B)) { const x = B.match(/«Изумруд»\*+ - надбавка к базовой ставке \+\s*([\d,]+)%/); if (x) res.levelBonusPrivilegia = parseFloat(x[1].replace(',', '.')); }
  }
  return res;
}

// ---------- Ключевой (floating, key-rate linked) ----------
function parseKlyuchevoy(rows, keyRate) {
  const effective = rows.map(([, r]) => Object.values(r).find((v) => /действует с/i.test(v))).find(Boolean);
  const out = [];
  let opt = null, termRow = null;
  for (const [, r] of rows) {
    if (/С пополнением$/.test(r.C || '')) opt = 'topUp';
    if (/Без пополнения и снятия/.test(r.C || '')) opt = 'noTopUp';
    if (Object.values(r).some((v) => /^\d+ мес$/.test(v))) { termRow = r; continue; }
    if (termRow && /^\d+$/.test(r.C || '') && Object.values(r).some((v) => /^КС/.test(v))) {
      for (const [c, v] of Object.entries(r)) {
        const m = /^КС\s*([+-])\s*([\d,]+)%/.exec(v); if (!m) continue;
        const spread = (m[1] === '-' ? -1 : 1) * parseFloat(m[2].replace(',', '.'));
        const ci = colIdx(c);
        const amount = ci >= colIdx('J') ? +(r.J || 0) : +r.C;
        const variant = opt === 'noTopUp' ? (ci >= colIdx('J') ? 'noTopUp/atMaturity' : 'noTopUp/monthly') : (ci >= colIdx('J') ? 'topUpWithdraw/monthly' : 'topUp/monthly');
        out.push({ variant, minAmount: amount, term: termRow[c].replace(' мес', 'm'), spread, rate: keyRate != null ? Math.round((keyRate + spread) * 100) / 100 : null });
      }
    }
  }
  return { effective, keyRate, rows: out };
}

const TERMS = ["1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m", "10m", "11m", "12m"];
const toGrid = (rows, key) => Object.fromEntries(rows.filter(x => TERMS.includes(x.term) && x[key] != null).map(x => [x.term.replace("m", ""), x[key]]));

export async function fetchVtb({ refAmount = 3e6, keyRate = null } = {}) {
  let buf, last;
  for (let i = 0; i < 4 && !buf; i++) {
    try {
      const b = await getBuffer(XLSX_URL, { timeout: 30000 });
      if (b.readUInt32LE(0) !== 0x04034b50) throw new Error(`VTB: not an XLSX (${b.length} B) — WAF page?`);
      buf = b;
    } catch (e) { last = e; await new Promise(r => setTimeout(r, 2000 * (i + 1))); }
  }
  if (!buf) throw last;
  const sheets = readWorkbook(unzip(buf));
  const need = ["ВТБ-Вклад", "Накопительный ВТБ-Счет", "ВТБ-Вклад Ключевой Привилегия"];
  for (const s of need) if (!sheets[s]) throw new Error(`VTB XLSX: sheet «${s}» missing — layout changed`);
  const vk = parseVtbVklad(sheets["ВТБ-Вклад"]());
  const grid = privilegiaGrid(vk);
  const amounts = [...new Set(grid.map(x => x.minAmount))].sort((a, b) => a - b);
  const amt = amounts.filter(a => a <= refAmount).at(-1) ?? amounts[0];
  const sel = (g, payout = "atMaturity") => grid.filter(x => x.currency === "RUB" && x.group === g && x.payout === payout && x.channel === "online" && x.minAmount === amt);
  const eff = s => { const m = String(s || "").match(/(\d\d)\.(\d\d)\.(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  const out = [];
  const base = { bank: "vtb", ...TIER, type: "deposit", name: "ВТБ-Вклад", payout: "end", withdraw: "нет", minAmount: 10000, source: SRC, effectiveFrom: eff(vk.effective) };
  const nt = sel("noTopUp");
  const g0 = toGrid(nt, "privBase");
  if (!Object.keys(g0).length || Object.values(g0).some(v => !(v > 1 && v < 30))) throw new Error("VTB: Привилегия grid empty or implausible");
  const sal = toGrid(nt, "privSalary"), nd = toGrid(nt, "privNewDepositor");
  out.push({ ...base, variant: "Без условий", rates: g0, topup: "нет",
    note: `С зарплатой/пенсией в ВТБ: ${Object.entries(sal).filter(([m]) => +m <= 6).map(([m, v]) => `${m} мес ${v}%`).join(", ")}. Новый вкладчик (нет вкладов 180 дней): до ${Math.max(...Object.values(nd))}%` });
  out.push({ ...base, variant: "Новые деньги", rates: toGrid(nt, "privNewMoney"), baseRates: g0, topup: "нет", note: "Надбавка «Новые деньги» — на прирост средств в ВТБ" });
  const tu = toGrid(sel("topUp"), "privBase");
  if (Object.keys(tu).length) out.push({ ...base, variant: "С пополнением", rates: tu, topup: "да" });

  try {
    const k = parseKlyuchevoy(sheets["ВТБ-Вклад Ключевой Привилегия"](), keyRate);
    const rows = k.rows.filter(r => r.variant === "noTopUp/atMaturity");
    const ka = [...new Set(rows.map(r => r.minAmount))].sort((a, b) => a - b);
    const a = ka.filter(x => x <= refAmount).at(-1) ?? ka[0];
    const g = Object.fromEntries(rows.filter(r => r.minAmount === a && TERMS.includes(r.term) && r.rate != null).map(r => [r.term.replace("m", ""), r.rate]));
    if (Object.keys(g).length) out.push({ ...base, name: "ВТБ-Вклад Ключевой", variant: "Плавающая ставка", rates: g, topup: "нет", floating: true, minAmount: 500000,
      spreads: Object.fromEntries(rows.filter(r => r.minAmount === a).map(r => [r.term.replace("m", ""), r.spread])),
      note: "Ставка = ключевая ставка ЦБ + фиксированный спред, пересчитывается при изменении ключевой", effectiveFrom: eff(k.effective) });
  } catch (e) { /* floating deposit is optional */ }

  const s = parseSavings(sheets["Накопительный ВТБ-Счет"]());
  const p = s.privilegia?.minBalance;
  if (p) {
    const buy = Math.max(0, ...(s.purchaseBonusPrivilegia || []).map(x => x.bonus));
    const max = Math.round((p.base + (s.salaryPensionBonus || 0) + buy + (s.levelBonusPrivilegia || 0)) * 100) / 100;
    out.push({ bank: "vtb", ...TIER, type: "savings", name: "Накопительный ВТБ-Счёт", rate: Math.max(max, p.welcome), guaranteed: p.base,
      promoRate: p.welcome, promoMonths: 2, accrual: "на минимальный остаток за месяц", capitalization: "monthly",
      conditions: `${p.welcome}% первые 2 мес. — если 180 дней в ВТБ было < 1 000 ₽ на вкладах и счетах. Далее ${p.base}% база; до ${max}%: +${s.salaryPensionBonus}% зарплата/пенсия, +${buy}% покупки от 100 тыс. ₽/мес, +${s.levelBonusPrivilegia}% за уровень. Надбавки на сумму до ${(Math.round(parseFloat(String(p.capRub).replace(/\s/g, "").replace(",", ".")) / 1e6) || "?").toLocaleString("ru-RU")} млн ₽`,
      source: SRC, effectiveFrom: eff(s.effective) });
  }
  return { products: out, meta: { refTier: amt } };
}
