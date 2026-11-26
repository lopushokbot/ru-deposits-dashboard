// Shared derivations for data.json, used by update.mjs (stored as data.highlights / data.positionViews)
// and by notify.mjs (Telegram digest), so the page and the message always show the same picks.
export const isNewMoney = p => /нов(ые|ых) деньг/i.test(p.variant || "");
export const realistic = s => s.guaranteed ?? s.rate;

export function bestDeposit(products, terms, filter = () => true, exclude = new Set()) {
  let best = null;
  for (const p of products.filter(p => p.type === "deposit" && filter(p))) {
    if (exclude.has(p.id)) continue;
    for (const m of terms) {
      const r = p.rates?.[m];
      if (r == null) continue;
      if (!best || r > best.rate + 1e-9 || (Math.abs(r - best.rate) < 1e-9 && m < best.term)) best = { id: p.id, term: m, rate: r };
    }
  }
  return best;
}
export const bestSavings = products => products.filter(p => p.type === "savings").sort((a, b) => realistic(b) - realistic(a))[0];

/** Your positions with today's comparable rate. */
export function positionViews(data) {
  return data.positions.map(pos => {
    if (pos.kind === "fund") {
      const f = data.funds.find(x => x.ticker === pos.ticker);
      return { id: pos.id, kind: "fund", ticker: pos.ticker, current: f?.y30 ?? null, y7: f?.y7 ?? null, y90: f?.y90 ?? null };
    }
    const m = pos.match || {};
    const s = data.products.find(x => x.type === "savings" && x.bank === m.bank && (!m.tier || x.tier === m.tier));
    return { id: pos.id, kind: "savings", productId: s?.id ?? null, userRate: pos.userRate ?? null, publicRate: s?.rate ?? null, guaranteed: s ? realistic(s) : null,
      current: pos.userRate ?? (s ? realistic(s) : null) };
  });
}

/** 3 deposit picks + best no-conditions savings account. */
export function highlights(data) {
  const P = data.products, used = new Set(), out = [];
  const add = (title, why, b) => { if (!b) return; used.add(b.id); out.push({ kind: "deposit", title, why, ...b }); };
  add("Короткий срок · 2–3 мес", "Самая высокая ставка, если деньги понадобятся через 2–3 месяца.", bestDeposit(P, [2, 3]));
  add("Оптимум · 4–6 мес", "Фиксирует ставку на полгода — полезно, если ключевую начнут снижать.", bestDeposit(P, [4, 5, 6], () => true, used));
  add("Без «новых денег»", "Можно открыть на деньги, которые уже лежат в этом банке.", bestDeposit(P, [3, 4, 5, 6], p => !isNewMoney(p) && !p.floating, used));
  const s = bestSavings(P);
  if (s) out.push({ kind: "savings", title: "Накопительный без условий", why: "Деньги доступны в любой день, без трат по карте и промо-периодов.", id: s.id, term: null, rate: realistic(s) });
  return out;
}
