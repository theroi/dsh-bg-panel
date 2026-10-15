/* 宿主半边的真实验证：把 apply() 注册的路由挂到真 http 服务器上跑一遍。
 * 覆盖：上传 / 列清单 / 取文件（含 Range）/ 保存配置 / 删除 / 信任栅栏 / 路径穿越。
 * 用法：在仓库根目录执行 node tests/test-host.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, 'tmp-bg');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

let pass = 0;
let fail = 0;
function check(label, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + label); }
  else { fail += 1; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}

// —— 假的 cordis ctx：只实现 inject + webServer.register ——
const routes = [];
const fakeCtx = {
  inject(names, cb) {
    check('apply 请求注入 webServer', names.includes('webServer'));
    return cb({ webServer: { register(route) { routes.push(route); return () => {}; } } });
  },
};
apply(fakeCtx, { dir: tmp });
check('注册了 5 条路由', routes.length === 5, '实际 ' + routes.length);

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  const route = routes.find((r) => r.kind === 'exact' && r.path === pathname);
  if (!route) { res.writeHead(404); res.end(); return; }
  route.handler(req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

try {
  console.log('\n[1] 上传');
  let res = await fetch(base + '/dsh-bg-panel/upload?name=test.png', {
    method: 'POST', headers: { 'sec-fetch-site': 'same-origin', 'Content-Type': 'image/png' }, body: PNG,
  });
  check('POST /upload 返回 200', res.status === 200, 'status=' + res.status);
  let body = await res.json();
  check('返回条目 kind=image', body.item && body.item.kind === 'image', JSON.stringify(body));
  check('文件真的落盘', fs.existsSync(path.join(tmp, 'history', 'test.png')));

  console.log('\n[2] 路径穿越与坏扩展名');
  res = await fetch(base + '/dsh-bg-panel/upload?name=' + encodeURIComponent('../../evil.png'), {
    method: 'POST', headers: { 'sec-fetch-site': 'same-origin' }, body: PNG,
  });
  const traverseBody = await res.json().catch(() => ({}));
  check('穿越名被挡或落回本目录',
    res.status !== 200 || !fs.existsSync(path.join(tmp, '..', 'evil.png')),
    'status=' + res.status + ' ' + JSON.stringify(traverseBody));
  res = await fetch(base + '/dsh-bg-panel/upload?name=bad.exe', {
    method: 'POST', headers: { 'sec-fetch-site': 'same-origin' }, body: PNG,
  });
  check('非白名单扩展名被拒（400）', res.status === 400, 'status=' + res.status);

  console.log('\n[3] 列清单 + 取文件 + Range');
  res = await fetch(base + '/dsh-bg-panel/list');
  body = await res.json();
  check('list 里有 test.png', (body.items || []).some((i) => i.name === 'test.png'));
  // 安全修复③：/list 不再回显宿主绝对路径 dir（该路由不受 GUI 鉴权保护）。
  // 原断言是「带 dir」，与新契约相反，故改为断言 dir 已消失、base/config 仍在。
  check('list 不带 dir（绝对路径不回显）且带 base/config',
    !('dir' in body) && typeof body.base === 'string' && !!body.config,
    JSON.stringify({ dir: body.dir, base: body.base }));

  res = await fetch(base + '/dsh-bg-panel/file?name=test.png');
  check('GET /file 200 且 Content-Type=image/png',
    res.status === 200 && res.headers.get('content-type') === 'image/png',
    'status=' + res.status + ' ct=' + res.headers.get('content-type'));
  const whole = Buffer.from(await res.arrayBuffer());
  check('取到的字节与上传一致', whole.length === PNG.length && whole.equals(PNG), 'len=' + whole.length);

  res = await fetch(base + '/dsh-bg-panel/file?name=test.png', { headers: { Range: 'bytes=0-3' } });
  check('Range 请求返回 206', res.status === 206, 'status=' + res.status);
  check('Content-Range 正确', res.headers.get('content-range') === 'bytes 0-3/' + PNG.length,
    res.headers.get('content-range'));

  console.log('\n[4] 保存配置（含清洗）');
  res = await fetch(base + '/dsh-bg-panel/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ active: 'test.png', dim: 999, blur: -5, fit: 'weird', transparentPanels: 1, evil: 'x' }),
  });
  body = await res.json();
  check('dim 被夹到 80', body.config.dim === 80, 'dim=' + body.config.dim);
  check('blur 被夹到 0', body.config.blur === 0, 'blur=' + body.config.blur);
  check('非法 fit 被回默认 cover', body.config.fit === 'cover', 'fit=' + body.config.fit);
  check('未知字段被丢弃', !('evil' in body.config));
  check('config.json 真写了', fs.existsSync(path.join(tmp, 'config.json')));

  // 新增的位置/缩放字段：越界必须夹回合法区间，缺省必须是 0.5/0.5/1
  res = await fetch(base + '/dsh-bg-panel/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ active: 'test.png', posX: 5, posY: -3, zoom: 99 }),
  });
  body = await res.json();
  check('posX 夹到 1', body.config.posX === 1, 'posX=' + body.config.posX);
  check('posY 夹到 0', body.config.posY === 0, 'posY=' + body.config.posY);
  check('zoom 夹到 4', body.config.zoom === 4, 'zoom=' + body.config.zoom);

  res = await fetch(base + '/dsh-bg-panel/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ active: 'test.png', posX: 'x', zoom: 0.2 }),
  });
  body = await res.json();
  check('非数字 posX 回落到 0.5', body.config.posX === 0.5, 'posX=' + JSON.stringify(body.config.posX));
  check('zoom 下限夹到 1', body.config.zoom === 1, 'zoom=' + body.config.zoom);

  res = await fetch(base + '/dsh-bg-panel/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ active: 'nope.png' }),
  });
  check('指向不存在的背景文件被拒（400）', res.status === 400, 'status=' + res.status);

  console.log('\n[5] 信任栅栏');
  res = await fetch(base + '/dsh-bg-panel/upload?name=x.png', {
    method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: PNG,
  });
  check('跨站写请求 403', res.status === 403, 'status=' + res.status);
  const forged = await new Promise((resolve) => {
    const req2 = http.request({
      host: '127.0.0.1', port: server.address().port, path: '/dsh-bg-panel/list', method: 'GET',
      headers: { Host: 'evil.example.com' },
    }, (r) => { r.resume(); resolve(r.statusCode); });
    req2.on('error', () => resolve(-1));
    req2.end();
  });
  check('伪造 Host 的读请求 403', forged === 403, 'status=' + forged);

  console.log('\n[6] 删除');
  res = await fetch(base + '/dsh-bg-panel/delete?name=test.png', {
    method: 'POST', headers: { 'sec-fetch-site': 'same-origin' },
  });
  body = await res.json();
  check('删除返回 200', res.status === 200, 'status=' + res.status);
  check('文件已删', !fs.existsSync(path.join(tmp, 'history', 'test.png')));
  check('删的是当前背景时 active 被清空', body.config.active === '', 'active=' + JSON.stringify(body.config.active));
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}
