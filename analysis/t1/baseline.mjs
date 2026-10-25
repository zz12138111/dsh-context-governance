// B1 baseline: read-only stats from DSH v4 session logs.
// Usage: node analysis/t1/baseline.mjs <out.json> <session.v4.jsonl.zstd>...
import fs from 'node:fs';
import path from 'node:path';
import { readSessionEvents } from './zstd-frames.mjs';

const outFile = process.argv[2];
const files = process.argv.slice(3);
if (!outFile || files.length === 0) {
  console.error('usage: baseline.mjs <out.json> <session...>');
  process.exit(1);
}

const FOLD_LIST = new Set(['grep', 'web_fetch', 'dsh_browser_content', 'cross_session_read', 'job_output', 'history_search']);
const HARD_EXCLUDE = new Set(['pwsh', 'read']);
const MIN_CHARS = 8000;

function pct(sorted, p) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[i];
}
function median(sorted) { return pct(sorted, 0.5); }

const sessions = [];
for (const file of files) {
  const events = readSessionEvents(file);
  const header = events.find((e) => e.type === 'session')?.data ?? events[0] ?? {};
  const turns = new Set();
  const ended = new Set();
  const stepByTurn = new Map();
  const callByTurn = new Map();
  const callNames = new Map();
  const callById = new Map();
  const results = [];
  const usage = [];
  let foldedTokenGuard = 0;
  let foldedCg = 0;
  let spillNotice = 0;
  let hostPruned = 0;
  let pruneEvents = 0;
  const prunedSeqs = new Set();
  let contextWindowErrors = 0;
  let compactions = 0;

  // Prune events land *after* the original tool/result they shadow, so collect
  // the shadowed seqs in a first pass before classifying results.
  for (const e of events) {
    if (e.type !== 'compaction/prune') continue;
    pruneEvents++;
    for (const seq of e.data?.shadowedSeqs ?? []) prunedSeqs.add(seq);
  }

  for (const e of events) {
    const d = e.data ?? {};
    switch (e.type) {
      case 'turn/start': turns.add(d.turn); break;
      case 'turn/end': ended.add(d.turn); break;
      case 'step/start': stepByTurn.set(d.turn, (stepByTurn.get(d.turn) ?? 0) + 1); break;
      case 'tool/call': {
        callByTurn.set(d.turn, (callByTurn.get(d.turn) ?? 0) + 1);
        callNames.set(d.name, (callNames.get(d.name) ?? 0) + 1);
        callById.set(d.callId, d.name);
        break;
      }
      case 'assistant/message': {
        if (d.usage && Number.isFinite(d.usage.inputTokens)) usage.push({ turn: d.turn, ...d.usage });
        break;
      }
      case 'assistant/attempt': {
        if (JSON.stringify(d).includes('CONTEXT_WINDOW_EXCEEDED')) contextWindowErrors++;
        break;
      }
      case 'compaction/start': compactions++; break;
      case 'tool/result': {
        const msg = d.message;
        const content = Array.isArray(msg?.content) ? msg.content : [];
        const text = content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
        const tool = callById.get(msg?.toolCallId) ?? '(unknown)';
        const hasImage = content.some((b) => b?.type === 'image');
        const isTokenGuard = text.startsWith('[token-guard]');
        const isCg = text.startsWith('[cg-fold]');
        const hasSpill = /\n\n\(Omitted \d+ bytes\. Full formatted result stored at:/.test(text);
        const isPruned = prunedSeqs.has(e.seq);
        if (isTokenGuard) foldedTokenGuard++;
        if (isCg) foldedCg++;
        if (hasSpill) spillNotice++;
        if (isPruned) hostPruned++;
        results.push({
          turn: d.turn,
          tool,
          chars: text.length,
          hasImage,
          isError: msg?.isError === true,
          folded: isTokenGuard || isCg || hasSpill || isPruned,
        });
        break;
      }
      default: break;
    }
  }

  const completedTurns = [...ended];
  const isCompleted = (turn) => completedTurns.includes(turn);
  const perTurn = completedTurns.map((t) => ({
    turn: t,
    steps: stepByTurn.get(t) ?? 0,
    calls: callByTurn.get(t) ?? 0,
  })).filter((r) => r.steps > 0);
  const promptTokens = usage.filter((u) => isCompleted(u.turn)).map((u) => (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0));
  const sortedPrompt = [...promptTokens].sort((a, b) => a - b);
  const stepsSorted = perTurn.map((t) => t.steps).sort((a, b) => a - b);
  const callsSorted = perTurn.map((t) => t.calls).sort((a, b) => a - b);
  const completedResults = results.filter((r) => isCompleted(r.turn));
  const candidate = completedResults.filter((r) => r.chars >= MIN_CHARS && !r.folded && !r.hasImage);
  const candidateByTool = {};
  for (const r of candidate) {
    const k = `${r.tool}${HARD_EXCLUDE.has(r.tool) ? ' (hard-exclude)' : FOLD_LIST.has(r.tool) ? ' (in-list)' : ' (not-in-list)'}`;
    candidateByTool[k] = (candidateByTool[k] ?? 0) + 1;
  }
  const charsByTool = {};
  for (const r of completedResults) charsByTool[r.tool] = (charsByTool[r.tool] ?? 0) + r.chars;

  const summary = {
    file: path.basename(file),
    id: header.id ?? null,
    turnsSeen: turns.size,
    turnsCompleted: completedTurns.length,
    steps: stepsSorted.reduce((a, b) => a + b, 0),
    calls: callsSorted.reduce((a, b) => a + b, 0),
    callsAllTurns: [...callByTurn.values()].reduce((a, b) => a + b, 0),
    results: completedResults.length,
    assistantMessages: usage.length,
    stepsPerTurn: {
      mean: perTurn.length ? +(stepsSorted.reduce((a, b) => a + b, 0) / perTurn.length).toFixed(2) : null,
      median: median(stepsSorted),
      max: stepsSorted.at(-1) ?? null,
    },
    callsPerTurn: {
      mean: perTurn.length ? +(callsSorted.reduce((a, b) => a + b, 0) / perTurn.length).toFixed(2) : null,
      median: median(callsSorted),
      max: callsSorted.at(-1) ?? null,
    },
    callsPerStep: {
      mean: (() => { const s = stepsSorted.reduce((a, b) => a + b, 0); const c = callsSorted.reduce((a, b) => a + b, 0); return s ? +(c / s).toFixed(3) : null; })(),
    },
    promptTokens: {
      n: promptTokens.length,
      mean: promptTokens.length ? Math.round(promptTokens.reduce((a, b) => a + b, 0) / promptTokens.length) : null,
      median: median(sortedPrompt),
      p90: pct(sortedPrompt, 0.9),
      max: sortedPrompt.at(-1) ?? null,
    },
    toolCallsByName: Object.fromEntries([...callNames.entries()].sort((a, b) => b[1] - a[1])),
    resultCharsByName: Object.fromEntries(Object.entries(charsByTool).sort((a, b) => b[1] - a[1])),
    foldCandidates: {
      minChars: MIN_CHARS,
      count: candidate.length,
      byTool: Object.fromEntries(Object.entries(candidateByTool).sort((a, b) => b[1] - a[1])),
      examples: candidate.sort((a, b) => b.chars - a.chars).slice(0, 10).map((r) => ({ turn: r.turn, tool: r.tool, chars: r.chars })),
    },
    existingFolds: { tokenGuard: foldedTokenGuard, cgFold: foldedCg, hostSpillNotice: spillNotice, hostPruner: hostPruned },
    pruneEvents,
    compactions,
    contextWindowErrors,
    perTurn,
  };
  sessions.push(summary);
  console.log(`== ${summary.id} turns=${summary.turnsCompleted} steps=${summary.steps} calls=${summary.calls} steps/turn(med)=${summary.stepsPerTurn.median} calls/step=${summary.callsPerStep.mean} prompt(med)=${summary.promptTokens.median} candidates>=${MIN_CHARS}=${summary.foldCandidates.count}`);
  console.log(`   foldCandidates: ${JSON.stringify(summary.foldCandidates.byTool)}`);
  console.log(`   existingFolds: ${JSON.stringify(summary.existingFolds)} pruneEvents=${summary.pruneEvents} compactions=${summary.compactions} ctxErr=${summary.contextWindowErrors}`);
}

const aggregate = {
  sessions: sessions.length,
  turnsCompleted: sessions.reduce((a, s) => a + s.turnsCompleted, 0),
  steps: sessions.reduce((a, s) => a + s.steps, 0),
  calls: sessions.reduce((a, s) => a + s.calls, 0),
};
const out = { generatedAt: new Date().toISOString(), minChars: MIN_CHARS, foldList: [...FOLD_LIST], hardExclude: [...HARD_EXCLUDE], aggregate, sessions };
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log('wrote', outFile);

