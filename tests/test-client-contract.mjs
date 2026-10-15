/* 浏览器产物的契约检查：在 vm 里跑 client.js，抓 window.__ModuleLoader__.load 的入参，
 * 再调 factory 看返回的模块契约。不碰 DOM、不渲染，只验接口形状。
 * 用法：在仓库根目录执行 node tests/test-client-contract.mjs
 */
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

let captured = null;
const sandbox = {
  window: { __ModuleLoader__: { load(cfg) { captured = cfg; } } },
  console,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });

check('调用了 __ModuleLoader__.load', !!captured);
check('id 等于包名', captured && captured.id === 'dsh-bg-panel', captured && captured.id);
check('factory 是函数', captured && typeof captured.factory === 'function');

const ReactStub = {
  createElement() { return null; },
  useState() { return [null, function () {}]; },
  useEffect() {},
  useRef() { return { current: null }; },
};
const required = [];
const mod = captured.factory(function (name) {
  required.push(name);
  if (name === 'react') return ReactStub;
  throw new Error('产物不应 require 其他模块，却要了：' + name);
});

check('只从模块表取 react', required.length === 1 && required[0] === 'react', required.join(','));
check('模块声明 inject: [slots]', Array.isArray(mod.inject) && mod.inject.includes('slots'), JSON.stringify(mod.inject));
check('apply 是函数', typeof mod.apply === 'function');

console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
