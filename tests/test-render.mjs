/* ============================================================================
 * test-render.mjs —— 「渲染台」：把组件真渲染一遍 + 把事件回调真调一遍
 *
 * 这个测试防的是什么（都是 node --check 与产物契约测试抓不到的）：
 *   ① 跨作用域的 ReferenceError。真实事故：几行 `const vDis = ...` 被误放进模块级
 *      applyLayer()，而 JSX 在 BgMain 组件里 `...vDis` —— 一渲染就
 *      "ReferenceError: vDis is not defined"，整个面板点不开；
 *      而假阴性套餐（语法检查 + 契约测试）全绿。
 *   ② 渲染期任何同步异常：未定义变量、类型错误、hooks 用错。
 *   ③ 事件回调里的崩溃：onClick / onChange / onPointerDown / onKeyUp / onBlur … 挨个调。
 *   ④ applyLayer()（模块级、非组件路径）的崩溃 —— 同一类 bug 的另一半，层建不出来面板也白搭。
 *
 * 做法：node:vm 里跑 client.js（自带最小 window / document / fetch / Image / 定时器…），
 *   取出 slots 注册的 BgMain 与 SidebarEntry，用自带的迷你 React
 *   （createElement / useState / useEffect / useRef）**真渲染**出 h(...) 树，
 *   递归遍历这棵树，把 props 里所有 on* 函数用合成事件调一遍，再覆盖多种
 *   配置 / 主题 / 历史状态各渲染一遍。任何异常都会记进报告，失败 exit 1。
 *
 * 用法：在仓库根目录执行 node tests/test-render.mjs
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, '..', 'client.js');
const code = fs.readFileSync(file, 'utf8');

let pass = 0;
let fail = 0;
function check(label, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + label); }
  else { fail += 1; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
function brief(err) {
  const msg = String((err && err.message) || err).replace(/\s+/g, ' ').trim();
  const where = err && err.where ? err.where + '：' : '';
  return (where + msg).slice(0, 160);
}

/* -------------------------------------------------- 异常收集（同步 / 异步） */
// syncErrors：每个场景前打标记，只算本场景的；asyncErrors：整场累计（异步链路里漏出来的）
const syncErrors = [];
const asyncErrors = [];
function grabSync(where, err) { syncErrors.push({ where, message: String((err && err.message) || err) }); }
function grabAsync(where, err) { asyncErrors.push({ where, message: String((err && err.message) || err) }); }

/* ------------------------------------------------------------- 假定时器 */
// 用假定时器：Cropper 的 setTimeout(measure,150) 这类回调能在场景内被跑到，又不真等 150ms
const timers = new Map();
let timerSeq = 1;
function fakeSetTimeout(fn, ms) {
  const id = timerSeq++;
  timers.set(id, { fn, ms: Number(ms) || 0 });
  return id;
}
function fakeClearTimeout(id) { timers.delete(id); }
async function flushTimers() {
  for (let n = 0; n < 20 && timers.size; n += 1) {
    const batch = Array.from(timers.values());
    timers.clear();
    for (const t of batch) {
      try { t.fn(); } catch (err) { grabSync('定时器回调', err); }
    }
    await Promise.resolve();
  }
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await flushTimers();
  await Promise.resolve();
}

/* ---------------------------------------------------- 最小 DOM（宿主环境） */
function makeNode(tag) {
  const node = Object.create(NODE_PROTO);
  node.tag = String(tag || 'div');
  node.tagName = node.tag.toUpperCase();
  node.childNodes = [];
  node.parentNode = null;
  node.attributes = {};
  node.style = {};
  node.dataset = {};
  node.className = '';
  node.textContent = '';
  node.id = '';
  node.value = '';
  node.checked = false;
  node.disabled = false;
  node.muted = false;
  node.autoplay = false;
  node.loop = false;
  node.preload = '';
  node.volume = 1;
  node.playbackRate = 1;
  node.currentTime = 0;
  node.onload = null;
  node.onerror = null;
  node.onloadedmetadata = null;
  node.__listeners = {};
  // 给"图片已缓存 / 框已布局"的合理默认值：组件里的 complete/naturalWidth/量尺寸分支才能往下走
  node.complete = true;
  node.naturalWidth = 1600;
  node.naturalHeight = 900;
  node.videoWidth = 1280;
  node.videoHeight = 720;
  node.clientWidth = 340;
  node.clientHeight = 190;
  node.offsetWidth = 340;
  node.offsetHeight = 190;
  if (node.tag === 'video') {
    // 视频：赋 src 后异步补一次 loadedmetadata（真浏览器就是这么来的）
    Object.defineProperty(node, 'src', {
      configurable: true,
      get() { return this.__src || ''; },
      set(v) {
        this.__src = String(v);
        const self = this;
        queueMicrotask(function () {
          try {
            if (typeof self.onloadedmetadata === 'function') self.onloadedmetadata({ target: self, currentTarget: self });
            self.fire('loadedmetadata', { target: self, currentTarget: self, type: 'loadedmetadata' });
          } catch (err) { grabAsync('video.loadedmetadata', err); }
        });
      },
    });
    node.play = function () { return Promise.resolve(); };
    node.pause = function () {};
    node.load = function () {};
  }
  if (node.tag === 'canvas') {
    node.getContext = function () {
      return {
        drawImage() {}, fillRect() {}, clearRect() {},
        setTransform() {}, scale() {}, translate() {},
      };
    };
    node.toBlob = function (cb) { cb({ size: 2048, type: 'image/png' }); };
    node.toDataURL = function () { return 'data:image/png;base64,'; };
  }
  return node;
}
const NODE_PROTO = {
  get firstChild() { return this.childNodes[0] || null; },
  get parentElement() { return this.parentNode; },
  get isConnected() {
    let p = this;
    while (p) { if (p.__isDocumentElement) return true; p = p.parentNode; }
    return false;
  },
  appendChild(c) { if (!c) return c; if (c.parentNode) c.parentNode.removeChild(c); this.childNodes.push(c); c.parentNode = this; return c; },
  insertBefore(c, ref) {
    if (!c) return c;
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
    c.parentNode = this;
    return c;
  },
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    if (c) c.parentNode = null;
    return c;
  },
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); },
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
  removeAttribute(k) { delete this.attributes[k]; },
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); },
  addEventListener(type, fn, opts) {
    if (typeof fn !== 'function') return;
    const list = this.__listeners[type] || (this.__listeners[type] = []);
    list.push({ fn, once: !!(opts && opts.once) });
  },
  removeEventListener(type, fn) {
    const list = this.__listeners[type];
    if (!list) return;
    const i = list.findIndex(function (e) { return e.fn === fn; });
    if (i >= 0) list.splice(i, 1);
  },
  // 触发这个节点上登记的监听器（返回调用次数）
  fire(type, ev) {
    const list = this.__listeners[type];
    if (!list || !list.length) return 0;
    let n = 0;
    for (const entry of list.slice()) {
      if (entry.once) this.removeEventListener(type, entry.fn);
      try { entry.fn(ev || { type: type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} }); n += 1; }
      catch (err) { grabSync('监听器 ' + type, err); }
    }
    return n;
  },
  dispatchEvent() { return true; },
  click() {}, focus() {}, blur() {},
  querySelector() { return null; },
  querySelectorAll() { return []; },
  closest() { return null; },
  contains() { return false; },
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight, x: 0, y: 0 }; },
};

// document.documentElement → head / body 之间的 getElementById：按真实 DOM 树查，不搞旁路索引
function findInTree(root, id, out) {
  if (!root || out.found) return;
  if (root.id === id) { out.found = root; return; }
  (root.childNodes || []).forEach(function (c) { findInTree(c, id, out); });
}

function makeDom() {
  const html = makeNode('html');
  html.__isDocumentElement = true;
  const head = makeNode('head');
  const body = makeNode('body');
  html.appendChild(head);
  html.appendChild(body);

  const document = {
    documentElement: html,
    head,
    body,
    __listeners: {},
    createElement(tag) { return makeNode(tag); },
    createTextNode(t) { const n = makeNode('#text'); n.textContent = String(t); return n; },
    getElementById(id) { const out = { found: null }; findInTree(html, String(id), out); return out.found; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn, opts) { NODE_PROTO.addEventListener.call(document, type, fn, opts); },
    removeEventListener(type, fn) { NODE_PROTO.removeEventListener.call(document, type, fn); },
    fire(type, ev) { return NODE_PROTO.fire.call(document, type, ev); },
  };

  const win = {
    innerWidth: 1920,
    innerHeight: 1080,
    devicePixelRatio: 1,
    __listeners: {},
    addEventListener(type, fn, opts) { NODE_PROTO.addEventListener.call(win, type, fn, opts); },
    removeEventListener(type, fn) { NODE_PROTO.removeEventListener.call(win, type, fn); },
    fire(type, ev) { return NODE_PROTO.fire.call(win, type, ev); },
    matchMedia() { return { matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }; },
  };

  return { document, win, html, head, body };
}

/* ------------------------------------------------- 假宿主接口（fetch 等） */
const BASE_URL = 'http://127.0.0.1:65535/dsh-bg-panel';
const hostState = { config: {}, items: [], dir: '', fail: false };

function jsonRes(obj, status) {
  return {
    ok: (status || 200) < 400,
    status: status || 200,
    headers: { get() { return null; } },
    json: async function () { return obj; },
    text: async function () { return JSON.stringify(obj); },
    blob: async function () { return { size: 2048, type: 'image/png' }; },
  };
}

async function fakeFetch(url, options) {
  const u = String(url);
  const method = ((options && options.method) || 'GET').toUpperCase();
  if (/\/list$/.test(u)) {
    if (hostState.fail) return jsonRes({ error: '宿主接口炸了' }, 500);
    return jsonRes({
      config: Object.assign({}, hostState.config),
      items: hostState.items.map(function (i) { return Object.assign({}, i); }),
      base: BASE_URL,
      ...(hostState.dir ? { dir: hostState.dir } : {}),
    });
  }
  if (/\/config$/.test(u) && method === 'POST') {
    let patch = {};
    try { patch = JSON.parse((options && options.body) || '{}'); } catch (err) { patch = {}; }
    hostState.config = Object.assign({}, hostState.config, patch);
    return jsonRes({ config: Object.assign({}, hostState.config) });
  }
  if (/\/upload/.test(u)) return jsonRes({ item: { name: 'x.png', kind: 'image', size: 2048 } });
  if (/\/delete/.test(u)) {
    const m = /name=([^&]+)/.exec(u);
    if (m) hostState.items = hostState.items.filter(function (i) { return i.name !== decodeURIComponent(m[1]); });
    return jsonRes({ ok: true });
  }
  if (/\/file\?/.test(u)) return jsonRes({ ok: true });
  return jsonRes({ error: 'HTTP 404' }, 404);
}

/* --------------------------------------------- 沙箱组装 + 跑 client.js */
const dom = makeDom();
const { document, win } = dom;

class MutationObserverStub {
  constructor(cb) { this.cb = cb; this.observers.push(this); }
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
}
MutationObserverStub.prototype.observers = [];
const mutationObservers = MutationObserverStub.prototype.observers;

class ResizeObserverStub {
  constructor(cb) { this.cb = cb; }
  observe(el) {
    try { this.cb([{ target: el, contentRect: { width: el && el.clientWidth, height: el && el.clientHeight } }], this); }
    catch (err) { grabSync('ResizeObserver 回调', err); }
  }
  unobserve() {}
  disconnect() {}
}

class ImageStub {
  constructor() {
    this.complete = true;
    this.naturalWidth = 1600;
    this.naturalHeight = 900;
    this.width = 1600;
    this.height = 900;
    this.onload = null;
    this.onerror = null;
    this.__src = '';
  }
  set src(v) {
    this.__src = String(v);
    const self = this;
    queueMicrotask(function () {
      try { if (typeof self.onload === 'function') self.onload({ target: self, currentTarget: self, type: 'load' }); }
      catch (err) { grabAsync('Image.onload', err); }
    });
  }
  get src() { return this.__src; }
  addEventListener() {} removeEventListener() {}
}

let urlSeq = 1;
const URLStub = {
  createObjectURL() { return 'blob:stub/' + (urlSeq++); },
  revokeObjectURL() {},
};

const captured = { cfg: null };
win.__ModuleLoader__ = { load(cfg) { captured.cfg = cfg; } };
win.document = document;
win.navigator = { userAgent: 'node-vm-render-harness', language: 'zh-CN', platform: 'Win32', clipboard: { writeText: async function () {} } };
win.location = { href: BASE_URL + '/', protocol: 'http:', host: '127.0.0.1:65535', origin: 'http://127.0.0.1:65535', pathname: '/', search: '', hash: '' };

const sandbox = {
  window: win,
  document,
  navigator: win.navigator,
  location: win.location,
  Image: ImageStub,
  URL: URLStub,
  fetch: fakeFetch,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  setInterval: fakeSetTimeout,
  clearInterval: fakeClearTimeout,
  requestAnimationFrame: function (fn) { return fakeSetTimeout(fn, 16); },
  cancelAnimationFrame: fakeClearTimeout,
  queueMicrotask,
  MutationObserver: MutationObserverStub,
  ResizeObserver: ResizeObserverStub,
  getComputedStyle() { return { getPropertyValue() { return ''; } }; },
  console,
  alert() {}, confirm() { return false; }, prompt() { return null; },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

try {
  vm.runInContext(code, sandbox, { filename: 'client.js' });
} catch (err) {
  check('client.js 能在 vm 沙箱里执行', false, brief(err));
}
check('client.js 调用了 window.__ModuleLoader__.load', !!captured.cfg, '没拿到产物配置');
const factory = captured.cfg && captured.cfg.factory;
check('factory 是函数且 id 是 dsh-bg-panel',
  typeof factory === 'function' && captured.cfg.id === 'dsh-bg-panel',
  captured.cfg && captured.cfg.id);

/* ---------------------------------------- 迷你 React（hooks + createElement） */
const instances = new Map();
const dirty = new Set();
let current = null;
let hookIndex = 0;
let passUsed = new Set();

function h(type, props) {
  const p = Object.assign({}, props || {});
  const kids = Array.prototype.slice.call(arguments, 2);
  if (kids.length === 1) p.children = kids[0];
  else if (kids.length > 1) p.children = kids;
  return { __el: true, type, props: p };
}

function needHook(name) {
  if (!current) throw new Error(name + ' 在组件渲染之外被调用（hooks 顺序错乱）');
  return current;
}
function slotsOf(inst) { return inst.hooks; }

const ReactStub = {
  createElement: h,
  Fragment: 'Fragment',
  useState(init) {
    const inst = needHook('useState');
    const i = hookIndex++;
    let slot = slotsOf(inst)[i];
    if (!slot) { slot = slotsOf(inst)[i] = { kind: 'state', value: typeof init === 'function' ? init() : init }; }
    return [slot.value, function (upd) {
      slot.value = typeof upd === 'function' ? upd(slot.value) : upd;
      dirty.add(inst);
    }];
  },
  useEffect(fn, deps) {
    const inst = needHook('useEffect');
    const i = hookIndex++;
    const prev = slotsOf(inst)[i];
    const changed = !prev || !prev.deps || !deps || deps.length !== prev.deps.length
      || deps.some(function (d, k) { return !Object.is(d, prev.deps[k]); });
    slotsOf(inst)[i] = {
      kind: 'effect',
      deps: deps || null,
      pending: changed ? fn : null,
      cleanup: prev ? prev.cleanup : null,
    };
  },
  useLayoutEffect(fn, deps) { ReactStub.useEffect(fn, deps); },
  useRef(init) {
    const inst = needHook('useRef');
    const i = hookIndex++;
    let slot = slotsOf(inst)[i];
    if (!slot) slot = slotsOf(inst)[i] = { kind: 'ref', current: init === undefined ? null : init };
    return slot;
  },
  useMemo(fn) { needHook('useMemo'); hookIndex += 1; return fn(); },
  useCallback(fn) { needHook('useCallback'); hookIndex += 1; return fn; },
  useContext() { needHook('useContext'); hookIndex += 1; return {}; },
};

function compName(type) { return (type && type.name) || 'anonymous'; }
function instLabel(inst) { return compName(inst.type) + '@' + inst.pathKey; }

function runEffect(inst, slot) {
  const fn = slot.pending;
  slot.pending = null;
  if (typeof slot.cleanup === 'function') {
    try { slot.cleanup(); } catch (err) { grabSync('effect 清理 ' + instLabel(inst), err); }
    slot.cleanup = null;
  }
  try {
    const c = fn();
    if (typeof c === 'function') slot.cleanup = c;
  } catch (err) { grabSync('effect ' + instLabel(inst), err); }
}

function flushEffects() {
  for (const inst of Array.from(instances.values())) {
    for (const slot of inst.hooks) {
      if (slot && slot.kind === 'effect' && slot.pending) runEffect(inst, slot);
    }
  }
}

function unmountInstance(inst) {
  for (let i = inst.hooks.length - 1; i >= 0; i -= 1) {
    const slot = inst.hooks[i];
    if (slot && slot.kind === 'effect' && typeof slot.cleanup === 'function') {
      try { slot.cleanup(); } catch (err) { grabSync('卸载清理 ' + instLabel(inst), err); }
      slot.cleanup = null;
    }
  }
}
function unmountAll() {
  for (const inst of Array.from(instances.values())) unmountInstance(inst);
  instances.clear();
  dirty.clear();
}
function sweepUnused() {
  for (const [key, inst] of Array.from(instances.entries())) {
    if (!passUsed.has(inst)) { unmountInstance(inst); instances.delete(key); }
  }
}

function takeInstance(pathKey, type, props) {
  let inst = instances.get(pathKey);
  if (inst && inst.type !== type) { unmountInstance(inst); instances.delete(pathKey); inst = null; }
  if (!inst) inst = { type, props, hooks: [], pathKey };
  inst.props = props;
  instances.set(pathKey, inst);
  passUsed.add(inst);
  return inst;
}

// 展开 h(...) 树：函数型 = 组件（有自己的 hooks），字符串型 = 宿主元素（造 stub 节点、接 ref）
function expand(node, pathKey, parentNode) {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (typeof node === 'string' || typeof node === 'number') return { __text: true, value: String(node) };
  if (Array.isArray(node)) {
    const out = [];
    for (let i = 0; i < node.length; i += 1) {
      const c = expand(node[i], pathKey + '#' + i, parentNode);
      if (c !== null) out.push(c);
    }
    return out;
  }
  const props = node.props || {};
  if (typeof node.type === 'function') {
    const inst = takeInstance(pathKey, node.type, props);
    current = inst;
    hookIndex = 0;
    let out = null;
    try { out = node.type(props); }
    catch (err) { grabSync('渲染 ' + compName(node.type), err); out = null; }
    finally { current = null; }
    if (out === null || out === undefined) return null;
    return expand(out, pathKey + '>r', parentNode);
  }
  const host = makeNode(String(node.type));
  if (props.className) host.className = String(props.className);
  if (parentNode) host.parentNode = parentNode;
  if (props.ref) {
    if (typeof props.ref === 'function') { try { props.ref(host); } catch (err) { grabSync('ref 回调', err); } }
    else if (typeof props.ref === 'object') props.ref.current = host;
  }
  const kids = expand(props.children, pathKey + '>h', host);
  const children = kids === null ? [] : (Array.isArray(kids) ? kids : [kids]);
  return { __host: true, type: String(node.type), props, node: host, children };
}

function walk(tree, fn, parent) {
  if (!tree) return;
  if (Array.isArray(tree)) { tree.forEach(function (c) { walk(c, fn, parent); }); return; }
  if (!tree.__host) return;
  fn(tree, parent);
  tree.children.forEach(function (c) { walk(c, fn, tree); });
}
function textOf(el) {
  let s = '';
  (function rec(n) {
    if (!n) return;
    if (Array.isArray(n)) { n.forEach(rec); return; }
    if (n.__text) { s += n.value; return; }
    if (n.__host) { if (n.props && (n.props.title || n.props.placeholder)) s += ' ' + (n.props.title || n.props.placeholder); n.children.forEach(rec); }
  })(el);
  return s;
}
function firstByType(el, type) {
  let hit = null;
  walk(el, function (n) { if (!hit && n.type === type) hit = n; });
  return hit;
}
function hostsOf(tree) { const out = []; walk(tree, function (n) { out.push(n); }); return out; }

/* -------------------------------------------------- 合成事件 + 回调遍历 */
function makeEvent(kind, valueTarget, currentTarget) {
  return {
    type: kind,
    target: valueTarget,
    currentTarget: currentTarget || null,
    clientX: 12, clientY: 34, pageX: 12, pageY: 34, screenX: 12, screenY: 34,
    movementX: 3, movementY: 4, deltaX: 0, deltaY: -1, deltaZ: 0, deltaMode: 0,
    button: 0, buttons: 1, detail: 1, which: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: 0.5,
    key: 'Enter', code: 'Enter', keyCode: 13, repeat: false,
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    dataTransfer: { files: [], types: [], getData() { return ''; }, setData() {}, dropEffect: 'none', effectAllowed: 'all' },
    relatedTarget: null, timeStamp: 1, isTrusted: false, bubbles: true, cancelable: true,
    preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, persist() {}, composedPath() { return []; },
  };
}
function makeValueTarget(type, props, el) {
  const p = props || {};
  let value = '1';
  if (p.type === 'range') value = String(p.value == null ? (p.min == null ? 1 : p.min) : p.value);
  else if (p.type === 'number') value = '128';
  else if (p.type === 'checkbox') value = 'on';
  else if (p.type === 'file') value = '';
  else if (type === 'select' && el) {
    const opt = firstByType(el, 'option');
    if (opt && opt.props.value != null) value = String(opt.props.value);
  }
  return {
    value: value,
    checked: p.type === 'checkbox' ? true : false,
    files: p.type === 'file' ? [{ name: 'demo.png', type: 'image/png', size: 2048 }] : [],
    naturalWidth: 1600, naturalHeight: 900, videoWidth: 1280, videoHeight: 720,
    playbackRate: 1, currentTime: 0, volume: 1, muted: false, complete: true,
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    focus() {}, blur() {}, click() {}, closest() { return null; }, querySelector() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 340, height: 190, right: 340, bottom: 190 }; },
  };
}
function describeHost(el) {
  const cls = String(el.props.className || '').split(' ').filter(Boolean)[0];
  return el.type + (cls ? '.' + cls : '');
}
// 把树里所有 on* 回调都调一遍（合成事件）；返回实际调用次数，异常按位置记录
function invokeHandlers(tree, sceneLabel) {
  let count = 0;
  walk(tree, function (el) {
    const isMask = /dbp-confirm-mask/.test(String(el.props.className || ''));
    Object.keys(el.props).forEach(function (k) {
      if (!/^on[A-Z]/.test(k)) return;
      const fn = el.props[k];
      if (typeof fn !== 'function') return;
      const target = makeValueTarget(el.type, el.props, el);
      // 遮罩层的 onMouseDown 靠 e.target === e.currentTarget 判断"点到了遮罩本身"，
      // 这里让两者相同，好把"点遮罩关闭弹窗"这条分支也走到
      const ev = makeEvent(k.slice(2).toLowerCase(), target, isMask ? target : null);
      try { fn(ev); count += 1; }
      catch (err) { grabSync(sceneLabel + ' · ' + describeHost(el) + ' 的 ' + k, err); }
    });
  });
  return count;
}

/* ----------------------------------------------------- 驱动：渲染 + 交互 */
let rootType = null;
let rootProps = {};
let rootKey = 'r0';

function expandRoot() {
  passUsed = new Set();
  let tree = null;
  try {
    tree = expand({ __el: true, type: rootType, props: rootProps }, rootKey, null);
  } catch (err) { grabSync('根渲染 ' + compName(rootType), err); tree = null; }
  sweepUnused();
  return tree;
}

// 反复展开直到没有待处理的 setState（最多 maxPass 轮，防自激死循环）
async function pump(maxPass) {
  let tree = null;
  for (let i = 0; i < (maxPass || 6); i += 1) {
    tree = expandRoot();
    flushEffects();
    await settle();
    if (!dirty.size) break;
    dirty.clear();
  }
  return tree;
}

function fireWindowEvents() {
  win.fire('resize', makeEvent('resize', makeValueTarget('div', {}, null), null));
  win.fire('pointermove', makeEvent('pointermove', makeValueTarget('div', {}, null), null));
  win.fire('pointerup', makeEvent('pointerup', makeValueTarget('div', {}, null), null));
  win.fire('pointercancel', makeEvent('pointercancel', makeValueTarget('div', {}, null), null));
  document.fire('click', makeEvent('click', makeValueTarget('div', {}, null), null));
  document.fire('touchstart', makeEvent('touchstart', makeValueTarget('div', {}, null), null));
  mutationObservers.slice().forEach(function (o) {
    try { o.cb([]); } catch (err) { grabSync('MutationObserver 回调', err); }
  });
}

function resetHost(sc) {
  hostState.config = Object.assign({}, sc.config || {});
  hostState.items = (sc.items || []).map(function (i, k) {
    return Object.assign({
      name: 'item-' + k,
      kind: /\.(mp4|webm|mov|m4v|ogv)$/i.test(i.name || '') ? 'video' : 'image',
      size: 1024,
    }, i);
  });
  hostState.dir = sc.dir || '';
  hostState.fail = !!sc.fail;
  // 干净 body（模拟新开页面），head 不动
  dom.body.childNodes.slice().forEach(function (n) { dom.body.removeChild(n); });
  dom.body.attributes = {};
  dom.body.className = '';
  if (sc.dark) dom.body.setAttribute('data-ds-dark-theme', '');
  timers.clear();
}

/* --------------------------------------------------------- 场景专属探针 */
function videoControlRows(tree) {
  const rows = [];
  walk(tree, function (el) {
    if (el.type !== 'label' && !/dbp-row/.test(String(el.props.className || ''))) return;
    const input = firstByType(el, 'input');
    if (input) rows.push({ text: textOf(el).replace(/\s+/g, ' ').trim().slice(0, 14), disabled: !!input.props.disabled });
  });
  return rows;
}
function isVideoTree(rows) { return rows.filter(function (r) { return /视频循环|视频静音|播放速度/.test(r.text); }); }

/* -------------------------------------------------------------- 场景表 */
const scenarios = [
  {
    title: '默认配置（无背景）',
    config: {}, items: [],
    probe: function (c) {
      check('无背景时不留背景层、body 不带 data-dsh-bg-panel',
        !c.doc.getElementById('dsh-bg-panel-layer') && !c.doc.body.hasAttribute('data-dsh-bg-panel'));
    },
  },
  {
    title: '背景=图片 a.png',
    config: { active: 'a.png' }, items: [],
    probe: function (c) {
      const layer = c.doc.getElementById('dsh-bg-panel-layer');
      const inner = layer && layer.childNodes[0];
      const scrimStyle = layer && layer.childNodes[1] ? layer.childNodes[1].getAttribute('style') || '' : '';
      check('图片背景：背景层建起来了且第一个孩子是图片层（applyLayer 真跑过）',
        !!layer && !!inner && inner.tag === 'div' && /background-image:url\("blob:/.test(inner.getAttribute('style') || ''),
        layer ? 'layer=' + layer.tag + ' inner=' + (inner && inner.tag) : '没有 #dsh-bg-panel-layer');
      check('背景层生效时 body 打了 data-dsh-bg-panel',
        c.doc.body.hasAttribute('data-dsh-bg-panel'));
      check('浅色主题：遮罩取白色并按 dim=20%（默认）压（与深色相反，主题相关渲染真的生效）',
        /rgba\(255,255,255,0\.200\)/.test(scrimStyle), 'scrim=' + scrimStyle);
    },
  },
  {
    title: '背景=视频 a.mp4（循环/静音/倍速可操作）',
    config: { active: 'a.mp4', videoLoop: true, videoMuted: true, videoRate: 1.5 }, items: [],
    probe: function (c) {
      const layer = c.doc.getElementById('dsh-bg-panel-layer');
      const inner = layer && layer.childNodes[0];
      const scrimStyle = layer && layer.childNodes[1] ? layer.childNodes[1].getAttribute('style') || '' : '';
      check('视频背景：层里放的是 <video>，且按 dim=20%（默认）压遮罩',
        !!inner && inner.tag === 'video' && /rgba\((?:0,0,0|255,255,255),0\.200\)/.test(scrimStyle),
        'inner=' + (inner && inner.tag) + ' scrim=' + scrimStyle);
      // 这一条直接盯住 vDis 那个 bug：视频背景时三项控件**不该**被 disabled
      const rows = isVideoTree(videoControlRows(c.tree));
      check('视频背景：视频循环/静音/播放速度三项控件可操作（vDis 在 BgMain 作用域可见）',
        rows.length === 3 && rows.every(function (r) { return !r.disabled; }),
        JSON.stringify(rows));
    },
  },
  {
    title: '视频有声 videoMuted:false（走 play() 兜底）',
    config: { active: 'a.mp4', videoMuted: false, videoLoop: false, videoRate: 0.25 }, items: [],
    probe: function (c) {
      check('有声自动播放：document 上挂好了 click/touchstart 兜底',
        (c.doc.__listeners.click || []).length > 0 || (c.doc.__listeners.touchstart || []).length > 0);
    },
  },
  {
    title: '全透明模式开（palette=blue-fantasy）',
    config: { active: 'a.png', palette: 'blue-fantasy' }, items: [],
    probe: function (c) {
      const style = c.doc.getElementById('dsh-bg-panel-style');
      check('全透明模式：主题 token 覆盖写进了 style',
        !!style && /--dsw-static-blue-500/.test(style.textContent || ''));
    },
  },
  {
    title: '全透明模式关（palette=\'\'）',
    config: { active: 'a.png', palette: '', accent: '#3b82f6' }, items: [],
    probe: function (c) {
      const style = c.doc.getElementById('dsh-bg-panel-style');
      check('全透明关：不套用整套配色 token',
        !!style && !/--dsw-static-blue-500/.test(style.textContent || ''));
    },
  },
  {
    title: '主题色 accent=#3b82f6 + 全透明',
    config: { active: 'a.png', palette: 'blue-fantasy', accent: '#3b82f6' }, items: [],
    probe: function (c) {
      const style = c.doc.getElementById('dsh-bg-panel-style');
      check('主题色：品牌色 token 被换成 #3b82f6',
        !!style && /--dsw-alias-brand-primary:#3b82f6/.test(style.textContent || ''));
    },
  },
  {
    title: '历史 2 条（含 1 个视频）',
    config: { active: 'a.png' },
    items: [{ name: 'his-1.png', kind: 'image', size: 204800 }, { name: 'his-2.mp4', kind: 'video', size: 5242880 }],
    probe: function (c) {
      const cells = hostsOf(c.tree).filter(function (el) { return /dbp-cell/.test(String(el.props.className || '')); });
      const thumbs = hostsOf(c.tree).filter(function (el) { return /dbp-thumb/.test(String(el.props.className || '')); });
      check('历史图库：2 个格子、缩略图分别画成 img / video（视频格子带「视频」角标）',
        cells.length === 2 && thumbs.length === 2
        && thumbs.some(function (t) { return t.type === 'video'; })
        && thumbs.some(function (t) { return t.type === 'img'; }),
        'cells=' + cells.length + ' thumbs=' + thumbs.map(function (t) { return t.type; }).join(','));
    },
  },
  {
    title: '非视频背景（a.png）：三项控件应禁用',
    config: { active: 'a.png' }, items: [],
    probe: function (c) {
      const rows = isVideoTree(videoControlRows(c.tree));
      check('非视频背景：视频循环/静音/播放速度三项被禁用',
        rows.length === 3 && rows.every(function (r) { return r.disabled; }),
        JSON.stringify(rows));
    },
  },
  {
    title: '深色主题 + 模糊/暗化 + contain + dir',
    dark: true,
    dir: 'D:\\fake\\bg',
    config: { active: 'a.png', blur: 8, dim: 60, fit: 'contain', translucent: true }, items: [],
    probe: function (c) {
      const style = c.doc.getElementById('dsh-bg-panel-style');
      const layer = c.doc.getElementById('dsh-bg-panel-layer');
      // 模糊写在媒体元素的行内 style 上；遮罩按 cfg.dim/100 上色，深色取黑、浅色取白
      const inline = layer ? layer.childNodes.map(function (n) { return n.getAttribute('style') || ''; }).join(' ') : '';
      const css = (style && style.textContent) || '';
      check('深色主题 + 模糊：媒体元素带 blur(8px)、遮罩按 dim=60% 压暗且取黑（深色分支真跑了）',
        /blur\(8px\)/.test(inline) && /rgba\(0,0,0,0\.600\)/.test(inline)
        && /html,body\{background:transparent/.test(css),
        'inline=' + inline.slice(0, 120) + ' cssLen=' + css.length);
    },
  },
  {
    title: '历史含 GIF + active=一张 GIF（裁剪提示分支）',
    config: { active: 'his-9.gif' },
    items: [{ name: 'his-9.gif', kind: 'image', size: 3072 }],
    probe: function (c) {
      check('GIF 背景：面板渲染出来了（裁剪会提示只保留当前帧）',
        hostsOf(c.tree).some(function (el) { return /dbp-root/.test(String(el.props.className || '')); }));
    },
  },
  {
    title: '宿主 /list 报错（错误提示分支）',
    fail: true, config: {}, items: [],
    probe: function (c) {
      const msg = hostsOf(c.tree).filter(function (el) { return /dbp-msg/.test(String(el.props.className || '')); });
      check('宿主接口报错：面板渲染出错误提示而不是白屏',
        msg.length > 0 && /宿主接口炸了|宿主接口没响应/.test(msg.map(function (m) { return textOf(m); }).join('')),
        msg.map(function (m) { return textOf(m); }).join('|').slice(0, 80));
    },
  },
];

/* ------------------------------------------------------------------ 主流程 */
let effectCleanups = [];
console.log('[1] 装载与注册');
let registry = new Map();
try {
  const mod = factory(function (name) {
    if (name === 'react') return ReactStub;
    throw new Error('产物不该 require 别的模块，却要了：' + name);
  });
  check('模块导出 inject/apply 且 inject 里有 slots',
    Array.isArray(mod.inject) && mod.inject.includes('slots') && typeof mod.apply === 'function',
    JSON.stringify(mod.inject));

  const slotCalls = [];
  const cleanups = [];
  const ctx = {
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') cleanups.push(dispose);
      return function () {};
    },
    inject(names, cb) { return typeof cb === 'function' ? cb({ webServer: { register() { return () => {}; } } }) : undefined; },
    slots: {
      inject(name, cb) { slotCalls.push(name); return typeof cb === 'function' ? cb() : undefined; },
      register(payload, component) { registry.set(payload.name, { payload, component }); return function () {}; },
      get(name) { return registry.get(name) && registry.get(name).component; },
      list() { return Array.from(registry.keys()); },
    },
    webServer: { register() { return () => {}; } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on() {}, off() {}, emit() {},
  };
  mod.apply(ctx);
  check('apply(ctx) 注册了 main 与 sidebar.panellist 两个组件',
    registry.has('main') && registry.has('sidebar.panellist') && typeof registry.get('main').component === 'function',
    '已注册：' + Array.from(registry.keys()).join(','));
  check('apply 常驻注入了入口样式 dsh-bg-panel-row-style',
    !!document.getElementById('dsh-bg-panel-row-style'));
  effectCleanups = cleanups;
} catch (err) {
  check('factory + apply(ctx) 能跑完', false, brief(err));
}

console.log('\n[2] 侧边栏入口组件（sidebar.panellist）');
if (registry.has('sidebar.panellist')) {
  rootType = registry.get('sidebar.panellist').component;
  rootKey = 'entry';
  rootProps = {};
  const mark = syncErrors.length;
  let tree = expandRoot();
  flushEffects();
  const errs = syncErrors.slice(mark);
  const svg = tree && firstByType(tree, 'svg');
  const stops = svg ? hostsOf(svg).filter(function (n) { return n.type === 'stop'; }) : [];
  check('入口组件渲染不抛异常', errs.length === 0, errs[0] && brief(errs[0]));
  check('入口组件画出了画笔图标（svg + 7 段七彩渐变）',
    !!svg && stops.length === 7,
    'svg=' + !!svg + ' stops=' + stops.length);

  rootProps = { active: true };
  const mark2 = syncErrors.length;
  const tree2 = expandRoot();
  flushEffects();
  const errs2 = syncErrors.slice(mark2);
  check('入口组件选中态（props.active=true）渲染不抛异常且带 .on',
    errs2.length === 0 && !!tree2 && /\bon\b/.test(String(tree2.props.className || '')),
    errs2[0] ? brief(errs2[0]) : String(tree2 && tree2.props.className));
}

console.log('\n[3] 主面板组件（main 槽）逐状态真渲染 + 事件回调');
let totalInvoked = 0;
if (registry.has('main')) {
  rootType = registry.get('main').component;
  rootKey = 'main';

  for (const sc of scenarios) {
    resetHost(sc);
    unmountAll();
    rootProps = {};

    // —— 挂载态 ——
    const mark = syncErrors.length;
    let tree = await pump(6);
    const mountErrs = syncErrors.slice(mark);
    check('挂载渲染「' + sc.title + '」不抛异常',
      mountErrs.length === 0,
      mountErrs[0] ? brief(mountErrs[0]) : '');

    // —— 场景专属断言（挂载态上做，避免被后面的交互改脏）——
    if (sc.probe) {
      try { sc.probe({ tree, doc: document, win }); }
      catch (err) { grabSync('场景探针 ' + sc.title, err); }
    }

    // —— 交互：把树里所有 on* 回调都真调一遍，反复 4 轮 ——
    const mark2 = syncErrors.length;
    let invoked = 0;
    let lastTree = tree;
    for (let round = 0; round < 4; round += 1) {
      if (!lastTree) break;
      invoked += invokeHandlers(lastTree, sc.title);
      await settle();
      fireWindowEvents();
      await settle();
      lastTree = await pump(6);
    }
    const interErrs = syncErrors.slice(mark2);
    check('交互后重渲染「' + sc.title + '」不抛异常（真调了 ' + invoked + ' 个 on* 回调）',
      interErrs.length === 0 && invoked > 0,
      interErrs.length ? brief(interErrs[0]) : (invoked === 0 ? '一个回调都没调到，测试空转了' : ''));
    totalInvoked += invoked;
  }
}

console.log('\n[4] 收尾');
check('on* 回调真的被调用过（防空转）', totalInvoked > 0, '共 ' + totalInvoked + ' 次');
check('异步链路（fetch / blob / Image.onload / video.loadedmetadata）没有未捕获异常',
  asyncErrors.length === 0,
  asyncErrors[0] ? brief(asyncErrors[0]) : '');
if (effectCleanups.length) {
  let cleanupErr = null;
  effectCleanups.forEach(function (fn) {
    try { fn(); } catch (err) { cleanupErr = cleanupErr || err; }
  });
  check('apply 注册的 effect 清理函数调用不抛异常', !cleanupErr, cleanupErr ? brief(cleanupErr) : '');
}

console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
