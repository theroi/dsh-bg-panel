/* ============================================================================
 * dsh-bg-panel —— 客户端半边（浏览器产物）
 *
 * 入口：侧边栏列表里的一项「背景」（sidebar.panellist），点开由 main 槽位渲染的面板。
 * 面板能力：当前背景预览 / 导入图片或视频 / 待应用预览后再确认 / 历史图库（选中·预览·删除）
 *          / 铺满方式·暗化·模糊·面板透明 四个参数。
 *
 * 背景层：往 <body> 头部插一个 #dsh-bg-panel-layer（position:fixed; z-index:-2），
 *   图片与 GIF 用 background-image（GIF 会动），视频用 <video autoplay muted loop>，
 *   遮罩是同层里的一个 div；再把 #root 抬到 z-index:1。清除时元素、样式、属性一起撤掉。
 *
 * 已知取舍：这是皮肤型插件，必须操作组件之外的 DOM（背景本就在组件之外）；做法与
 *   blue-fantasy 皮肤一致，所有改动都在 apply 的 effect 里成对注册/撤销。
 * ========================================================================== */
window.__ModuleLoader__.load({
  id: 'dsh-bg-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;

    const API = '/dsh-bg-panel';
    const PANEL_ID = 'bg-panel';
    const LAYER_ID = 'dsh-bg-panel-layer';
    const STYLE_ID = 'dsh-bg-panel-style';
    const ROW_STYLE_ID = 'dsh-bg-panel-row-style';
    const ATTR = 'data-dsh-bg-panel';
    const MAX_UPLOAD = 64 * 1024 * 1024;

    const DEFAULTS = {
      active: '', fit: 'cover', dim: 20, blur: 0, palette: '', translucent: true, accent: '',
      posX: 0.5, posY: 0.5, zoom: 1,
      videoLoop: true, videoMuted: true, videoRate: 1, gifFps: 0,
    };

    /* ------------------------------------------------------------ 全局状态 */

    const state = { config: Object.assign({}, DEFAULTS), items: [], dir: '', base: '', error: '', loaded: false };
    const subs = new Set();

    function emit() {
      subs.forEach(function (fn) {
        try { fn(); } catch (err) { /* 单个订阅者出错不影响别人 */ }
      });
    }
    function subscribe(fn) {
      subs.add(fn);
      return function () { subs.delete(fn); };
    }

    // URL 必须稳定：以前带 Date.now()，每次渲染都是新 URL → 浏览器重新加载图片 →
    // 触发 onLoad → nat 变新对象 → 复位 effect 跟着触发 → 缩放与位置被弹回，
    // 表现就是"滑块拖不动、图片拖不动"。只在文件真变了（上传/删除）时 bustUrls()。
    const urlCache = new Map();
    function fileUrl(name) {
      let url = urlCache.get(name);
      if (!url) {
        // 必须用宿主下发的绝对地址：页面基准是 dsh-app://app/ 时，
        // 相对路径会被解析到那个协议上，媒体一律 404（已用 getComputedStyle 验过）。
        url = (state.base || API) + '/file?name=' + encodeURIComponent(name) + '&v=' + Date.now();
        urlCache.set(name, url);
      }
      return url;
    }
    function bustUrls() { urlCache.clear(); blobUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} }); blobUrls.clear(); }

    // 媒体统一走 blob：页面在 dsh-app:// 协议下，直接引用 http:// 地址会被浏览器挡掉
    // （net::ERR_FAILED），而 fetch 是通的 —— 拉成 blob 再转 objectURL 就能显示，
    // 视频也照样能拖进度（blob 支持 seek）。
    const blobUrls = new Map();
    function mediaUrl(name) {
      if (!name) return '';
      if (blobUrls.has(name)) return blobUrls.get(name);
      blobUrls.set(name, ''); // 占位：正在拉，别重复请求
      // 必须用绝对 http 地址：相对地址在 dsh-app:// 协议下取不到 /file（404），
      // 而绝对地址是跨源请求，靠宿主新加的 CORS 头放行。
      fetch((state.base || API) + '/file?name=' + encodeURIComponent(name))
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
        .then(function (b) {
          blobUrls.set(name, URL.createObjectURL(b));
          applyLayer();
          emit();
        })
        .catch(function () { blobUrls.delete(name); });
      return '';
    }

    // 图片/视频的原始尺寸：预览框的遮罩几何与背景层的像素定位都要用。
    const dimsCache = new Map();
    function getDims(name, cb) {
      const hit = dimsCache.get(name);
      if (hit) { cb(hit); return function () {}; }
      let alive = true;
      function deliver(w, h) {
        const d = { w: w || 16, h: h || 9 };
        dimsCache.set(name, d);
        if (alive) cb(d);
      }
      if (kindOf(name) === 'video') {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.muted = true;
        v.onloadedmetadata = function () { deliver(v.videoWidth, v.videoHeight); };
        v.src = mediaUrl(name);
      } else {
        const im = new Image();
        im.onload = function () { deliver(im.naturalWidth, im.naturalHeight); };
        im.src = mediaUrl(name);
      }
      return function () { alive = false; };
    }

    // 背景层与预览框共用的几何：给定视口、原图尺寸、zoom 与位置，
    // 算出「可见区域」在原图坐标系里的矩形。两边用同一套公式 = 所见即所得。
    function visibleRect(iw, ih, vw, vh, cfg) {
      const zoom = cfg.zoom || 1;
      const s = Math.max(vw / iw, vh / ih) * zoom; // cover 比例 × 缩放
      const sw = vw / s;
      const sh = vh / s;
      const px = (cfg.posX == null ? 0.5 : cfg.posX);
      const py = (cfg.posY == null ? 0.5 : cfg.posY);
      return { s: s, sw: sw, sh: sh, sx: px * (iw - sw), sy: py * (ih - sh) };
    }
    function kindOf(name) {
      return /\.(mp4|webm|mov|m4v|ogv)$/i.test(name || '') ? 'video' : 'image';
    }
    function formatBytes(n) {
      if (!n && n !== 0) return '';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    }

    async function api(path, options) {
      const res = await fetch(API + path, options);
      let body = {};
      try { body = await res.json(); } catch (err) { body = {}; }
      if (!res.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + res.status);
      return body;
    }

    async function refresh() {
      try {
        const data = await api('/list');
        state.config = Object.assign({}, DEFAULTS, data.config || {});
        state.items = Array.isArray(data.items) ? data.items : [];
        state.dir = data.dir || '';
        state.base = data.base || '';
        state.error = '';
      } catch (err) {
        state.error = String((err && err.message) || err);
      }
      state.loaded = true;
      applyLayer();
      emit();
    }

    // 宿主接口没接上时给一句人话：常见原因是宿主进程还是旧代码（插件装卸后没重启）
    function hostHint() {
      if (!state.error) return '';
      if (/40[4589]|Failed to fetch|NetworkError/i.test(state.error)) {
        return '宿主接口没响应（' + state.error + '）。若刚更新过本插件，重启一次 DSH 让宿主半边重新加载即可。';
      }
      return state.error;
    }

    async function saveConfig(patch) {
      state.config = Object.assign({}, state.config, patch);
      applyLayer();
      emit();
      try {
        const data = await api('/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state.config),
        });
        state.config = Object.assign({}, DEFAULTS, data.config || {});
        state.error = '';
      } catch (err) {
        state.error = String((err && err.message) || err);
      }
      applyLayer();
      emit();
    }

    /* ------------------------------------------------------------ 背景层 */

    // 「面板半透明」= 把承载面板底色的那几个 token 换成带 alpha 的值。
    // 关键：必须**按主题分开给值**（皮肤 blue-fantasy 就是这么做的：亮色一套、暗色一套）。
    // 以前只有一份写死的 rgba(255,255,255,.62)，暗色主题下所有按钮就变成亮灰 —— 那是人家写错了。
    const TOKEN_OVERRIDES = [
      "body[data-dsh-bg-panel]{--dsw-static-amber-100:#f7ecd8;--dsw-static-amber-400:#d9a94f;--dsw-static-amber-500:#c08a33;--dsw-static-amber-600:#a3732a;--dsw-static-amber-900:#4a3515;--dsw-static-blue-100:#dce3f7;--dsw-static-blue-300:#a5b7e2;--dsw-static-blue-400:#7f96d2;--dsw-static-blue-450:#647ebf;--dsw-static-blue-500:#4a5fa8;--dsw-static-blue-50:#eef1fb;--dsw-static-blue-50p:#e4eaf7;--dsw-static-blue-600:#3c4e92;--dsw-static-blue-75:#dce3f7;--dsw-static-blue-800:#2c3765;--dsw-static-blue-950:#141a2b;--dsw-static-deepseek-100:#dce3f7;--dsw-static-deepseek-200:#c3cfee;--dsw-static-deepseek-300:#a5b7e2;--dsw-static-deepseek-400:#7f96d2;--dsw-static-deepseek-450:#647ebf;--dsw-static-deepseek-500:#4a5fa8;--dsw-static-deepseek-50:#eef1fb;--dsw-static-deepseek-600:#3c4e92;--dsw-static-deepseek-700-delete:#33417a;--dsw-static-deepseek-800:#2c3765;--dsw-static-deepseek-900:#222b4d;--dsw-static-green-100:#dcefe2;--dsw-static-green-400:#5cb877;--dsw-static-green-500:#2e8e52;--dsw-static-green-900:#1e3f2c;--dsw-static-neutral-00:#fff;--dsw-static-neutral-1000:#0e1220;--dsw-static-neutral-100:#eef0f6;--dsw-static-neutral-150:#e6e9f1;--dsw-static-neutral-200:#dee2ec;--dsw-static-neutral-250:#d6dae6;--dsw-static-neutral-300:#c7ccda;--dsw-static-neutral-400:#a8afc2;--dsw-static-neutral-500:#8b93a9;--dsw-static-neutral-50:#f7f8fb;--dsw-static-neutral-550:#7b839a;--dsw-static-neutral-600:#6b738a;--dsw-static-neutral-700:#535b73;--dsw-static-neutral-800:#3b4257;--dsw-static-neutral-850:#343b4f;--dsw-static-neutral-900:#262c3e;--dsw-static-neutral-bluish-00:#fff;--dsw-static-neutral-bluish-1000:#0e1220;--dsw-static-neutral-bluish-100:#e3e8f2;--dsw-static-neutral-bluish-150:#dae0ec;--dsw-static-neutral-bluish-200:#d1d8e6;--dsw-static-neutral-bluish-250:#c7cfe0;--dsw-static-neutral-bluish-300:#b4bed4;--dsw-static-neutral-bluish-400:#909dbb;--dsw-static-neutral-bluish-500:#7280a3;--dsw-static-neutral-bluish-50:#f2f5fa;--dsw-static-neutral-bluish-600:#5b6989;--dsw-static-neutral-bluish-60:#edf1f8;--dsw-static-neutral-bluish-700:#48567a;--dsw-static-neutral-bluish-750:#3e4b6d;--dsw-static-neutral-bluish-75:#e7ecf5;--dsw-static-neutral-bluish-800:#303b59;--dsw-static-neutral-bluish-850:#2a3450;--dsw-static-neutral-bluish-875:#242d46;--dsw-static-neutral-bluish-900:#1d2539;--dsw-static-neutral-bluish-950:#141a2b;--dsw-static-red-100:#f7d9d9;--dsw-static-red-400:#e05c5c;--dsw-static-red-500:#c00000;--dsw-static-red-50:#fbecec;--dsw-static-red-600:#a00000;--dsw-static-red-900:#5c1010;--dsw-alias-bg-base:#ffffff73;--dsw-alias-bg-layer-1:#f3f5fb80;--dsw-alias-bg-layer-2:#e9edf78c;--dsw-alias-bg-layer-3:#dde3f194;--dsw-alias-bg-mask-1:#1c254666;--dsw-alias-bg-mask-2:#1c254633;--dsw-alias-bg-mask-3:#1c254680;--dsw-alias-bg-mask-photo:#101424e0;--dsw-alias-bg-module-platform:#e9edf78c;--dsw-alias-bg-multi-select:#dce3f7cc;--dsw-alias-bg-overlay:#eef1f9eb;--dsw-alias-bg-skeleton:#1c25460f;--dsw-alias-border-inverted2:#fff9;--dsw-alias-border-inverted:#fff6;--dsw-alias-border-l1:#2c3a7326;--dsw-alias-border-l2-darkmode-thin:#2c3a7333;--dsw-alias-border-l2:#2c3a7338;--dsw-alias-border-l3:#2c3a7352;--dsw-alias-border-l4:#2c3a736b;--dsw-alias-brand-primary-invert:#fff;--dsw-alias-brand-primary-new-colorprimary-new-color:#4a5fa8;--dsw-alias-brand-primary:#4a5fa8;--dsw-alias-brand-text:#222b4d;--dsw-alias-button-contrast-fill:#3c4e92;--dsw-alias-button-elevated-fill:#fff;--dsw-alias-button-floating-fill:#fff;--dsw-alias-button-floating-hover:#e9edf7;--dsw-alias-button-ghost-active-border:#a5b7e2;--dsw-alias-button-ghost-active-fill:#dce3f7;--dsw-alias-button-ghost-active-hover:#c3cfee;--dsw-alias-button-info-fill:#4a5fa8;--dsw-alias-button-info-hover:#5d74c4;--dsw-alias-button-primary-dimmed:#dce3f7;--dsw-alias-button-primary-fill:#4a5fa8;--dsw-alias-button-primary-hover:#5d74c4;--dsw-alias-button-tool-bar-fill-invisible:#4a5fa85c;--dsw-alias-button-tool-bar-fill:#4a5fa880;--dsw-alias-button-tool-bar-hover:#4a5fa899;--dsw-alias-interactive-bg-active:#4a5fa824;--dsw-alias-interactive-bg-hover-accent:#4a5fa82e;--dsw-alias-interactive-bg-hover-danger:#c000000f;--dsw-alias-interactive-bg-hover-solid:#e4eaf7;--dsw-alias-interactive-bg-hover:#4a5fa814;--dsw-alias-label-caption:#7c8bab;--dsw-alias-label-dimmed:#909dbb;--dsw-alias-label-primary-dimmed:#3e4b6d;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-label-primary-inverted:#fff;--dsw-alias-label-primary:#1d2539;--dsw-alias-label-secondary:#3e4b6d;--dsw-alias-label-tertiary:#5f6e93;--dsw-alias-markdown-citation:#e9edf799;--dsw-alias-markdown-code-block-banner:#f3f5fb94;--dsw-alias-markdown-code-block:#f3f5fb94;--dsw-alias-markdown-code-segment-selected:#fffc;--dsw-alias-markdown-code-segment-unselected:#eef1f999;--dsw-alias-markdown-inline-code:#e7ecf599;--dsw-alias-markdown-placeholder:#f3f5fb94;--dsw-alias-markdown-tag:#e7ecf599;--dsw-alias-scrollbar-bg-l1:#d8dfec;--dsw-alias-scrollbar-bg-l2:#d8dfec;--dsw-alias-scrollbar-hover-l1:#a5b7e2;--dsw-alias-scrollbar-hover-l2:#a5b7e2;--dsw-alias-state-business-primary:#4a5fa8;--dsw-alias-state-business-tertiary:#dce3f7;--dsw-alias-state-error-primary:#c00000;--dsw-alias-state-error-secondary:#e05c5c;--dsw-alias-state-success-primary:#2e8e52;--dsw-alias-state-success-secondary:#58b058;--dsw-alias-state-success-tertiary:#dcefe2;--dsw-alias-state-warn-label:#a3732a;--dsw-alias-state-warn-primary:#c08a33;--dsw-alias-state-warn-secondary:#d9a94f;--dsw-alias-state-warn-tertiary:#f7ecd8;--dsw-alias-toast-bg:#3c4e92;--dsw-alias-tooltip-bg:#ffffe1;--dsw-specific-bubble-highlight:#c3cfee;--dsw-specific-bubble:#dce3f7;--dsw-specific-input-major:#fff9;--dsw-specific-login-input:#fff9;--dsw-specific-menu:#f3f5fbf0;--dsw-specific-selector:#e4eaf7d9;--dsw-specific-sidebar-fill:#f2f5fa80;--dsw-specific-sidebar-nav-item-active-accent:#a5b7e2;--dsw-specific-sidebar-nav-item-active:#dce3f7;--dsw-specific-sidebar-nav-item-hover:#e4eaf7;--dsw-specific-tip:#f3f5fb}",
      "body[data-dsh-bg-panel][data-ds-dark-theme]{--dsw-static-amber-100:#4a3515;--dsw-static-amber-400:#d9a94f;--dsw-static-amber-500:#c08a33;--dsw-static-amber-600:#a3732a;--dsw-static-amber-900:#4a3515;--dsw-static-blue-100:#2c3765;--dsw-static-blue-300:#3c4e92;--dsw-static-blue-400:#4a5fa8;--dsw-static-blue-450:#647ebf;--dsw-static-blue-500:#7f96d2;--dsw-static-blue-50:#222b4d;--dsw-static-blue-50p:#26304f;--dsw-static-blue-600:#94a8dc;--dsw-static-blue-75:#283352;--dsw-static-blue-800:#b4c3e8;--dsw-static-blue-950:#c9d4ef;--dsw-static-deepseek-100:#2c3765;--dsw-static-deepseek-200:#33417a;--dsw-static-deepseek-300:#3c4e92;--dsw-static-deepseek-400:#4a5fa8;--dsw-static-deepseek-450:#647ebf;--dsw-static-deepseek-500:#7f96d2;--dsw-static-deepseek-50:#222b4d;--dsw-static-deepseek-600:#94a8dc;--dsw-static-deepseek-700-delete:#a5b7e2;--dsw-static-deepseek-800:#b4c3e8;--dsw-static-deepseek-900:#c3cfee;--dsw-static-green-100:#1e3f2c;--dsw-static-green-400:#5cb877;--dsw-static-green-500:#2e8e52;--dsw-static-green-900:#1e3f2c;--dsw-static-neutral-00:#141a2b;--dsw-static-neutral-1000:#e8ebf3;--dsw-static-neutral-100:#1d2539;--dsw-static-neutral-150:#212a40;--dsw-static-neutral-200:#253047;--dsw-static-neutral-250:#2a3550;--dsw-static-neutral-300:#32405e;--dsw-static-neutral-400:#455678;--dsw-static-neutral-500:#586b90;--dsw-static-neutral-50:#191f33;--dsw-static-neutral-550:#64779c;--dsw-static-neutral-600:#7083a8;--dsw-static-neutral-700:#8b9cbc;--dsw-static-neutral-800:#a9b7d0;--dsw-static-neutral-850:#b6c2d8;--dsw-static-neutral-900:#c9d2e2;--dsw-static-neutral-bluish-00:#141a2b;--dsw-static-neutral-bluish-1000:#e8ebf3;--dsw-static-neutral-bluish-100:#232e4a;--dsw-static-neutral-bluish-150:#273352;--dsw-static-neutral-bluish-200:#2c3a5c;--dsw-static-neutral-bluish-250:#324067;--dsw-static-neutral-bluish-300:#3c4c77;--dsw-static-neutral-bluish-400:#4e618f;--dsw-static-neutral-bluish-500:#6276a5;--dsw-static-neutral-bluish-50:#1a2238;--dsw-static-neutral-bluish-600:#788bb4;--dsw-static-neutral-bluish-60:#1d263e;--dsw-static-neutral-bluish-700:#8fa0c2;--dsw-static-neutral-bluish-750:#9baaca;--dsw-static-neutral-bluish-75:#202a44;--dsw-static-neutral-bluish-800:#a9b7d0;--dsw-static-neutral-bluish-850:#b4c0d6;--dsw-static-neutral-bluish-875:#bcc7da;--dsw-static-neutral-bluish-900:#c6cfe0;--dsw-static-neutral-bluish-950:#d4dae7;--dsw-static-red-100:#4a2222;--dsw-static-red-400:#e07070;--dsw-static-red-500:#d05050;--dsw-static-red-50:#3a1c1c;--dsw-static-red-600:#b84040;--dsw-static-red-900:#5c1010;--dsw-alias-bg-base:#10162a80;--dsw-alias-bg-layer-1:#1a22388c;--dsw-alias-bg-layer-2:#202a4499;--dsw-alias-bg-layer-3:#26324fa3;--dsw-alias-bg-mask-1:#0000008c;--dsw-alias-bg-mask-2:#0000004d;--dsw-alias-bg-mask-3:#0009;--dsw-alias-bg-mask-photo:#060914e6;--dsw-alias-bg-module-platform:#202a4499;--dsw-alias-bg-multi-select:#2c3765cc;--dsw-alias-bg-overlay:#1a2238eb;--dsw-alias-bg-skeleton:#ffffff0f;--dsw-alias-border-inverted2:#fff9;--dsw-alias-border-inverted:#fff6;--dsw-alias-border-l1:#a0b4e61f;--dsw-alias-border-l2-darkmode-thin:#a0b4e626;--dsw-alias-border-l2:#a0b4e62e;--dsw-alias-border-l3:#a0b4e642;--dsw-alias-border-l4:#a0b4e657;--dsw-alias-brand-primary-invert:#10141f;--dsw-alias-brand-primary-new-colorprimary-new-color:#7f96d2;--dsw-alias-brand-primary:#7f96d2;--dsw-alias-brand-text:#c3cfee;--dsw-alias-button-contrast-fill:#3c4e92;--dsw-alias-button-elevated-fill:#202a44;--dsw-alias-button-floating-fill:#1a2238;--dsw-alias-button-floating-hover:#2c3765;--dsw-alias-button-ghost-active-border:#647ebf;--dsw-alias-button-ghost-active-fill:#2c3765;--dsw-alias-button-ghost-active-hover:#33417a;--dsw-alias-button-info-fill:#3c4e92;--dsw-alias-button-info-hover:#4a5fa8;--dsw-alias-button-primary-dimmed:#33417a;--dsw-alias-button-primary-fill:#3c4e92;--dsw-alias-button-primary-hover:#4a5fa8;--dsw-alias-button-tool-bar-fill-invisible:#a0b9eb5c;--dsw-alias-button-tool-bar-fill:#a0b9eb80;--dsw-alias-button-tool-bar-hover:#a0b9eb99;--dsw-alias-interactive-bg-active:#a0b9eb24;--dsw-alias-interactive-bg-hover-accent:#a0b9eb33;--dsw-alias-interactive-bg-hover-danger:#e05c5c1f;--dsw-alias-interactive-bg-hover-solid:#2c3765;--dsw-alias-interactive-bg-hover:#ffffff12;--dsw-alias-label-caption:#788bb4;--dsw-alias-label-dimmed:#6276a5;--dsw-alias-label-primary-dimmed:#b4c0d6;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-label-primary-inverted:#10141f;--dsw-alias-label-primary:#dbe2f2;--dsw-alias-label-secondary:#a9b7d0;--dsw-alias-label-tertiary:#8b9cbc;--dsw-alias-markdown-citation:#202a449e;--dsw-alias-markdown-code-block-banner:#171e33a8;--dsw-alias-markdown-code-block:#171e33a8;--dsw-alias-markdown-code-segment-selected:#26324fbf;--dsw-alias-markdown-code-segment-unselected:#1a223899;--dsw-alias-markdown-inline-code:#1e27409e;--dsw-alias-markdown-placeholder:#1a223899;--dsw-alias-markdown-tag:#1e27409e;--dsw-alias-scrollbar-bg-l1:#33406a;--dsw-alias-scrollbar-bg-l2:#33406a;--dsw-alias-scrollbar-hover-l1:#4a5fa8;--dsw-alias-scrollbar-hover-l2:#4a5fa8;--dsw-alias-state-business-primary:#7f96d2;--dsw-alias-state-business-tertiary:#2c3765;--dsw-alias-state-error-primary:#e05c5c;--dsw-alias-state-error-secondary:#e07070;--dsw-alias-state-success-primary:#58b058;--dsw-alias-state-success-secondary:#58b058;--dsw-alias-state-success-tertiary:#1e3f2c;--dsw-alias-state-warn-label:#d9a94f;--dsw-alias-state-warn-primary:#d9a94f;--dsw-alias-state-warn-secondary:#d9a94f;--dsw-alias-state-warn-tertiary:#4a3515;--dsw-alias-toast-bg:#33417a;--dsw-alias-tooltip-bg:#ffffe1;--dsw-specific-bubble-highlight:#33417a;--dsw-specific-bubble:#2c3765;--dsw-specific-input-major:#1a2238a6;--dsw-specific-login-input:#1a2238a6;--dsw-specific-menu:#1a2238f0;--dsw-specific-selector:#1e2740d9;--dsw-specific-sidebar-fill:#1d25398c;--dsw-specific-sidebar-nav-item-active-accent:#33417a;--dsw-specific-sidebar-nav-item-active:#2c3765;--dsw-specific-sidebar-nav-item-hover:#202a44;--dsw-specific-tip:#1a2238}",
    ].join('');

    // 可选配色：键是 palette 的值，值是挂到 body[data-dsh-bg-panel] 上的一整段主题 token 覆盖。
    // 目前只有 blue-fantasy 一套（gen-tokens.js 从皮肤里抄的 160 个 token × 亮暗两套）；
    // 以后抄到别的皮肤，这里加一项、下拉里加一个 option 即可。
    const PALETTES = { '': '', 'blue-fantasy': TOKEN_OVERRIDES };

    // 预设主题：卡片壁纸（渐变）+ 主题色
    const THEME_PRESETS = [
      { name: '默认蓝', c: '#0078d4', g: 'linear-gradient(135deg,#0b3d91,#0a6ed1)' },
      { name: '湖水青', c: '#00b7c3', g: 'linear-gradient(135deg,#00565e,#00b7c3)' },
      { name: '森林绿', c: '#107c10', g: 'linear-gradient(135deg,#063d06,#107c10)' },
      { name: '琥珀金', c: '#ffb900', g: 'linear-gradient(135deg,#6b4b00,#ffb900)' },
      { name: '朱红', c: '#e81123', g: 'linear-gradient(135deg,#4a0a10,#e81123)' },
      { name: '紫罗兰', c: '#8764b8', g: 'linear-gradient(135deg,#2b1f47,#8764b8)' },
      { name: '薄荷', c: '#00cc6a', g: 'linear-gradient(135deg,#00402a,#00cc6a)' },
      { name: '石墨', c: '#5d5d5d', g: 'linear-gradient(135deg,#1c1c1c,#5d5d5d)' },
    ];
    // ---- 方案甲：整套配色的色相旋转 ----
    function rgbToHsl(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
      if (max === min) return [0, 0, l];
      const d = max - min;
      const sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      let h;
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      return [h * 60, sat, l];
    }
    function hslToRgb(h, sat, l) {
      h = ((h % 360) + 360) % 360 / 360;
      if (sat === 0) { const v = Math.round(l * 255); return [v, v, v]; }
      const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat, pp = 2 * l - q;
      function f(t) {
        let x = t; if (x < 0) x += 1; if (x > 1) x -= 1;
        if (x < 1 / 6) return pp + (q - pp) * 6 * x;
        if (x < 1 / 2) return q;
        if (x < 2 / 3) return pp + (q - pp) * (2 / 3 - x) * 6;
        return pp;
      }
      return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
    }
    // 把 CSS 文本里所有颜色按 delta 度旋转色相（近灰色保持不动）
    function rotCss(text, delta) {
      const re = /#[0-9a-fA-F]{6}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)/g;
      return text.replace(re, function (m) {
        let r, g, b, a = null;
        if (m.charAt(0) === '#') {
          r = parseInt(m.slice(1, 3), 16); g = parseInt(m.slice(3, 5), 16); b = parseInt(m.slice(5, 7), 16);
        } else {
          const n = m.replace(/rgba?\(|\)/g, '').split(',').map(function (x) { return x.trim(); });
          r = Number(n[0]); g = Number(n[1]); b = Number(n[2]); a = n.length > 3 ? n[3] : null;
        }
        const hsl = rgbToHsl(r, g, b);
        if (hsl[1] < 0.025) return m;   // 近灰（<2.5%）：不动
        // 深色表面往往饱和度极低，直接旋转几乎看不出色调 → 给一个饱和度下限，让主题色显出来
        const sat = hsl[2] < 0.35 ? Math.max(hsl[1], 0.18) : hsl[1];
        const o = hslToRgb(hsl[0] + delta, sat, hsl[2]);
        if (a === null) return '#' + o.map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
        return 'rgba(' + o[0] + ',' + o[1] + ',' + o[2] + ',' + a + ')';
      });
    }
    // 把 CSS 文本里的颜色按 pct 混向白色（alpha 不变）
    function whiteTint(text, pct) {
      const re = /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)/g;
      return text.replace(re, function (m) {
        const n2 = m.replace(/rgba?\(|\)/g, '').split(',').map(function (x) { return x.trim(); });
        const r = Math.round(Number(n2[0]) * (1 - pct) + 255 * pct);
        const g = Math.round(Number(n2[1]) * (1 - pct) + 255 * pct);
        const b = Math.round(Number(n2[2]) * (1 - pct) + 255 * pct);
        const a = n2.length > 3 ? n2[3] : null;
        return a === null ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
      });
    }
    // 把 CSS 文本里所有颜色的 alpha 乘以 f（用于"面板不透明度"）
    function scaleAlpha(text, f) {
      const re = /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*([\d.]+)\s*)?\)/g;
      return text.replace(re, function (m, a) {
        const n2 = m.replace(/rgba?\(|\)/g, '').split(',').map(function (x) { return x.trim(); });
        const al = (a === undefined ? 1 : Number(a)) * f;
        return 'rgba(' + n2[0] + ',' + n2[1] + ',' + n2[2] + ',' + Math.max(0, Math.min(1, al)).toFixed(3) + ')';
      });
    }
    // 基准蓝（主题自带的品牌深蓝）的色相，作为旋转起点
    const BASE_BLUE = '#3c4e92';

    // 取配色一律走这里：任何异常都退化成"不加配色"，绝不让背景层跟着崩
    function paletteCss(id, accent) {
      try {
        const base = PALETTES[id] || '';
        if (!base) return '';
        if (!accent) return base;
        // 方案甲：整套配色按『目标色相 - 基准蓝色相』整体旋转
        const delta = rgbToHsl.apply(null, hexRgb(accent))[0] - rgbToHsl.apply(null, hexRgb(BASE_BLUE))[0];
        return rotCss(base, delta);
      } catch (err) { return ''; }
    }
    // 主题色：给定时先套 blue-fantasy 的 160 token 打底，再把品牌色/按钮色换成用户选的颜色
      // #rrggbb → [r,g,b]
      function hexRgb(hex) {
        const h = String(hex || '').replace('#', '');
        if (!/^[0-9a-fA-F]{6}$/.test(h)) return [74, 95, 168];
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
      }
      // 主题色：只改三个品牌色 token（表面与透明度一律不碰，避免该透明的反而不透明）
      // 主题色是否生效（与「全透明模式」绑定）
      function THEME_ON(cfg) { return (cfg.palette || '') === 'blue-fantasy'; }
      function themeCss(cfg) {
        try {
          // 与「全透明模式」绑定：未勾选时不套主题色（但配置里的 accent 保留）
          const accent = cfg.palette ? cfg.accent : '';
          if (!accent) return '';
          return 'body[' + ATTR + ']{'
            + '--dsw-alias-brand-primary:' + accent + ' !important;'
            + '--dsw-alias-button-primary-fill:' + accent + ' !important;'
            + '--dsw-alias-button-primary-hover:' + accent + ' !important;'
            + '}';
        } catch (err) { return ''; }
      }
      // 元素级兜底：侧栏根 / 顶栏 / 输入框（用类名片段与稳定属性，不用哈希全名）
      // 只对指定 token 的 alpha 做缩放（界面层用；按钮/文字不受影响）
      const SURFACE_TOKENS = ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2',
        '--dsw-alias-bg-layer-3', '--dsw-specific-sidebar-fill', '--dsw-alias-bg-module-platform'];
      function scaleSurfaceAlpha(text, f) {
        return text.split('}').map(function (chunk) {
          const hit = SURFACE_TOKENS.some(function (t) { return chunk.indexOf(t + ':') >= 0; });
          return hit ? scaleAlpha(chunk, f) : chunk;
        }).join('}');
      }
      // 界面层（对话区 + 右侧栏）底色：由 glassAlpha 控制，左侧栏不动
      // #rrggbb → [r,g,b]（保留给以后可能用到的染色）
      function hexRgb(hex) {
        const h = String(hex || '').replace('#', '');
        if (!/^[0-9a-fA-F]{6}$/.test(h)) return [74, 95, 168];
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
      }

// HSL → #rrggbb（色环取色用）
    function hslHex(hDeg, sPct, lPct) {
      const h = ((hDeg % 360) + 360) % 360 / 360, s = sPct / 100, l = lPct / 100;
      function f(p, q, t) {
        let x = t; if (x < 0) x += 1; if (x > 1) x -= 1;
        if (x < 1 / 6) return p + (q - p) * 6 * x;
        if (x < 1 / 2) return q;
        if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
        return p;
      }
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
      const r = Math.round(f(p, q, h + 1 / 3) * 255), g = Math.round(f(p, q, h) * 255), b = Math.round(f(p, q, h - 1 / 3) * 255);
      return '#' + [r, g, b].map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
    }

    // 半透明地基：DSH 的容器底色来自这几个 token，不把它们变透明，
    // 光清 #root 也没用 —— 里面那层依然是不透明的（对比 blue-fantasy：它的 token 覆盖是常驻的）。
    // 亮色用白 alpha、暗色用深蓝 alpha，两套都给，避免暗色主题下变亮灰。
    // 外壳清底：把应用自己的实底扒掉（#root 直接子层、*_frame / *_shell 外壳）
    const SHELL_CLEAR = [
      'body[' + ATTR + '] #root{background:transparent !important;}',
      'body[' + ATTR + '] #root>*{background-color:transparent !important;}',
      'body[' + ATTR + '] [class*="_frame"]{background-color:transparent !important;}',
      'body[' + ATTR + '] [class*="_shell"]{background-color:transparent !important;}',
    ].join('');

    const BASE_TOKENS = [
      'body[' + ATTR + ']{',
      '--dsw-alias-bg-base:transparent !important;',
      '--dsw-alias-bg-layer-1:rgba(255,255,255,.55) !important;',
      '--dsw-alias-bg-layer-2:rgba(255,255,255,.66) !important;',
      '--dsw-alias-bg-layer-3:rgba(255,255,255,.76) !important;',
      '}',
      'body[' + ATTR + '][data-ds-dark-theme]{',
      '--dsw-alias-bg-base:transparent !important;',
      '--dsw-alias-bg-layer-1:rgba(18,24,38,.52) !important;',
      '--dsw-alias-bg-layer-2:rgba(22,29,45,.64) !important;',
      '--dsw-alias-bg-layer-3:rgba(26,34,52,.74) !important;',
      '}',
    ].join('');

    // 深色模式护眼：暗化自动 +20%（浅色模式不变）
    function isDarkTheme() {
      try { return document.body.hasAttribute('data-ds-dark-theme'); } catch (err) { return false; }
    }
    const DARK_DIM_BONUS = 20;
    function effDim(cfg) {
      const base = Number(cfg.dim) || 0;
      return Math.max(0, Math.min(100, base + (isDarkTheme() ? DARK_DIM_BONUS : 0)));
    }
    // 主题切换（深浅）时重画背景层
    let darkWatch = null;
    function watchDarkMode(rerender) {
      if (darkWatch || typeof MutationObserver === 'undefined') return;
      darkWatch = new MutationObserver(function () { try { rerender(); } catch (err) {} });
      darkWatch.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
    }
    function applyLayer() {
      watchDarkMode(function () { try { applyLayer(); if (typeof emit === 'function') emit(); } catch (err) {} });
      const doc = document;
      const cfg = state.config;
      let layer = doc.getElementById(LAYER_ID);
      let style = doc.getElementById(STYLE_ID);

      if (!cfg.active) {
        if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
        if (style && style.parentNode) style.parentNode.removeChild(style);
        if (doc.body) doc.body.removeAttribute(ATTR);
        return;
      }

      const kind = kindOf(cfg.active);
      const src = mediaUrl(cfg.active);
      if (!src) return; // blob 还没到手，等 mediaUrl 回调里再重画（层先留空）
      // 模糊只加 filter，不要再加 transform：像素定位是绝对坐标算出来的，
      // 缩放会让它跟预览对不上；边缘的模糊溢出由 bleed 外扩解决。
      const filter = cfg.blur > 0 ? 'filter:blur(' + cfg.blur + 'px);' : '';

      if (!layer) {
        layer = doc.createElement('div');
        layer.id = LAYER_ID;
        if (doc.body.firstChild) doc.body.insertBefore(layer, doc.body.firstChild);
        else doc.body.appendChild(layer);
      }
      layer.setAttribute('style', 'position:fixed;inset:0;z-index:-2;pointer-events:none;overflow:hidden;');
      while (layer.firstChild) layer.removeChild(layer.firstChild);

      let inner;
      const vw = window.innerWidth || 1920;
      const vh = window.innerHeight || 1080;
      const dims = dimsCache.get(cfg.active);
      const useCover = cfg.fit === 'cover';
      if (useCover && !dims) {
        // 原图尺寸还没到手：先按老办法铺一层，等尺寸回来再精确重排
        getDims(cfg.active, function () { applyLayer(); emit(); });
      }
      const bleed = cfg.blur > 0 ? cfg.blur * 2 : 0;
      if (kind === 'video') {
        // 循环 / 静音 / 倍速三项来自配置（宿主 schema：videoLoop / videoMuted / videoRate）
        const vLoop = cfg.videoLoop !== false;   // false = 播完停在最后一帧
        const vMuted = cfg.videoMuted !== false; // false = 带声音播
        const vRateNum = Number(cfg.videoRate);
        const vRate = isFinite(vRateNum) ? Math.min(2, Math.max(0.25, vRateNum)) : 1;
        inner = doc.createElement('video');
        inner.src = src;
        inner.autoplay = true;
        // 属性先默认为静音：自动播放策略只放行"静音"的无手势播放；
        // 真正生效的是 property，所以要响就把 property 设成 false（属性留着当默认）。
        inner.setAttribute('muted', '');
        inner.muted = vMuted;
        inner.loop = vLoop;
        inner.setAttribute('playsinline', '');
        // 倍速等元数据到手再设：设早了有些内核会忽略
        inner.addEventListener('loadedmetadata', function () {
          try { inner.playbackRate = vRate; } catch (err) { /* 个别内核不认倍速，忽略 */ }
        });
        if (!vMuted) {
          inner.volume = 1;
          // 有声自动播放通常会被浏览器拦下（要求先有用户手势）：第一次点击/触摸时再补一次 play()
          const kick = function () {
            // 两个监听器一起摘：桌面端 touchstart 永远不触发，只靠 once 会一直攒着，
            // 闭包拖着已经下线的旧 video（代码审查指出）
            doc.removeEventListener('click', kick);
            doc.removeEventListener('touchstart', kick);
            if (!inner.isConnected) return; // 层已重画，旧 video 不用管了
            // play() 返回的是 Promise，被策略拦下时是 rejected —— try/catch 接不住它
            const p = inner.play();
            if (p && typeof p.catch === 'function') p.catch(function () { /* 仍被拦就算了，用户还能手动点 */ });
          };
          doc.addEventListener('click', kick, { once: true });
          doc.addEventListener('touchstart', kick, { once: true });
        }
        if (useCover && dims) {
          const r = visibleRect(dims.w, dims.h, vw, vh, cfg);
          inner.setAttribute('style', 'position:absolute;object-fit:fill;'
            + 'left:' + (-r.sx * r.s - bleed) + 'px;top:' + (-r.sy * r.s - bleed) + 'px;'
            + 'width:' + (dims.w * r.s + bleed * 2) + 'px;height:' + (dims.h * r.s + bleed * 2) + 'px;'
            + filter);
        } else {
          inner.setAttribute('style', 'width:100%;height:100%;object-fit:'
            + (cfg.fit === 'contain' ? 'contain' : 'cover') + ';' + filter);
        }
      } else {
        inner = doc.createElement('div');
        if (useCover && dims) {
          const r = visibleRect(dims.w, dims.h, vw, vh, cfg);
          inner.setAttribute('style', 'position:absolute;'
            + 'left:' + (-r.sx * r.s - bleed) + 'px;top:' + (-r.sy * r.s - bleed) + 'px;'
            + 'width:' + (dims.w * r.s + bleed * 2) + 'px;height:' + (dims.h * r.s + bleed * 2) + 'px;'
            + 'background-image:url("' + src + '");background-size:100% 100%;' + filter);
        } else {
          const bg = cfg.fit === 'repeat'
            ? 'background-image:url("' + src + '");background-repeat:repeat;background-size:auto;'
            : 'background-image:url("' + src + '");background-repeat:no-repeat;background-position:center;'
              + 'background-size:' + (cfg.fit === 'contain' ? 'contain' : 'cover') + ';';
          inner.setAttribute('style', 'width:100%;height:100%;' + bg + filter);
        }
      }
      layer.appendChild(inner);

      // 遮罩颜色随主题：深色压暗（黑）/ 浅色提亮（白）——全局层，所有面板/插件自动一致
      const scrimRgb = isDarkTheme() ? '0,0,0' : '255,255,255';
      const scrim = doc.createElement('div');
      scrim.setAttribute('style', 'position:absolute;inset:0;background:rgba(' + scrimRgb + ','
        + (cfg.dim / 100).toFixed(3) + ');');
      layer.appendChild(scrim);

      if (!style) {
        style = doc.createElement('style');
        style.id = STYLE_ID;
        (doc.head || doc.documentElement).appendChild(style);
      }
      // 半透明底层（照抄 blue-fantasy 皮肤的做法）：
      // 皮肤底文件里有 `body[data-dsh-blue-fantasy] [id=root]{background:0 0}` ——
      // DSH 自己给 #root 铺了不透明底色，不清掉它，背景图永远被盖在下面。
      // 这里把 body、html、#root 三层底色一起清成透明，并保留 #root 的层级抬升。
      // 主题色相对基准蓝的色相偏移（0 = 不偏）
      let hueDelta = 0;
      try {
        if (cfg.accent && cfg.palette) {
          hueDelta = rgbToHsl.apply(null, hexRgb(cfg.accent))[0] - rgbToHsl.apply(null, hexRgb(BASE_BLUE))[0];
        }
      } catch (err) { hueDelta = 0; }
      style.textContent = 'html,body{background:transparent !important;}'
        + 'body{background-image:none !important;}'
        + 'body[' + ATTR + '] #root{position:relative;z-index:1;}'
        // 半透明开关：连**外壳清底**一起管（只关 token 的话，外壳那层还在扒底，看着没变化）
        + rotCss(SHELL_CLEAR + BASE_TOKENS, hueDelta)   // 玻璃层恢复原样（不再缩放 token）
        + paletteCss(cfg.palette, cfg.accent)   // 全透明模式：整套配色按主题色旋转（方案甲）（含各类表面 token 的透明）
        + themeCss(cfg);                     // 主题色：只覆盖颜色 token
        + '';                                // （图片透明度在下方按元素设置）
      if (doc.body) doc.body.setAttribute(ATTR, 'on');
    }

    function removeLayer() {
      const doc = document;
      const layer = doc.getElementById(LAYER_ID);
      if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
      const style = doc.getElementById(STYLE_ID);
      if (style && style.parentNode) style.parentNode.removeChild(style);
      if (doc.body) doc.body.removeAttribute(ATTR);
    }

    /* -------------------------------------------------------------- 样式 */

    const CSS = [
      '.dbp-root{display:flex;flex-direction:column;gap:12px;padding:14px 16px 24px;',
      'font-size:13px;line-height:1.6;color:#fff;overflow:auto;height:100%;}',
      '.dbp-h{font-size:14px;font-weight:600;margin:2px 0 0;}',
      // 整个插件面板：30% 白底
      '.dbp-root{background-color:rgba(255,255,255,.30);border-radius:10px;}',
      // 深色模式：白底 → 60% 灰（透明度不变）
      'body[data-ds-dark-theme] .dbp-root,html[data-ds-dark-theme] .dbp-root{background-color:rgba(153,153,153,.30) !important;}',
      'body[data-ds-dark-theme] .dbp-drop,html[data-ds-dark-theme] .dbp-drop{background-color:rgba(153,153,153,.45) !important;}',
      // 深色模式：插件文字改白（覆盖上面的黑色）
      'body[data-ds-dark-theme] .dbp-root{color:#fff !important;}',
      'body[data-ds-dark-theme] .dbp-sub{color:#fff !important;}',
      'body[data-ds-dark-theme] .dbp-tip{color:#fff !important;}',
      'body[data-ds-dark-theme] .dbp-confirm-name{color:#fff !important;}',
      'body[data-ds-dark-theme] .dbp-msg{color:#fff !important;}',

      // 导入 / 拖放区：白底再亮一档
      '.dbp-drop{background-color:rgba(255,255,255,.45) !important;}',
      '.dbp-divider{height:1px;margin:16px 0 4px;',
      'background:var(--dsw-alias-border-l2,rgba(128,128,128,.28));max-width:440px;}',
      '.dbp-sub{font-size:11px;color:#fff;word-break:break-all;}',
      '.dbp-box{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:10px;',
      'overflow:hidden;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));}',
      '.dbp-frame{display:flex;align-items:center;justify-content:center;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));overflow:hidden;padding:4px;min-height:64px;}',
      '.dbp-frame>img,.dbp-frame>video{max-width:100%;max-height:42vh;object-fit:contain;',
      'display:block;border-radius:6px;}',
      '.dbp-empty{display:flex;align-items:center;justify-content:center;height:90px;',
      'color:#fff;font-size:12px;}',
      /* 固定取景框预览：框不动，图在框下平移；框外压暗（可切全黑） */
      '.dbp-stagewrap{position:relative;width:auto;align-self:center;}',
      '.dbp-stage{position:relative;overflow:hidden;border-radius:8px;background:#0b0d14;margin:0 auto;',
      'touch-action:none;}',
      '.dbp-stage.drag{cursor:grab;}',
      '.dbp-stage.drag:active{cursor:grabbing;}',
      '.dbp-stage>img,.dbp-stage>video{position:absolute;user-select:none;pointer-events:none;display:block;}',
      '.dbp-visrect{position:absolute;pointer-events:none;border-radius:2px;',
      'box-shadow:0 0 0 9999px rgba(0,0,0,var(--dbp-dim,.55));outline:1px solid rgba(255,255,255,.85);}',
      '.dbp-preview-row{display:flex;align-items:center;justify-content:center;width:100%;}',
      '.dbp-zoomcol{position:absolute;left:100%;top:50%;transform:translateY(-50%);margin-left:6px;',
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;',
      'padding:8px 5px;border-radius:10px;',
      'background:rgba(0,0,0,.42);border:1px solid rgba(255,255,255,.14);',
      'backdrop-filter:blur(4px);}',
      '.dbp-zoomcol>input[type=range]{writing-mode:vertical-lr;direction:rtl;width:24px;height:170px;',
      'accent-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4a5fa8)));}',
      '.dbp-zoomcol>.dbp-tip{white-space:nowrap;font-size:10px;}',
      '.dbp-badge2{position:absolute;right:4px;top:4px;font-size:10px;padding:1px 5px;border-radius:4px;',
      'background:rgba(0,0,0,.6);color:#fff;}',
      /* 裁剪器：整图等比显示，框内拖动选位 */
      '.dbp-crop-wrap{display:flex;flex-direction:column;gap:8px;width:min(540px,100%);',
      'align-self:flex-start;padding:10px 11px;border-radius:12px;',
      'background:rgba(0,0,0,.42);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(4px);}',
      '.dbp-crop-frame{position:relative;overflow:hidden;border-radius:8px;background:#000;',
      'width:100%;max-width:520px;touch-action:none;cursor:grab;}', // 与主预览同宽
      '.dbp-crop-actions{display:flex;flex-direction:row;gap:8px;flex-wrap:wrap;}',
      '.dbp-crop-actions>.dbp-btn{padding:5px 12px;}',
      '.dbp-crop-frame:active{cursor:grabbing;}',
      '.dbp-crop-frame>img{position:absolute;user-select:none;pointer-events:none;max-width:none;}',
      '.dbp-crop-grid{position:absolute;inset:0;pointer-events:none;',
      'background-image:linear-gradient(to right,rgba(255,255,255,.3) 1px,transparent 1px),',
      'linear-gradient(to bottom,rgba(255,255,255,.3) 1px,transparent 1px);',
      'background-size:33.333% 33.333%;}',
      '.dbp-tip{font-size:11px;color:#fff;}',
      '.dbp-drop{padding:14px;border:1px dashed var(--dsw-alias-border-l3,rgba(0,0,0,.28));',
      'border-radius:10px;text-align:center;cursor:pointer;color:#fff;}',
      '.dbp-drop.on{border-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4a5fa8));',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}',
      '.dbp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;}',
      '.dbp-cell{position:relative;border-radius:8px;overflow:hidden;cursor:pointer;',
      'border:2px solid transparent;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));}',
      '.dbp-cell.sel{border-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4a5fa8));}',
      '.dbp-cell.cur{box-shadow:0 0 0 2px var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4a5fa8)) inset;}',
      '.dbp-thumb{width:100%;height:64px;object-fit:contain;display:block;}',
      '.dbp-name{font-size:10px;padding:3px 5px;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;color:#fff;}',
      '.dbp-del{position:absolute;top:3px;right:3px;width:18px;height:18px;line-height:16px;',
      'text-align:center;border-radius:50%;border:0;cursor:pointer;font-size:12px;',
      'background:rgba(0,0,0,.55);color:#fff;}',
      '.dbp-badge{position:absolute;left:3px;bottom:20px;font-size:9px;padding:1px 4px;',
      'border-radius:4px;background:rgba(0,0,0,.6);color:#fff;}',
      '.dbp-row{display:flex;align-items:center;gap:8px;max-width:440px;}', // 宽面板下不要拉满
      '.dbp-row>label{flex:0 0 76px;color:#fff;font-size:12px;}',
      '.dbp-row>input[type=range]{flex:1;accent-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4a5fa8)));}',
      '.dbp-row>select{flex:1;padding:3px 6px;border-radius:6px;color:inherit;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));',
      'background:var(--dsw-alias-bg-layer-2,transparent);}',
      '.dbp-btn{padding:5px 12px;border-radius:8px;cursor:pointer;font-size:12px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));color:inherit;',
      'background:var(--dsw-alias-bg-layer-2,transparent);}',
      '.dbp-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}',
      '.dbp-btn.primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4a5fa8)));color:var(--dsw-alias-label-primary-inverted,#fff);border-color:transparent;}',
      '.dbp-note{color:#e5484d;font-size:12px;margin:-4px 0 0 2px;}',
      '.dbp-hint{margin:2px 0 0;padding:7px 11px;border-radius:9px;font-size:12px;',
      'background:rgba(128,128,128,.20);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);',
      'border:1px solid rgba(255,255,255,.18);box-shadow:0 2px 10px rgba(0,0,0,.12);}',
      '.dbp-row input:disabled{opacity:.45;filter:grayscale(1);cursor:not-allowed;}',
      '.dbp-row input:disabled+span,.dbp-check input:disabled+span{opacity:.6;}',
      '.dbp-btn:disabled{opacity:.55;cursor:default;filter:grayscale(1);pointer-events:none;}',
      // 方形「恢复默认」按钮：两行两字、居中，距滑杆一段距离
      '.dbp-reset{flex:0 0 auto;margin-left:18px;width:46px;height:46px;padding:0;',
      'display:flex;align-items:center;justify-content:center;text-align:center;',
      'white-space:pre-line;line-height:1.2;font-size:11px;border-radius:8px;cursor:pointer;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));',
      'background:var(--dsw-alias-bg-layer-2,transparent);color:inherit;',
      'transition:background .15s,color .15s,transform .06s;}',
      '.dbp-reset:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.08));',
      'color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4a5fa8));}',
      '.dbp-reset:active{transform:scale(.96);}',
      // 通用按钮悬停/按压过渡
      '.dbp-btn{transition:background .15s,color .15s,transform .06s,filter .15s;}',
      '.dbp-btn:active{transform:scale(.97);}',
      '.dbp-btn.primary:hover{filter:brightness(1.1);}',
      // 危险按钮：红色 + 悬停变亮
      // 柔和危险态：平时低调，悬停变大红
      // 主按钮同款格式：平时浅色底（主题色淡化），悬停实心
      // 淡主题色底 + 一层 12% 微白，避免在深色壁纸上糊成一团
      '.dbp-btn.primary{background:color-mix(in srgb, #ffffff 12%,',
      'color-mix(in srgb, var(--dsw-alias-button-primary-fill, #4a5fa8) 30%, transparent));',
      'color:color-mix(in srgb, #ffffff 70%, var(--dsw-alias-button-primary-fill, #4a5fa8));',
      'border-color:color-mix(in srgb, #ffffff 25%, var(--dsw-alias-button-primary-fill, #4a5fa8));}',
      '.dbp-btn.primary:hover{background:var(--dsw-alias-button-primary-fill, #4a5fa8);color:#fff;',
      'border-color:transparent;filter:none;}',
      '.dbp-btn.danger-soft{background:rgba(229,72,77,.16);color:#e5484d;',
      'border-color:rgba(229,72,77,.38);}',
      '.dbp-btn.danger-soft:hover{background:#e5484d;color:#fff;border-color:transparent;filter:none;}',
      '.dbp-btn.danger-soft:active{background:#c0392b;}',
      '.dbp-btn.danger{background:#c0392b;color:#fff;border-color:transparent;}',
      '.dbp-btn.danger:hover{background:#d9483a;filter:brightness(1.05);}',
      '.dbp-btn.danger:active{background:#a93226;}',
      // 二次确认弹窗
      '.dbp-confirm-mask{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);',
      'backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);',
      'display:flex;align-items:center;justify-content:center;}',
      '.dbp-confirm-card{width:min(400px,92%);padding:20px 22px;border-radius:14px;',
      'background:rgba(20,24,36,.62);color:var(--dsw-alias-label-primary,#eee);',
      'backdrop-filter:blur(12px) saturate(1.1);-webkit-backdrop-filter:blur(12px) saturate(1.1);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));',
      'box-shadow:0 18px 44px rgba(0,0,0,.45);font-size:13px;}',
      '.dbp-confirm-title{font-size:15px;font-weight:600;margin-bottom:8px;}',
      '.dbp-sign{text-align:right;font-size:11px;opacity:.5;margin-top:2px;letter-spacing:.02em;}',
      '.dbp-confirm-name{font-size:12px;color:#fff;',
      'word-break:break-all;margin-bottom:8px;}',
      '.dbp-actions{display:flex;gap:8px;flex-wrap:wrap;}',
      '.dbp-msg{font-size:11px;color:#fff;min-height:16px;}',
      '.dbp-msg.err{color:var(--dsw-alias-label-danger,#c0392b);}',
      '.dbp-check{display:flex;align-items:center;gap:6px;font-size:12px;}',
      /* 侧边栏列表入口的样式**只在全局注入那一份**里定义（见 apply 内的 ROW_STYLE_ID）。
         这里再写一份会导致：面板打开时 span 变成 width:100% + 上下 padding，
         面板关闭时又是另一个尺寸 —— 行内容跟着位移。所以这里一个字都不写。 */
    ].join('');

    /* ------------------------------------------------------------ 小组件 */

    // 回到上一版图标：单色描边（currentColor），跟随宿主行颜色；选中/悬停由父级改色
    function Icon(props) {
      const s = props.size || 18;
      return h('svg', {
        width: s,
        height: s,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }, [

        // 七彩渐变定义（选中时描边引用；未选中由 CSS 压回 currentColor）
        h('defs', { key: 'defs' }, h('linearGradient', {
          id: 'dbp-rainbow', x1: '0', y1: '0', x2: '1', y2: '1',
        }, ['#ff4d4d', '#ff9f43', '#f7d94c', '#4cd964', '#3ec6e0', '#4a7cf7', '#a55cf0']
          .map(function (c, i) {
            return h('stop', { key: i, offset: (i / 6).toFixed(3), stopColor: c });
          }))),
        // 画笔：笔杆 + 刷头 + 蘸料弧线
        h('path', { key: 'a', stroke: 'url(#dbp-rainbow)', d: 'M18.37 2.63 14 7l-1.59-1.59a2 2 0 0 0-2.82 0L8 7l9 9 1.59-1.59a2 2 0 0 0 0-2.82L17 10l4.37-4.37a2.12 2.12 0 1 0-3-3Z' }),
        h('path', { key: 'b', stroke: 'url(#dbp-rainbow)', d: 'M9 8c-2 3-4 3.5-7 4l8 10c2-1 6-5 6-7' }),
        h('path', { key: 'c', stroke: 'url(#dbp-rainbow)', d: 'M14.5 17.5 4.5 15' }),
      ]);
    }

    // 预览 = 分层模拟真实背景：
    //   ① 底层：整张图按 contain 完整显示（异型图、裁剪后的窄条都看得全）
    //   ② 亮框：屏幕上「实际能看到」的区域，几何公式与背景层完全一致 → 所见即所得
    //   ③ 遮罩：亮框之外压暗，提示这部分会被裁掉
    //   ④ 可拖：拖动改 posX/posY，节流后写回配置，真背景同步跟手
    function Preview(props) {
      const name = props.name;
      const cfg = state.config;
      const [dims, setDims] = useState(null);
      const [vp, setVp] = useState({
        w: window.innerWidth || 1920,
        h: window.innerHeight || 1080,
      });
      const [avail, setAvail] = useState(0);
      const [drag, setDrag] = useState(null);
      const wrapRef = useRef(null);

      useEffect(function () {
        if (!name) { setDims(null); return undefined; }
        return getDims(name, setDims);
      }, [name]);

      useEffect(function () {
        function onResize() {
          setVp({ w: window.innerWidth || 1920, h: window.innerHeight || 1080 });
        }
        window.addEventListener('resize', onResize);
        return function () { window.removeEventListener('resize', onResize); };
      }, []);

      useEffect(function () {
        // 测外层容器而不是 stagewrap 自己：stagewrap 是收缩宽度的，
        // 拿它当基准会形成"自己量自己"的循环依赖，预览会缩到最小。
        const el = (wrapRef.current && wrapRef.current.parentElement) || wrapRef.current;
        if (!el) return undefined;
        function measure() {
          const w = el.clientWidth;
          setAvail(function (prev) { return prev === w ? prev : w; });
        }
        measure();
        let ro = null;
        if (typeof ResizeObserver === 'function') {
          ro = new ResizeObserver(measure);
          ro.observe(el);
        }
        window.addEventListener('resize', measure);
        return function () {
          if (ro) ro.disconnect();
          window.removeEventListener('resize', measure);
        };
      }, [name]);

      useEffect(function () {
        return function () { /* 无定时器需要清理（拖动只改草稿，不再节流写配置） */ };
      }, []);

      if (!name) {
        return h('div', { className: 'dbp-box' },
          h('div', { className: 'dbp-empty' }, props.empty || '还没有背景'));
      }

      const iw = dims ? dims.w : 16;
      const ih = dims ? dims.h : 9;
      const base = props.draft || { posX: cfg.posX, posY: cfg.posY, zoom: cfg.zoom };
      // 关键：拖动时的临时值也必须带上 zoom。
      // 以前写成 `drag || base`，drag 只有 {posX,posY} ⇒ 一按下去 zoom 变 undefined ⇒
      // visibleRect 按 zoom=1 重算 ⇒ 图弹回原始大小；而且 zoom=1 时必有一个方向
      // span = 0（无处可拖），那一轴就拖不动 —— 两个症状同一个根因。
      const pos = drag
        ? { posX: drag.posX, posY: drag.posY, zoom: base.zoom }
        : base;
      const geo = visibleRect(iw, ih, vp.w, vp.h, pos);
      const interact = !!props.interactive && cfg.fit === 'cover' && !!dims;

      // 取景框固定：框宽由可用宽度决定，高按屏幕比例；框外留 M 边距给"被裁掉"的部分
      const M = 22;
      const frameW = Math.max(80, Math.min(520, (avail || 320) - M * 2 - 34)); // -34 给右边的竖滑杆留位
      const frameH = frameW / (vp.w / vp.h);
      const k = geo.sw > 0 ? frameW / geo.sw : 1; // 预览里 1 图像像素 = k CSS 像素
      const imgW = iw * k;
      const imgH = ih * k;
      const imgLeft = M - geo.sx * k;
      const imgTop = M - geo.sy * k;

      function onDown(e) {
        if (!interact || !k) return;
        const start = { x: e.clientX, y: e.clientY, posX: pos.posX, posY: pos.posY };
        function move(ev) {
          // 图片跟着鼠标走；只改草稿，不写配置
          const dImgX = (ev.clientX - start.x) / k;
          const dImgY = (ev.clientY - start.y) / k;
          const spanX = iw - geo.sw;
          const spanY = ih - geo.sh;
          const next = {
            posX: spanX > 0 ? Math.min(1, Math.max(0, start.posX - dImgX / spanX)) : 0.5,
            posY: spanY > 0 ? Math.min(1, Math.max(0, start.posY - dImgY / spanY)) : 0.5,
          };
          setDrag(next);
          if (props.onDraft) props.onDraft(next);
        }
        function up() {
          window.removeEventListener('pointermove', move, true);
          window.removeEventListener('pointerup', up, true);
          window.removeEventListener('pointercancel', up, true);
          setDrag(null);
        }
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', up, true);
        window.addEventListener('pointercancel', up, true);
        if (e.preventDefault) e.preventDefault();
      }

      const mediaStyle = { left: imgLeft, top: imgTop, width: imgW, height: imgH };
      // 预览里的视频要和真背景一致：循环 / 静音 / 倍速三项同源同算法
      const vMuted = cfg.videoMuted !== false;
      const vLoop = cfg.videoLoop !== false;
      const vRateNum = Number(cfg.videoRate);
      const vRate = isFinite(vRateNum) ? Math.min(2, Math.max(0.25, vRateNum)) : 1;
      const media = kindOf(name) === 'video'
        ? h('video', {
          key: 'v', src: mediaUrl(name), muted: vMuted, autoPlay: true, loop: vLoop, playsInline: true,
          onLoadedMetadata: function (e) {
            try { e.currentTarget.playbackRate = vRate; } catch (err) { /* 个别内核不认倍速 */ }
          },
          style: mediaStyle,
        })
        : h('img', { key: 'i', src: mediaUrl(name), alt: name, style: mediaStyle });

      return h('div', { className: 'dbp-stagewrap', ref: wrapRef }, [
        h('div', {
          key: 'stage',
          className: 'dbp-stage' + (interact ? ' drag' : ''),
          style: { width: frameW + M * 2, height: frameH + M * 2, '--dbp-dim': props.hideOutside ? '1' : '0.55' },
          onPointerDown: onDown,
        }, [
          media,
          h('div', {
            key: 'rect',
            className: 'dbp-visrect',
            style: { left: M, top: M, width: frameW, height: frameH },
          }),
          h('span', { key: 'tag', className: 'dbp-badge2' }, '屏幕所见'),
        ]),
        h('div', { className: 'dbp-tip', key: 'tip' },
          (cfg.fit === 'cover'
            ? (interact ? '按住图片拖动调整位置 · ' : '')
            : '当前铺满方式 ' + cfg.fit + ' 不吃位置调整 · ')
          + '亮框 = 屏幕，框外会被裁掉'),
        h('div', { className: 'dbp-tip', key: 'tip2' },
          '可见区约 ' + Math.round(geo.sw) + '×' + Math.round(geo.sh) + ' 像素 · 缩放 '
          + (pos.zoom || 1).toFixed(2) + '×'),
              , props.zoomSlot || null
      ]);
    }

    // 色环取色：conic-gradient 色相环，拖动按角度取色（HSL→hex），只改本地值，松手才落盘
    function ColorWheel(props) {
      const ref = useRef(null);
      const [hue, setHue] = useState(210);
      const hex = props.value || hslHex(hue, 70, 55);
      function pick(e) {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        let deg = Math.atan2(dy, dx) * 180 / Math.PI + 90; // 正上方为 0°
        if (deg < 0) deg += 360;
        setHue(deg);
        if (props.onChange) props.onChange(hslHex(deg, 70, 55));
      }
      function onDown(e) {
        pick(e);
        function move(ev) { pick(ev); }
        function up() {
          window.removeEventListener('pointermove', move, true);
          window.removeEventListener('pointerup', up, true);
          if (props.onCommit) props.onCommit();
        }
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', up, true);
        if (e.preventDefault) e.preventDefault();
      }
      return h('div', { className: 'dbp-wheelwrap' }, [
        h('div', {
          key: 'w', ref: ref, className: 'dbp-wheel', title: '拖动取色',
          onPointerDown: onDown,
          style: { '--dbp-accent': hex },
        }, h('div', {
          key: 'dot', className: 'dbp-wheeldot',
          style: { transform: 'rotate(' + hue + 'deg) translateY(-17px)' },
        })),
        h('div', { key: 'hex', className: 'dbp-tip' }, props.value || '未设置（跟随主题）'),
      ]);
    }

    /* ------------------------------------------------------------ 裁剪器 */

    const CROP_AR = { '16:9': 16 / 9, '21:9': 21 / 9, '4:3': 4 / 3, '3:2': 3 / 2, '1:1': 1 };

    function Cropper(props) {
      const name = props.name;
      const [nat, setNat] = useState(null);
      const [arMode, setArMode] = useState('原图比例'); // 默认原图比例：来图先按它自己的比例
      const [zoom, setZoom] = useState(1);
      const [off, setOff] = useState({ x: 0, y: 0 });
      const [fsize, setFsize] = useState({ w: 0, h: 0 });
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState('');
      const frameRef = useRef(null);
      const imgRef = useRef(null);

      const ar = arMode === '原图比例' && nat ? nat.w / nat.h : (CROP_AR[arMode] || 16 / 9);

      // 量裁剪框的 CSS 尺寸（框高由 aspect-ratio 决定）。ResizeObserver 跟住布局，
      // 并且 setFsize 在值没变时返回原对象，避免多余重渲染。
      useEffect(function () {
        const el = frameRef.current;
        if (!el) return undefined;
        function measure() {
          const w = el.clientWidth;
          const h = el.clientHeight;
          setFsize(function (prev) { return (prev.w === w && prev.h === h) ? prev : { w: w, h: h }; });
        }
        measure();
        let ro = null;
        if (typeof ResizeObserver === 'function') {
          ro = new ResizeObserver(measure);
          ro.observe(el);
        }
        window.addEventListener('resize', measure);
        const timer = setTimeout(measure, 150);
        return function () {
          if (ro) ro.disconnect();
          window.removeEventListener('resize', measure);
          clearTimeout(timer);
        };
      }, [ar]);

      // 图片尺寸 / 比例 / 框尺寸变化时才重新居中并复位缩放。
      // 依赖写成数值而不是 nat 对象：对象同一性变化不该复位。
      useEffect(function () {
        if (!nat || !fsize.w || !fsize.h) return;
        const cover = Math.max(fsize.w / nat.w, fsize.h / nat.h);
        const dw = nat.w * cover;
        const dh = nat.h * cover;
        setZoom(1);
        setOff({ x: (fsize.w - dw) / 2, y: (fsize.h - dh) / 2 });
      }, [nat ? nat.w : 0, nat ? nat.h : 0, arMode, fsize.w, fsize.h]);

      // 兜底：图片若在挂载前就已缓存完成，onLoad 可能赶不上，这里补一次
      useEffect(function () {
        const img = imgRef.current;
        if (!nat && img && img.complete && img.naturalWidth) {
          setNat({ w: img.naturalWidth, h: img.naturalHeight });
        }
      });

      // 覆盖比例：保证框永远被图盖满
      const geo = (nat && fsize.w && fsize.h)
        ? (function () {
          const cover = Math.max(fsize.w / nat.w, fsize.h / nat.h);
          const scale = cover * zoom;
          return { cover: cover, scale: scale, dw: nat.w * scale, dh: nat.h * scale };
        })()
        : null;

      function clampOff(next, g) {
        if (!g) return next;
        const minX = Math.min(0, fsize.w - g.dw);
        const minY = Math.min(0, fsize.h - g.dh);
        return {
          x: Math.min(0, Math.max(minX, next.x)),
          y: Math.min(0, Math.max(minY, next.y)),
        };
      }

      function changeZoom(nextZoom) {
        const z = Math.min(4, Math.max(1, nextZoom));
        if (!geo || !nat) { setZoom(z); return; }
        const newScale = geo.cover * z;
        const g2 = { dw: nat.w * newScale, dh: nat.h * newScale };
        // 保持框中心对准同一块图
        const cx = (fsize.w / 2 - off.x) / geo.scale;
        const cy = (fsize.h / 2 - off.y) / geo.scale;
        setZoom(z);
        setOff(clampOff({ x: fsize.w / 2 - cx * newScale, y: fsize.h / 2 - cy * newScale }, g2));
      }

      // 拖动：不在元素上收 pointermove（宿主容器可能抢先处理或指针离开元素），
      // 改成按下后在 window 上用捕获阶段监听，谁拦都拦不住；抬起时成对摘掉。
      function onDown(e) {
        if (!geo) return;
        const start = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
        const g = geo;
        function move(ev) {
          setOff(clampOff({ x: start.ox + (ev.clientX - start.x), y: start.oy + (ev.clientY - start.y) }, g));
        }
        function up() {
          window.removeEventListener('pointermove', move, true);
          window.removeEventListener('pointerup', up, true);
          window.removeEventListener('pointercancel', up, true);
        }
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', up, true);
        window.addEventListener('pointercancel', up, true);
        if (e.preventDefault) e.preventDefault();
      }

      async function doCrop() {
        const img = imgRef.current;
        if (!img || !geo || !nat) return;
        setBusy(true);
        setMsg('正在裁剪…');
        try {
          const s = geo.scale;
          const sw = fsize.w / s;
          const sh = fsize.h / s;
          const sx = -off.x / s;
          const sy = -off.y / s;
          const outW = Math.max(1, Math.round(Math.min(sw, 2560)));
          const outH = Math.max(1, Math.round(sh * (outW / sw)));
          const canvas = document.createElement('canvas');
          canvas.width = outW;
          canvas.height = outH;
          const c2d = canvas.getContext('2d');
          c2d.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
          const blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
          if (!blob) throw new Error('导出失败');
          const base = name.replace(/^[a-z0-9]+-/, '').replace(/\.[^.]+$/, '');
          const out = Date.now().toString(36) + '-crop-' + base + '.png';
          const res = await fetch(API + '/upload?name=' + encodeURIComponent(out), {
            method: 'POST',
            headers: { 'Content-Type': 'image/png' },
            body: blob,
          });
          if (!res.ok) {
            const body = await res.json().catch(function () { return {}; });
            throw new Error((body && body.error) || ('HTTP ' + res.status));
          }
          await refresh();
          setBusy(false);
          props.onDone(out);
        } catch (e) {
          setBusy(false);
          setMsg('裁剪失败：' + String((e && e.message) || e));
        }
      }

      const isGif = /\.gif$/i.test(name);

      return h('div', { className: 'dbp-root' }, [
        h('style', { key: 'css' }, CSS),
        h('div', { className: 'dbp-h', key: 't' }, '裁剪：' + name.replace(/^[a-z0-9]+-/, '')),
        h('div', { className: 'dbp-row', key: 'ar' }, [
          h('label', { key: 'l' }, '裁剪比例'),
          h('select', {
            key: 's', value: arMode,
            onChange: function (e) { setArMode(e.target.value); },
          }, ['16:9', '21:9', '4:3', '3:2', '1:1', '原图比例'].map(function (k) {
            return h('option', { key: k, value: k }, k);
          })),
        ]),
        h('div', { className: 'dbp-crop-wrap', key: 'wrap' },
          h('div', {
            ref: frameRef,
            className: 'dbp-crop-frame',
            style: { aspectRatio: String(ar) },
            onPointerDown: onDown,
            onWheel: function (e) { changeZoom(zoom + (e.deltaY < 0 ? 0.12 : -0.12)); },
          }, [
            h('img', {
              key: 'img',
              ref: imgRef,
              src: mediaUrl(name),
              alt: name,
              onLoad: function (e) {
                const w = e.target.naturalWidth;
                const h = e.target.naturalHeight;
                if (!w || !h) return;
                setNat(function (prev) {
                  return (prev && prev.w === w && prev.h === h) ? prev : { w: w, h: h };
                });
              },
              style: geo
                ? { left: off.x + 'px', top: off.y + 'px', width: geo.dw + 'px', height: geo.dh + 'px' }
                : { left: 0, top: 0, width: '100%', height: '100%', objectFit: 'contain' },
            }),
            h('div', { key: 'grid', className: 'dbp-crop-grid' }),
          ]),
          h('div', { className: 'dbp-crop-actions', key: 'acts' }, [
            h('button', {
              key: 'ok', className: 'dbp-btn primary', disabled: busy || !nat,
              onClick: doCrop,
            }, busy ? '裁剪中…' : '裁剪并存入历史'),
            h('button', {
              key: 'reset', className: 'dbp-btn', disabled: busy,
              onClick: function () { changeZoom(1); },
            }, '复位缩放'),
            h('button', {
              key: 'no', className: 'dbp-btn', disabled: busy,
              onClick: function () { props.onCancel(); },
            }, '返回'),
          ])),
        h('div', { className: 'dbp-tip', key: 'hint' },
          '拖动图片选位置 · 滚轮或下面滑杆缩放 · 框内就是裁出来的部分'),

        isGif ? h('div', { className: 'dbp-tip', key: 'gifwarn' },
          '注意：裁剪 GIF 只会保留当前这一帧，结果存成 PNG。') : null,

        h('div', { className: 'dbp-msg', key: 'msg' }, msg),
      ]);
    }

    /* -------------------------------------------------------------- 面板 */

    function BgMain() {
      const [, force] = useState(0);
      const [sel, setSel] = useState('');
      const [draft, setDraft] = useState(null);
      const [hideOutside, setHideOutside] = useState(false);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState('');
      const [err, setErr] = useState('');
      const [dragOn, setDragOn] = useState(false);
      const [cropping, setCropping] = useState('');
      const [confirmDel, setConfirmDel] = useState('');
      // 拖动中的临时参数：只做本地预览，松手才写配置（否则每个 input 事件都发一次请求，会抽动）
      const [live, setLive] = useState(null);
      const [colorOpen, setColorOpen] = useState(false);
      const [colorDraft, setColorDraft] = useState('#3b82f6');
      const inputRef = useRef(null);

      useEffect(function () {
        const off = subscribe(function () { force(function (n) { return n + 1; }); });
        refresh();
        return off;
      }, []);

      async function upload(file) {
        if (!file) return;
        // svg 不再算可接受的图片：宿主白名单里已经去掉它（能塞 <script>），
        // 这边提前拦掉，省得传完才吃 400（与宿主 EXT_KIND 对齐）
        const looksOk = /^(image|video)\//.test(file.type || '')
          || /\.(gif|png|jpe?g|webp|avif|bmp|mp4|webm|mov|m4v|ogv)$/i.test(file.name || '');
        if (!looksOk) { setErr('只支持图片或视频文件'); return; }
        if (file.size > MAX_UPLOAD) { setErr('文件超过 ' + Math.round(MAX_UPLOAD / 1024 / 1024) + 'MB'); return; }
        setBusy(true); setErr(''); setMsg('正在导入…');
        try {
          const safe = String(file.name || 'bg').replace(/[^A-Za-z0-9._-]/g, '_');
          const name = Date.now().toString(36) + '-' + safe;
          await api('/upload?name=' + encodeURIComponent(name), {
            method: 'POST',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file,
          });
          bustUrls();
          await refresh();
          pick(name);
          setMsg('已导入，拖动调整位置，满意后点「保存为背景」');
        } catch (e) {
          setErr(String((e && e.message) || e));
          setMsg('');
        }
        setBusy(false);
      }

      function onPick(e) {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        upload(file);
      }

      function onDrop(e) {
        e.preventDefault();
        setDragOn(false);
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        upload(file);
      }

      // 选中一张图：草稿用它的现状（就是当前背景则沿用已保存的位置/缩放）
      function pick(name) {
        setSel(name);
        setDraft(name && name === state.config.active
          ? { posX: state.config.posX, posY: state.config.posY, zoom: state.config.zoom }
          : { posX: 0.5, posY: 0.5, zoom: 1 });
      }

      // 草稿与已保存值的差异：用来提示"还没保存"
      const shown = sel || state.config.active;
      const shownIsActive = !!shown && shown === state.config.active;
      const eff = draft || { posX: state.config.posX, posY: state.config.posY, zoom: state.config.zoom };
      const dirty = !!sel && (!shownIsActive
        || eff.posX !== state.config.posX
        || eff.posY !== state.config.posY
        || eff.zoom !== state.config.zoom);

      function liveNum(key, fallback) {
        return (live && live[key] != null) ? live[key] : fallback;
      }
      // 倍速显示：1 →「1.0×」；0.25 这种步进值原样显示（别被 toFixed(1) 吃成 0.3）
      function rateLabel(v) {
        const n = Math.round(Number(v) * 100) / 100;
        return (n % 1 === 0 ? n.toFixed(1) : String(n)) + '×';
      }
      // 拖动中：改 state.config 的副本 + 重画背景层，但不发请求
      function setLiveParam(key, value) {
        const next = Object.assign({}, live || {});
        next[key] = value;
        setLive(next);
        state.config = Object.assign({}, state.config, next);
        applyLayer();
      }
      // 松手/键盘结束/失焦：把最终值写进配置（一次请求）
      function commitLive() {
        if (!live) return;
        const payload = Object.assign({}, live);
        setLive(null);
        saveConfig(payload);
      }
      async function commitDraft() {
        if (!shown) return;
        setBusy(true);
        await saveConfig({ active: shown, posX: eff.posX, posY: eff.posY, zoom: eff.zoom });
        setBusy(false);
        setMsg('已保存为背景：' + shown);
      }

      async function removeItem(name) {
        setErr(''); setMsg('正在删除…');
        try {
          await api('/delete?name=' + encodeURIComponent(name), { method: 'POST' });
          if (sel === name) setSel('');
          bustUrls();
          await refresh();
          setMsg('已删除 ' + name);
        } catch (e) {
          setErr(String((e && e.message) || e));
        }
      }

      const cfg = state.config;
      const items = state.items;

      // 视频扩展名：决定"视频循环 / 静音 / 倍速"三项能否操作（只看扩展名，不碰文件本身）。
      // 必须定义在 BgMain 里、且在 return 之前 —— 这几项是 JSX 里的控件，
      // 早前把它们放在 applyLayer 内部，JSX 那侧拿不到 vDis，
      // 一渲染就 ReferenceError: vDis is not defined，整个面板点不开。
      const VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v', 'ogv'];
      function isVideoName(nm) {
        const m = String(nm || '').toLowerCase().match(/\.([a-z0-9]+)$/);
        return !!m && VIDEO_EXT.indexOf(m[1]) >= 0;
      }
      // 只看当前背景（pending 之类的变量不在本作用域）
      const isVideoNow = isVideoName(cfg.active || '');
      const vDis = isVideoNow ? {} : { disabled: true };

      if (cropping) {
        return h(Cropper, {
          name: cropping,
          onDone: function (out) {
            setCropping('');
            pick(out);
            setMsg('裁剪完成并存入历史，拖动调整后点「保存为背景」');
          },
          onCancel: function () { setCropping(''); },
        });
      }

      return h('div', { className: 'dbp-root' }, [
        h('style', { key: 'css' }, CSS),
        h('div', { className: 'dbp-h', key: 'title' }, '自定义背景 · v0.6'),
        state.dir ? h('div', { className: 'dbp-sub', key: 'dir' }, '存放目录：' + state.dir) : null,

        h('div', { className: 'dbp-sub', key: 'curlabel' },
          shown ? (shownIsActive ? '当前背景' : '选中的图（尚未保存）') + '：' + shown.replace(/^[a-z0-9]+-/, '')
            : '还没有设置背景'),
        h(Preview, {
            key: 'cur',
            name: shown,
            draft: eff,
            interactive: true,
            hideOutside: hideOutside,
            onDraft: function (next) { setDraft(Object.assign({}, eff, next)); },
            empty: '还没有设置背景',

          zoomSlot: h('div', { className: 'dbp-zoomcol', key: 'zoom' }, [
          h('input', {
          key: 'i', type: 'range', min: 1, max: 4, step: 0.01, value: eff.zoom || 1,
          disabled: cfg.fit !== 'cover',
          onChange: function (e) { setDraft(Object.assign({}, eff, { zoom: Number(e.target.value) })); },
          }),
          h('span', { className: 'dbp-tip', key: 't' }, '缩放 ' + (eff.zoom || 1).toFixed(2) + '×'),
          ]),
        }),


        h('div', { className: 'dbp-actions', key: 'mainacts' }, [
          h('button', {
            key: 'save', className: 'dbp-btn primary', disabled: busy || !shown,
            onClick: commitDraft,
          }, dirty ? '保存为背景（有改动）' : '保存为背景'),
          shown && kindOf(shown) === 'image' ? h('button', {
            key: 'crop', className: 'dbp-btn', disabled: busy,
            onClick: function () { setCropping(shown); },
          }, '裁剪') : null,
          shown ? h('button', {
            key: 'reset', className: 'dbp-btn', disabled: busy,
            onClick: function () {
              setDraft({ posX: cfg.posX, posY: cfg.posY, zoom: shownIsActive ? cfg.zoom : 1 });
              setMsg('已还原为当前保存值');
            },
          }, '还原') : null,
          sel ? h('button', {
            key: 'unsel', className: 'dbp-btn', disabled: busy,
            onClick: function () { setSel(''); setMsg('已取消选择'); },
          }, '取消选择') : null,
          // 右侧一组的两个按钮（marginLeft:auto 把它们推到行尾）
          h('span', { key: 'rightgroup', style: { marginLeft: 'auto', display: 'flex', gap: '8px' } }, [
            h('button', {
              key: 'clear', className: 'dbp-btn danger-soft',
              onClick: function () { saveConfig({ active: '' }); setMsg('背景已清除'); },
            }, '清除背景'),
            h('button', {
              key: 'reload', className: 'dbp-btn',
              onClick: function () { refresh(); setMsg('已刷新列表'); },
            }, '刷新'),
          ]),
        ]),


        h('div', {
          key: 'drop',
          className: 'dbp-drop' + (dragOn ? ' on' : ''),
          onClick: function () { if (!busy && inputRef.current) inputRef.current.click(); },
          onDragOver: function (e) { e.preventDefault(); setDragOn(true); },
          onDragLeave: function () { setDragOn(false); },
          onDrop: onDrop,
        }, busy ? '正在导入…' : '点这里导入图片 / 视频，或直接拖进来'),
        h('input', {
          key: 'file', ref: inputRef, type: 'file',
          accept: 'image/*,video/*', style: { display: 'none' }, onChange: onPick,
        }),

        h('div', { className: 'dbp-sub', key: 'histlabel' }, '历史背景（' + items.length + '）'),
        items.length
          ? h('div', { className: 'dbp-grid', key: 'grid' }, items.map(function (it) {
            const isSel = sel === it.name;
            const cur = cfg.active === it.name;
            return h('div', {
              key: it.name,
              className: 'dbp-cell' + (isSel ? ' sel' : '') + (cur ? ' cur' : ''),
              title: it.name + ' · ' + formatBytes(it.size),
              onClick: function () { pick(it.name); setMsg('已选中，拖动调整后点「保存为背景」'); },
            }, [
              it.kind === 'video'
                ? h('video', {
                  key: 'v', className: 'dbp-thumb', src: mediaUrl(it.name),
                  // 缩略图一律静音，不看配置：一屏几十个视频同时出声是灾难
                  muted: true, preload: 'metadata', playsInline: true,
                })
                : h('img', {
                  key: 'i', className: 'dbp-thumb', src: mediaUrl(it.name),
                  alt: it.name, loading: 'lazy',
                }),
              it.kind === 'video' ? h('span', { key: 'b', className: 'dbp-badge' }, '视频') : null,
              h('div', { key: 'n', className: 'dbp-name' }, it.name.replace(/^[a-z0-9]+-/, '')),
              h('button', {
                key: 'd', className: 'dbp-del', title: '删除',
                onClick: function (e) { e.stopPropagation(); setConfirmDel(it.name); },
              }, '×'),
            ]);
          }))
          : h('div', { className: 'dbp-sub', key: 'nogrid' }, '还没有导入过文件'),

        h('div', { className: 'dbp-row', key: 'fit' }, [
          h('label', { key: 'l' }, '铺满方式'),
          h('select', {
            key: 's', value: cfg.fit,
            onChange: function (e) { saveConfig({ fit: e.target.value }); },
          }, [
            h('option', { key: 'c', value: 'cover' }, '铺满裁切 cover'),
            h('option', { key: 'n', value: 'contain' }, '完整显示 contain'),
            h('option', { key: 'r', value: 'repeat' }, '平铺 repeat（视频不适用）'),
          ]),
        ]),
        h('div', { className: 'dbp-row', key: 'dim' }, [
          h('label', { key: 'l' }, '背景明暗 ' + liveNum('dim', cfg.dim) + '%'),
          h('input', {
            key: 'i', type: 'range', min: 0, max: 80, value: liveNum('dim', cfg.dim),
            onChange: function (e) { setLiveParam('dim', Number(e.target.value)); },
            onPointerUp: commitLive, onKeyUp: commitLive, onBlur: commitLive,
          }),
          h('button', {
            key: 'r', className: 'dbp-reset', title: '恢复默认 20%',
            onClick: function () { saveConfig({ dim: 20 }); },
          }, '恢复\n默认'),
        ]),
        h('div', { className: 'dbp-row', key: 'blur' }, [
          h('label', { key: 'l' }, '模糊 ' + liveNum('blur', cfg.blur) + 'px'),
          h('input', {
            key: 'i', type: 'range', min: 0, max: 20, value: liveNum('blur', cfg.blur),
            onChange: function (e) { setLiveParam('blur', Number(e.target.value)); },
            onPointerUp: commitLive, onKeyUp: commitLive, onBlur: commitLive,
          }),
          h('button', {
            key: 'r', className: 'dbp-reset', title: '恢复默认 0px',
            onClick: function () { saveConfig({ blur: 0 }); },
          }, '恢复\n默认'),
        ]),
        // 下面是视频播放三项 + GIF 帧率上限（GIF 那项只存数值，限速本身还没做）
        h('label', { className: 'dbp-check', key: 'vloop' }, [
          h('input', {
            key: 'i', type: 'checkbox', checked: cfg.videoLoop !== false, ...vDis,
            onChange: function (e) { saveConfig({ videoLoop: e.target.checked }); },
          }),
          h('span', { key: 's' }, '视频循环（' + (cfg.videoLoop !== false ? '循环播放' : '只播一次') + '）'),
        ]),
        h('label', { className: 'dbp-check', key: 'vmute' }, [
          h('input', {
            key: 'i', type: 'checkbox', checked: cfg.videoMuted !== false, ...vDis,
            onChange: function (e) { saveConfig({ videoMuted: e.target.checked }); },
          }),
          h('span', { key: 's' }, '视频静音（' + (cfg.videoMuted !== false ? '静音' : '有声') + '）'),
        ]),
        // 视频控件被禁用时给出原因（可用时自动消失）
        isVideoNow ? null : h('div', { className: 'dbp-hint', key: 'vidhint' },
          '先将视频保存为背景才能进行设置'),
        h('div', { className: 'dbp-row', key: 'vrate' }, [
          h('label', { key: 'l' }, '播放速度 ' + rateLabel(liveNum('videoRate', cfg.videoRate))),
          h('input', {
            key: 'i', type: 'range', min: 0.25, max: 2, step: 0.25,
            value: liveNum('videoRate', cfg.videoRate), ...vDis,
            onChange: function (e) { setLiveParam('videoRate', Number(e.target.value)); },
            onPointerUp: commitLive, onKeyUp: commitLive, onBlur: commitLive,
          }),
          h('button', {
            key: 'r', className: 'dbp-reset', title: '恢复默认 1×',
            onClick: function () { saveConfig({ videoRate: 1 }); },
          }, '恢复\n默认'),
        ]),
        // GIF 帧率上限：0 = 不限。限速本身**没实现** —— CSS 背景图里的 GIF 由浏览器解码，
        // 插件拿不到它的帧；真要限速得换一条非 CSS 的渲染路径（拆帧 + canvas 逐帧画），以后再说。
        // 所以滑块上标了"暂未生效"：值能存，但当前不影响渲染。
        h('div', { className: 'dbp-row', key: 'giffps' }, [
          h('label', { key: 'l', title: '暂未生效：宿主只保存该值，当前渲染路径还无法限制 GIF 帧率' },
            'GIF 帧率上限 '
            + (Number(liveNum('gifFps', cfg.gifFps)) > 0 ? liveNum('gifFps', cfg.gifFps) + ' fps' : '不限')),
          h('input', {
            key: 'i', type: 'range', min: 0, max: 60, step: 1,
            value: liveNum('gifFps', cfg.gifFps), disabled: true,
            onChange: function (e) { setLiveParam('gifFps', Number(e.target.value)); },
            onPointerUp: commitLive, onKeyUp: commitLive, onBlur: commitLive,
          }),
          h('button', {
            key: 'r', className: 'dbp-reset', title: '恢复默认 0（不限）',
            onClick: function () { saveConfig({ gifFps: 0 }); },
          }, '恢复\n默认'),
        ]),
        h('div', { className: 'dbp-note', key: 'gifnote' }, '（暂未生效）'),


        colorOpen ? h('div', {
          key: 'colormask', className: 'dbp-confirm-mask',
          onMouseDown: function (e) { if (e.target === e.currentTarget) setColorOpen(false); },
        }, h('div', { className: 'dbp-confirm-card', role: 'dialog', 'aria-modal': 'true' }, [
          h('div', { className: 'dbp-confirm-title', key: 't' }, '选择主题色'),
          h('div', { className: 'dbp-colorhead', key: 'h' }, [
            h('input', {
              key: 'native', type: 'color', className: 'dbp-colorinput',
              value: /^#[0-9a-fA-F]{6}$/.test(colorDraft) ? colorDraft : '#3b82f6',
              onChange: function (e) { setColorDraft(e.target.value); },
            }),
            h('div', { key: 'prev', className: 'dbp-colorprev', style: { background: colorDraft } }),
          ]),
          h('div', { className: 'dbp-row', key: 'hex' }, [
            h('label', { key: 'l' }, '十六进制'),
            h('input', {
              key: 'i', className: 'dbp-textin', type: 'text', value: colorDraft,
              placeholder: '#rrggbb',
              onChange: function (e) { setColorDraft(e.target.value.trim()); },
            }),
          ]),
          h('div', { className: 'dbp-row', key: 'rgb' }, [
            h('label', { key: 'l' }, 'RGB'),
            ['r', 'g', 'b'].map(function (ch, i) {
              const v = /^#[0-9a-fA-F]{6}$/.test(colorDraft) ? parseInt(colorDraft.slice(1 + i * 2, 3 + i * 2), 16) : 0;
              return h('input', {
                key: ch, className: 'dbp-numin', type: 'number', min: 0, max: 255, value: v,
                onChange: function (e) {
                  const arr = [0, 1, 2].map(function (k) {
                    return k === i ? Math.min(255, Math.max(0, Number(e.target.value) || 0))
                      : parseInt((/^#[0-9a-fA-F]{6}$/.test(colorDraft) ? colorDraft : '#000000').slice(1 + k * 2, 3 + k * 2), 16);
                  });
                  setColorDraft('#' + arr.map(function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''));
                },
              });
            }),
          ]),
          h('div', { className: 'dbp-actions', key: 'a', style: { marginTop: '14px', justifyContent: 'flex-end' } }, [
            h('button', { key: 'cancel', className: 'dbp-btn', onClick: function () { setColorOpen(false); } }, '再想想'),
            h('button', {
              key: 'ok', className: 'dbp-btn primary',
              onClick: function () {
                const hex = /^#[0-9a-fA-F]{6}$/.test(colorDraft) ? colorDraft.toLowerCase() : '';
                setColorOpen(false);
                saveConfig({ accent: hex });
              },
            }, '确定'),
          ]),
        ])) : null,
        confirmDel ? h('div', {
          key: 'delmask', className: 'dbp-confirm-mask',
          onMouseDown: function (e) { if (e.target === e.currentTarget) setConfirmDel(''); },
        }, h('div', { className: 'dbp-confirm-card', role: 'dialog', 'aria-modal': 'true' }, [
          h('div', { className: 'dbp-confirm-title', key: 't' }, '真的要丢掉这张吗？'),
          h('div', { className: 'dbp-confirm-name', key: 'n' }, confirmDel),
          h('div', { className: 'dbp-tip', key: 'w' }, '删了就真没啦，人家可不会帮你捡回来哦～'),
          h('div', { className: 'dbp-sign', key: 'sign' }, '--By DeepSleep'),
          h('div', { className: 'dbp-actions', key: 'a', style: { marginTop: '14px', justifyContent: 'flex-end' } }, [
            h('button', {
              key: 'cancel', className: 'dbp-btn',
              onClick: function () { setConfirmDel(''); },
            }, '取消'),
            h('button', {
              key: 'ok', className: 'dbp-btn danger',
              onClick: function () { const target = confirmDel; setConfirmDel(''); removeItem(target); },
            }, '狠心删掉'),
          ]),
        ])) : null,
        h('div', { className: 'dbp-divider', key: 'divider' }),
        h('div', { className: 'dbp-h', key: 'themehead' }, '自定义主题'),
        h('label', { className: 'dbp-check', key: 'fulltrans' }, [
          h('input', {
            key: 'i', type: 'checkbox', checked: (cfg.palette || '') === 'blue-fantasy',
            onChange: function (e) { saveConfig({ palette: e.target.checked ? 'blue-fantasy' : '' }); },
          }),
          h('span', { key: 's' }, '全透明模式（能看清完整壁纸）'),
        ]),
        h('div', { className: 'dbp-row', key: 'accent' }, [
          h('label', { key: 'l' }, '主题色'),
          h('button', {
            key: 'w', className: 'dbp-btn',
            title: THEME_ON(cfg) ? '打开取色窗口' : '需先勾选「全透明模式」',
            disabled: !THEME_ON(cfg),
            onClick: function () { setColorDraft(cfg.accent || '#3b82f6'); setColorOpen(true); },
          }, THEME_ON(cfg) && cfg.accent ? cfg.accent : '选色'),
          h('button', {
            key: 'c', className: 'dbp-btn',
            disabled: !THEME_ON(cfg),
            onClick: function () { saveConfig({ accent: '' }); },
          }, '清除'),
        ]),
        h('div', { className: 'dbp-msg' + (err || hostHint() ? ' err' : ''), key: 'msg' },
          err || hostHint() || msg || ''),
      ]);
    }

    /* -------------------------------------------------- 侧边栏列表入口 */

    // 列表入口：只有图标，不带文字、不铺底色；悬停/选中靠图标自身变色。
    // 选中态优先看宿主传进来的字段，拿不到就只保留悬停变色。
    // 入口只画一个 span + 图标：外面那一行本来就是宿主的 <button>，点击由它处理。
    // 这里**绝不能再用 <button>** —— 浏览器 UA 样式会给 button 铺一层灰色 buttonface 底，
    // 而面板没打开时我们那段组件内 <style> 并不在 DOM 里，于是灰底就露出来了。
    function SidebarEntry(props) {
      const selected = !!(props && (props.active || props.selected || props.current || props.on));
      return h('span', {
        className: 'dbp-entry' + (selected ? ' on' : ''),
        title: '个性化（背景自定义）',
      }, h(Icon, { key: 'i', size: 18 }));
    }

    /* ---------------------------------------------------------------- 插件 */

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(function () {
          refresh();
          return function () { removeLayer(); };
        });

        // 视口尺寸变了要重排背景层（cover 的像素定位依赖视口）
        ctx.effect(function () {
          function onResize() { applyLayer(); emit(); }
          window.addEventListener('resize', onResize);
          return function () { window.removeEventListener('resize', onResize); };
        });

        // 这里只常驻注入"入口自己"的样式。**不要**再去覆盖宿主行按钮的 background：
        // 那层悬停/选中底色是宿主给整行的正常反馈，压掉之后咱这一项就成了唯一没有悬停提示的
        // （曾经的真凶是 UA 给 <button> 的灰底，改用 <span> 后已消失，与宿主底色无关）。
        ctx.effect(function () {
          const style = document.createElement('style');
          style.id = ROW_STYLE_ID;
          style.textContent = [
            /* 入口自身的样式必须**全局常驻**：只写在面板组件的 <style> 里的话，
               面板一关那段 CSS 就不在 DOM 里，入口会退回浏览器默认按钮外观（灰底）。
               注意：入口是 <span>，不参与宿主行按钮的悬停/选中底色 ——
               那层底色是宿主给整行的正常反馈，必须让它照常显示，不要用 !important 压掉。 */
            /* 入口固定 18×18 的盒子：宽高写死，悬停/选中/面板开关都不改变几何，
               所以永远不会有位移。只让颜色变。 */
            '.dbp-entry{display:inline-flex;align-items:center;justify-content:center;',
            'width:18px;height:18px;padding:0;margin:0;border:0;background:transparent;',
            'color:inherit;line-height:0;cursor:pointer;}',
            '.dbp-entry:hover{color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4a5fa8));}',
            '.dbp-entry.on{color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4a5fa8));}',
            '.dbp-entry svg{display:block;}',
      // 色环：外圈色相环 + 环上的取色点
      '.dbp-swatch{min-width:78px;height:28px;padding:5px 12px;border-radius:6px;cursor:pointer;',
      'font-size:12px;line-height:1;display:inline-flex;align-items:center;justify-content:center;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));color:inherit;',
      'transition:filter .15s,box-shadow .15s;}',
      '.dbp-swatch:hover{filter:brightness(1.08);box-shadow:0 0 0 1px var(--dsw-alias-border-l2,rgba(0,0,0,.25));}',
      '.dbp-presets{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px;max-width:440px;}',
      '.dbp-preset{position:relative;height:58px;border-radius:8px;cursor:pointer;padding:0;overflow:hidden;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.22));background-size:cover;transition:box-shadow .15s,border-color .15s;}',
      '.dbp-preset:hover{border-color:var(--dbp-p);}',
      '.dbp-preset.on{border-color:var(--dbp-p);box-shadow:0 0 0 2px var(--dbp-p);}',
      // 缩略图 = 咱主界面的三栏布局
      '.dbp-pv{position:absolute;left:5px;right:5px;top:5px;bottom:5px;display:flex;gap:2px;',
      'padding:3px;border-radius:4px;background:rgba(16,17,21,.78);overflow:hidden;}',
      '.dbp-pv>span{display:flex;flex-direction:column;gap:2px;border-radius:2px;}',
      '.dbp-pv>span>i{display:block;border-radius:1px;background:rgba(255,255,255,.42);}',
      '.dbp-pvside{flex:0 0 23px;background:rgba(255,255,255,.07);padding:2px;}',
      '.dbp-t-logo{height:5px;border-radius:1px;background:var(--dbp-p) !important;}',
      '.dbp-t-pill{height:3px;}',
      '.dbp-t-pill.on{background:var(--dbp-p) !important;}',
      '.dbp-pvmain{flex:1;background:rgba(255,255,255,.04);padding:4px 3px;justify-content:flex-start;}',
      '.dbp-t-line{height:3px;}',
      '.dbp-t-line.s{width:62%;}',
      '.dbp-t-input{height:7px;margin-top:auto;border-radius:2px;background:rgba(255,255,255,.16) !important;}',
      '.dbp-pvright{flex:0 0 26px;padding:2px;}',
      '.dbp-t-card{flex:1;border-radius:2px;background:rgba(255,255,255,.1) !important;border-top:3px solid transparent;}',
      '.dbp-t-card.accent{border-top-color:var(--dbp-p);background:rgba(255,255,255,.16) !important;}',
      '.dbp-colorhead{display:flex;align-items:center;gap:12px;margin:6px 0 12px;}',
      '.dbp-colorinput{width:64px;height:40px;padding:0;border:0;background:transparent;cursor:pointer;}',
      '.dbp-colorprev{flex:1;height:40px;border-radius:8px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.18));}',
      '.dbp-textin,.dbp-numin{padding:4px 6px;border-radius:6px;color:inherit;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));',
      'background:var(--dsw-alias-bg-layer-2,transparent);}',
      '.dbp-textin{flex:1;}',
      '.dbp-numin{width:56px;}',
      '.dbp-wheelwrap{display:flex;align-items:center;gap:8px;}',
      '.dbp-wheel{position:relative;width:38px;height:38px;border-radius:50%;cursor:crosshair;',
      'background:conic-gradient(from 0deg,#ff0000,#ffff00,#00ff00,#00ffff,#0000ff,#ff00ff,#ff0000);',
      '-webkit-mask:radial-gradient(circle,transparent 50%,#000 52%);',
      'mask:radial-gradient(circle,transparent 50%,#000 52%);}',
      '.dbp-wheeldot{position:absolute;left:50%;top:50%;width:9px;height:9px;margin:-4.5px 0 0 -4.5px;',
      'border-radius:50%;background:var(--dbp-accent,#fff);border:1.5px solid #fff;',
      'box-shadow:0 0 0 1px rgba(0,0,0,.55);}',
      '.dbp-entry:not(.on) svg path{stroke:currentColor !important;}',
      '.dbp-entry svg{position:relative;z-index:1;}',
          ].join('');
          (document.head || document.documentElement).appendChild(style);
          return function () { if (style.parentNode) style.parentNode.removeChild(style); };
        });

        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: PANEL_ID }, BgMain);
        });

        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            label: function () { return '个性化'; },
          }, SidebarEntry);
        });
      },
    };
  },
});
