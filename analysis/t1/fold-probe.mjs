// T1 gate probe (no production code): the fixed fold transform, the F2 marker
// skip rules, and a faithful simulation of the host's post-execute waterfall
// order (host spill-policy is prepended; tokenGuard sits in the same waterfall).
// Usage: node analysis/t1/fold-probe.mjs
const FOLD_LIST = new Set(['grep', 'web_fetch', 'dsh_browser_content', 'cross_session_read', 'job_output', 'history_search']);
const HARD_EXCLUDE = new Set(['pwsh', 'read']);
const MIN_CHARS = 8000;
const HEAD = 1500;
const TAIL = 1500;
const FOLD_MARK = '[cg-fold]';
const TOKEN_GUARD_MARK = '[token-guard]';
const HOST_SPILL = /\(Omitted \d+ bytes\. Full formatted result stored at:/;
const HOST_PRUNE_MARK = '[... tool result middle pruned ...]';

function singleText(content) {
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text') return undefined;
  return content[0].text;
}

/**
 * Pure form of the planned post-execute transform.
 * Returns { changed, reason, content }.
 */
export function foldDecision(exec, result, options = {}) {
  const tool = exec?.name;
  const content = result?.content ?? [];
  const text = singleText(content);
  if (text === undefined) return { changed: false, reason: 'not-single-text' };
  if (!FOLD_LIST.has(tool)) return { changed: false, reason: 'tool-not-in-list' };
  if (HARD_EXCLUDE.has(tool)) return { changed: false, reason: 'hard-exclude' };
  if (text.includes(TOKEN_GUARD_MARK)) return { changed: false, reason: 'token-guard' };
  if (text.includes(FOLD_MARK)) return { changed: false, reason: 'cg-fold' };
  if (HOST_SPILL.test(text)) return { changed: false, reason: 'host-spill' };
  if (text.includes(HOST_PRUNE_MARK)) return { changed: false, reason: 'host-pruned' };
  if (options.alreadyPruned === true) return { changed: false, reason: 'host-pruned-event' };
  if (content.some((b) => b?.type === 'image')) return { changed: false, reason: 'image' };
  const minChars = options.minChars ?? MIN_CHARS;
  if (text.length < minChars) return { changed: false, reason: 'below-threshold' };
  const head = text.slice(0, HEAD);
  const tail = text.slice(text.length - TAIL);
  const omitted = text.length - HEAD - TAIL;
  const pointer = options.pointer ?? 'C:\\Users\\<user>\\.dsh\\context-governance\\spill\\<session>\\<callId>-grep.txt';
  const folded = [
    `${FOLD_MARK} tool=${tool} chars=${text.length} kept=${HEAD}+${TAIL} omitted=${omitted}`,
    head,
    `…[省略 ${omitted} 字符，完整内容见指针]…`,
    tail,
    `${FOLD_MARK} full: ${pointer}（用原生 read 按 offset/limit 读取）`,
  ].join('\n');
  return { changed: true, content: [{ type: 'text', text: folded }], omitted };
}

// --- tiny assertion harness -------------------------------------------------
let checks = 0;
let failures = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) { failures++; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
  else console.log(`ok   ${name}`);
}

const big = (n = 48213) => 'A'.repeat(HEAD) + 'B'.repeat(n - HEAD - TAIL) + 'C'.repeat(TAIL);
const textOf = (d) => d.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

console.log('--- fold format');
{
  const text = big();
  const d = foldDecision({ name: 'grep' }, { content: [{ type: 'text', text }] });
  check('grep folds', d.changed === true);
  const out = textOf(d);
  const first = out.split('\n')[0];
  check('header exact', first === `[cg-fold] tool=grep chars=48213 kept=1500+1500 omitted=45213`, first);
  check('placeholder present', out.includes('…[省略 45213 字符，完整内容见指针]…'));
  check('head/tail preserved', out.includes('A'.repeat(HEAD)) && out.includes('C'.repeat(TAIL)));
  check('omitted arithmetic', 48213 - HEAD - TAIL === 45213);
  check('pointer line', /\[cg-fold\] full: .+（用原生 read 按 offset\/limit 读取）$/.test(out));
}

console.log('\n--- hard exclusions and non-list tools');
for (const tool of ['pwsh', 'read', 'job_list', 'unknown']) {
  const d = foldDecision({ name: tool }, { content: [{ type: 'text', text: big() }] });
  check(`${tool} unchanged`, d.changed === false, d.reason);
}

console.log('\n--- already-folded markers (F2)');
{
  const tg = `[token-guard] status=ok exit=0 lines=10 kept=2 omitted_lines=8\nhead\ntail\n完整输出: C:\\tmp\\x.txt`;
  const d = foldDecision({ name: 'grep' }, { content: [{ type: 'text', text: tg + big() }] });
  check('token-guard skipped', d.changed === false && d.reason === 'token-guard', d.reason);
}
{
  const cg = `${FOLD_MARK} tool=grep chars=48213 kept=1500+1500 omitted=45213\nhead\n…[省略 45213 字符，完整内容见指针]…\ntail\n${FOLD_MARK} full: C:\\x`;
  const d = foldDecision({ name: 'grep' }, { content: [{ type: 'text', text: cg + big() }] });
  check('cg-fold skipped', d.changed === false && d.reason === 'cg-fold', d.reason);
}
{
  const host = `${big()}\n\n[...]\n\nC\n(Omitted 12345 bytes. Full formatted result stored at: C:\\spill\\x.txt. Use read)`;
  const d = foldDecision({ name: 'grep' }, { content: [{ type: 'text', text: host }] });
  check('host-spill notice skipped', d.changed === false && d.reason === 'host-spill', d.reason);
}
{
  const pruned = `${'A'.repeat(4096)}\n\n[... tool result middle pruned ...]\n\n${'C'.repeat(1024)}`;
  const d = foldDecision({ name: 'read' }, { content: [{ type: 'text', text: pruned }] });
  check('host-pruned text skipped (read)', d.changed === false, d.reason);
  const d2 = foldDecision({ name: 'grep' }, { content: [{ type: 'text', text: pruned + big() }] });
  check('host-pruned marker skipped (grep)', d2.changed === false && d2.reason === 'host-pruned', d2.reason);
  const d3 = foldDecision({ name: 'grep' }, { content: [{ type: 'text', text: big() }] }, { alreadyPruned: true });
  check('host-pruned event metadata skipped', d3.changed === false && d3.reason === 'host-pruned-event', d3.reason);
}
{
  const d = foldDecision({ name: 'grep' }, { content: [{ type: 'text', text: big() }, { type: 'image', attachment: {} }] });
  check('multi-block/image skipped', d.changed === false && d.reason === 'not-single-text', d.reason);
}
{
  const d = foldDecision({ name: 'grep' }, { content: [{ type: 'text', text: 'x'.repeat(7999) }] });
  check('below threshold skipped', d.changed === false && d.reason === 'below-threshold', d.reason);
}

console.log('\n--- waterfall order simulation');
// Host spill-policy is `prepend: true`: it calls next() first (our listener),
// then bounds the accepted content if it exceeds maxInlineTokens.
function makeWaterfall(listeners) {
  // listeners are [name, fn] in call order; each fn(exec, result, next) -> decision
  const run = async (i, exec, result) => {
    if (i >= listeners.length) return { kind: 'accept', content: result.content };
    return listeners[i][1](exec, result, () => run(i + 1, exec, result));
  };
  return (exec, result) => run(0, exec, result);
}
const spillOuter = async (exec, result, next) => {
  const d = await next();
  if (d.kind !== 'accept') return d;
  const text = textOf(d);
  if (text.length > 50000) return { ...d, content: [{ type: 'text', text: text.slice(0, 25000) + '\n[...]\n' + text.slice(-25000) }] };
  return d;
};
const ourInner = async (exec, result, next) => {
  const d = await next();
  if (d.kind !== 'accept') return d;
  const r = foldDecision(exec, d);
  return r.changed ? { ...d, content: r.content } : d;
};
{
  const flow = makeWaterfall([['spill-policy', spillOuter], ['cg-fold', ourInner]]);
  const d = await flow({ name: 'grep' }, { content: [{ type: 'text', text: big() }] });
  check('spill outer + cg inner => cg wins', textOf(d).startsWith('[cg-fold]') && textOf(d).length < 5000);
}
const tokenGuardOuter = async (exec, result, next) => {
  const d = await next();
  if (d.kind !== 'accept') return d;
  const text = textOf(d);
  if (exec.name === 'pwsh' && text.length > 8000) return { ...d, content: [{ type: 'text', text: '[token-guard] status=ok\n' + text.slice(0, 100) }] };
  return d;
};
{
  const flow = makeWaterfall([['token-guard', tokenGuardOuter], ['cg-fold', ourInner]]);
  const d = await flow({ name: 'grep' }, { content: [{ type: 'text', text: `[token-guard] status=ok\n` + big() }] });
  check('token-guard outer => cg skips it', textOf(d).startsWith('[token-guard]'));
  const d2 = await flow({ name: 'pwsh' }, { content: [{ type: 'text', text: big() }] });
  check('pwsh stays token-guard only', textOf(d2).startsWith('[token-guard]') && !textOf(d2).includes('[cg-fold]'));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
