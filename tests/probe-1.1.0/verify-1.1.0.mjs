/**
 * 测试角色 · 1.1.0（REQ-20261114-02）C1-C5 独立复核探针。
 * 不复用开发用例的断言写法：直接从 package.json / adapters 导出自证取值。
 * 只读；不写仓库文件。运行：node tests\probe-1.1.0\verify-1.1.0.mjs
 */
import fs from 'node:fs/promises';

import {
  DEFAULT_MATRIX, detectAdapter, detectHostVersion, runSelfCheck, satisfiesRange,
} from '../../packages/dsh-context-governance/src/compress/adapters.js';
import { detectConflicts } from '../../packages/dsh-context-governance/src/compress/selection.js';
import { buildProtectionItems } from '../../packages/dsh-context-governance/src/compress/protection-memory.js';
import { detectTitleTruncation } from '../../packages/dsh-context-governance/src/memory/contract.js';

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`);
}

class CtxZip {
  constructor() { this.undoManualSeat = () => {}; }
  compactNow() {}
  compactRegion() {}
}
const selfCheckFor = (hostVersion) => runSelfCheck({
  adapter: detectAdapter({ compaction: new CtxZip(), hostVersion, backendVersion: '0.1.10' }),
  eventApi: true,
  matrix: DEFAULT_MATRIX,
});

// C1：单一真源字面相等
const manifest = JSON.parse(await fs.readFile(new URL('../../packages/dsh-context-governance/package.json', import.meta.url), 'utf8'));
check('C1-engines-single-source',
  manifest.engines.dsh === DEFAULT_MATRIX.host.join(' || ') && DEFAULT_MATRIX.host.length === 2,
  `engines="${manifest.engines.dsh}" matrix=${JSON.stringify(DEFAULT_MATRIX.host)}`);
check('C1-satisfiesRange-not-for-or-string',
  satisfiesRange('0.2.2-rc.3', manifest.engines.dsh) === false && satisfiesRange('0.2.2-rc.3', DEFAULT_MATRIX.host[1]) === true,
  `satisfies(enginesstr)=${satisfiesRange('0.2.2-rc.3', manifest.engines.dsh)} satisfies(2nd)=${satisfiesRange('0.2.2-rc.3', DEFAULT_MATRIX.host[1])}`);
check('C1-version', manifest.version === '1.1.0', `version=${manifest.version}`);

// C2：区间语义全表
const expectIn = ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1', '0.2.2-rc.3', '0.2.2-rc.4', '0.2.2'];
const expectOut = ['0.2.2-rc.1', '0.2.2-rc.2', '0.1.9', '0.3.0-rc.1', '0.3.0'];
const wrongIn = expectIn.filter((v) => selfCheckFor(v).matrix.host !== 'in');
const wrongOut = expectOut.filter((v) => selfCheckFor(v).matrix.host !== 'out');
check('C2-range-matrix', wrongIn.length === 0 && wrongOut.length === 0,
  `in=${expectIn.length - wrongIn.length}/${expectIn.length} out=${expectOut.length - wrongOut.length}/${expectOut.length} 误判=${JSON.stringify([...wrongIn, ...wrongOut])}`);

// C3：自检不误伤
const good = selfCheckFor('0.2.2-rc.3');
const goodConflicts = detectConflicts({ adapter: good }).filter((c) => c.code === 'host-version-out-of-matrix');
const bad = selfCheckFor('0.2.2-rc.1');
const badConflicts = detectConflicts({ adapter: bad }).filter((c) => c.code === 'host-version-out-of-matrix' && c.severity === 'error');
check('C3-0.2.2-rc.3-in', good.matrix.host === 'in' && good.selfCheck.state !== 'fail' && goodConflicts.length === 0,
  `matrix=${good.matrix.host} state=${good.selfCheck.state} conflicts=${goodConflicts.length}`);
check('C3-0.2.2-rc.1-out', bad.matrix.host === 'out' && bad.selfCheck.state === 'fail' && badConflicts.length > 0,
  `matrix=${bad.matrix.host} state=${bad.selfCheck.state} conflicts=${badConflicts.length}`);

// C4：版本探测 fixtures
const rc3 = detectHostVersion({
  resourcesPath: 'C:/app/resources',
  readFile: (file) => {
    if (file.endsWith('/app.asar/dsh/package.json')) return JSON.stringify({ version: '0.2.2-rc.3' });
    throw new Error('ENOENT');
  },
  resolvePackage: () => { throw new Error('unused'); },
});
const unknown = detectHostVersion({
  resourcesPath: undefined,
  readFile: () => { throw new Error('ENOENT'); },
  resolvePackage: () => { throw new Error('not found'); },
});
check('C4-detect', rc3 === '0.2.2-rc.3' && unknown === 'unknown', `rc3=${rc3} fail=${unknown}`);

// C5：#4 三项
const base = { latestUser: null, rules: [], batch: null, rollback: null, unpairedCalls: [] };
const ctx = { sessionId: 's', cycleKey: 'c-110' };
const build = (patch) => buildProtectionItems({ ...base, ...patch }, ctx).items;
const plain = build({ rollback: { paths: [], keyword: '回滚点', seq: 1 } });
const plainAnchor = plain.find((item) => item.type === 'anchor');
check('C5-plain-fallback', plainAnchor?.title === '回滚点（见 source）', `title="${plainAnchor?.title}"`);

const residual = build({ rollback: { paths: [], keyword: '回滚点：G:\\DS-HARNESS`（见记忆', seq: 2 } });
const residualAnchor = residual.find((item) => item.type === 'anchor');
check('C5-residual-fallback',
  residualAnchor?.title === '回滚点（见 source）' && detectTitleTruncation(residualAnchor?.title) === null,
  `title="${residualAnchor?.title}" trunc=${detectTitleTruncation(residualAnchor?.title)}`);

const noneBatch = build({ batch: { ratios: [], statePath: null, seq: 3 } });
const ratiosOnly = build({ batch: { ratios: ['511/958'], statePath: null, seq: 4 } });
const pathOnly = build({ batch: { ratios: [], statePath: 'G:\\T\\x-STATE.md', seq: 5 } });
const ratiosTitle = ratiosOnly.find((item) => item.type === 'progress')?.title ?? '';
const pathTitle = pathOnly.find((item) => item.type === 'progress')?.title ?? '';
check('C5-batch-three-cases',
  noneBatch.every((item) => item.type !== 'progress') &&
  ratiosTitle === '批次进度：511/958' && pathTitle.startsWith('批次 STATE：') &&
  !`${ratiosTitle}${pathTitle}`.includes('有批次标记'),
  `none=无 progress, ratios="${ratiosTitle}", statePath="${pathTitle}"`);

const longMsg = '这是一条很长的用户消息'.repeat(30);
const longItems = build({ latestUser: { title: longMsg, seq: 6 } });
const fact = longItems.find((item) => item.type === 'fact');
check('C5-user-title-budget',
  fact !== undefined && fact.title.length <= 87 && fact.title.startsWith('最后用户消息：') && fact.detail.includes(longMsg),
  `titleLen=${fact?.title.length} detailLen=${fact?.detail.length} full=${fact?.detail.includes(longMsg)}`);

const failed = results.filter((item) => !item.ok);
console.log(`\nVERIFY 1.1.0 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
