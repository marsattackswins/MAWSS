/**
 * Analyse one CDP trace written by `npm run perf:pan -- --trace`.
 *
 *   node scripts/perf-trace-report.mjs %USERPROFILE%/maws-perf/trace-4pane-trace.json
 *
 * Prints, for the window covered by the pan: the top JS functions by self time,
 * the main-thread task/idle split, the GPU-process and compositor cost, canvas
 * draw/present counts (for cross-checking the harness' paint counter) and the
 * intervals between pointer events, rAF callbacks and canvas presents.
 */
import fs from "node:fs";
import path from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/perf-trace-report.mjs <trace.json>");
  process.exit(1);
}
const trace = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
const events = trace.traceEvents ?? trace;
console.log(`events: ${events.length}`);

const pidFor = (name) => {
  const proc = events.find((e) => e.name === "process_name" && e.args?.name === name);
  return proc?.pid;
};
const rendererPid = pidFor("Renderer");
const gpuPid = pidFor("GPU Process");

/** Complete events on one thread. */
const completeEvents = events.filter((e) => e.ph === "X" && typeof e.dur === "number");
const byThread = (pid, tid) => completeEvents.filter((e) => e.pid === pid && e.tid === tid);
const mainThreads = new Map();
for (const e of completeEvents) {
  if (e.pid !== rendererPid || !e.name?.startsWith("ThreadControllerImpl::RunTask")) continue;
  mainThreads.set(e.tid, (mainThreads.get(e.tid) ?? 0) + e.dur);
}
const mainTid = [...mainThreads.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
console.log(`renderer pid ${rendererPid}, main tid ${mainTid}`);

const window_ = (() => {
  const moves = events.filter(
    (e) => e.name === "EventDispatch" && e.args?.data?.type === "pointermove",
  );
  if (moves.length === 0) return null;
  const starts = moves.map((m) => m.ts);
  return { from: Math.min(...starts), to: Math.max(...starts), moves: starts.length };
})();
const span = window_ ? (window_.to - window_.from) / 1000 : 0;
console.log(
  window_
    ? `pan window: ${span.toFixed(0)} ms, ${window_.moves} pointermove dispatches (${(window_.moves / (span / 1000)).toFixed(0)}/s)`
    : "pan window: no pointermove dispatches found",
);

// ── main-thread task vs idle ────────────────────────────────────────────────
const main = window_ ? byThread(rendererPid, mainTid).filter((e) => e.ts >= window_.from && e.ts <= window_.to) : [];
const tasks = main.filter((e) => e.name.startsWith("ThreadControllerImpl::RunTask"));
const busyUs = tasks.reduce((sum, e) => sum + e.dur, 0);
console.log(
  `main thread: ${tasks.length} tasks, ${(busyUs / 1000).toFixed(0)} ms busy of ${span.toFixed(0)} ms ` +
    `(${((busyUs / 1000 / span) * 100).toFixed(0)}% busy, ${(100 - (busyUs / 1000 / span) * 100).toFixed(0)}% idle)`,
);

// ── top JS self time from the V8 sampling profile ───────────────────────────
function topFunctions(limit = 15) {
  const profileEvents = events.filter(
    (e) => (e.name === "ProfileChunk" || e.name === "Profile") && e.args?.data,
  );
  const nodes = new Map();
  const samples = [];
  for (const e of profileEvents) {
    const data = e.args.data;
    // Newer Chrome nests the profile inside `cpuProfile`; older builds spread it.
    const inner = data.cpuProfile ?? data;
    const list = data.nodes ?? inner.nodes ?? [];
    for (const n of list) nodes.set(n.id, n);
    // Each chunk carries its own samples and matching timeDeltas (µs).
    const chunkSamples = data.samples ?? inner.samples ?? [];
    const chunkDeltas = data.timeDeltas ?? inner.timeDeltas ?? [];
    for (let i = 0; i < chunkSamples.length; i += 1) samples.push([chunkSamples[i], chunkDeltas[i] ?? 0]);
  }
  if (samples.length === 0) return null;
  const self = new Map();
  for (let i = 0; i < samples.length; i += 1) {
    const [sampleId, deltaUs] = samples[i];
    const node = nodes.get(sampleId);
    if (!node) continue;
    const frame = node.callFrame ?? {};
    const url = (frame.url ?? "").replace(/^.*\/(?=[^/]+\/?$)/, "");
    const key = `${frame.functionName || "(anonymous)"} @ ${url || "?"}:${frame.lineNumber ?? "?"}`;
    self.set(key, (self.get(key) ?? 0) + deltaUs);
  }
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}
const topJs = topFunctions();
if (topJs) {
  console.log("\ntop JS self time (ms):");
  for (const [name, us] of topJs) console.log(`  ${(us / 1000).toFixed(1).padStart(8)}  ${name}`);
} else {
  console.log("\ntop JS self time: no CPU profile in this trace");
}

// ── GPU process + compositor ────────────────────────────────────────────────
function aggregate(filterFn, label) {
  const totals = new Map();
  for (const e of completeEvents) {
    if (!filterFn(e)) continue;
    totals.set(e.name, (totals.get(e.name) ?? 0) + e.dur);
  }
  const list = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(`\n${label} (total ms, count):`);
  for (const [name, us] of list) console.log(`  ${(us / 1000).toFixed(1).padStart(8)}  ${name}`);
}
aggregate((e) => e.pid === gpuPid, "GPU process top events");
aggregate((e) => e.pid === rendererPid && /cc::|Compositor|DrawFrame|BeginMainFrame/.test(e.name ?? ""), "compositor events");

// ── canvas draw / present candidates (cross-check the paint counter) ────────
const canvasish = completeEvents.filter((e) =>
  /Canvas|DrawingBuffer|WebGL|Raster|Present|Swap|Flush/i.test(e.name ?? ""),
);
const counts = new Map();
for (const e of canvasish) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
console.log("\ncanvas / present events (count):");
for (const [name, n] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
  const perSecond = span ? (n / (span / 1000)).toFixed(1) : "?";
  console.log(`  ${String(n).padStart(6)}  ${String(perSecond).padStart(7)}/s  ${name}`);
}

// ── event / frame interval distributions ───────────────────────────────────
function intervals(points, label) {
  if (points.length < 3) {
    console.log(`${label}: too few samples (${points.length})`);
    return;
  }
  const sorted = [...points].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((t, i) => (t - sorted[i]) / 1000);
  gaps.sort((a, b) => a - b);
  const at = (p) => gaps[Math.min(gaps.length - 1, Math.ceil((p / 100) * gaps.length) - 1)].toFixed(1);
  console.log(
    `${label}: n=${gaps.length} p50 ${at(50)} ms · p95 ${at(95)} ms · p99 ${at(99)} ms · max ${gaps[gaps.length - 1].toFixed(1)} ms`,
  );
}
const draws = events.filter((e) => /DrawingBuffer|Canvas2DLayer|DrawFrame|Present/.test(e.name ?? "")).map((e) => e.ts);
intervals(
  events.filter((e) => e.name === "EventDispatch" && e.args?.data?.type === "pointermove").map((e) => e.ts),
  "pointermove gap",
);
intervals(events.filter((e) => e.name === "FireAnimationFrame").map((e) => e.ts), "rAF gap");
intervals(draws, "present/draw gap");
