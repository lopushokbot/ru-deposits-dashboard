// Shared helpers: HTTP (system roots + Russian Trusted Root CA), MOEX ISS (money-market funds, RUSFAR), cbr.ru (key rate).
// Russian bank sites and, since 2026-11-24, iss.moex.com serve certificates from the Минцифры root CA,
// which no OS trusts — every request goes through an https.Agent that trusts the system roots PLUS that one root.
import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import tls from "node:tls";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_PATH = path.join(ROOT, "data.json");
export const CONFIG_PATH = path.join(ROOT, "config.json");
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
export const readJSON = p => JSON.parse(fs.readFileSync(p, "utf8"));
export const writeJSON = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 1) + "\n");
export const todayMoscow = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

export const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const RU_CA = fs.readFileSync(path.join(ROOT, "certs/russian_trusted_root_ca.pem"), "utf8");
const agent = new https.Agent({ ca: [...tls.rootCertificates, RU_CA], keepAlive: true });

function request(url, { method = "GET", headers = {}, body = null, timeout = 30000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.request(u, {
      method, agent: u.protocol === "https:" ? agent : undefined, timeout,
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.6", "Accept-Encoding": "gzip, deflate, br", Accept: "*/*", ...headers },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(request(new URL(res.headers.location, u).toString(), { method, headers, body, timeout, redirects: redirects - 1 }));
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        let buf = Buffer.concat(chunks);
        try {
          const enc = res.headers["content-encoding"];
          if (enc === "gzip") buf = zlib.gunzipSync(buf);
          else if (enc === "deflate") buf = zlib.inflateSync(buf);
          else if (enc === "br") buf = zlib.brotliDecompressSync(buf);
        } catch (e) { return reject(e); }
        resolve({ status: res.statusCode, headers: res.headers, body: buf });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout ${url}`)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** GET/POST with retries. Returns text. 4xx (except 429) is fatal, no retry. */
export async function getText(url, { tries = 3, ...opts } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await request(url, opts);
      if (r.status >= 400) {
        const e = new Error(`HTTP ${r.status} ${url}`);
        if (r.status < 500 && r.status !== 429) e.fatal = true;
        throw e;
      }
      return r.body.toString("utf8");
    } catch (e) {
      last = e;
      if (e.fatal) break;
      await sleep(2000 * (i + 1));
    }
  }
  throw last;
}
export const getJSON = async (url, o) => JSON.parse(await getText(url, o));
export const getBuffer = async (url, o = {}) => (await request(url, o)).body;

/* ---------------- MOEX ISS ---------------- */
const ISS = "https://iss.moex.com/iss";
const table = (j, k) => (j[k]?.data || []).map(r => Object.fromEntries(j[k].columns.map((c, i) => [c, r[i]])));

/** Daily closes of an exchange-traded fund (any board), last ~120 days. */
export async function moexHistory(secid, days = 120) {
  const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const out = [];
  let start = 0, total = 1;
  while (start < total) {
    const j = await getJSON(`${ISS}/history/engines/stock/markets/shares/securities/${secid}.json?iss.meta=off&from=${from}&start=${start}&history.columns=BOARDID,TRADEDATE,LEGALCLOSEPRICE,CLOSE,VALUE`);
    for (const r of table(j, "history")) {
      const px = r.LEGALCLOSEPRICE || r.CLOSE;
      if (r.BOARDID === "TQBR" || r.BOARDID === "TQTF") if (px > 0) out.push({ d: r.TRADEDATE, p: px, v: r.VALUE });
    }
    const cur = table(j, "history.cursor")[0];
    total = cur?.TOTAL ?? 0; start += cur?.PAGESIZE ?? 100;
  }
  return out;
}

/** Simple annualised return between the last close and the close nearest `days` calendar days before it (act/365). */
export function annualised(hist, days) {
  if (hist.length < 2) return null;
  const last = hist.at(-1);
  const target = new Date(last.d).getTime() - days * 864e5;
  let base = null;
  for (const h of hist) if (new Date(h.d).getTime() <= target) base = h;
  if (!base) return null;
  const span = (new Date(last.d) - new Date(base.d)) / 864e5;
  return { rate: (last.p / base.p - 1) * 365 / span * 100, from: base.d, to: last.d };
}

/** RUSFAR overnight (MOEX index), last value + 30-day mean. */
export async function rusfar() {
  const from = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
  const h = table(await getJSON(`${ISS}/history/engines/stock/markets/index/securities/RUSFAR.json?iss.meta=off&from=${from}&history.columns=TRADEDATE,CLOSE`), "history").filter(r => r.CLOSE > 0);
  const last = h.at(-1);
  const cut = new Date(new Date(last.TRADEDATE) - 30 * 864e5);
  const win = h.filter(r => new Date(r.TRADEDATE) >= cut);
  return { value: last.CLOSE, date: last.TRADEDATE, avg30: win.reduce((s, r) => s + r.CLOSE, 0) / win.length };
}

/* ---------------- cbr.ru ---------------- */
/** Key rate: current value + date of the last change (scans the cbr.ru table, newest first). */
export async function keyRate() {
  const to = new Date(Date.now() + 3 * 3600e3);
  const from = new Date(to - 400 * 864e5);
  const f = d => `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
  const html = await getText(`https://www.cbr.ru/hd_base/KeyRate/?UniDbQuery.Posted=True&UniDbQuery.From=${f(from)}&UniDbQuery.To=${f(to)}`);
  const rows = [...html.matchAll(/<td>(\d\d)\.(\d\d)\.(\d{4})<\/td>\s*<td>([\d,]+)<\/td>/g)]
    .map(m => ({ d: `${m[3]}-${m[2]}-${m[1]}`, v: parseFloat(m[4].replace(",", ".")) }));
  if (!rows.length) throw new Error("cbr.ru key rate table not found");
  const cur = rows[0];
  let since = cur.d;
  for (const r of rows) { if (r.v !== cur.v) break; since = r.d; }
  const prev = rows.find(r => r.v !== cur.v);
  return { value: cur.v, date: cur.d, since, prev: prev?.v ?? null };
}
