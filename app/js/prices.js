/* Sentinel — feed de precios con fuentes de respaldo.
   Fuente primaria: Binance. Si falla 3 veces seguidas, pasa a Crypto.com.
   Vuelve a intentar la primaria cada 5 minutos. */
(function () {
  'use strict';

  const POLL_MS = 5000;
  const RETRY_PRIMARY_MS = 5 * 60 * 1000;

  const sources = [
    {
      name: 'Binance',
      async fetch(assets) {
        const symbols = assets.map(a => `"${a.toUpperCase()}USDT"`).join(',');
        const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=[${symbols}]`);
        if (!r.ok) throw new Error('binance http ' + r.status);
        const data = await r.json();
        const out = {};
        for (const t of data) out[t.symbol.replace('USDT', '')] = parseFloat(t.price);
        return out;
      },
    },
    {
      name: 'Crypto.com',
      async fetch(assets) {
        const out = {};
        await Promise.all(assets.map(async a => {
          const r = await fetch(`https://api.crypto.com/exchange/v1/public/get-tickers?instrument_name=${a.toUpperCase()}_USDT`);
          if (!r.ok) throw new Error('cdc http ' + r.status);
          const j = await r.json();
          const t = j.result && j.result.data && j.result.data[0];
          if (t) out[a.toUpperCase()] = parseFloat(t.a); // último precio
        }));
        return out;
      },
    },
  ];

  const state = {
    prices: {},          // { BTC: 67000, ... }
    updatedAt: null,
    sourceIdx: 0,
    failCount: 0,
    fellBackAt: null,
    listeners: [],
    assets: new Set(),
    timer: null,
  };

  function setAssets(list) {
    state.assets = new Set(list.map(a => a.toUpperCase()).filter(Boolean));
  }

  function onUpdate(fn) { state.listeners.push(fn); }

  async function tick() {
    const assets = [...state.assets];
    if (!assets.length) return;

    // Reintentar fuente primaria pasado el plazo
    if (state.sourceIdx > 0 && state.fellBackAt && Date.now() - state.fellBackAt > RETRY_PRIMARY_MS) {
      state.sourceIdx = 0;
      state.failCount = 0;
    }

    const src = sources[state.sourceIdx];
    try {
      const prices = await src.fetch(assets);
      if (!Object.keys(prices).length) throw new Error('sin datos');
      Object.assign(state.prices, prices);
      state.updatedAt = Date.now();
      state.failCount = 0;
      state.listeners.forEach(fn => fn(state.prices, src.name));
    } catch (e) {
      state.failCount++;
      if (state.failCount >= 3 && state.sourceIdx < sources.length - 1) {
        state.sourceIdx++;
        state.failCount = 0;
        state.fellBackAt = Date.now();
        console.warn('Precio: cambiando a fuente de respaldo', sources[state.sourceIdx].name);
      }
    }
  }

  function start() {
    if (state.timer) return;
    tick();
    state.timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') tick(); // refresco inmediato al volver a la app
    });
  }

  window.Prices = {
    start, setAssets, onUpdate, tick,
    get: a => state.prices[(a || '').toUpperCase()] ?? null,
    sourceName: () => sources[state.sourceIdx].name,
    updatedAt: () => state.updatedAt,
  };
})();
