/* Sentinel — persistencia offline-first.
   localStorage es siempre la copia local (la app funciona sin internet).
   Si hay Supabase configurado y sesión iniciada, la nube es la fuente de
   verdad y todo cambio se replica allá. */
(function () {
  'use strict';

  const LS_POSITIONS = 'sentinel.positions.v2';
  const LS_SETTINGS = 'sentinel.settings.v1';
  const LS_COOLDOWNS = 'sentinel.cooldowns.v1';

  let supabase = null;     // cliente supabase-js (carga diferida)
  let session = null;
  const listeners = [];

  /* ---- settings ---- */
  // Valores públicos del proyecto de Matías (la publishable key está diseñada
  // para ir en el cliente; la seguridad real la dan las políticas RLS).
  const DEFAULTS = {
    supabaseUrl: 'https://laoijzwmdeukfuqfijul.supabase.co',
    supabaseKey: 'sb_publishable_YPOVyYyDOz-ywY8-JUH3zQ_YqxDLXNl',
    vapidPublic: 'BJju4WwocoMW8J70qR6Ca0B1sKFG8RLE-MNDPjmfp4F6wUZBJ3s85RRRUqp_8M1-qzS68GxxLXiHqN9FxUrec00',
  };
  function getSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(LS_SETTINGS)) || {}; } catch { /* sin datos */ }
    for (const k of Object.keys(DEFAULTS)) if (!s[k]) s[k] = DEFAULTS[k];
    return s;
  }
  function saveSettings(s) {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
  }

  /* ---- posiciones (local) ---- */
  function localPositions() {
    try { return JSON.parse(localStorage.getItem(LS_POSITIONS)) || []; } catch { return []; }
  }
  function saveLocal(list) {
    localStorage.setItem(LS_POSITIONS, JSON.stringify(list));
  }

  let positions = localPositions();

  function notify() { listeners.forEach(fn => fn(positions)); }
  function onChange(fn) { listeners.push(fn); }

  /* ---- Supabase ---- */
  async function initCloud() {
    const s = getSettings();
    if (!s.supabaseUrl || !s.supabaseKey) return { ok: false, reason: 'sin-config' };
    if (!supabase) {
      const mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
      supabase = mod.createClient(s.supabaseUrl, s.supabaseKey);
    }
    const { data } = await supabase.auth.getSession();
    session = data.session;
    if (!session) return { ok: false, reason: 'sin-sesion' };
    await pullCloud();
    return { ok: true };
  }

  async function login(email, password) {
    const s = getSettings();
    if (!supabase) {
      const mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
      supabase = mod.createClient(s.supabaseUrl, s.supabaseKey);
    }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    session = data.session;
    await pushAllLocal(); // primera sincronización: subir lo que haya local
    await pullCloud();
    return session;
  }

  async function pullCloud() {
    if (!supabase || !session) return;
    const { data, error } = await supabase.from('positions').select('id,data,updated_at');
    if (error) { console.warn('pullCloud', error); return; }
    if (data) {
      positions = data.map(r => ({ ...r.data, id: r.id }));
      saveLocal(positions);
      notify();
    }
  }

  async function pushAllLocal() {
    if (!supabase || !session) return;
    for (const p of positions) await upsertCloud(p);
  }

  async function upsertCloud(p) {
    if (!supabase || !session) return;
    const { error } = await supabase.from('positions').upsert({
      id: p.id, user_id: session.user.id, data: p, updated_at: new Date().toISOString(),
    });
    if (error) console.warn('upsertCloud', error);
  }

  async function deleteCloud(id) {
    if (!supabase || !session) return;
    const { error } = await supabase.from('positions').delete().eq('id', id);
    if (error) console.warn('deleteCloud', error);
  }

  /* ---- API pública ---- */
  function uuid() {
    return (crypto.randomUUID) ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
  }

  function upsert(p) {
    if (!p.id) p.id = uuid();
    p.updatedAt = new Date().toISOString();
    const i = positions.findIndex(x => x.id === p.id);
    if (i >= 0) positions[i] = p; else positions.push(p);
    saveLocal(positions);
    notify();
    upsertCloud(p);
    return p;
  }

  function remove(id) {
    positions = positions.filter(p => p.id !== id);
    saveLocal(positions);
    notify();
    deleteCloud(id);
  }

  /* ---- cooldown de alertas en la app (no repetir cada 5s) ---- */
  function cooldowns() {
    try { return JSON.parse(localStorage.getItem(LS_COOLDOWNS)) || {}; } catch { return {}; }
  }
  function shouldFire(key, minutes) {
    const cd = cooldowns();
    const last = cd[key] || 0;
    if (Date.now() - last < minutes * 60000) return false;
    cd[key] = Date.now();
    // limpieza de entradas viejas (> 2 días)
    for (const k of Object.keys(cd)) if (Date.now() - cd[k] > 172800000) delete cd[k];
    localStorage.setItem(LS_COOLDOWNS, JSON.stringify(cd));
    return true;
  }

  window.Store = {
    all: () => positions,
    upsert, remove, onChange,
    getSettings, saveSettings,
    initCloud, login, pullCloud,
    isCloudActive: () => !!(supabase && session),
    getSupabase: () => supabase,
    getSession: () => session,
    shouldFire,
  };
})();
