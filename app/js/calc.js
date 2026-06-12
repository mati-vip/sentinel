/* Sentinel — lógica de cálculo y evaluación de alertas.
   Esta misma lógica está portada en supabase/functions/monitor/index.ts:
   si se cambia una fórmula acá, hay que replicarla allá. */
(function () {
  'use strict';

  const MMR_DEFAULT = 0.005; // margen de mantenimiento estimado si el exchange no da precio de liq.

  function num(v) {
    const n = parseFloat(String(v).replace(',', '.'));
    return isFinite(n) ? n : null;
  }

  /* ---- Métricas por tipo de posición ---- */

  function futuresMetrics(p, price) {
    const entry = num(p.entryPrice), margin = num(p.margin), lev = num(p.leverage) || 1;
    if (entry === null || margin === null || price === null) return null;
    const dir = p.side === 'short' ? -1 : 1;
    const qty = num(p.qty) !== null ? num(p.qty) : (margin * lev) / entry;
    const pnl = dir * qty * (price - entry);
    const pnlPct = margin > 0 ? (pnl / margin) * 100 : 0;

    // Si el usuario cargó el precio de liquidación del exchange, se usa ese (más preciso).
    let liq = num(p.liqPrice);
    if (liq === null) liq = entry * (1 - dir * (1 / lev) + dir * MMR_DEFAULT);
    if (liq < 0) liq = 0;
    // Distancia con signo: negativa = el precio ya cruzó la liquidación.
    const distToLiqPct = price > 0 ? (dir * (price - liq) / price) * 100 : null;

    return {
      qty, pnl, pnlPct, liq, distToLiqPct,
      value: qty * price,
      marginHealth: distToLiqPct === null ? null : Math.max(0, Math.min(100, distToLiqPct * lev)),
    };
  }

  // Deuda actualizada: interés compuesto diario desde la fecha de apertura.
  // La tasa se interpreta como nominal del período elegido (anual/mensual/diaria).
  function loanDebt(p) {
    const principal = num(p.principal);
    if (principal === null) return null;
    const rate = num(p.interestRate);
    if (rate === null || rate <= 0 || !p.openedAt) return principal;
    const days = Math.max(0, (Date.now() - new Date(p.openedAt + 'T00:00:00')) / 86400000);
    const perDay = p.ratePeriod === 'daily' ? rate / 100
      : p.ratePeriod === 'monthly' ? rate / 100 / 30
      : rate / 100 / 365;
    return principal * Math.pow(1 + perDay, days);
  }

  function loanMetrics(p, price) {
    const principal = num(p.principal), collQty = num(p.collateralQty);
    if (principal === null || collQty === null || price === null) return null;
    const collValue = collQty * price;
    const debt = loanDebt(p);
    const interest = debt !== null ? debt - principal : null;
    const ltv = collValue > 0 && debt !== null ? (debt / collValue) * 100 : null;
    const floor = num(p.floorPrice), ceil = num(p.ceilPrice);
    const distToFloorPct = floor !== null && price > 0 ? ((price - floor) / price) * 100 : null;
    const distToCeilPct = ceil !== null && price > 0 ? ((ceil - price) / price) * 100 : null;
    let daysToDue = null;
    if (p.dueDate) {
      daysToDue = Math.ceil((new Date(p.dueDate + 'T23:59:59') - Date.now()) / 86400000);
    }
    return { collValue, debt, interest, ltv, distToFloorPct, distToCeilPct, daysToDue, value: collValue };
  }

  function spotMetrics(p, price) {
    const entry = num(p.entryPrice), qty = num(p.qty);
    if (entry === null || qty === null || price === null) return null;
    const pnl = qty * (price - entry);
    const pnlPct = entry > 0 ? ((price - entry) / entry) * 100 : 0;
    return { pnl, pnlPct, value: qty * price };
  }

  function metrics(p, price) {
    if (p.type === 'futures') return futuresMetrics(p, price);
    if (p.type === 'loan') return loanMetrics(p, price);
    if (p.type === 'spot') return spotMetrics(p, price);
    return null;
  }

  /* ---- Evaluación de alertas ----
     Devuelve [{key, severity:'warn'|'crit', message}]. `key` identifica la alerta
     para aplicar cooldown (no repetir la misma alerta cada minuto). */

  function evaluate(p, price) {
    const out = [];
    const a = p.alerts || {};
    const m = metrics(p, price);
    if (!m || price === null) return out;
    const sym = p.asset || '?';
    const push = (key, severity, message) => out.push({ key: p.id + ':' + key, severity, message });

    // Niveles de precio personalizados (todos los tipos)
    const above = num(a.priceAbove), below = num(a.priceBelow);
    if (above !== null && price >= above) push('above', 'warn', `${sym} cruzó hacia arriba $${fmt(above)} (ahora $${fmt(price)}) — [${p.strategy || p.exchange || ''}]`);
    if (below !== null && price <= below) push('below', 'warn', `${sym} cruzó hacia abajo $${fmt(below)} (ahora $${fmt(price)}) — [${p.strategy || p.exchange || ''}]`);

    // SL / TP (futuros y spot)
    if (p.type === 'futures' || p.type === 'spot') {
      const dir = p.side === 'short' ? -1 : 1;
      const sl = num(p.stopLoss), tp = num(p.takeProfit);
      if (sl !== null && a.slAlert !== false && dir * (price - sl) <= 0)
        push('sl', 'crit', `🛑 ${sym}: precio $${fmt(price)} alcanzó tu STOP LOSS ($${fmt(sl)}). Revisá si la orden se ejecutó — [${p.strategy || ''}]`);
      if (tp !== null && a.tpAlert !== false && dir * (price - tp) >= 0)
        push('tp', 'warn', `🎯 ${sym}: precio $${fmt(price)} alcanzó tu TAKE PROFIT ($${fmt(tp)}). Considerá tomar ganancia — [${p.strategy || ''}]`);
    }

    if (p.type === 'futures' && m.distToLiqPct !== null) {
      const warnPct = num(a.liqWarnPct) ?? 15;
      const critPct = num(a.liqCritPct) ?? 7;
      const lev = num(p.leverage) || 1;
      if (m.distToLiqPct <= 0)
        push('liq-past', 'crit', `🚨 ${sym} ${p.side || 'long'} x${lev} en ${p.exchange}: el precio ($${fmt(price)}) cruzó la liquidación ($${fmt(m.liq)}). VERIFICÁ EN EL EXCHANGE si la posición sigue viva.`);
      else if (m.distToLiqPct <= critPct)
        push('liq-crit', 'crit', `🚨 ${sym} ${p.side || 'long'} x${lev} en ${p.exchange}: a ${m.distToLiqPct.toFixed(1)}% de LIQUIDACIÓN ($${fmt(m.liq)}). RECARGÁ MARGEN o cerrá la posición YA.`);
      else if (m.distToLiqPct <= warnPct)
        push('liq-warn', 'warn', `⚠️ ${sym} ${p.side || 'long'} x${lev} en ${p.exchange}: a ${m.distToLiqPct.toFixed(1)}% de la liquidación ($${fmt(m.liq)}). Atento al margen.`);
    }

    if (p.type === 'loan') {
      const ltvWarn = num(a.ltvWarn), ltvCrit = num(a.ltvCrit);
      if (m.ltv !== null && ltvCrit !== null && m.ltv >= ltvCrit)
        push('ltv-crit', 'crit', `🚨 Préstamo ${p.exchange || ''} ${sym}: LTV ${m.ltv.toFixed(1)}% superó el crítico (${ltvCrit}%). Cancelá parte del préstamo o agregá colateral YA.`);
      else if (m.ltv !== null && ltvWarn !== null && m.ltv >= ltvWarn)
        push('ltv-warn', 'warn', `⚠️ Préstamo ${p.exchange || ''} ${sym}: LTV ${m.ltv.toFixed(1)}% superó tu umbral (${ltvWarn}%).`);

      const distPct = num(a.rangeDistPct) ?? 5;
      if (m.distToFloorPct !== null && m.distToFloorPct <= distPct)
        push('floor', m.distToFloorPct <= distPct / 2 ? 'crit' : 'warn',
          `⚠️ ${sym} a ${m.distToFloorPct.toFixed(1)}% del PISO ($${fmt(num(p.floorPrice))}) — ${p.strategy || ''}. Considerá cancelar parte del préstamo.`);
      if (m.distToCeilPct !== null && m.distToCeilPct <= distPct)
        push('ceil', 'warn', `📈 ${sym} a ${m.distToCeilPct.toFixed(1)}% del TECHO ($${fmt(num(p.ceilPrice))}) — ${p.strategy || ''}.`);

      const dueDays = num(a.dueDays) ?? 7;
      if (m.daysToDue !== null && m.daysToDue <= dueDays && m.daysToDue >= 0)
        push('due', m.daysToDue <= 2 ? 'crit' : 'warn', `📅 Préstamo ${p.exchange || ''} ${sym} vence en ${m.daysToDue} día(s) (${p.dueDate}).`);
      if (m.daysToDue !== null && m.daysToDue < 0)
        push('due-past', 'crit', `🚨 Préstamo ${p.exchange || ''} ${sym} VENCIDO hace ${-m.daysToDue} día(s).`);
    }

    return out;
  }

  function fmt(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (Math.abs(n) >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
  }

  window.Calc = { metrics, evaluate, fmt, num };
})();
