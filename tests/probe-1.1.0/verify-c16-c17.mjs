/**
 * 测试角色 · 1.1.0 D2 离线契约探针（C16 / C17）。
 * 判据：REQUIREMENTS.md:1149-1150（2026-11-14 新增；根因口径按需求 23:5x 定稿）。
 *
 * 根因口径（需求定）：①客户端注册未走官方 `ctx.slots.inject(slotName, () => ctx.slots.register(...))`，
 * 失败被 try/catch 吞；②宿主 webServer 注册在服务就绪前整块跳过。**否决"缺 dsh.client.inject"**：
 * 宿主 parseDshClient() 只强制 platform，inject 只是 row 排序依赖；dsh.client 不改。
 *
 * 本探针编码"修好后应满足"的断言；修复落地前预期部分红（基线红）。
 * 运行：node tests\probe-1.1.0\verify-c16-c17.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`);
}

const PKG = 'packages/dsh-context-governance';
const manifest = JSON.parse(await fs.readFile(path.join(PKG, 'package.json'), 'utf8'));
const clientPath = path.join(process.cwd(), PKG, 'lib/client.js');
const clientSource = await fs.readFile(clientPath, 'utf8');
const indexSource = await fs.readFile(path.join(PKG, 'src/index.js'), 'utf8');
const policySource = await fs.readFile(path.join(PKG, 'src/settings-policy.js'), 'utf8');

async function loadClient(tag) {
  const captured = [];
  const savedWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (spec) => captured.push(spec) } };
  try {
    await import(pathToFileURL(clientPath).href + `?${tag}=${Date.now()}`);
  } finally {
    globalThis.window = savedWindow;
  }
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
  };
  return {
    captured,
    client: captured[0].factory((name) => {
      if (name !== 'react') throw new Error(`unexpected require: ${name}`);
      return reactStub;
    }),
  };
}

/** 假 slots：实现官方 inject/register 语义，可模拟"先无后有"。 */
function fakeSlots() {
  const registered = [];
  const available = new Set();
  const pending = new Map();
  return {
    registered,
    available,
    slots: {
      inject(name, callback) {
        if (available.has(name)) callback();
        else {
          const list = pending.get(name) ?? [];
          list.push(callback);
          pending.set(name, list);
        }
      },
      register(spec) { registered.push(spec.name); },
    },
    // 模拟宿主在 slot 就绪后回调 inject
    drain(name) {
      for (const callback of pending.get(name) ?? []) callback();
      pending.delete(name);
    },
    makeAvailable(...names) { for (const name of names) available.add(name); },
  };
}

// ── C16①：dsh.client 与宿主 parseDshClient() 逐字段对齐（platform 必填；inject/external/immediately 可选取值校验） ──
const decl = manifest.dsh?.client ?? null;
const allowedKeys = new Set(['platform', 'inject', 'external', 'immediately']);
const badKeys = decl === null ? ['<no dsh.client>'] : Object.keys(decl).filter((key) => !allowedKeys.has(key));
const typeOk = decl !== null
  && typeof decl.platform === 'string'
  && (decl.inject === undefined || (Array.isArray(decl.inject) && decl.inject.every((item) => typeof item === 'string')))
  && (decl.external === undefined || (Array.isArray(decl.external) && decl.external.every((item) => typeof item === 'string')))
  && (decl.immediately === undefined || typeof decl.immediately === 'boolean');
check('C16-manifest-shape', badKeys.length === 0 && typeOk,
  `decl=${JSON.stringify(decl)} 未知字段=${JSON.stringify(badKeys)} 类型=${typeOk}`);

// ── C16②：bundle 导出形状符合 Cordis 客户端插件约定（apply + inject 数组） ──
const { captured, client } = await loadClient('c16');
check('C16-bundle-exports',
  captured.length === 1 && captured[0].id === 'dsh-context-governance'
  && typeof client.apply === 'function' && Array.isArray(client.inject) && typeof client.registrationPlan === 'function',
  `load次数=${captured.length} id=${captured[0]?.id} apply=${typeof client.apply} inject=${JSON.stringify(client.inject)}`);

// ── C16③：apply 引用的服务 ⊆ 导出 inject（dsh.client.inject 不再是必需项，需求已否决） ──
const KNOWN_SERVICES = ['slots', 'locale', 'configForms'];
const usedServices = [...new Set([...clientSource.matchAll(/ctx\??\.(\w+)/g)]
  .map((match) => match[1])
  .filter((name) => KNOWN_SERVICES.includes(name)))];
const exportedInject = new Set(client.inject);
const missingExported = usedServices.filter((name) => !exportedInject.has(name));
check('C16-service-subset', usedServices.length > 0 && missingExported.length === 0,
  `用到=${JSON.stringify(usedServices)} 导出inject=${JSON.stringify([...exportedInject])} 缺导出=${JSON.stringify(missingExported)}`);

// ── C17(a)：slots 一开始就在 → 三处入口必须全部注册 ──
{
  const fake = fakeSlots();
  fake.makeAvailable('conversation.composer.dock', 'conversation.input.overlay', 'settings.section');
  client.apply({ locale: { language: 'zh' }, slots: fake.slots });
  check('C17-slots-present', fake.registered.length === 3,
    `注册数=${fake.registered.length} 入口=${JSON.stringify(fake.registered)}`);
}

// ── C17(b) 定稿（2bfdb69，限缩到槽位级）：槽位**声明**迟到 → 注册必须最终成功 ──
{
  const fake = fakeSlots();
  // slots 服务在场，但三个槽位名尚未声明（inject 会排队）
  client.apply({ locale: { language: 'zh' }, slots: fake.slots });
  const beforeArrival = fake.registered.length;
  // 槽位声明到达：宿主依次回调 inject
  fake.makeAvailable('conversation.composer.dock', 'conversation.input.overlay', 'settings.section');
  for (const name of ['conversation.composer.dock', 'conversation.input.overlay', 'settings.section']) fake.drain(name);
  await new Promise((resolve) => setTimeout(resolve, 100));
  check('C17-slot-late', beforeArrival === 0 && fake.registered.length === 3,
    `槽位到达前注册=${beforeArrival} 到达后注册=${fake.registered.length} 入口=${JSON.stringify(fake.registered)}`);
}

// ── C17(b2) 定稿：**服务整体缺席**（slots 不存在）→ 只要求 warn 可见 + 不崩 + 不静默，不要求重试 ──
{
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map((item) => String(item)).join(' ')); };
  let threw = null;
  try {
    client.apply({ locale: { language: 'zh' } }); // 无 slots 服务
  } catch (error) {
    threw = String(error?.message ?? error);
  } finally {
    console.warn = originalWarn;
  }
  const warned = warnings.some((line) => /slots service unavailable/.test(line) && /not registered/.test(line));
  check('C17-service-absent-warn', threw === null && warned,
    `抛错=${threw} warn 命中=${warned} 原文=${JSON.stringify(warnings)}`);
}

// ── C17(c)：客户端必须用官方 slots.inject 约定（当前直调 register 即失败点） ──
check('C17-client-slot-inject-convention', /slots\??\.inject\s*\(/.test(clientSource),
  `client.js 含 ctx.slots.inject(...)=${/slots\??\.inject\s*\(/.test(clientSource)}`);

// ── C17(d)：快照路由 GET→200 / 非 GET→405（handler 级，离线可直接跑） ──
{
  const { createSnapshotHandler } = await import(
    pathToFileURL(path.join(process.cwd(), PKG, 'src/settings-policy.js')).href
  );
  const res = () => {
    const record = { status: 0, body: '' };
    return { record, writeHead: (code) => { record.status = code; }, end: (body) => { record.body = body ?? ''; } };
  };
  const handler = createSnapshotHandler({
    getPolicy: () => ({ values: { 'compact.at': 0.6 }, sources: { 'compact.at': 'builtin' } }),
    getNative: () => 0.6785,
  });
  const ok = res(); handler({ method: 'GET' }, ok);
  const post = res(); handler({ method: 'POST' }, post);
  check('C17-route-methods', ok.record.status === 200 && post.record.status === 405,
    `GET=${ok.record.status} POST=${post.record.status}`);
}

// ── C17⑤（需求 3cca9cd 定稿）：路由注册顺序必须是**功能级假 ctx** —— 静态 grep 不算过。
//   允许面：mount 函数可在 settings-policy.js 或 index.js（需求已批 settings-policy 仅收拢该段）。
//   若两处都没有可调用函数 → 直接判不过（不再退化为静态断言）。
{
  let functional = null;
  let source = null;
  for (const candidate of ['src/settings-policy.js', 'src/index.js']) {
    try {
      const mod = await import(pathToFileURL(path.join(process.cwd(), PKG, candidate)).href);
      if (typeof mod.mountSnapshotRoute === 'function') { functional = mod.mountSnapshotRoute; source = candidate; break; }
    } catch (error) {
      console.log(`INFO mount 导入失败(${candidate})：${String(error?.message ?? error).slice(0, 120)}`);
    }
  }
  if (functional === null) {
    check('C17-host-webserver-late', false, '无可调用的 mountSnapshotRoute 导出 → 静态 grep 不算过，判失败');
  } else {
    const registered = [];
    let injected = null;
    const fakeCtx = {
      inject(services, callback) { injected = { services, callback }; },
      effect() {},
      logger: { warn() {} },
    };
    const returned = functional(fakeCtx, {
      getPolicy: () => ({ values: { 'compact.at': 0.6 }, sources: { 'compact.at': 'builtin' } }),
      getNative: () => 0.6785,
    });
    const waited = injected !== null && Array.isArray(injected.services) && injected.services.includes('webServer');
    const registeredBeforeCallback = registered.length;
    const scopedHost = {
      webServer: { register: (spec) => { registered.push(spec); return () => {}; } },
      effect() {},
    };
    if (injected !== null) injected.callback(scopedHost);
    check('C17-host-webserver-late',
      returned === true && waited && registeredBeforeCallback === 0
      && registered.length === 1 && registered[0].path === '/context-governance/policy-snapshot' && registered[0].kind === 'exact',
      `functional(${source}) inject(['webServer']) 捕获=${waited} 回调前注册=${registeredBeforeCallback} 回调后注册=${JSON.stringify(registered.map((spec) => spec.path))}`);
  }
}

// ── C17(生产同源)：mountSnapshotRoute 必须是生产路径调用的同一函数，禁止"测试专用实现" ──
{
  const definedInIndex = /export function mountSnapshotRoute\s*\(/.test(indexSource);
  const importedFromPolicy = /import\s*\{[^}]*mountSnapshotRoute[^}]*\}\s*from\s*['"]\.\/settings-policy\.js['"]/.test(indexSource);
  const calledInProduction = /mountSnapshotRoute\s*\(\s*ctx\s*,/.test(indexSource);
  check('C17-mount-production-call',
    (definedInIndex || importedFromPolicy) && calledInProduction,
    `定义在 index.js=${definedInIndex} 从 settings-policy 导入=${importedFromPolicy} 生产调用点=${calledInProduction}`);
}

// ── C17(单一实现，需求 da4d912)：mount 允许在 index.js 或 settings-policy.js 之一，
//   **不得两处重复实现**；另一文件只允许"移出该段"。 ──
{
  const definesInIndex = /export function mountSnapshotRoute\s*\(/.test(indexSource);
  const definesInPolicy = /export function mountSnapshotRoute\s*\(/.test(policySource);
  const duplicated = definesInIndex && definesInPolicy;
  check('C17-mount-single-source',
    (definesInIndex !== definesInPolicy) && !duplicated,
    `index.js 定义=${definesInIndex} settings-policy.js 定义=${definesInPolicy} 重复=${duplicated}`);
}

const failed = results.filter((item) => !item.ok);
console.log(`\nC16/C17 TOTAL ${results.length - failed.length}/${results.length} PASS（修复落地前预期为基线红）`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
