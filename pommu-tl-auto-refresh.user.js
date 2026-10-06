// ==UserScript==
// @name         Pommu タイムライン自動更新
// @namespace    https://github.com/4STRA1/pommu-tl-auto-refresh
// @version      1.2.2
// @description  設定画面に「タイムラインの自動更新」を追加。一定間隔で新着を確認し、遡り中は新着件数をオーバーレイで通知する。
// @author       4STRA1
// @license      MIT
// @match        https://ch.dlsite.com/pommu/*
// @run-at       document-start
// @grant        none
// @homepageURL  https://github.com/4STRA1/pommu-tl-auto-refresh
// @supportURL   https://github.com/4STRA1/pommu-tl-auto-refresh/issues
// @updateURL    https://raw.githubusercontent.com/4STRA1/pommu-tl-auto-refresh/main/pommu-tl-auto-refresh.user.js
// @downloadURL  https://raw.githubusercontent.com/4STRA1/pommu-tl-auto-refresh/main/pommu-tl-auto-refresh.user.js
// ==/UserScript==

(() => {
  'use strict';

  // ===== 設定値 =====
  const LABEL = 'タイムラインの自動更新';
  const LS_KEY = 'tlAutoRefresh.settings';
  const RL_KEY = 'tlAutoRefresh.lastReload';
  const MIN_INTERVAL = 20;          // 秒(これ未満は不可)
  const DEFAULT_INTERVAL = 60;      // 秒
  const TOP_THRESHOLD = 80;         // px: これ以下なら「最上部」とみなす
  const SETTINGS_PATH_RE = /^\/pommu\/settings\/?$/; // 項目を追加する設定トップのURL
  const SETTINGS_ANY_RE = /\/settings(\/|$)/;       // 設定配下(ここではTL検出/ポーリングをしない)
  const TL_ROUTE_RE = null;         // TLのパスに限定したい場合に指定 例: /^\/pommu\/?$/
  const LIST_PATH_RE = /post|timeline|tl|feed|home/i; // TL用APIらしいパス(同点時の優先度)
  const PAGED_KEY_RE = /^(\w*cursor|offset|before|after|max_id|older|until_id|since_id)$/i; // nextCursor 等も含む
  const NOISE_PARAM_RE = /^(token|_|t|ts|timestamp)$/i; // キャッシュ回避パラメータ
  const ID_KEYS = ['id', 'postId', 'post_id', 'postID', 'contentId'];

  const ITEM_ID = 'tl-auto-item';
  const MODAL_ID = 'tl-auto-modal';
  const OVERLAY_ID = 'tl-auto-overlay';
  const STYLE_ID = 'tl-auto-style';

  const origFetch = window.fetch.bind(window);

  const state = {
    settings: loadSettings(),
    routes: new Map(), // routeKey -> Map(cid -> {cid,pathname,url,headers,known,pending,capped,size,match})
    seen: [],          // 観測したAPI(診断用)
    polls: [],         // ポーリング結果(診断用)
    other: new Map(),  // 投稿リスト以外のAPI(種別->回数、診断用)
    pick: null,        // pickCandidateのキャッシュ
    timer: null,
    busy: false,
    lastPoll: 0,
  };

  const pushLog = (arr, v) => { arr.push(v); if (arr.length > 30) arr.shift(); };

  // ===== 設定の保存/読込 =====
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      return { enabled: !!s.enabled, interval: clampInterval(s.interval) };
    } catch (e) {
      return { enabled: false, interval: DEFAULT_INTERVAL };
    }
  }
  function saveSettings() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state.settings)); } catch (e) {}
  }
  function clampInterval(v) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return DEFAULT_INTERVAL;
    return Math.max(MIN_INTERVAL, n);
  }

  // ===== ルート/スクロール =====
  const routeKey = () => location.pathname.replace(/\/+$/, '') + location.search;

  // 縦スクロールしうる要素(window + 画面中央から辿れる祖先)を全部返す
  function scrollables() {
    const root = document.scrollingElement || document.documentElement;
    const list = [root];
    let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    while (el && el !== document.body && el !== document.documentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 1) list.push(el);
      el = el.parentElement;
    }
    return list;
  }
  // どれか1つでも下にスクロールされていれば「遡り中」
  const isAtTop = () => scrollables().every((e) => e.scrollTop <= TOP_THRESHOLD);

  function isTyping() {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
  }

  // ===== fetch / XHR フック: サイト自身のTL取得リクエストを学習する =====
  // (Pommuの /api/pommu/* は XHR で呼ばれているため、XHRも必ずフックする)
  window.fetch = function (input, init) {
    const p = origFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const u = candidateUrl(method, url);
      if (u) {
        const headers = pickHeaders(input, init);
        const key = routeKey();
        p.then((res) => {
          if (!res.ok) return;
          return res.clone().json().then((json) => onListResponse(key, u, headers, json));
        }).catch(() => {});
      }
    } catch (e) {}
    return p;
  };

  const xOpen = XMLHttpRequest.prototype.open;
  const xSet = XMLHttpRequest.prototype.setRequestHeader;
  const xSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__tl = { method: String(method).toUpperCase(), url: String(url), headers: {} };
    return xOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__tl && !/^(content-length|host|cookie)$/i.test(k)) this.__tl.headers[k] = v;
    return xSet.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const meta = this.__tl;
    try {
      const u = meta && candidateUrl(meta.method, meta.url);
      if (u) {
        const key = routeKey();
        this.addEventListener('load', () => {
          try {
            if (this.status < 200 || this.status >= 300) return;
            const rt = this.responseType;
            if (rt && rt !== 'text' && rt !== 'json') return;
            const json = rt === 'json' ? this.response : JSON.parse(this.responseText);
            onListResponse(key, u, meta.headers, json);
          } catch (e) {}
        });
      }
    } catch (e) {}
    return xSend.apply(this, arguments);
  };

  // 監視対象にするURLか判定(対象ならURLオブジェクトを返す)
  function candidateUrl(method, url) {
    if (method !== 'GET') return null;
    let u;
    try { u = new URL(url, location.href); } catch (e) { return null; }
    if (u.origin !== location.origin || !u.pathname.includes('/api/')) return null;
    if (SETTINGS_ANY_RE.test(location.pathname)) return null;
    if (TL_ROUTE_RE && !TL_ROUTE_RE.test(location.pathname)) return null;
    return u;
  }

  function isPagedUrl(u) {
    for (const [k, v] of u.searchParams) {
      if ((k === 'page' || k === 'p') && Number(v) > 1) return true;
      if (PAGED_KEY_RE.test(k) && v) return true;
    }
    return false;
  }

  function pickHeaders(input, init) {
    const out = {};
    try {
      const h = new Headers((init && init.headers) || (input && input.headers) || undefined);
      h.forEach((v, k) => { if (!/^(content-length|host|cookie)$/i.test(k)) out[k] = v; });
    } catch (e) {}
    return out;
  }

  // 投稿IDの取り出し(id / postId / {post:{id}} など)
  function idOf(x) {
    if (!x || typeof x !== 'object') return null;
    const pick = (o) => {
      for (const k of ID_KEYS) if (o[k] != null && typeof o[k] !== 'object') return String(o[k]);
      return null;
    };
    let v = pick(x);
    if (v != null) return v;
    for (const k of ['post', 'item', 'data']) {
      if (x[k] && typeof x[k] === 'object' && !Array.isArray(x[k])) { v = pick(x[k]); if (v != null) return v; }
    }
    return null;
  }

  function findItems(json, depth = 0) {
    if (Array.isArray(json)) {
      return json.length && json.every((x) => idOf(x) != null) ? json : null;
    }
    if (json && typeof json === 'object' && depth < 3) {
      let best = null;
      for (const v of Object.values(json)) {
        const f = findItems(v, depth + 1);
        if (f && (!best || f.length > best.length)) best = f;
      }
      return best;
    }
    return null;
  }

  // パス+(ノイズを除いた)クエリで候補を識別する
  function candidateId(u) {
    const q = [...u.searchParams].filter(([k]) => !NOISE_PARAM_RE.test(k)).sort().map(([k, v]) => `${k}=${v}`).join('&');
    return u.pathname + (q ? `?${q}` : '');
  }

  // ページ送り用URL(nextCursor等)から「先頭ページ(最新側)」のURLを作る
  function headUrl(u) {
    const h = new URL(u.href);
    for (const k of [...h.searchParams.keys()]) if (PAGED_KEY_RE.test(k)) h.searchParams.delete(k);
    for (const k of ['page', 'p']) if (h.searchParams.has(k)) h.searchParams.set(k, '1');
    return h;
  }

  // 先頭ページURLは localStorage に覚えておく(再読込直後=SSR表示でAPIが呼ばれない場合に使う)
  const TPL_KEY = 'tlAutoRefresh.templates';
  function loadTemplates() {
    try { return JSON.parse(localStorage.getItem(TPL_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveTemplate(key, u, headers) {
    try {
      const t = loadTemplates();
      t[key] = { href: u.pathname + u.search, headers };
      const keys = Object.keys(t);
      if (keys.length > 10) delete t[keys[0]];
      localStorage.setItem(TPL_KEY, JSON.stringify(t));
    } catch (e) {}
  }

  const normApi = (p) => p.replace(/[0-9a-f]{32,}/gi, ':hash').replace(/\d+/g, ':n');

  function upsertCandidate(key, u, headers, ids) {
    let m = state.routes.get(key);
    if (!m) { m = new Map(); state.routes.set(key, m); }
    const cid = candidateId(u);
    let c = m.get(cid);
    if (!c) {
      c = { cid, pathname: u.pathname, url: u.href, headers, known: ids ? new Set(ids) : null, pending: new Set(), capped: false, size: ids ? ids.length : 0, match: 0, baselining: false };
      m.set(cid, c);
      return { c, created: true };
    }
    c.url = u.href;
    c.headers = headers;
    if (ids) {
      // サイト側が先頭ページを再取得した → 表示済みとして扱う
      if (!c.known) c.known = new Set();
      ids.forEach((id) => c.known.add(id));
      c.pending.clear();
      c.capped = false;
      c.size = ids.length;
    }
    return { c, created: false };
  }

  function onListResponse(key, u, headers, json) {
    const api = u.pathname + u.search;
    const items = findItems(json);
    if (!items) {
      const n = normApi(u.pathname);
      state.other.set(n, (state.other.get(n) || 0) + 1);
      return;
    }
    const ids = items.map(idOf);
    const paged = isPagedUrl(u);
    // ページ送り(2ページ目以降)の応答は古い投稿なので、先頭ページのURLだけ学習して基準は取り直す
    const head = paged ? headUrl(u) : u;
    saveTemplate(key, head, headers);
    const { c, created } = upsertCandidate(key, head, headers, paged ? null : ids);
    if (created) {
      pushLog(state.seen, { t: Date.now(), key, api: head.pathname + head.search, note: paged ? 'ページ送りから先頭ページURLを推定して登録' : `先頭ページ${ids.length}件を登録` });
      if (paged) scheduleBaseline(c, 500);
    }
    state.pick = null;
    updateOverlay();
  }

  // 先頭ページを取得して「表示済みID」の基準にする
  async function baseline(c) {
    if (c.known || c.baselining) return;
    c.baselining = true;
    const rec = { t: Date.now(), key: routeKey(), api: c.cid, note: '基準取得' };
    try {
      const res = await origFetch(freshUrl(c.url), { headers: c.headers, credentials: 'include', cache: 'no-store' });
      rec.status = res.status;
      if (!res.ok) return;
      const items = findItems(await res.json());
      if (!items) { rec.note = '基準取得: 応答から投稿リストを取れず'; return; }
      if (!c.known) { c.known = new Set(items.map(idOf)); c.size = items.length; }
      rec.total = items.length;
    } catch (e) {
      rec.note = String(e);
    } finally {
      c.baselining = false;
      pushLog(state.polls, rec);
    }
  }
  function scheduleBaseline(c, delay) {
    setTimeout(() => { if (state.settings.enabled && !c.known) baseline(c); }, delay);
  }

  // 保存済みの先頭ページURLから候補を復元(再読込直後でもポーリングできるように)
  function restoreTemplate() {
    if (SETTINGS_ANY_RE.test(location.pathname)) return;
    const key = routeKey();
    const m = state.routes.get(key);
    if (m && m.size) return;
    const t = loadTemplates()[key];
    if (!t || !t.href) return;
    try {
      const u = new URL(t.href, location.origin);
      const { c } = upsertCandidate(key, u, t.headers || {}, null);
      pushLog(state.seen, { t: Date.now(), key, api: u.pathname + u.search, note: '保存済みURLから復元' });
      scheduleBaseline(c, 1500);
    } catch (e) {}
  }

  // 画面内リンクに含まれる数字(投稿ID等)
  function collectDomIds() {
    const s = new Set();
    document.querySelectorAll('a[href]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/\d+/g);
      if (m) m.forEach((x) => s.add(x));
    });
    return s;
  }

  // 現在のページに複数の候補がある場合、DOM上の投稿と一番一致するAPIを選ぶ
  function pickCandidate(key, force) {
    const m = state.routes.get(key);
    if (!m || !m.size) return null;
    if (!force && state.pick && state.pick.key === key && Date.now() - state.pick.t < 3000) return state.pick.c;
    const domIds = collectDomIds();
    let best = null;
    let bestScore = -1;
    for (const c of m.values()) {
      let match = 0;
      if (c.known) for (const id of c.known) if (domIds.has(id)) match++;
      c.match = match;
      const score = match * 10000 + (LIST_PATH_RE.test(c.pathname) ? 1000 : 0) + c.size;
      if (score > bestScore) { best = c; bestScore = score; }
    }
    state.pick = { key, c: best, t: Date.now() };
    return best;
  }

  // ===== ポーリング =====
  // ?token=<13桁の時刻> のようなキャッシュ回避パラメータは毎回更新する
  function freshUrl(href) {
    try {
      const u = new URL(href);
      if (/^\d{13}$/.test(u.searchParams.get('token') || '')) u.searchParams.set('token', String(Date.now()));
      return u.href;
    } catch (e) { return href; }
  }

  async function poll() {
    if (!state.settings.enabled || state.busy || document.hidden) return;
    if (SETTINGS_ANY_RE.test(location.pathname)) return;
    const key = routeKey();
    const c = pickCandidate(key, true);
    if (!c) {
      pushLog(state.polls, { t: Date.now(), key, note: 'このページ用のTL APIが未検出' });
      return;
    }
    state.busy = true;
    state.lastPoll = Date.now();
    try {
      if (!c.known) { await baseline(c); return; } // 基準が無ければ今回は基準取得のみ
      const rec = { t: Date.now(), key, api: c.cid, domMatch: c.match };
      try {
        const res = await origFetch(freshUrl(c.url), { headers: c.headers, credentials: 'include', cache: 'no-store' });
        rec.status = res.status;
        if (!res.ok) return;
        const items = findItems(await res.json());
        if (!items) { rec.note = '応答から投稿リストを取れず'; return; }
        const ids = items.map(idOf);
        const fresh = ids.filter((id) => !c.known.has(id));
        c.pending = new Set(fresh);
        c.capped = fresh.length > 0 && fresh.length === ids.length;
        rec.total = ids.length;
        rec.fresh = fresh.length;
        rec.atTop = isAtTop();
        if (fresh.length && rec.atTop) applyUpdate(false);
        else updateOverlay();
      } catch (e) {
        rec.note = String(e);
      } finally {
        pushLog(state.polls, rec);
      }
    } finally {
      state.busy = false;
    }
  }

  function restartTimer() {
    clearInterval(state.timer);
    state.timer = null;
    if (state.settings.enabled) state.timer = setInterval(poll, state.settings.interval * 1000);
  }

  // 最上部にいる時は、そのまま更新を反映(ページ再読込)
  function applyUpdate(force) {
    if (!force && (isTyping() || document.getElementById(MODAL_ID))) return updateOverlay();
    try {
      const last = Number(sessionStorage.getItem(RL_KEY) || 0);
      if (!force && Date.now() - last < 30000) return;
      sessionStorage.setItem(RL_KEY, String(Date.now()));
    } catch (e) {}
    location.reload();
  }

  // ===== オーバーレイ通知 =====
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = `
#${OVERLAY_ID}{position:fixed;top:calc(env(safe-area-inset-top,0px) + 64px);left:50%;transform:translate(-50%,-8px);z-index:2147483000;padding:8px 16px;border-radius:999px;background:#2f80ed;color:#fff;font:600 14px/1.2 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.3);cursor:pointer;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;user-select:none;-webkit-tap-highlight-color:transparent;white-space:nowrap}
#${OVERLAY_ID}.show{opacity:1;transform:translate(-50%,0);pointer-events:auto}
#${MODAL_ID}{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;color-scheme:light}
#${MODAL_ID}[data-theme="dark"]{color-scheme:dark}
#${MODAL_ID} .card{--bg:#fff;--fg:#222;--sub:#666;--line:#bbb;--field:#fff;--btn:#f4f4f4;background:var(--bg);color:var(--fg);border-radius:12px;padding:20px;width:min(360px,100%);max-height:100%;overflow-y:auto;font:14px/1.6 system-ui,sans-serif;box-sizing:border-box}
#${MODAL_ID}[data-theme="dark"] .card{--bg:#2a2a2e;--fg:#eee;--sub:#aaa;--line:#666;--field:#1b1b1e;--btn:#3a3a40}
#${MODAL_ID} h2{margin:0 0 12px;font-size:16px;color:var(--fg)}
#${MODAL_ID} label{display:block;margin:10px 0 4px;color:var(--fg)}
#${MODAL_ID} .row{display:flex;align-items:center;gap:8px}
#${MODAL_ID} input[type=number],#${MODAL_ID} textarea{background:var(--field) !important;color:var(--fg) !important;-webkit-text-fill-color:var(--fg) !important;border:1px solid var(--line) !important;border-radius:6px;padding:6px 8px;font-size:16px;box-sizing:border-box;opacity:1}
#${MODAL_ID} input[type=number]{width:100px}
#${MODAL_ID} .note{margin-top:10px;font-size:12px;color:var(--sub);word-break:break-all}
#${MODAL_ID} textarea{display:none;width:100%;margin-top:8px;font-size:11px}
#${MODAL_ID} .btns{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
#${MODAL_ID} button{padding:8px 16px;border-radius:8px;border:1px solid var(--line) !important;background:var(--btn) !important;color:var(--fg) !important;font-size:14px;cursor:pointer}
#${MODAL_ID} button.primary{background:#2f80ed !important;border-color:#2f80ed !important;color:#fff !important}
#${ITEM_ID}{cursor:pointer}
`;
    (document.head || document.documentElement).appendChild(st);
  }

  function ensureOverlay() {
    let el = document.getElementById(OVERLAY_ID);
    if (el || !document.body) return el;
    ensureStyle();
    el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.addEventListener('click', onOverlayTap);
    document.body.appendChild(el);
    return el;
  }

  function updateOverlay() {
    const c = SETTINGS_ANY_RE.test(location.pathname) ? null : pickCandidate(routeKey(), false);
    const n = c ? c.pending.size : 0;
    const show = n > 0 && !isAtTop();
    const el = show ? ensureOverlay() : document.getElementById(OVERLAY_ID);
    if (!el) return;
    if (show) el.textContent = `↑ 新着 ${n}${c.capped ? '+' : ''}件(タップで最上部へ)`;
    el.classList.toggle('show', show);
  }

  function onOverlayTap() {
    const els = scrollables();
    els.forEach((e) => e.scrollTo({ top: 0, behavior: 'smooth' }));
    const start = Date.now();
    const wait = () => {
      if (els.every((e) => e.scrollTop <= 2) || Date.now() - start > 1500) applyUpdate(true);
      else setTimeout(wait, 50);
    };
    wait();
  }

  // スクロール監視(オーバーレイの出し入れ / 手動で最上部に戻ったら反映)
  let scrollRaf = 0;
  let scrollTimer = 0;
  document.addEventListener('scroll', () => {
    if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateOverlay(); });
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (SETTINGS_ANY_RE.test(location.pathname)) return;
      const c = pickCandidate(routeKey(), false);
      if (c && c.pending.size && isAtTop()) applyUpdate(false);
    }, 300);
  }, { capture: true, passive: true });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.settings.enabled && Date.now() - state.lastPoll >= state.settings.interval * 1000) poll();
  });

  // ===== 設定画面への項目追加 =====
  function findItemGroup(root) {
    const groups = new Map();
    root.querySelectorAll('a, button, [role="button"], li').forEach((el) => {
      if (el.closest(`nav, aside, header, footer, #${ITEM_ID}, #${MODAL_ID}`)) return;
      if (!(el.textContent || '').trim() || el.offsetParent === null) return;
      const p = el.parentElement;
      if (!p) return;
      const arr = groups.get(p) || [];
      arr.push(el);
      groups.set(p, arr);
    });
    let best = null;
    for (const [parent, arr] of groups) {
      const same = arr.filter((e) => e.tagName === arr[0].tagName);
      if (same.length >= 2 && (!best || same.length > best.items.length)) best = { parent, items: same };
    }
    return best;
  }

  function prepareClone(node) {
    node.removeAttribute('id');
    node.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    node.querySelectorAll('input, [role="switch"]').forEach((n) => n.remove());
    [node, ...node.querySelectorAll('*')].forEach((n) => {
      if (n.tagName === 'A') { n.setAttribute('href', '#'); n.removeAttribute('target'); }
      n.classList.remove('router-link-active', 'router-link-exact-active', 'active', 'is-active');
      n.removeAttribute('aria-current');
    });
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let first = true;
    const texts = [];
    while (walker.nextNode()) if (walker.currentNode.nodeValue.trim()) texts.push(walker.currentNode);
    texts.forEach((t) => { t.nodeValue = first ? LABEL : ''; first = false; });
  }

  // Nuxt(Vue)のハイドレーション完了を待つ。完了前にDOMへ要素を足すと、Vueが余計な要素として
  // 消したり、既存項目と取り違えて上書きしてしまう(リロード時にUIが消える原因)。
  let readySince = 0;
  function appReady() {
    let ok = document.readyState === 'complete';
    const root = document.getElementById('__nuxt');
    if (!root || !root.__vue_app__) ok = false;
    try {
      const nuxt = root && root.__vue_app__ && root.__vue_app__.config.globalProperties.$nuxt;
      if (nuxt && nuxt.isHydrating) ok = false;
    } catch (e) {}
    if (!ok) { readySince = 0; return false; }
    if (!readySince) readySince = Date.now();
    return Date.now() - readySince >= 600; // 完了後も少し待つ
  }

  function ensureSettingsEntry() {
    const existing = document.getElementById(ITEM_ID);
    if (!SETTINGS_PATH_RE.test(location.pathname)) { if (existing) existing.remove(); return; }
    if (!appReady()) { scheduleInject(300); return; }
    if (existing) {
      if (existing.isConnected && existing.textContent.trim() === LABEL) return;
      existing.remove(); // 表示が壊れている場合は作り直す
    }
    const root = document.querySelector('main') || document.body;
    if (!root) return;
    ensureStyle();

    // 「アカウント」項目(li)を複製して、その直下に挿入する
    const accountLink = document.querySelector('a[href$="/settings/account"]');
    const accountLi = accountLink && accountLink.closest('li');
    const group = accountLi ? null : findItemGroup(root);
    let node;
    if (accountLi) {
      node = accountLi.cloneNode(true);
      prepareClone(node);
      accountLi.after(node);
    } else if (group) {
      const first = group.items[0];
      node = first.cloneNode(true);
      prepareClone(node);
      first.after(node);
    } else {
      node = document.createElement('button');
      node.type = 'button';
      node.textContent = LABEL;
      node.style.cssText = 'display:block;width:100%;padding:16px;text-align:left;background:none;border:0;border-top:1px solid rgba(128,128,128,.3);color:inherit;font:inherit';
      root.appendChild(node);
    }
    node.id = ITEM_ID;
    node.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openModal(); }, true);
  }

  let injectTimer = 0;
  const scheduleInject = (delay = 150) => {
    clearTimeout(injectTimer);
    injectTimer = setTimeout(ensureSettingsEntry, delay);
  };

  // ===== 診断レポート =====
  function buildReport() {
    const tm = (t) => new Date(t).toLocaleTimeString();
    const L = [];
    L.push(`script: 1.2.2 / page: ${location.pathname}${location.search}`);
    L.push(`settings: ${JSON.stringify(state.settings)} / timer: ${state.timer ? 'on' : 'off'}`);
    L.push(`routes: ${state.routes.size}`);
    for (const [key, m] of state.routes) {
      L.push(`[route] ${key}`);
      for (const c of m.values()) L.push(`  - ${c.cid} size=${c.size} known=${c.known ? c.known.size : '基準未取得'} pending=${c.pending.size} domMatch=${c.match}`);
    }
    L.push('--- 保存済み先頭ページURL ---');
    const tpl = loadTemplates();
    Object.keys(tpl).forEach((k) => L.push(`${k} => ${tpl[k].href}`));
    L.push('--- 投稿リスト以外のAPI(種別:回数) ---');
    state.other.forEach((n, k) => L.push(`${k} : ${n}`));
    L.push('--- 観測したAPI(末尾が最新) ---');
    state.seen.forEach((s) => L.push(`${tm(s.t)} [${s.key}] ${s.api} : ${s.note}`));
    L.push('--- ポーリング結果 ---');
    state.polls.forEach((p) => L.push(`${tm(p.t)} [${p.key}] ${JSON.stringify({ ...p, t: undefined, key: undefined })}`));
    return L.join('\n');
  }

  // ===== 設定モーダル(時間の入力) =====
  // サイトの背景色からダークテーマかどうかを判定する
  function siteIsDark() {
    for (const el of [document.querySelector('.bg-surface'), document.body, document.documentElement]) {
      if (!el) continue;
      const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
      if (!m) continue;
      const [r, g, b, a = 1] = m.map(Number);
      if (a === 0) continue;
      return 0.299 * r + 0.587 * g + 0.114 * b < 128;
    }
    return matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function openModal() {
    if (document.getElementById(MODAL_ID)) return;
    ensureStyle();
    const s = state.settings;
    let cands = 0;
    state.routes.forEach((m) => { cands += m.size; });
    const wrap = document.createElement('div');
    wrap.id = MODAL_ID;
    wrap.dataset.theme = siteIsDark() ? 'dark' : 'light';
    wrap.innerHTML = `
<div class="card" role="dialog" aria-modal="true">
  <h2>${LABEL}</h2>
  <label class="row"><input type="checkbox" data-k="enabled"> 自動更新を有効にする</label>
  <label>更新間隔(秒・${MIN_INTERVAL}以上)</label>
  <div class="row"><input type="number" data-k="interval" min="${MIN_INTERVAL}" step="1" inputmode="numeric"> 秒</div>
  <div class="note" data-k="status"></div>
  <textarea data-k="report" rows="8" readonly></textarea>
  <div class="btns"><button type="button" data-k="diag">診断</button><button type="button" data-k="cancel">キャンセル</button><button type="button" class="primary" data-k="save">保存</button></div>
</div>`;
    const q = (k) => wrap.querySelector(`[data-k="${k}"]`);
    q('enabled').checked = s.enabled;
    q('interval').value = s.interval;
    q('status').textContent = cands
      ? `TL API候補: ${cands}件検出済み`
      : 'TL APIは未検出です。タイムラインを開いて少しスクロールしてから、もう一度ここを開いてください。';

    const close = () => wrap.remove();
    q('cancel').addEventListener('click', close);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    q('diag').addEventListener('click', () => {
      const text = buildReport();
      const ta = q('report');
      ta.value = text;
      ta.style.display = 'block';
      try {
        navigator.clipboard.writeText(text).then(() => { q('status').textContent = '診断結果をクリップボードにコピーしました'; }, () => {});
      } catch (e) {}
    });
    q('save').addEventListener('click', () => {
      state.settings = { enabled: q('enabled').checked, interval: clampInterval(q('interval').value) };
      saveSettings();
      restartTimer();
      close();
    });
    document.body.appendChild(wrap);
  }

  // ===== SPA遷移の検知 =====
  const onRoute = () => { state.pick = null; updateOverlay(); scheduleInject(); setTimeout(restoreTemplate, 300); };
  ['pushState', 'replaceState'].forEach((k) => {
    const orig = history[k];
    history[k] = function () {
      const r = orig.apply(this, arguments);
      queueMicrotask(onRoute);
      return r;
    };
  });
  window.addEventListener('popstate', onRoute);

  new MutationObserver(() => scheduleInject()).observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener('DOMContentLoaded', restoreTemplate);
  if (document.readyState !== 'loading') restoreTemplate();
  restartTimer();
  window.__tlAuto = { state, poll, buildReport }; // デバッグ用
})();
