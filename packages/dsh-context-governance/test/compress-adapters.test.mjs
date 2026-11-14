import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADAPTER_KINDS,
  AdapterContractError,
  DEFAULT_MATRIX,
  applySummaryObservation,
  classifySummaryText,
  compareSemver,
  createContextZipAdapter,
  createHostBasicAdapter,
  detectAdapter,
  detectHostVersion,
  normalizeBackendVersion,
  runSelfCheck,
  satisfiesRange,
  validateAdapter,
} from '../src/compress/adapters.js';
import { FIVE_SECTION_SUMMARY, FREE_FORM_SUMMARY } from './compress-helpers.mjs';
import { detectConflicts } from '../src/compress/selection.js';

class BasicCompactionEngine {
  compactNow() {}
  compactRegion() {}
  compactIfNeeded() {}
}

class ContextZipEngine {
  constructor() {
    this.declaredConfig = {};
    this.undoManualSeat = () => {};
  }
  compactNow() {}
  compactRegion() {}
}

test('detectAdapter：识别宿主默认与 context-zip，缺服务/未知 provider 不猜', () => {
  assert.equal(detectAdapter({ compaction: null }).kind, 'none');
  assert.equal(detectAdapter({ compaction: {} }).kind, 'unknown');
  assert.equal(detectAdapter({ compaction: { compactNow() {} } }).kind, 'unknown');
  assert.equal(detectAdapter({ compaction: new BasicCompactionEngine() }).kind, 'host-basic');
  assert.equal(detectAdapter({ compaction: new ContextZipEngine() }).kind, 'context-zip');
  assert.equal(detectAdapter({
    compaction: { compactNow() {}, constructor: { name: 'ContextZipEngine' } },
  }).kind, 'context-zip');
});

test('适配器九维字段完整且通过校验', () => {
  const adapter = detectAdapter({
    compaction: new ContextZipEngine(),
    hostVersion: '0.2.1-rc.2',
    backendVersion: '0.1.10',
  });
  validateAdapter(adapter);
  for (const kind of ADAPTER_KINDS) assert.equal(typeof kind, 'string');
  assert.equal(adapter.control, 'host-pressure');
  assert.equal(adapter.perception, 'event');
  assert.deepEqual(adapter.triggers, ['compaction-event', 'command']);
  assert.equal(adapter.hooks.before, 'best-effort');
  assert.equal(adapter.summary.authority, 'exclusive');
  assert.equal(adapter.rewrite.boundary, 'replace-span');
  assert.equal(adapter.protectionRole, 'validator');
  assert.equal(adapter.observability.range, true);
  assert.equal(adapter.versions.host, '0.2.1-rc.2');
  assert.equal(adapter.versions.backend, '0.1.10');
});

test('校验器拒绝缺字段/非法枚举', () => {
  const good = createHostBasicAdapter({ hostVersion: '0.2.1-rc.2' });
  assert.throws(() => validateAdapter({ ...good, perception: 'telepathy' }), AdapterContractError);
  assert.throws(() => validateAdapter({ ...good, summary: undefined }), AdapterContractError);
  assert.throws(() => validateAdapter({ ...good, versions: { host: 'x' } }), AdapterContractError);
  assert.doesNotThrow(() => validateAdapter(good));
});

test('宿主矩阵按双区间：0.2.1 线与 0.2.2-rc.3 线通过；0.2.2-rc.1/rc.2、0.1.9、0.3.0 线拒绝', () => {
  // 单区间按 npm 语义判不了 0.2.2-rc.3（prerelease 同 [major,minor,patch] 才参与），故矩阵必须两段。
  assert.equal(satisfiesRange('0.2.2-rc.3', '>=0.2.1-rc.2 <0.2.2-0'), false);
  assert.equal(compareSemver('0.2.2-rc.3', '0.2.2-0'), 1);
  assert.equal(compareSemver('0.2.1-rc.3', '0.2.1-rc.2'), 1);
  assert.equal(compareSemver('0.2.1', '0.2.1-rc.4'), 1);

  const hostIn = ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1', '0.2.2-rc.3', '0.2.2-rc.4', '0.2.2'];
  for (const hostVersion of hostIn) {
    const adapter = runSelfCheck({
      adapter: detectAdapter({ compaction: new ContextZipEngine(), hostVersion, backendVersion: '0.1.10' }),
      eventApi: true,
      matrix: DEFAULT_MATRIX,
    });
    assert.equal(adapter.matrix.host, 'in', hostVersion);
    assert.equal(adapter.selfCheck.state, 'pass', hostVersion);
    assert.ok(
      !detectConflicts({ adapter }).some((conflict) => conflict.code === 'host-version-out-of-matrix'),
      `${hostVersion} 不得出 host-version-out-of-matrix`,
    );
  }

  const hostOut = ['0.2.2-rc.1', '0.2.2-rc.2', '0.1.9', '0.3.0-rc.1', '0.3.0'];
  for (const hostVersion of hostOut) {
    const adapter = runSelfCheck({
      adapter: detectAdapter({ compaction: new ContextZipEngine(), hostVersion, backendVersion: '0.1.10' }),
      eventApi: true,
      matrix: DEFAULT_MATRIX,
    });
    assert.equal(adapter.matrix.host, 'out', hostVersion);
    assert.equal(adapter.selfCheck.state, 'fail', hostVersion);
    assert.ok(
      detectConflicts({ adapter }).some((conflict) => conflict.code === 'host-version-out-of-matrix' && conflict.severity === 'error'),
      `${hostVersion} 应出 host-version-out-of-matrix`,
    );
  }
});

test('C1 区间单一真源：engines.dsh === DEFAULT_MATRIX.host.join(" || ")（字面相等，不喂 satisfiesRange）', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.engines.dsh, DEFAULT_MATRIX.host.join(' || '));
  assert.equal(DEFAULT_MATRIX.host.length, 2);
  // 引擎串含 `||`，不得喂给 satisfiesRange（其不支持 `||`，会恒 false）。
  assert.equal(satisfiesRange('0.2.2-rc.3', manifest.engines.dsh), false);
  assert.equal(satisfiesRange('0.2.2-rc.3', DEFAULT_MATRIX.host[1]), true);
  assert.equal(manifest.version, '1.1.0');
});

test('context-zip backend=unknown：只告警，不把自检判死', () => {
  const adapter = runSelfCheck({
    adapter: detectAdapter({
      compaction: new ContextZipEngine(),
      hostVersion: '0.2.1-rc.3',
      backendVersion: 'unknown',
    }),
    eventApi: true,
    matrix: DEFAULT_MATRIX,
  });
  assert.equal(adapter.matrix.host, 'in');
  assert.equal(adapter.matrix.backend, 'unknown');
  assert.equal(adapter.selfCheck.checks.find((check) => check.id === 'backend-version').status, 'warn');
  assert.equal(adapter.selfCheck.state, 'pass');
});

test('自检：矩阵内通过、版本出矩阵失败、事件面缺失失败', () => {
  const base = detectAdapter({
    compaction: new BasicCompactionEngine(),
    hostVersion: '0.2.1-rc.2',
  });
  const pending = runSelfCheck({ adapter: base, eventApi: true, matrix: DEFAULT_MATRIX });
  assert.equal(pending.selfCheck.state, 'pending');
  assert.equal(pending.selfCheck.checks.find((c) => c.id === 'compaction-service').status, 'pass');
  assert.equal(pending.selfCheck.checks.find((c) => c.id === 'summary-readability').status, 'pending');

  const noEvents = runSelfCheck({ adapter: base, eventApi: false, matrix: DEFAULT_MATRIX });
  assert.equal(noEvents.selfCheck.state, 'fail');

  const badHost = runSelfCheck({
    adapter: detectAdapter({ compaction: new BasicCompactionEngine(), hostVersion: '0.3.0' }),
    eventApi: true,
    matrix: DEFAULT_MATRIX,
  });
  assert.equal(badHost.selfCheck.state, 'fail');
  assert.equal(badHost.matrix.host, 'out');

  const badBackend = runSelfCheck({
    adapter: detectAdapter({
      compaction: new ContextZipEngine(),
      hostVersion: '0.2.1-rc.2',
      backendVersion: '0.2.0',
    }),
    eventApi: true,
    matrix: DEFAULT_MATRIX,
  });
  assert.equal(badBackend.matrix.backend, 'out');
  assert.equal(badBackend.selfCheck.state, 'fail');
});

test('摘要校准：五段式/自由式/不可读；并提示 provider 漂移', () => {
  assert.deepEqual(classifySummaryText('').readability, 'unreadable');
  assert.equal(classifySummaryText(FIVE_SECTION_SUMMARY).style, 'five-section');
  assert.equal(classifySummaryText(FREE_FORM_SUMMARY).style, 'free-form');

  const host = createHostBasicAdapter({ hostVersion: '0.2.1-rc.2' });
  const observed = applySummaryObservation(host, FIVE_SECTION_SUMMARY);
  assert.equal(observed.summary.style, 'five-section');
  assert.equal(observed.summary.readability, 'readable');
  assert.ok(observed.notes.some((note) => note.includes('provider may have been taken over')));

  const zip = createContextZipAdapter({ hostVersion: '0.2.1-rc.2', backendVersion: '0.1.10' });
  const zipFree = applySummaryObservation(zip, FREE_FORM_SUMMARY);
  assert.equal(zipFree.summary.style, 'free-form');
  assert.ok(zipFree.notes.some((note) => note.includes('takeover may be stale')));
});

test('宿主版本探测：asar → app → 包解析 → unknown', () => {
  const files = new Map([
    ['C:/app/resources/app.asar/dsh/package.json', JSON.stringify({ version: '0.2.1-rc.2' })],
    ['C:/app/resources/app/dsh/package.json', JSON.stringify({ version: '0.1.0' })],
  ]);
  assert.equal(detectHostVersion({
    resourcesPath: 'C:/app/resources',
    readFile: (file) => {
      if (!files.has(file)) throw new Error('ENOENT');
      return files.get(file);
    },
    resolvePackage: () => { throw new Error('unused'); },
  }), '0.2.1-rc.2');

  assert.equal(detectHostVersion({
    resourcesPath: '',
    readFile: () => JSON.stringify({ version: '0.2.2' }),
    resolvePackage: () => 'C:/host/@deepseek-ai/dsh-app-boot/package.json',
  }), '0.2.2');

  assert.equal(detectHostVersion({
    resourcesPath: undefined,
    readFile: () => { throw new Error('ENOENT'); },
    resolvePackage: () => { throw new Error('not found'); },
  }), 'unknown');

  // C4：0.2.2-rc.3 形态可读回（版本源 = app.asar/dsh/package.json，与引擎门禁同源核对见单 §四 C4）
  assert.equal(detectHostVersion({
    resourcesPath: 'C:/app/resources',
    readFile: (file) => {
      if (file.endsWith('/app.asar/dsh/package.json')) return JSON.stringify({ version: '0.2.2-rc.3' });
      throw new Error('ENOENT');
    },
    resolvePackage: () => { throw new Error('unused'); },
  }), '0.2.2-rc.3');

  // 非法 JSON 不抛错，继续下一个候选。
  assert.equal(detectHostVersion({
    resourcesPath: 'C:/app/resources',
    readFile: () => 'not json',
    resolvePackage: () => { throw new Error('not found'); },
  }), 'unknown');
});

test('normalizeBackendVersion 只清洗，不猜', () => {
  assert.equal(normalizeBackendVersion(' 0.1.10 '), '0.1.10');
  assert.equal(normalizeBackendVersion(''), 'unknown');
  assert.equal(normalizeBackendVersion(undefined), 'unknown');
  assert.equal(normalizeBackendVersion(42), 'unknown');
});
