import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../src/memory/store.js';

export async function tempDir(prefix = 'cg-mem-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 打开临时项目记忆库并保证清理。 */
export async function withStore(fn, options = {}) {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({
    rootDir,
    project: 'test-project',
    ...options,
  });
  try {
    return await fn(store, rootDir);
  } finally {
    await store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

export function fixedClock(start = '2026-10-25T08:00:00.000Z') {
  let tick = 0;
  const base = new Date(start).getTime();
  return () => new Date(base + tick++ * 1000);
}

export const draft = (overrides = {}) => ({
  type: 'decision',
  title: '插件名定为 dsh-context-governance',
  detail: '大小写与 npm 包名一致；插件目录放在 packages/ 下。',
  writer: 'user',
  source: 'session:test#1',
  ...overrides,
});
