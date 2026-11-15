/**
 * P5（rc.11）：写入口 `via` —— 成功响应/审计只记来源类型，不记 token 值。
 * P3-a/P3-b（rc.11）：`header-injected` 的 `pointers` 不被白名单丢弃、两行 header 审计带 `sessionId`。
 * P6（rc.11）：无 session id 的 `resolveSessionRoot` 不抛，显式返回 no-root/no-session-id。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AuditLog } from '../src/audit.js';
import { RootRegistry } from '../src/roots/registry.js';
import { createPluginPolicyHandler, createSessionPolicyHandler, successVia } from '../src/session-policy-route.js';

const TOKEN = 'tok-via-0123456789abcdef';

function makeRes() {
  const res = { status: 0, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = payload === undefined ? '' : String(payload); };
  return res;
}

function makeReq(body, headers = {}) {
  const merged = { 'content-type': 'application/json', ...headers };
  return { method: 'POST', socket: { remoteAddress: '::1' }, headers: merged, body };
}

const SAME = { host: '127.0.0.1:8840', origin: 'http://127.0.0.1:8840' };
const CROSS = { host: '127.0.0.1:8840', origin: 'http://evil.example' };

test('P5 via：successVia 三证各自归类，无凭据为 null，且从不回 token 值', () => {
  assert.equal(successVia(makeReq({}, { ...SAME }), TOKEN), 'origin');
  assert.equal(successVia(makeReq({}, { host: '127.0.0.1:8840', 'sec-fetch-site': 'same-origin' }), TOKEN), 'sec-fetch');
  assert.equal(successVia(makeReq({}, { 'x-context-governance-csrf': TOKEN }), TOKEN), 'token');
  assert.equal(successVia(makeReq({}, {}), TOKEN), null, '三证皆无 → null（由调用方回 missing-proof）');
  assert.equal(successVia(makeReq({}, CROSS), TOKEN), null, '跨源 Origin 不得算作 origin 证');
  for (const via of ['origin', 'sec-fetch', 'token']) {
    assert.equal(String(via).includes(TOKEN), false, 'via 只能是类型字面量');
  }
});

test('P5 via：三种凭据各自 200 响应带对应 via，token 值不进响应', async () => {
  const cases = [
    { name: 'origin', headers: { ...SAME }, expect: 'origin' },
    { name: 'sec-fetch', headers: { host: '127.0.0.1:8840', 'sec-fetch-site': 'same-origin' }, expect: 'sec-fetch' },
    { name: 'token', headers: { 'x-context-governance-csrf': TOKEN }, expect: 'token' },
  ];
  for (const item of cases) {
    const inputs = [];
    const handler = createSessionPolicyHandler({
      csrfToken: TOKEN,
      writeSessionAt: async (input) => { inputs.push(input); return { ok: true }; },
    });
    const res = makeRes();
    await handler(makeReq({ sessionId: 'session-via', at: 0.5 }, item.headers), res);
    assert.equal(res.status, 200, `${item.name} 应放行`);
    const body = JSON.parse(res.body);
    assert.equal(body.via, item.expect, `${item.name} → via=${item.expect}`);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].via, item.expect, '写入回调必须拿到同一个 via，审计据此落盘');
    assert.equal(res.body.includes(TOKEN), false, 'token 值不得出现在响应里');
  }
});

test('P5 via：plugin 路由同样带 via；token-only 也能写（不再被漏传 csrfToken 卡死）', async () => {
  const inputs = [];
  const handler = createPluginPolicyHandler({
    csrfToken: TOKEN,
    writePluginAt: ({ at, via }) => { inputs.push({ at, via }); return { ok: true }; },
  });
  const res = makeRes();
  await handler(makeReq({ at: 0.62 }, { 'x-context-governance-csrf': TOKEN }), res);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.via, 'token');
  assert.equal(inputs[0].via, 'token');
  assert.equal(res.body.includes(TOKEN), false);
});

test('P5 via：policy-set 审计落 via，且不落 token 值', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-via-audit-'));
  try {
    const file = path.join(dir, 'audit.jsonl');
    const log = new AuditLog({ file });
    assert.equal(log.append('policy-set', { sessionId: 'session-via', key: 'compact.at', value: '0.5', via: 'sec-fetch' }), true);
    assert.equal(log.append('plugin-policy-persisted', { at: 0.5, via: 'token' }), true);
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows[0].via, 'sec-fetch');
    assert.equal(rows[1].via, 'token');
    assert.equal(JSON.stringify(rows).includes(TOKEN), false, 'token 值不得进审计');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('P3-a/P3-b：header-injected 的 pointers 能落盘，两行 header 审计都带 sessionId', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hdr-audit-'));
  try {
    const file = path.join(dir, 'audit.jsonl');
    const log = new AuditLog({ file });
    const { headerInjectedFields } = await import('../src/memory/header.js');
    log.append('header-injected', headerInjectedFields(
      { text: '[CG-MEMORY]\n- MEM-1 · A\n[Note: ...]', count: 1, mode: 'session-pointers' },
      { messagesBefore: 0, messagesAfter: 1 },
      { sessionId: 'session-hdr' },
    ));
    log.append('header-truncated', { count: 2, bytes: 300, lines: 4, sessionId: 'session-hdr' });
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows[0].sessionId, 'session-hdr', 'header-injected 必须带 sessionId');
    assert.equal(rows[0].pointers, 1, 'pointers 不得被审计白名单丢弃');
    assert.equal(rows[0].lines, 3, 'lines 是实际注入行数（3），不是条目数');
    assert.equal(rows[1].sessionId, 'session-hdr', 'header-truncated 必须带 sessionId');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('P6：无 session id 的 resolveSessionRoot 不抛，返回 no-root/no-session-id 并留审计', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nosid-'));
  try {
    const seen = [];
    const reg = RootRegistry.load({
      stateFile: path.join(dir, 'context-governance', 'root-state-nosid.json'),
      profile: 'test',
      now: () => new Date('2026-11-15T00:00:00Z'),
      rootAudit: { append: (event, details) => seen.push({ event, details }) },
    });
    // 跑两轮：同 (空 id + 同 cwd) 只记一次，避免空会话反复探测刷审计。
    for (let round = 0; round < 2; round += 1) {
      for (const session of [{ header: {} }, { header: { cwd: dir } }, undefined]) {
        const resolved = reg.resolveSessionRoot(session);
        assert.equal(resolved.status, 'no-root');
        assert.equal(resolved.reason, 'no-session-id');
        assert.equal(resolved.entry, null);
      }
    }
    const rows = seen.filter((row) => row.event === 'no-session-id');
    assert.deepEqual(rows.map((row) => row.details.cwd).sort(), ['', dir].sort(),
      '两个 cwd 各记一次，重复调用不再刷');
    assert.equal(rows.every((row) => row.details.reason === 'no-session-id'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
