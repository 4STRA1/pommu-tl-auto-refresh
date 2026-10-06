// ==UserScript==
// @name         Pommu タイムライン自動更新
// @namespace    https://github.com/4STRA1/pommu-tl-auto-refresh
// @version      1.2.0
// @description  Pommuのタイムラインを一定間隔で確認し、新着投稿を自動反映する
// @author       4STRA1
// @license      MIT
// @match        https://ch.dlsite.com/pommu/*
// @run-at       document-start
// @grant        none
// @homepageURL  https://github.com/4STRA1/pommu-tl-auto-refresh
// @supportURL   https://github.com/4STRA1/pommu-tl-auto-refresh/issues
// ==/UserScript==

(() => {
  'use strict';

  // =========================================================
  // 設定
  // =========================================================

  const LABEL = 'タイムラインの自動更新';

  const LS_KEY = 'tlAutoRefresh.settings';

  const MIN_INTERVAL = 20;
  const DEFAULT_INTERVAL = 60;

  // この位置以下なら「最上部」と判断
  const TOP_THRESHOLD = 80;

  const SETTINGS_PATH_RE =
    /\/settings?(\/|$)/;

  const PAGED_KEY_RE =
    /^(cursor|offset|before|after|max_id|older|until_id|since_id)$/i;

  const ITEM_ID = 'tl-auto-item';
  const MODAL_ID = 'tl-auto-modal';
  const OVERLAY_ID = 'tl-auto-overlay';
  const STYLE_ID = 'tl-auto-style';

  const origFetch =
    window.fetch.bind(window);

  // =========================================================
  // 状態
  // =========================================================

  const state = {
    settings: loadSettings(),

    candidates: new Map(),

    timer: null,
    busy: false,
    lastPoll: 0,

    // 新着通知を表示中か
    hasNew: false,
  };

  // =========================================================
  // 設定
  // =========================================================

  function loadSettings() {
    try {
      const s = JSON.parse(
        localStorage.getItem(LS_KEY) || '{}'
      );

      return {
        enabled: !!s.enabled,
        interval: clampInterval(s.interval),
      };

    } catch (e) {
      return {
        enabled: false,
        interval: DEFAULT_INTERVAL,
      };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify(state.settings)
      );
    } catch (e) {}
  }

  function clampInterval(value) {
    const n =
      Math.floor(Number(value));

    if (!Number.isFinite(n)) {
      return DEFAULT_INTERVAL;
    }

    return Math.max(
      MIN_INTERVAL,
      n
    );
  }

  // =========================================================
  // スクロール
  // =========================================================

  function getScroller() {
    let el =
      document.elementFromPoint(
        innerWidth / 2,
        innerHeight / 2
      );

    while (
      el &&
      el !== document.body &&
      el !== document.documentElement
    ) {
      const oy =
        getComputedStyle(el).overflowY;

      if (
        (
          oy === 'auto' ||
          oy === 'scroll' ||
          oy === 'overlay'
        ) &&
        el.scrollHeight >
          el.clientHeight + 1
      ) {
        return el;
      }

      el = el.parentElement;
    }

    return (
      document.scrollingElement ||
      document.documentElement
    );
  }

  function isAtTop() {
    return (
      getScroller().scrollTop <=
      TOP_THRESHOLD
    );
  }

  function isTyping() {
    const a =
      document.activeElement;

    return !!a && (
      a.tagName === 'INPUT' ||
      a.tagName === 'TEXTAREA' ||
      a.isContentEditable
    );
  }

  // =========================================================
  // API判定
  // =========================================================

  function isPagedUrl(url) {
    for (
      const [key, value]
      of url.searchParams
    ) {
      if (
        (
          key === 'page' ||
          key === 'p'
        ) &&
        Number(value) > 1
      ) {
        return true;
      }

      if (
        PAGED_KEY_RE.test(key) &&
        value
      ) {
        return true;
      }
    }

    return false;
  }

  function pickHeaders(input, init) {
    const result = {};

    try {
      const headers =
        new Headers(
          (init && init.headers) ||
          (input && input.headers) ||
          undefined
        );

      headers.forEach(
        (value, key) => {
          if (
            !/^(content-length|host|cookie)$/i.test(
              key
            )
          ) {
            result[key] = value;
          }
        }
      );

    } catch (e) {}

    return result;
  }

  // =========================================================
  // 投稿ID
  // =========================================================

  function idOf(item) {
    if (
      !item ||
      typeof item !== 'object'
    ) {
      return null;
    }

    const id =
      item.id ??
      item.postId ??
      (
        item.post &&
        item.post.id
      ) ??
      (
        item.data &&
        item.data.id
      );

    return id == null
      ? null
      : String(id);
  }

  // =========================================================
  // 投稿配列を探す
  // =========================================================

  function findItems(json, depth = 0) {
    if (Array.isArray(json)) {

      if (
        json.length &&
        json.every(
          item =>
            idOf(item) != null
        )
      ) {
        return json;
      }

      return null;
    }

    if (
      json &&
      typeof json === 'object' &&
      depth < 5
    ) {
      let best = null;

      for (
        const value
        of Object.values(json)
      ) {
        const result =
          findItems(
            value,
            depth + 1
          );

        if (
          result &&
          (
            !best ||
            result.length > best.length
          )
        ) {
          best = result;
        }
      }

      return best;
    }

    return null;
  }

  // =========================================================
  // APIレスポンスを学習
  // =========================================================

  function learnApi(
    url,
    headers,
    json
  ) {
    if (
      !url ||
      url.origin !== location.origin
    ) {
      return;
    }

    if (
      !url.pathname.includes('/api/')
    ) {
      return;
    }

    if (
      SETTINGS_PATH_RE.test(
        location.pathname
      )
    ) {
      return;
    }

    if (
      isPagedUrl(url)
    ) {
      return;
    }

    const items =
      findItems(json);

    if (!items) {
      return;
    }

    const ids =
      items
        .map(idOf)
        .filter(Boolean);

    if (!ids.length) {
      return;
    }

    const pathname =
      url.pathname;

    let score =
      ids.length;

    if (
      /post|timeline|feed|home|tl/i.test(
        pathname
      )
    ) {
      score += 1000;
    }

    let candidate =
      state.candidates.get(
        pathname
      );

    // -------------------------------------------------------
    // 新しい候補
    // -------------------------------------------------------

    if (!candidate) {

      candidate = {
        url: url.href,
        headers: headers || {},
        score,
        known: new Set(ids),

        // ここが重要
        // 新着通知を保持する
        pending: new Set(),

        capped: false,
      };

      state.candidates.set(
        pathname,
        candidate
      );

      console.log(
        '[tl-auto] TL API検出:',
        url.href,
        `(${ids.length}件)`
      );

      return;
    }

    // -------------------------------------------------------
    // 同じAPI
    // -------------------------------------------------------

    candidate.url =
      url.href;

    candidate.headers =
      headers || candidate.headers;

    candidate.score =
      Math.max(
        candidate.score,
        score
      );

    // -------------------------------------------------------
    // 重要
    //
    // 通常のPommu側API取得では
    // pendingを消さない。
    //
    // 以前はここで
    // pending.clear()
    // していたため、
    // オーバーレイが消えていた。
    // -------------------------------------------------------

    ids.forEach(
      id => candidate.known.add(id)
    );

    ensureOverlayAlive();

    updateOverlay();
  }

  // =========================================================
  // FETCH監視
  // =========================================================

  window.fetch =
    function(input, init) {

      const promise =
        origFetch(
          input,
          init
        );

      try {
        inspectFetch(
          input,
          init,
          promise
        );
      } catch (e) {
        console.warn(
          '[tl-auto] fetch監視エラー',
          e
        );
      }

      return promise;
    };

  function inspectFetch(
    input,
    init,
    promise
  ) {
    const rawUrl =
      typeof input === 'string'
        ? input
        : (
            input &&
            input.url
          ) ||
          String(input);

    const method =
      String(
        (
          init &&
          init.method
        ) ||
        (
          input &&
          input.method
        ) ||
        'GET'
      ).toUpperCase();

    if (
      method !== 'GET'
    ) {
      return;
    }

    let url;

    try {
      url =
        new URL(
          rawUrl,
          location.href
        );
    } catch (e) {
      return;
    }

    if (
      url.origin !==
      location.origin
    ) {
      return;
    }

    if (
      !url.pathname.includes('/api/')
    ) {
      return;
    }

    if (
      isPagedUrl(url)
    ) {
      return;
    }

    const headers =
      pickHeaders(
        input,
        init
      );

    promise
      .then(res => {

        if (!res.ok) {
          return;
        }

        return res
          .clone()
          .json()
          .then(json => {

            learnApi(
              url,
              headers,
              json
            );

          });
      })
      .catch(() => {});
  }

  // =========================================================
  // XHR監視
  // =========================================================

  const OrigXHR =
    window.XMLHttpRequest;

  const xhrOpen =
    OrigXHR.prototype.open;

  const xhrSend =
    OrigXHR.prototype.send;

  const xhrSetHeader =
    OrigXHR.prototype.setRequestHeader;

  OrigXHR.prototype.open =
    function(method, url) {

      this.__tlAutoMethod =
        String(
          method || 'GET'
        ).toUpperCase();

      try {
        this.__tlAutoUrl =
          new URL(
            url,
            location.href
          );
      } catch (e) {
        this.__tlAutoUrl = null;
      }

      this.__tlAutoHeaders = {};

      return xhrOpen.apply(
        this,
        arguments
      );
    };

  OrigXHR.prototype.setRequestHeader =
    function(name, value) {

      try {
        if (
          this.__tlAutoHeaders
        ) {
          this.__tlAutoHeaders[name] =
            value;
        }
      } catch (e) {}

      return xhrSetHeader.apply(
        this,
        arguments
      );
    };

  OrigXHR.prototype.send =
    function() {

      const xhr = this;

      try {

        if (
          xhr.__tlAutoMethod === 'GET' &&
          xhr.__tlAutoUrl &&
          xhr.__tlAutoUrl.origin ===
            location.origin &&
          xhr.__tlAutoUrl.pathname.includes(
            '/api/'
          ) &&
          !isPagedUrl(
            xhr.__tlAutoUrl
          )
        ) {

          xhr.addEventListener(
            'load',
            function() {

              try {

                if (
                  xhr.status < 200 ||
                  xhr.status >= 300
                ) {
                  return;
                }

                const text =
                  xhr.responseText;

                if (!text) {
                  return;
                }

                const json =
                  JSON.parse(text);

                learnApi(
                  xhr.__tlAutoUrl,
                  xhr.__tlAutoHeaders,
                  json
                );

              } catch (e) {}

            }
          );
        }

      } catch (e) {}

      return xhrSend.apply(
        this,
        arguments
      );
    };

  console.log(
    '[tl-auto] fetch / XHR監視開始'
  );

  // =========================================================
  // 最も有力なAPI
  // =========================================================

  function getBestCandidate() {

    return [...state.candidates.values()]
      .sort(
        (a, b) =>
          b.score - a.score
      )[0] || null;
  }

  // =========================================================
  // 保留中の新着件数
  // =========================================================

  function getPendingCount() {

    const candidate =
      getBestCandidate();

    return candidate
      ? candidate.pending.size
      : 0;
  }

  // =========================================================
  // ポーリング
  // =========================================================

  async function poll() {

    if (
      !state.settings.enabled
    ) {
      scheduleNextPoll();
      return;
    }

    if (
      state.busy
    ) {
      scheduleNextPoll();
      return;
    }

    if (
      document.hidden
    ) {
      scheduleNextPoll();
      return;
    }

    if (
      SETTINGS_PATH_RE.test(
        location.pathname
      )
    ) {
      scheduleNextPoll();
      return;
    }

    const candidate =
      getBestCandidate();

    if (!candidate) {

      console.log(
        '[tl-auto] 監視対象APIがまだありません'
      );

      scheduleNextPoll();
      return;
    }

    state.busy = true;
    state.lastPoll =
      Date.now();

    try {

      console.log(
        '[tl-auto] 自動チェック:',
        candidate.url
      );

      const response =
        await origFetch(
          candidate.url,
          {
            method: 'GET',
            headers:
              candidate.headers,
            credentials:
              'include',
            cache:
              'no-store',
          }
        );

      if (!response.ok) {

        console.warn(
          '[tl-auto] APIエラー:',
          response.status
        );

        return;
      }

      const json =
        await response.json();

      const items =
        findItems(json);

      if (!items) {

        console.warn(
          '[tl-auto] 投稿一覧を取得できませんでした'
        );

        return;
      }

      const ids =
        items
          .map(idOf)
          .filter(Boolean);

      // -----------------------------------------------------
      // 新着判定
      // -----------------------------------------------------

      const fresh =
        ids.filter(
          id =>
            !candidate.known.has(id)
        );

      if (fresh.length) {

        // 既存のpendingに追加
        fresh.forEach(
          id =>
            candidate.pending.add(id)
        );

        candidate.capped =
          candidate.pending.size >= ids.length;

        state.hasNew = true;

        console.log(
          '[tl-auto] 新着:',
          fresh.length,
          '件 / 保留:',
          candidate.pending.size,
          '件'
        );

        // 新着IDを既知にする
        fresh.forEach(
          id =>
            candidate.known.add(id)
        );

        ensureOverlayAlive();

        // 最上部でも自動リロードしない
        // ユーザーがオーバーレイを押した時に更新する

        updateOverlay();

      } else {

        console.log(
          '[tl-auto] 新着なし'
        );

        // pendingが残っている場合は
        // オーバーレイを維持する

        ensureOverlayAlive();
        updateOverlay();
      }

    } catch (e) {

      console.warn(
        '[tl-auto] 自動チェック失敗:',
        e
      );

    } finally {

      state.busy = false;

      // -----------------------------------------------------
      // 重要
      //
      // 必ず次回チェックを予約する
      // -----------------------------------------------------

      scheduleNextPoll();
    }
  }

  // =========================================================
  // 次回ポーリング
  // =========================================================

  function scheduleNextPoll() {

    clearTimeout(
      state.timer
    );

    state.timer = null;

    if (
      !state.settings.enabled
    ) {
      return;
    }

    state.timer =
      setTimeout(
        () => {
          state.timer = null;
          poll();
        },
        state.settings.interval * 1000
      );
  }

  function restartTimer() {

    clearTimeout(
      state.timer
    );

    state.timer = null;

    if (
      !state.settings.enabled
    ) {
      console.log(
        '[tl-auto] 自動更新OFF'
      );

      return;
    }

    console.log(
      '[tl-auto] 自動更新ON:',
      state.settings.interval,
      '秒'
    );

    scheduleNextPoll();
  }

  // =========================================================
  // ページ更新
  // =========================================================

  function applyUpdate() {

    if (
      isTyping()
    ) {
      return;
    }

    try {
      sessionStorage.setItem(
        'tlAutoRefresh.lastReload',
        String(Date.now())
      );
    } catch (e) {}

    // 保留中を消してから更新
    const candidate =
      getBestCandidate();

    if (candidate) {
      candidate.pending.clear();
      candidate.capped = false;
    }

    state.hasNew = false;

    const overlay =
      document.getElementById(
        OVERLAY_ID
      );

    if (overlay) {
      overlay.classList.remove(
        'show'
      );
    }

    location.reload();
  }

  // =========================================================
  // スタイル
  // =========================================================

  function ensureStyle() {

    if (
      document.getElementById(
        STYLE_ID
      )
    ) {
      return;
    }

    const style =
      document.createElement(
        'style'
      );

    style.id =
      STYLE_ID;

    style.textContent = `
#${OVERLAY_ID}{
  position:fixed;
  top:calc(env(safe-area-inset-top,0px) + 64px);
  left:50%;
  transform:translate(-50%,0);
  z-index:2147483000;
  padding:9px 16px;
  border-radius:999px;
  background:#2f80ed;
  color:#fff;
  font:600 14px/1.2 system-ui,sans-serif;
  box-shadow:0 2px 10px rgba(0,0,0,.3);
  cursor:pointer;
  opacity:0;
  pointer-events:none;
  transition:opacity .2s;
  user-select:none;
  white-space:nowrap;
}

#${OVERLAY_ID}.show{
  opacity:1;
  pointer-events:auto;
}

#${MODAL_ID}{
  position:fixed;
  inset:0;
  z-index:2147483001;
  background:rgba(0,0,0,.5);
  display:flex;
  align-items:center;
  justify-content:center;
  padding:16px;
  box-sizing:border-box;
}

#${MODAL_ID} .card{
  background:#fff;
  color:#222;
  border-radius:12px;
  padding:20px;
  width:min(360px,100%);
  font:14px/1.6 system-ui,sans-serif;
  box-sizing:border-box;
}

#${MODAL_ID} h2{
  margin:0 0 12px;
  font-size:16px;
}

#${MODAL_ID} label{
  display:block;
  margin:10px 0 4px;
}

#${MODAL_ID} .row{
  display:flex;
  align-items:center;
  gap:8px;
}

#${MODAL_ID} input[type=number]{
  width:100px;
  padding:6px 8px;
  font-size:16px;
  border:1px solid #bbb;
  border-radius:6px;
  box-sizing:border-box;
}

#${MODAL_ID} .note{
  margin-top:10px;
  font-size:12px;
  color:#666;
  word-break:break-all;
}

#${MODAL_ID} .btns{
  display:flex;
  justify-content:flex-end;
  gap:8px;
  margin-top:16px;
}

#${MODAL_ID} button{
  padding:8px 16px;
  border-radius:8px;
  border:1px solid #bbb;
  background:#f4f4f4;
  color:#222;
  font-size:14px;
}

#${MODAL_ID} button.primary{
  background:#2f80ed;
  border-color:#2f80ed;
  color:#fff;
}

#${ITEM_ID}{
  cursor:pointer;
}
`;

    (
      document.head ||
      document.documentElement
    ).appendChild(style);
  }

  // =========================================================
  // オーバーレイ
  // =========================================================

  function ensureOverlay() {

    let el =
      document.getElementById(
        OVERLAY_ID
      );

    if (
      !document.body
    ) {
      return null;
    }

    ensureStyle();

    if (
      el &&
      el.isConnected
    ) {
      return el;
    }

    el =
      document.createElement(
        'div'
      );

    el.id =
      OVERLAY_ID;

    el.addEventListener(
      'click',
      onOverlayTap
    );

    document.body.appendChild(
      el
    );

    return el;
  }

  function ensureOverlayAlive() {

    if (
      !state.hasNew
    ) {
      return;
    }

    if (
      SETTINGS_PATH_RE.test(
        location.pathname
      )
    ) {
      return;
    }

    const el =
      ensureOverlay();

    if (!el) {
      return;
    }

    updateOverlay();
  }

  function updateOverlay() {

    const candidate =
      getBestCandidate();

    const count =
      candidate
        ? candidate.pending.size
        : 0;

    const shouldShow =
      state.hasNew &&
      count > 0 &&
      !isAtTop() &&
      !SETTINGS_PATH_RE.test(
        location.pathname
      );

    const el =
      shouldShow
        ? ensureOverlay()
        : document.getElementById(
            OVERLAY_ID
          );

    if (!el) {
      return;
    }

    if (shouldShow) {

      el.textContent =
        `↑ 新着 ${count}${candidate.capped ? '+' : ''}件　タップで表示`;

      el.classList.add(
        'show'
      );

    } else {

      // 最上部にいる場合でも
      // pending自体は消さない

      el.classList.remove(
        'show'
      );
    }
  }

  function onOverlayTap() {

    const scroller =
      getScroller();

    scroller.scrollTo({
      top:0,
      behavior:'smooth'
    });

    const start =
      Date.now();

    const wait = () => {

      if (
        scroller.scrollTop <= 2 ||
        Date.now() - start > 1500
      ) {

        applyUpdate();

      } else {

        setTimeout(
          wait,
          50
        );

      }
    };

    wait();
  }

  // =========================================================
  // スクロール監視
  // =========================================================

  let scrollRaf = 0;

  document.addEventListener(
    'scroll',
    () => {

      if (!scrollRaf) {

        scrollRaf =
          requestAnimationFrame(
            () => {

              scrollRaf = 0;

              updateOverlay();

            }
          );
      }

    },
    {
      capture:true,
      passive:true,
    }
  );

  // =========================================================
  // 設定画面
  // =========================================================

  function getSettingsMenu() {

    if (
      !SETTINGS_PATH_RE.test(
        location.pathname
      )
    ) {
      return null;
    }

    const accountLink =
      document.querySelector(
        'a[href="/pommu/settings/account"]'
      );

    if (!accountLink) {
      return null;
    }

    return accountLink.closest(
      'ul.menu'
    );
  }

  function ensureSettingsEntry() {

    const old =
      document.getElementById(
        ITEM_ID
      );

    if (
      !SETTINGS_PATH_RE.test(
        location.pathname
      )
    ) {

      if (old) {
        old.remove();
      }

      return;
    }

    const menu =
      getSettingsMenu();

    if (!menu) {
      return;
    }

    if (
      old &&
      old.isConnected
    ) {

      updateSettingsEntry(old);

      return;
    }

    const node =
      document.createElement('li');

    node.id =
      ITEM_ID;

    node.className =
      'h-12';

    node.innerHTML = `
<span
  class="flex size-full items-center justify-between py-0 text-body-md text-on-surface px-3"
  role="button"
  tabindex="0"
>
  <span>${LABEL}</span>

  <span
    data-k="summary"
    class="text-body-sm text-on-surface-variant whitespace-nowrap"
  ></span>
</span>
`;

    const row =
      node.querySelector(
        '[role="button"]'
      );

    row.addEventListener(
      'click',
      e => {
        e.preventDefault();
        e.stopPropagation();
        openModal();
      }
    );

    row.addEventListener(
      'keydown',
      e => {

        if (
          e.key === 'Enter' ||
          e.key === ' '
        ) {

          e.preventDefault();

          openModal();
        }
      }
    );

    const accountItem =
      menu.querySelector(
        'a[href="/pommu/settings/account"]'
      )?.closest('li');

    if (accountItem) {
      accountItem.after(node);
    } else {
      menu.prepend(node);
    }

    updateSettingsEntry(node);
  }

  function updateSettingsEntry(node) {

    if (!node) {
      return;
    }

    const summary =
      node.querySelector(
        '[data-k="summary"]'
      );

    if (!summary) {
      return;
    }

    summary.textContent =
      state.settings.enabled
        ? `${state.settings.interval}秒`
        : 'オフ';
  }

  let injectTimer = 0;

  function scheduleInject() {

    clearTimeout(
      injectTimer
    );

    injectTimer =
      setTimeout(
        ensureSettingsEntry,
        150
      );
  }

  // =========================================================
  // 設定モーダル
  // =========================================================

  function openModal() {

    if (
      document.getElementById(
        MODAL_ID
      )
    ) {
      return;
    }

    ensureStyle();

    const wrap =
      document.createElement(
        'div'
      );

    wrap.id =
      MODAL_ID;

    wrap.innerHTML = `
<div
  class="card"
  role="dialog"
  aria-modal="true"
>
  <h2>${LABEL}</h2>

  <label class="row">
    <input
      type="checkbox"
      data-k="enabled"
    >
    自動更新を有効にする
  </label>

  <label>
    更新間隔（秒・${MIN_INTERVAL}以上）
  </label>

  <div class="row">
    <input
      type="number"
      data-k="interval"
      min="${MIN_INTERVAL}"
      step="1"
      inputmode="numeric"
    >
    秒
  </div>

  <div
    class="note"
    data-k="status"
  >
    タイムラインを一度表示すると監視対象APIを自動検出します。
  </div>

  <div class="btns">

    <button
      type="button"
      data-k="cancel"
    >
      キャンセル
    </button>

    <button
      type="button"
      class="primary"
      data-k="save"
    >
      保存
    </button>

  </div>
</div>
`;

    const q =
      key =>
        wrap.querySelector(
          `[data-k="${key}"]`
        );

    q('enabled').checked =
      state.settings.enabled;

    q('interval').value =
      state.settings.interval;

    const close =
      () => wrap.remove();

    q('cancel')
      .addEventListener(
        'click',
        close
      );

    wrap.addEventListener(
      'click',
      e => {

        if (
          e.target === wrap
        ) {
          close();
        }

      }
    );

    q('save')
      .addEventListener(
        'click',
        () => {

          state.settings = {
            enabled:
              q('enabled').checked,

            interval:
              clampInterval(
                q('interval').value
              ),
          };

          saveSettings();

          restartTimer();

          updateSettingsEntry(
            document.getElementById(
              ITEM_ID
            )
          );

          close();

        }
      );

    document.body.appendChild(
      wrap
    );
  }

  // =========================================================
  // SPA遷移
  // =========================================================

  function onRoute() {

    scheduleInject();

    ensureOverlayAlive();

    updateOverlay();
  }

  [
    'pushState',
    'replaceState',
  ].forEach(
    name => {

      const original =
        history[name];

      history[name] =
        function() {

          const result =
            original.apply(
              this,
              arguments
            );

          queueMicrotask(
            onRoute
          );

          return result;
        };
    }
  );

  window.addEventListener(
    'popstate',
    onRoute
  );

  // =========================================================
  // DOM監視
  // =========================================================

  new MutationObserver(
    () => {

      scheduleInject();

      // Pommuの再描画で
      // オーバーレイが消えた場合に復活
      if (state.hasNew) {
        ensureOverlayAlive();
      }

    }
  ).observe(
    document.documentElement,
    {
      childList:true,
      subtree:true,
    }
  );

  // =========================================================
  // 初期化
  // =========================================================

  ensureStyle();

  restartTimer();

  window.__tlAuto = {
    state,
    poll,
    restartTimer,
    ensureOverlayAlive,
  };

  console.log(
    '[tl-auto] 起動完了'
  );

})();