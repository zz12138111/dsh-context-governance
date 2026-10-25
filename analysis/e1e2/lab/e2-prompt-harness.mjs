/**
 * E2 隔离实验：用**本机已装** dsh-context-zip 的真实引擎代码，
 * 在临时目录里配一个 `@deepseek-ai/dsh-llm` 桩，喂合成会话，
 * 截获"摘要器实际收到的完整 prompt"。
 *
 * 不启动 DSH、不改任何已装插件/配置、不发网络请求。
 * 只回答一个问题：三种回注形态在下一次压缩时会不会进入摘要输入、会不会被去重。
 *
 * 用法：node e2-prompt-harness.mjs [输出 json 路径]
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE_ENGINE = path.join(
  process.env.USERPROFILE,
  '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-context-zip', 'engine', 'lib', 'engine.js',
);
const OUT = process.argv[2] ?? path.join(process.cwd(), 'e2-prompt.json');

const FIVE_SECTION = [
  '## Goal and intent',
  '把回注形态定下来，保证压缩后不断线。',
  '',
  '## Decisions',
  '- 默认只回注 ID + 状态 + 指针。',
  '',
  '## Current state',
  'E1 已确认事件级感知；E2 正在做形态实验。',
  '',
  '## Next steps',
  '- 确认默认形态。',
  '',
  '## Anchors',
  '- docs/上下文治理插件-架构说明-v1.0.md',
].join('\n');

const MARKER = 'MEM-20261025-017';
const INJECTIONS = {
  detail: [
    `${MARKER} 待确认（见记忆）`,
    '详情：默认回注形态选 ID+状态+指针。理由：详情一旦回注就会进入下一次压缩的摘要输入，可能被二次改写并产生第二段摘要；',
    '架构 §6.5 明确要求详情永不回注；标题只在摘要可读且覆盖判断未命中时补一行。实现时在 compaction/end 之后注入，',
    '并且每轮只注入一次，避免同一指针在保留尾部重复出现。',
  ].join(''),
  title: `${MARKER} 待确认：默认回注形态选 ID+状态+指针（见记忆）`,
  id: `${MARKER} 待确认（见记忆）`,
};

const LABEL = {
  baseline: '无回注',
  detail: '详情回注',
  title: '标题+指针',
  id: 'ID+状态',
  duplicate: 'ID+状态（连续注入两次）',
  notes: 'context-zip 工作笔记（对照组）',
};

const systemMessage = {
  role: 'system',
  content: [{ type: 'text', text: 'SYSTEM PROMPT: 你是 00 总管理。'.repeat(8) }],
};
const history = [
  { role: 'user', content: [{ type: 'text', text: '把 E1/E2 前置门禁跑完。' }] },
  { role: 'assistant', content: [{ type: 'text', text: '先看宿主压缩事件和 context-zip 引擎。' }] },
  { role: 'user', content: [{ type: 'text', text: '<compacted-summary>\n## Goal and intent\n…上一轮五段摘要…\n</compacted-summary>' }] },
];
const tail = { role: 'user', content: [{ type: 'text', text: '继续：这一轮先做 T1 + T2。' }] };

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
}

async function setupLab() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-e2-lab-'));
  const stubDir = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-llm');
  await fs.mkdir(stubDir, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  await fs.writeFile(path.join(stubDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-llm', version: '0.0.0-e2-stub', type: 'module', main: 'index.js',
  }));
  await fs.writeFile(path.join(stubDir, 'index.js'), [
    '// E2 实验桩：engine 只在模块加载期需要这些符号存在。',
    'export class BlockAssembler { push() {} get finish() { return { kind: "error" }; } blocks() { return []; } }',
    'export function contentHasImage() { return false; }',
    'export function createUserMessage(value) { return value; }',
    'export class HarnessError extends Error {}',
    '',
  ].join('\n'));
  await fs.copyFile(SOURCE_ENGINE, path.join(dir, 'engine.mjs'));
  return { dir, enginePath: path.join(dir, 'engine.mjs') };
}

async function runCase(Engine, buildMessages, { notes = '' } = {}) {
  const captured = [];
  const deps = {
    readMode: async () => 'plugin',
    readNotes: async () => notes,
    summarize: async (_ctx, config, input) => {
      captured.push({ config, messages: input.messages });
      return { summary: [{ type: 'text', text: FIVE_SECTION }], provider: 'stub', model: 'stub' };
    },
  };
  const ctx = {
    effect: (callback) => { try { return callback(); } catch { return undefined; } },
    logger: { warn() {}, debug() {}, info() {} },
  };
  const engine = new Engine(ctx, { thresholdRatio: 0.65 }, deps);
  const messages = buildMessages();
  await engine.summarize({ messages }, { session: { id: 'session-e2-lab' } }, undefined);
  const prompt = captured[0]?.messages ?? [];
  const promptText = prompt.map(textOf).join('\n');
  const instruction = prompt.length > 0 ? textOf(prompt[prompt.length - 1]) : '';
  return {
    promptMessages: prompt.length,
    promptChars: promptText.length,
    instructionChars: instruction.length,
    fiveHeadingsInInstruction: ['Goal and intent', 'Decisions', 'Current state', 'Next steps', 'Anchors']
      .filter((heading) => instruction.includes(heading)).length,
    markerHits: promptText.split(MARKER).length - 1,
    notesInInstruction: notes.length > 0 && instruction.includes(notes.trim()),
    notesInMessages: notes.length > 0 && prompt.slice(0, -1).some((message) => textOf(message).includes(notes.trim())),
    injectedTextPresent: promptText.includes(MARKER),
  };
}

const { dir, enginePath } = await setupLab();
try {
  const module = await import(pathToFileURL(enginePath).href);
  // 生产环境里 Base 是宿主的 BasicCompactionEngine；这里只做最小替身，
  // 让 ContextZipEngine 的 summarize() 分支可运行（不触碰事务/会话层）。
  class StubBase {
    constructor(ctx, config) {
      this.ctx = ctx;
      this.config = config ?? {};
    }
  }
  const Engine = module.default(StubBase);

  const cases = [
    ['baseline', () => [systemMessage, ...history, tail], {}],
    ['detail', () => [systemMessage, ...history,
      { role: 'user', content: [{ type: 'text', text: INJECTIONS.detail }] }, tail], {}],
    ['title', () => [systemMessage, ...history,
      { role: 'user', content: [{ type: 'text', text: INJECTIONS.title }] }, tail], {}],
    ['id', () => [systemMessage, ...history,
      { role: 'user', content: [{ type: 'text', text: INJECTIONS.id }] }, tail], {}],
    ['duplicate', () => [systemMessage, ...history,
      { role: 'user', content: [{ type: 'text', text: INJECTIONS.id }] },
      { role: 'assistant', content: [{ type: 'text', text: '收到。' }] },
      { role: 'user', content: [{ type: 'text', text: INJECTIONS.id }] }, tail], {}],
    ['notes', () => [systemMessage, ...history, tail], {
      notes: '草稿：E2 要确认默认回注形态；E1 结论是事件级感知可用。',
    }],
  ];

  const results = [];
  for (const [key, build, options] of cases) {
    const measured = await runCase(Engine, build, options);
    results.push({
      case: key,
      label: LABEL[key],
      injectionChars: key === 'baseline' || key === 'notes' ? 0 : key === 'duplicate' ? INJECTIONS.id.length * 2 : INJECTIONS[key].length,
      ...measured,
    });
  }
  const baseline = results.find((row) => row.case === 'baseline');
  for (const row of results) {
    row.promptCharsDeltaVsBaseline = row.promptChars - baseline.promptChars;
  }

  const report = {
    experiment: 'E2 回注形态 × context-zip 摘要输入（真实引擎代码 + 桩 LLM）',
    date: new Date().toISOString(),
    engineSource: '%USERPROFILE%\\.dsh\\profiles\\desktop\\node_modules\\dsh-context-zip\\engine\\lib\\engine.js',
    engineVersion: 'dsh-context-zip 0.1.10（profile 内实际安装版本）',
    method: [
      '只读复制已装插件 engine/lib/engine.js 到临时目录',
      '用桩 @deepseek-ai/dsh-llm 满足模块加载；不发任何模型请求',
      'deps.summarize 截获传给摘要器的完整 messages（含五段式指令）',
      '三种回注形态各放一条 user/message 进被压缩区间；另测连续注入两次与工作笔记对照',
    ],
    results,
  };
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(report, null, 2));
  for (const row of results) {
    console.log(`${row.label.padEnd(22)} chars=${String(row.promptChars).padStart(5)} Δ=${String(row.promptCharsDeltaVsBaseline).padStart(5)} hits=${row.markerHits} five=${row.fiveHeadingsInInstruction}/5 notesInInstr=${row.notesInInstruction} notesInMsgs=${row.notesInMessages}`);
  }
  console.log(`out=${OUT}`);
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
