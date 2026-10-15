/* ============================================================================
 * dsh-bg-panel —— 宿主半边
 *
 * 职责：
 *   1. 管一个数据目录（默认 ~/.dsh/bg-panel/），history/ 子目录放导入的图片与视频；
 *   2. 提供 /dsh-bg-panel/* 路由：列清单、取文件（支持 Range，视频拖动要靠它）、
 *      上传、删除、保存配置；
 *   3. 配置写 config.json，跟着宿主走 —— 换端口/换浏览器也不会丢。
 *
 * 安全栅栏：只认回环 Host；写操作额外要求同源（sec-fetch-site / Origin 校验）。
 * 文件名一律白名单正则 + 扩展名白名单，杜绝路径穿越。
 *
 * ---------------------------------------------------------------------------
 * 0.7.0 改动（2026-10-15，由蓝曦审后修）：
 *   ① Range 后缀式 bytes=-N 原来被当成 0..N-1，现在按"最后 N 字节"算；
 *   ② 去掉 Access-Control-Allow-Origin: *（同源请求本就不需要它，
 *      留着等于让任意网页都能读走清单和素材）；
 *   ③ .svg 移出白名单 —— SVG 里能塞 <script>，/file 直接打开它
 *      就会在回环源上执行脚本；背景用不到矢量图，索性不收；
 *   ④ 上传超限由 500 改为 413；
 *   ⑤ /upload 改原子写（先落 .tmp 再 rename），避免断电留半截文件；
 *   ⑥ readBody 超限不再 destroy 连接，改为带状态码正常回应；
 *   ⑦ 新增四个字段：videoLoop / videoMuted / videoRate / gifFps。
 * ========================================================================== */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROUTE = '/dsh-bg-panel';
const MAX_UPLOAD = 64 * 1024 * 1024; // 单个文件上限 64MB
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const EXT_KIND = {
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.webp': 'image', '.avif': 'image', '.bmp': 'image',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.m4v': 'video', '.ogv': 'video',
};
const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v', '.ogv': 'video/ogg',
};

const DEFAULT_CONFIG = {
  active: '',
  fit: 'cover',
  dim: 20,
  blur: 0,
  transparentPanels: false,
  // 位置与缩放：0.5 = 居中；zoom 1–4。只对 fit=cover 生效，
  // 客户端预览框与真实背景层用同一套像素公式，所以预览就是所见即所得。
  posX: 0.5,
  posY: 0.5,
  zoom: 1,
  // —— 0.7.0 新增：视频与动图专属 ——
  videoLoop: true,   // false = 只播一遍，停在最后一帧
  videoMuted: true,  // false = 放声音（背景视频默认静音更稳）
  videoRate: 1,      // 播放速度 0.25 – 2
  gifFps: 0,         // GIF 帧率上限；0 = 不限制（原速）。大 GIF 很吃 CPU，卡顿时可设 12/15
};

function cleanConfig(raw) {
  const out = Object.assign({}, DEFAULT_CONFIG);
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.active === 'string' && NAME_RE.test(raw.active)) out.active = raw.active;
  if (raw.fit === 'cover' || raw.fit === 'contain' || raw.fit === 'repeat') out.fit = raw.fit;
  if (typeof raw.dim === 'number' && isFinite(raw.dim)) out.dim = Math.min(80, Math.max(0, Math.round(raw.dim)));
  if (typeof raw.blur === 'number' && isFinite(raw.blur)) out.blur = Math.min(20, Math.max(0, Math.round(raw.blur)));
  if (typeof raw.posX === 'number' && isFinite(raw.posX)) out.posX = Math.min(1, Math.max(0, raw.posX));
  if (typeof raw.posY === 'number' && isFinite(raw.posY)) out.posY = Math.min(1, Math.max(0, raw.posY));
  if (typeof raw.zoom === 'number' && isFinite(raw.zoom)) out.zoom = Math.min(4, Math.max(1, raw.zoom));
  if (raw.palette === '' || raw.palette === 'blue-fantasy') out.palette = raw.palette;
  // 0.7.0 补：DEFAULT_CONFIG 里一直有 transparentPanels，但从来没清洗分支，
  // 所以这个字段永远写不出 true —— 实际是死的（代码审查指出）
  if (typeof raw.transparentPanels === 'boolean') out.transparentPanels = raw.transparentPanels;
  out.translucent = raw.translucent !== false;           // 默认开
  if (typeof raw.panelAlpha === 'number' && isFinite(raw.panelAlpha)) {
    out.panelAlpha = Math.max(0, Math.min(100, Math.round(raw.panelAlpha)));
  }
  if (typeof raw.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.accent)) out.accent = raw.accent.toLowerCase();
  // —— 0.7.0 新增 ——
  if (typeof raw.videoLoop === 'boolean') out.videoLoop = raw.videoLoop;
  if (typeof raw.videoMuted === 'boolean') out.videoMuted = raw.videoMuted;
  if (typeof raw.videoRate === 'number' && isFinite(raw.videoRate)) {
    // 步进半档，避免滑块抖动写出 1.0000000001 这种值
    out.videoRate = Math.round(Math.min(2, Math.max(0.25, raw.videoRate)) * 4) / 4;
  }
  if (typeof raw.gifFps === 'number' && isFinite(raw.gifFps)) {
    out.gifFps = Math.min(60, Math.max(0, Math.round(raw.gifFps)));
  }
  return out;
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  // 不回 Access-Control-Allow-Origin：面板是同源页面，本就不需要它。
  // 带上 "*" 会让任意站点都能 fetch 本机 /list 与素材（0.6.0 的问题②）。
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(text)),
  });
  res.end(text);
}

function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

// 拆 "主机名 + 端口"：端口缺省时是空串，主机名去掉 IPv6 方括号并转小写
function hostParts(host) {
  if (typeof host !== 'string') return null;
  const m = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(host.trim());
  if (!m) return null;
  return { name: m[1].replace(/^\[|\]$/g, '').toLowerCase(), port: m[2] || '' };
}

// Origin 必须与本次请求的 Host 同端口 —— 回环名之间（127.0.0.1 / localhost / ::1）可视为等价。
// 0.7.0 只看主机名，本机其它端口的网页也能过闸（审查指出）
function sameLoopbackOrigin(origin, hostHeader) {
  let parsed;
  try { parsed = new URL(origin); } catch (err) { return false; }
  const a = hostParts(parsed.host);
  const b = hostParts(hostHeader);
  if (!a || !b || a.port !== b.port) return false;
  return isLoopbackHost(a.name) && isLoopbackHost(b.name);
}

// 返回 true 表示已经拒绝并结束响应
function fenceRejected(req, res) {
  if (!isLoopbackHost(req.headers && req.headers.host)) {
    json(res, 403, { error: 'forbidden host' });
    return true;
  }
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return false;
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    json(res, 403, { error: 'cross-site write rejected' });
    return true;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin) {
    try {
      if (!sameLoopbackOrigin(origin, req.headers && req.headers.host)) {
        json(res, 403, { error: 'foreign origin rejected' });
        return true;
      }
    } catch (err) {
      json(res, 403, { error: 'bad origin' });
      return true;
    }
  }
  return false;
}

// 超限时抛出带 code 的错误，由调用方翻成 413（0.6.0 会变成 500）
class BodyTooLarge extends Error {
  constructor(limit) {
    // 小于 1MB 时按 KB 报，否则 64KB 的上限会被说成"上限 0MB"
    super('文件超过上限 ' + (limit < 1024 * 1024
      ? Math.round(limit / 1024) + 'KB'
      : Math.round(limit / 1024 / 1024) + 'MB'));
    this.code = 413;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; fn(arg); } };
    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > limit) {
        // 不 destroy：让调用方拿到错误、正常回一个 413，
        // 客户端才知道发生了什么（0.6.0 直接掐断，对面只会干等）
        req.pause();
        finish(reject, new BodyTooLarge(limit));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks)));
    req.on('error', (err) => finish(reject, err));
  });
}

export function apply(ctx, config) {
  const root = (config && typeof config.dir === 'string' && config.dir)
    ? config.dir
    : path.join(os.homedir(), '.dsh', 'bg-panel');
  const historyDir = path.join(root, 'history');
  const configFile = path.join(root, 'config.json');

  fs.mkdirSync(historyDir, { recursive: true });

  function readConfig() {
    try {
      return cleanConfig(JSON.parse(fs.readFileSync(configFile, 'utf8')));
    } catch (err) {
      return Object.assign({}, DEFAULT_CONFIG);
    }
  }

  function writeConfig(next) {
    const clean = cleanConfig(next);
    const tmp = configFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
    fs.renameSync(tmp, configFile);
    return clean;
  }

  function safePath(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
    const ext = path.extname(name).toLowerCase();
    if (!MIME[ext]) return null;
    const full = path.join(historyDir, name);
    if (path.dirname(path.resolve(full)) !== path.resolve(historyDir)) return null;
    return full;
  }

  function listItems() {
    let names = [];
    try { names = fs.readdirSync(historyDir); } catch (err) { names = []; }
    const items = [];
    for (const name of names) {
      const full = safePath(name);
      if (!full) continue;
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        items.push({
          name,
          size: st.size,
          mtime: st.mtimeMs,
          kind: EXT_KIND[path.extname(name).toLowerCase()] || 'image',
        });
      } catch (err) { /* 跳过读不到的 */ }
    }
    items.sort((a, b) => b.mtime - a.mtime);
    return items;
  }

  // 解析单段 Range。返回 null 表示"没有可用的 Range，走整文件"。
  // 支持三种写法（0.6.0 只对前两种正确）：
  //   bytes=100-200   闭区间
  //   bytes=100-      从 100 到结尾
  //   bytes=-500      ★ 最后 500 字节（原来被错当成 0-499）
  function parseRange(header, size) {
    if (typeof header !== 'string' || !header) return null;
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m) return null;
    const hasStart = m[1] !== '';
    const hasEnd = m[2] !== '';
    if (!hasStart && !hasEnd) return null;              // "bytes=-" 无意义
    let start;
    let end;
    if (!hasStart) {
      // 后缀式：取末尾 N 字节
      const suffix = parseInt(m[2], 10);
      if (!isFinite(suffix) || suffix <= 0) return null;
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = parseInt(m[1], 10);
      end = hasEnd ? parseInt(m[2], 10) : size - 1;
    }
    if (!isFinite(start) || start < 0) start = 0;
    if (!isFinite(end) || end >= size) end = size - 1;
    if (start > end || start >= size) return { unsatisfiable: true };
    return { start, end };
  }

  function serveFile(req, res, name) {
    const full = safePath(name);
    if (!full || !fs.existsSync(full)) {
      json(res, 404, { error: 'not found' });
      return;
    }
    const stat = fs.statSync(full);
    const ext = path.extname(full).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const range = parseRange(req.headers.range, stat.size);
    if (range && range.unsatisfiable) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
      res.end();
      return;
    }
    // 媒体是拿绝对地址 fetch 再转 blob 加载的（client.js），页面可能挂在 dsh-app:// 下：
    // 那种情况算跨源，0.7.0 删掉 ACAO 时漏了这条读路由 → 缩略图/预览/视频全黑。
    // 按 Origin 回显放行，且只认回环来源与 dsh-app://，绝不下发 "*"（审查补充）
    const origin = req.headers.origin;
    if (origin && /^(https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?|dsh-app:\/\/[a-z0-9.-]+)$/i.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (range) {
      res.writeHead(206, {
        'Content-Type': mime,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      });
      const rs = fs.createReadStream(full, { start: range.start, end: range.end });
      // statSync 之后、流真正 open 之前文件可能被 /delete 删掉（或被 /upload 顶掉）——
      // 那时 'error' 没人接就是 uncaughtException，会把整个宿主进程带下去
      rs.on('error', () => { try { res.destroy(); } catch (err) { /* ignore */ } });
      // 反向也要兜：客户端中途断开时 res 自己会 emit ERR_STREAM_DESTROYED，
      // 没人接同样是 uncaughtException，会把宿主进程带下去（审查指出）
      res.on('error', () => { try { res.destroy(); } catch (err) { /* ignore */ } });
      rs.pipe(res);
      return;
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    const rs2 = fs.createReadStream(full);
    rs2.on('error', () => { try { res.destroy(); } catch (err) { /* ignore */ } });
    // 同上：够不着写端的时候 res 的 'error' 没人接就是进程级崩溃
    res.on('error', () => { try { res.destroy(); } catch (err) { /* ignore */ } });
    rs2.pipe(res);
  }

  const log = (msg) => {
    try { console.log('[dsh-bg-panel] ' + msg); } catch (err) { /* ignore */ }
  };
  log('数据目录：' + root);

  ctx.inject(['webServer'], (wctx) => {
    const disposers = [];
    const reg = (suffix, handler) => {
      disposers.push(wctx.webServer.register({
        kind: 'exact',
        path: ROUTE + suffix,
        handler: async (req, res) => {
          if (fenceRejected(req, res)) return;
          try {
            await handler(req, res);
          } catch (err) {
            const code = (err && err.code === 413) ? 413 : 500;
            if (!res.headersSent) json(res, code, { error: String((err && err.message) || err) });
            else { try { res.end(); } catch (e2) { /* ignore */ } }
          }
        },
      }));
    };

    // 列清单 + 当前配置
    reg('/list', async (req, res) => {
      // 前端页面可能挂在 dsh-app:// 协议下，相对地址会被解析成那个协议而 404。
      // 所以这里把宿主自己的绝对地址（取自请求的 Host 头）一并下发，媒体一律用它。
      const host = (req.headers && req.headers.host) || '127.0.0.1:19387';
      // dir（宿主绝对路径）不下发：这条路由不受 GUI 鉴权保护，没必要把宿主目录结构说出去
      // （审查指出）。服务端日志里仍有记录。
      json(res, 200, { base: 'http://' + host + ROUTE, config: readConfig(), items: listItems() });
    });

    // 取文件（带 Range，视频拖动进度要用）
    reg('/file', async (req, res) => {
      const name = new URL(req.url, 'http://127.0.0.1').searchParams.get('name') || '';
      serveFile(req, res, name);
    });

    // 上传：原始字节直接进 body，文件名走查询串
    reg('/upload', async (req, res) => {
      if (String(req.method || '').toUpperCase() !== 'POST') { json(res, 405, { error: 'POST only' }); return; }
      const url = new URL(req.url, 'http://127.0.0.1');
      let name = url.searchParams.get('name') || '';
      name = path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_');
      const full = safePath(name);
      if (!full) { json(res, 400, { error: '文件名或扩展名不被接受：' + name }); return; }
      const body = await readBody(req, MAX_UPLOAD);   // 超限会抛 413
      if (!body.length) { json(res, 400, { error: '空文件' }); return; }
      // 原子写：先落 .tmp 再 rename —— 写一半断电不会留下半截素材
      const tmp = full + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
      try {
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, full);
      } catch (err) {
        // 写盘失败（ENOSPC/IO）也会走到这儿：不清理就会留一个
        // /list 看不见、/delete 又删不掉的 .tmp（扩展名过不了白名单）
        try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
        throw err;
      }
      log('已导入 ' + name + '（' + body.length + ' 字节）');
      const st = fs.statSync(full);
      json(res, 200, {
        item: { name, size: st.size, mtime: st.mtimeMs, kind: EXT_KIND[path.extname(name).toLowerCase()] || 'image' },
      });
    });

    // 删除
    reg('/delete', async (req, res) => {
      if (String(req.method || '').toUpperCase() !== 'POST') { json(res, 405, { error: 'POST only' }); return; }
      const name = new URL(req.url, 'http://127.0.0.1').searchParams.get('name') || '';
      const full = safePath(name);
      if (!full || !fs.existsSync(full)) { json(res, 404, { error: 'not found' }); return; }
      fs.unlinkSync(full);
      const cur = readConfig();
      if (cur.active === name) writeConfig(Object.assign({}, cur, { active: '' }));
      log('已删除 ' + name);
      json(res, 200, { ok: true, config: readConfig() });
    });

    // 保存配置
    reg('/config', async (req, res) => {
      if (String(req.method || '').toUpperCase() !== 'POST') { json(res, 405, { error: 'POST only' }); return; }
      const body = await readBody(req, 64 * 1024);
      let parsed = {};
      try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch (err) { json(res, 400, { error: 'bad json' }); return; }
      // JSON.parse('null') === null、'1' === 1：不是普通对象就当坏请求回 400，
      // 免得下面读 parsed.active 抛 TypeError 变成 500（审查指出）。
      // 也不静默当成 {} 存下去 —— 那等于客户端一个笔误就把背景配置清空。
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        json(res, 400, { error: 'bad json' });
        return;
      }
      if (parsed.active) {
        const full = safePath(parsed.active);
        if (!full || !fs.existsSync(full)) { json(res, 400, { error: '背景文件不存在：' + parsed.active }); return; }
      }
      json(res, 200, { config: writeConfig(parsed) });
    });

    return () => {
      for (const dispose of disposers) {
        try { dispose(); } catch (err) { /* ignore */ }
      }
    };
  });
}
