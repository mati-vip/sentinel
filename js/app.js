/* Sentinel — UI principal */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const { metrics, evaluate, fmt, num } = window.Calc;

  const COOLDOWN_MIN = 30; // minutos sin repetir la misma alerta en la app
  let filter = { status: 'open', type: '', strategy: '', exchange: '', search: '' };

  /* ================= render ================= */

  function visiblePositions() {
    return Store.all().filter(p => {
      if ((p.status || 'open') !== filter.status) return false;
      if (filter.type && p.type !== filter.type) return false;
      if (filter.strategy && (p.strategy || '') !== filter.strategy) return false;
      if (filter.exchange && (p.exchange || '') !== filter.exchange) return false;
      if (filter.search) {
        const hay = [p.asset, p.exchange, p.strategy, p.notes].join(' ').toLowerCase();
        if (!hay.includes(filter.search.toLowerCase())) return false;
      }
      return true;
    });
  }

  function typeBadge(p) {
    if (p.type === 'loan') return '<span class="badge loan">Préstamo</span>';
    if (p.type === 'spot') return '<span class="badge spot">Spot</span>';
    const side = p.side === 'short' ? 'short' : 'long';
    return `<span class="badge ${side}">${side}</span><span class="badge lev">x${p.leverage || 1}</span>`;
  }

  function riskLevel(p, price) {
    const fired = evaluate(p, price);
    if (fired.some(a => a.severity === 'crit')) return 'crit';
    if (fired.some(a => a.severity === 'warn')) return 'warn';
    return 'ok';
  }

  function riskBar(p, m, price) {
    let pct = 0, color = 'var(--accent)';
    if (p.type === 'futures' && m && m.distToLiqPct !== null) {
      const warn = num(p.alerts?.liqWarnPct) ?? 15;
      pct = Math.max(0, Math.min(100, 100 - (m.distToLiqPct / (warn * 2)) * 100));
    } else if (p.type === 'loan' && m && m.ltv !== null) {
      const crit = num(p.alerts?.ltvCrit) ?? 80;
      pct = Math.max(0, Math.min(100, (m.ltv / crit) * 100));
    } else if (p.type === 'spot' && m && num(p.stopLoss) !== null && num(p.entryPrice) !== null) {
      const sl = num(p.stopLoss), entry = num(p.entryPrice);
      const range = Math.abs(entry - sl);
      pct = range > 0 ? Math.max(0, Math.min(100, (1 - (price - sl) / range) * 100)) : 0;
    }
    if (pct > 70) color = 'var(--red)'; else if (pct > 45) color = 'var(--amber)';
    return `<div class="riskbar"><div style="width:${pct.toFixed(0)}%;background:${color}"></div></div>`;
  }

  function cells(p, m, price) {
    const c = (lbl, val, cls) => `<div class="cell"><div class="lbl">${lbl}</div><div class="val ${cls || ''}">${val}</div></div>`;
    const money = v => v === null || v === undefined || !isFinite(v) ? '—' : '$' + fmt(v);
    const out = [c('Precio', money(price))];

    if (p.status === 'closed') {
      const pnl = num(p.realizedPnl);
      out.length = 0;
      out.push(c('Cierre', money(num(p.closePrice))));
      out.push(c('PnL realizado', pnl === null ? '—' : (pnl >= 0 ? '+' : '') + money(pnl).replace('$-', '-$'), pnl >= 0 ? 'pos' : 'neg'));
      out.push(c('Cerrada', p.closedAt || '—'));
      return out.join('');
    }

    if (p.type === 'futures' && m) {
      out.push(c('Entrada', money(num(p.entryPrice))));
      out.push(c('PnL', (m.pnl >= 0 ? '+' : '') + money(m.pnl).replace('$-', '-$') + ` (${m.pnlPct.toFixed(1)}%)`, m.pnl >= 0 ? 'pos' : 'neg'));
      out.push(c('Liquidación', money(m.liq)));
      out.push(c('Dist. a liq.', m.distToLiqPct === null ? '—' : m.distToLiqPct.toFixed(1) + '%', m.distToLiqPct < 10 ? 'neg' : ''));
      out.push(c('Margen', money(num(p.margin))));
    } else if (p.type === 'loan' && m) {
      out.push(c('LTV', m.ltv === null ? '—' : m.ltv.toFixed(1) + '%', m.ltv > (num(p.alerts?.ltvWarn) ?? 65) ? 'neg' : 'pos'));
      out.push(c('Colateral', money(m.collValue)));
      out.push(c('Deuda hoy', money(m.debt)));
      if (m.interest !== null && m.interest >= 0.01) out.push(c('Intereses acum.', '+' + money(m.interest), 'neg'));
      if (num(p.floorPrice) !== null) out.push(c('Dist. piso', m.distToFloorPct === null ? '—' : m.distToFloorPct.toFixed(1) + '%'));
      if (m.daysToDue !== null) out.push(c('Vence en', m.daysToDue + ' días', m.daysToDue <= 7 ? 'neg' : ''));
    } else if (p.type === 'spot' && m) {
      out.push(c('Entrada', money(num(p.entryPrice))));
      out.push(c('PnL', (m.pnl >= 0 ? '+' : '') + money(m.pnl).replace('$-', '-$') + ` (${m.pnlPct.toFixed(1)}%)`, m.pnl >= 0 ? 'pos' : 'neg'));
      out.push(c('Valor', money(m.value)));
      if (num(p.stopLoss) !== null) out.push(c('Stop Loss', money(num(p.stopLoss))));
      if (num(p.takeProfit) !== null) out.push(c('Take Profit', money(num(p.takeProfit))));
    } else {
      out.push(c('Datos', 'incompletos'));
    }
    return out.join('');
  }

  function render() {
    const list = visiblePositions();
    const cont = $('positions');
    if (!list.length) {
      cont.innerHTML = `<div class="empty">${filter.status === 'open' ? 'Sin posiciones abiertas.<br>Tocá + para cargar la primera.' : 'Sin operaciones cerradas todavía.'}</div>`;
    } else {
      cont.innerHTML = list.map(p => {
        const price = Prices.get(p.asset);
        const m = metrics(p, price);
        const risk = p.status === 'closed' ? 'ok' : riskLevel(p, price);
        return `<div class="card risk-${risk}" data-id="${p.id}">
          <div class="top">
            <span class="asset">${(p.asset || '?').toUpperCase()}</span>
            ${typeBadge(p)}
            <span class="strat">${esc(p.strategy || '')}<br><span style="opacity:.7">${esc(p.exchange || '')}</span></span>
          </div>
          <div class="grid">${cells(p, m, price)}</div>
          ${p.status !== 'closed' ? riskBar(p, m, price) : ''}
          ${p.notes ? `<div class="notes">${esc(p.notes)}</div>` : ''}
          <div class="meta">Abierta: ${p.openedAt || '—'}</div>
          <div class="actions">
            <button data-act="edit">Editar</button>
            ${p.status !== 'closed' ? '<button data-act="close">Cerrar pos.</button>' : ''}
            <button data-act="del">Borrar</button>
          </div>
        </div>`;
      }).join('');
    }
    renderSummary();
    renderFilterOptions();
  }

  function renderSummary() {
    const open = Store.all().filter(p => (p.status || 'open') === 'open');
    let pnl = 0, hasPnl = false, risky = 0;
    for (const p of open) {
      const price = Prices.get(p.asset);
      const m = metrics(p, price);
      if (m && typeof m.pnl === 'number') { pnl += m.pnl; hasPnl = true; }
      if (riskLevel(p, price) !== 'ok') risky++;
    }
    const el = $('sum-pnl');
    el.textContent = hasPnl ? (pnl >= 0 ? '+$' : '-$') + fmt(Math.abs(pnl)) : '—';
    el.className = 'val ' + (pnl >= 0 ? 'pos' : 'neg');
    $('sum-count').textContent = open.length;
    const r = $('sum-risk');
    r.textContent = risky;
    r.className = 'val ' + (risky > 0 ? 'neg' : 'pos');
  }

  function renderTicker() {
    const assets = [...new Set(Store.all().filter(p => (p.status || 'open') === 'open').map(p => (p.asset || '').toUpperCase()))];
    $('ticker').innerHTML = assets.map(a => {
      const v = Prices.get(a);
      return `<span class="tk">${a} <b>${v ? '$' + fmt(v) : '…'}</b></span>`;
    }).join('');
    const ts = Prices.updatedAt();
    $('hdr-info').textContent = ts ? `${Prices.sourceName()} · ${new Date(ts).toLocaleTimeString('es-AR')}` : 'conectando…';
    $('dot').className = 'status-dot ' + (ts && Date.now() - ts < 30000 ? 'live' : 'err');
  }

  function renderFilterOptions() {
    fillSelect('f-strategy', 'Estrategia: todas', uniq('strategy'), filter.strategy);
    fillSelect('f-exchange', 'Exchange: todos', uniq('exchange'), filter.exchange);
    $('dl-strategy').innerHTML = uniq('strategy').map(v => `<option value="${esc(v)}">`).join('');
    $('dl-exchange').innerHTML = uniq('exchange').map(v => `<option value="${esc(v)}">`).join('');
  }
  function uniq(field) {
    return [...new Set(Store.all().map(p => p[field]).filter(Boolean))].sort();
  }
  function fillSelect(id, label, values, current) {
    const sel = $(id);
    const html = `<option value="">${label}</option>` + values.map(v => `<option ${v === current ? 'selected' : ''}>${esc(v)}</option>`).join('');
    if (sel.innerHTML !== html) sel.innerHTML = html;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ================= alertas en la app ================= */

  let audioCtx = null;
  function beep(severity) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      o.frequency.value = severity === 'crit' ? 880 : 600;
      g.gain.setValueAtTime(0.18, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.45);
      o.start(); o.stop(audioCtx.currentTime + 0.45);
    } catch (e) { /* audio bloqueado hasta primera interacción: ok */ }
  }

  function toast(message, severity) {
    const el = document.createElement('div');
    el.className = 'toast ' + (severity || '');
    el.textContent = message;
    el.onclick = () => el.remove();
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 12000);
  }

  function checkAlerts() {
    for (const p of Store.all()) {
      if ((p.status || 'open') !== 'open') continue;
      const price = Prices.get(p.asset);
      for (const a of evaluate(p, price)) {
        if (!Store.shouldFire('app:' + a.key, COOLDOWN_MIN)) continue;
        toast(a.message, a.severity);
        beep(a.severity);
        sendMakeWebhook(a);
      }
    }
  }

  async function sendMakeWebhook(alert) {
    const s = Store.getSettings();
    if (!s.makeWebhook) return;
    try {
      await fetch(s.makeWebhook, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'sentinel-app', severity: alert.severity, message: alert.message, at: new Date().toISOString() }),
      });
    } catch (e) { console.warn('webhook make', e); }
  }

  /* ================= formulario de posición ================= */

  function showTypeFields() {
    const t = $('p-type').value;
    document.querySelectorAll('[data-types]').forEach(el => {
      el.style.display = el.dataset.types.split(',').includes(t) ? '' : 'none';
    });
    $('fw-side').style.display = (t === 'futures' || t === 'spot') ? '' : 'none';
  }

  function openForm(p) {
    $('pos-title').textContent = p ? 'Editar posición' : 'Nueva posición';
    const f = p || {};
    const a = f.alerts || {};
    $('p-id').value = f.id || '';
    $('p-type').value = f.type || 'futures';
    $('p-asset').value = f.asset || '';
    $('p-exchange').value = f.exchange || '';
    $('p-strategy').value = f.strategy || '';
    $('p-opened').value = f.openedAt || new Date().toISOString().slice(0, 10);
    $('p-side').value = f.side || 'long';
    $('p-margin').value = f.margin ?? '';
    $('p-leverage').value = f.leverage ?? '';
    $('p-entry-f').value = f.type !== 'spot' ? (f.entryPrice ?? '') : '';
    $('p-liq').value = f.liqPrice ?? '';
    $('p-principal').value = f.principal ?? '';
    $('p-collqty').value = f.collateralQty ?? '';
    $('p-rate').value = f.interestRate ?? '';
    $('p-rateper').value = f.ratePeriod || 'annual';
    $('p-floor').value = f.floorPrice ?? '';
    $('p-ceil').value = f.ceilPrice ?? '';
    $('p-due').value = f.dueDate || '';
    $('p-qty-s').value = f.type === 'spot' ? (f.qty ?? '') : '';
    $('p-entry-s').value = f.type === 'spot' ? (f.entryPrice ?? '') : '';
    $('p-sl').value = f.stopLoss ?? '';
    $('p-tp').value = f.takeProfit ?? '';
    $('a-liqwarn').value = a.liqWarnPct ?? '';
    $('a-liqcrit').value = a.liqCritPct ?? '';
    $('a-ltvwarn').value = a.ltvWarn ?? '';
    $('a-ltvcrit').value = a.ltvCrit ?? '';
    $('a-rangedist').value = a.rangeDistPct ?? '';
    $('a-duedays').value = a.dueDays ?? '';
    $('a-above').value = a.priceAbove ?? '';
    $('a-below').value = a.priceBelow ?? '';
    $('p-notes').value = f.notes || '';
    showTypeFields();
    $('modal-pos').classList.add('open');
  }

  function saveForm(e) {
    e.preventDefault();
    const t = $('p-type').value;
    const v = id => { const x = $(id).value.trim(); return x === '' ? null : x; };
    const existing = Store.all().find(x => x.id === $('p-id').value);
    const p = {
      ...(existing || {}),
      id: $('p-id').value || undefined,
      status: existing?.status || 'open',
      type: t,
      asset: ($('p-asset').value || '').trim().toUpperCase(),
      exchange: v('p-exchange'),
      strategy: v('p-strategy'),
      openedAt: v('p-opened'),
      side: (t === 'futures' || t === 'spot') ? $('p-side').value : null,
      margin: t === 'futures' ? v('p-margin') : null,
      leverage: t === 'futures' ? v('p-leverage') : null,
      entryPrice: t === 'spot' ? v('p-entry-s') : (t === 'futures' ? v('p-entry-f') : null),
      liqPrice: t === 'futures' ? v('p-liq') : null,
      qty: t === 'spot' ? v('p-qty-s') : (existing?.qty ?? null),
      principal: t === 'loan' ? v('p-principal') : null,
      collateralQty: t === 'loan' ? v('p-collqty') : null,
      interestRate: t === 'loan' ? v('p-rate') : null,
      ratePeriod: t === 'loan' ? $('p-rateper').value : null,
      floorPrice: t === 'loan' ? v('p-floor') : null,
      ceilPrice: t === 'loan' ? v('p-ceil') : null,
      dueDate: t === 'loan' ? v('p-due') : null,
      stopLoss: t !== 'loan' ? v('p-sl') : null,
      takeProfit: t !== 'loan' ? v('p-tp') : null,
      notes: v('p-notes'),
      alerts: {
        liqWarnPct: v('a-liqwarn'), liqCritPct: v('a-liqcrit'),
        ltvWarn: v('a-ltvwarn'), ltvCrit: v('a-ltvcrit'),
        rangeDistPct: v('a-rangedist'), dueDays: v('a-duedays'),
        priceAbove: v('a-above'), priceBelow: v('a-below'),
      },
    };
    if (!p.asset) return;
    Store.upsert(p);
    $('modal-pos').classList.remove('open');
    refreshAssets();
    render();
  }

  /* ================= cerrar posición ================= */

  function openClose(p) {
    $('c-id').value = p.id;
    $('c-price').value = Prices.get(p.asset) ?? '';
    $('c-date').value = new Date().toISOString().slice(0, 10);
    $('c-notes').value = '';
    $('modal-close').classList.add('open');
  }

  function confirmClose() {
    const p = Store.all().find(x => x.id === $('c-id').value);
    if (!p) return;
    const closePrice = num($('c-price').value);
    p.status = 'closed';
    p.closePrice = closePrice;
    p.closedAt = $('c-date').value;
    p.closeNotes = $('c-notes').value.trim() || null;
    const m = metrics(p, closePrice);
    p.realizedPnl = m && typeof m.pnl === 'number' ? m.pnl : null;
    Store.upsert(p);
    $('modal-close').classList.remove('open');
    refreshAssets();
    render();
  }

  /* ================= configuración ================= */

  function openSettings() {
    const s = Store.getSettings();
    $('s-sburl').value = s.supabaseUrl || '';
    $('s-sbkey').value = s.supabaseKey || '';
    $('s-email').value = s.email || '';
    $('s-vapid').value = s.vapidPublic || '';
    $('s-make').value = s.makeWebhook || '';
    updateCloudStatus();
    $('modal-settings').classList.add('open');
  }

  function updateCloudStatus() {
    const el = $('cloud-status');
    if (Store.isCloudActive()) {
      el.className = 'cloud-status on';
      el.textContent = 'Nube: ✓ conectada — datos sincronizados y monitor 24/7 activo';
    } else {
      el.className = 'cloud-status off';
      el.textContent = 'Nube: no conectada — los datos viven solo en este dispositivo';
    }
  }

  function saveSettings() {
    const s = Store.getSettings();
    s.supabaseUrl = $('s-sburl').value.trim();
    s.supabaseKey = $('s-sbkey').value.trim();
    s.email = $('s-email').value.trim();
    s.vapidPublic = $('s-vapid').value.trim();
    s.makeWebhook = $('s-make').value.trim();
    Store.saveSettings(s);
    toast('Configuración guardada', '');
  }

  async function doLogin() {
    saveSettings();
    try {
      await Store.login($('s-email').value.trim(), $('s-pass').value);
      updateCloudStatus();
      toast('✓ Nube conectada. Datos sincronizados.', '');
      render();
    } catch (e) {
      toast('Error al conectar: ' + (e.message || e), 'crit');
    }
  }

  /* ================= push ================= */

  async function enablePush() {
    saveSettings();
    const s = Store.getSettings();
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        toast('Este navegador no soporta push. En iPhone: instalá la app en pantalla de inicio primero.', 'warn');
        return;
      }
      if (!s.vapidPublic) { toast('Falta la clave VAPID en configuración.', 'warn'); return; }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('Permiso de notificaciones denegado.', 'warn'); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(s.vapidPublic),
      });
      // guardar la suscripción en Supabase para que el monitor pueda enviar push
      if (Store.isCloudActive()) {
        const sb = Store.getSupabase();
        const { error } = await sb.from('push_subscriptions').upsert({
          endpoint: sub.endpoint,
          user_id: Store.getSession().user.id,
          subscription: sub.toJSON(),
        }, { onConflict: 'endpoint' });
        if (error) throw error;
        toast('✓ Push activado en este dispositivo. El monitor en la nube ya puede avisarte.', '');
      } else {
        toast('Push local activado, pero conectá la nube para recibir alertas con la app cerrada.', 'warn');
      }
    } catch (e) {
      toast('Error activando push: ' + (e.message || e), 'crit');
    }
  }

  function urlB64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }

  /* ================= export / import ================= */

  function exportJson() {
    const blob = new Blob([JSON.stringify(Store.all(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sentinel-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  }

  function importJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const list = JSON.parse(reader.result);
        if (!Array.isArray(list)) throw new Error('formato inválido');
        list.forEach(p => Store.upsert(p));
        refreshAssets(); render();
        toast(`✓ Importadas ${list.length} posiciones`, '');
      } catch (e) { toast('Error importando: ' + e.message, 'crit'); }
    };
    reader.readAsText(file);
  }

  /* ================= init ================= */

  function refreshAssets() {
    Prices.setAssets(Store.all().filter(p => (p.status || 'open') === 'open').map(p => p.asset));
  }

  function bind() {
    $('fab').onclick = () => openForm(null);
    $('btn-cancel').onclick = () => $('modal-pos').classList.remove('open');
    $('pos-form').onsubmit = saveForm;
    $('p-type').onchange = showTypeFields;
    $('btn-settings').onclick = openSettings;
    $('btn-settings-close').onclick = () => $('modal-settings').classList.remove('open');
    $('btn-settings-save').onclick = () => { saveSettings(); $('modal-settings').classList.remove('open'); };
    $('btn-login').onclick = doLogin;
    $('btn-push').onclick = enablePush;
    $('btn-notif').onclick = enablePush;
    $('btn-close-cancel').onclick = () => $('modal-close').classList.remove('open');
    $('btn-close-ok').onclick = confirmClose;
    $('btn-export').onclick = exportJson;
    $('btn-import').onclick = () => $('file-import').click();
    $('file-import').onchange = e => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; };

    document.querySelectorAll('#filters .chip').forEach(ch => ch.onclick = () => {
      document.querySelectorAll('#filters .chip').forEach(c => c.classList.remove('active'));
      ch.classList.add('active');
      filter.status = ch.dataset.status;
      render();
    });
    $('f-type').onchange = e => { filter.type = e.target.value; render(); };
    $('f-strategy').onchange = e => { filter.strategy = e.target.value; render(); };
    $('f-exchange').onchange = e => { filter.exchange = e.target.value; render(); };
    $('f-search').oninput = e => { filter.search = e.target.value; render(); };

    $('positions').onclick = e => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.closest('.card').dataset.id;
      const p = Store.all().find(x => x.id === id);
      if (!p) return;
      if (btn.dataset.act === 'edit') openForm(p);
      if (btn.dataset.act === 'close') openClose(p);
      if (btn.dataset.act === 'del' && confirm(`¿Borrar ${p.asset} (${p.strategy || p.exchange || p.type})? Esto no se puede deshacer.`)) {
        Store.remove(id); refreshAssets(); render();
      }
    };

    document.querySelectorAll('.modal-bg').forEach(m => m.addEventListener('click', e => {
      if (e.target === m) m.classList.remove('open');
    }));
  }

  async function init() {
    bind();
    refreshAssets();
    render();
    Prices.onUpdate(() => { renderTicker(); render(); checkAlerts(); });
    Prices.start();
    setInterval(renderTicker, 5000);

    if ('serviceWorker' in navigator) {
      try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('sw', e); }
    }

    const cloud = await Store.initCloud().catch(() => ({ ok: false }));
    if (cloud.ok) { refreshAssets(); render(); }
    Store.onChange(() => { refreshAssets(); render(); });
  }

  init();
})();
