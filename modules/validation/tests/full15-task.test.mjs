import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  getFull15Versions, startFull15Review, resumeFull15Review, readFull15Progress,
} from "../runtime/full15-task.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
const draft = "# 测试\n\n" + Array.from({ length: 10 }, (_, n) =>
  "## 第" + (n + 1) + "章\n\n张三拿起钥匙。他要去学校。\n").join("\n");
const manuscript = { text: draft, sha256: hash(draft) };
const quote = "张三拿起钥匙。";
const quoteStart = draft.indexOf(quote);
const questions = ["actor", "event", "goal_or_risk"].map(question => ({
  question, answer: question === "actor" ? "张三" : "张三拿起钥匙准备去学校",
  citations: [{
    source_id: "draft", quote, start_char: quoteStart, end_char: quoteStart + quote.length,
  }],
}));

function fixtureAnalyze({ emptyOutput = false, emptyStage = null, reuseContext = false, delay = null } = {}) {
  const calls = [];
  const analyze = async input => {
    calls.push(input);
    if (delay) await delay;
    if (emptyOutput || emptyStage === input.stage) return { outputText: "", receipt: null };
    const indices = input.chunks.map(chunk => chunk.index);
    const output = input.stage === "cold_read"
      ? {
        schema_version: "full15-cold-read-1", source_sha256: input.sourceSha256,
        scope: { full_text_read: true, read_chunks: indices },
        questions, candidates: [], limitations: [],
      }
      : {
        schema_version: "full15-analysis-1", source_sha256: input.sourceSha256,
        scope: { full_text_read: true, read_chunks: indices },
        checks: {
          C02: { status: "checked", summary: "开篇可识别人物和动作。", answers: questions },
          C03: { status: "checked", summary: "未发现明确互斥知情表述。" },
          C04: { status: "checked", summary: "未发现明确互斥物件状态。" },
          C05: {
            status: "not_applicable", summary: "本稿未声明四五章付费推广切口。",
            data: { action_done_in_ch4: null, pending_result_or_cost: null, actual_ch5_continuation: null },
            citations: [],
          },
        },
        issues: [], limitations: [], reference_use: [],
      };
    return {
      outputText: JSON.stringify(output),
      receipt: {
        provider: "fixture-only", invocationId: "fixture-" + input.stage,
        contextId: reuseContext ? "fixture-shared" : "fixture-context-" + input.stage,
        packetSha256: input.packetSha256, deliveredChunkIndices: indices,
      },
    };
  };
  return { analyze, calls };
}

async function withRoot(callback) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "full15-adapter-test-")));
  try { return await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("versions are read-only and a changed manuscript is rejected before dispatch", async () => {
  const versions = await getFull15Versions();
  assert.match(versions.rulesVersion, /^[0-9a-f]{64}$/);
  assert.match(versions.toolVersion, /^[0-9a-f]{64}$/);
  const { analyze, calls } = fixtureAnalyze();
  const result = await startFull15Review({
    manuscript: { ...manuscript, sha256: "0".repeat(64) },
    requirements: { c05_applicable: false }, profile: "no_corpus", analyze,
  });
  assert.equal(result.error.code, "manuscript_hash_mismatch");
  assert.equal(calls.length, 0);
});

test("two isolated provider receipts complete bounded checks and a new draft is stale", async () => withRoot(async root => {
  const { analyze, calls } = fixtureAnalyze();
  const result = await startFull15Review({
    runRoot: root, manuscript, requirements: { c05_applicable: false, input_complete: true },
    profile: "no_corpus", analyze,
  });
  assert.equal(result.status, "complete", JSON.stringify(result.error));
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].contextKey, calls[1].contextKey);
  assert.equal(result.report.coverageComplete, true);
  const report = JSON.parse(await readFile(result.report.path, "utf8"));
  assert.equal(report.execution.observed_analysis_tasks, 0);
  assert.equal(report.execution.observed_provider_calls, 2);
  assert.equal(report.execution.observed_analysis_executions, 2);
  assert.equal(report.checks.find(item => item.id === "C05").status, "not_applicable");
  assert.equal(report.checks.find(item => item.id === "C06").status, "not_evaluated");
  const stale = await readFull15Progress({
    runDir: result.runDir, currentManuscriptSha256: hash(draft + "新句"),
  });
  assert.equal(stale.status, "stale");
  const changedRules = await readFull15Progress({
    runDir: result.runDir, currentRulesVersion: "0".repeat(64),
  });
  assert.equal(changedRules.status, "stale");
  const again = await resumeFull15Review({
    runDir: result.runDir, manuscriptSha256: manuscript.sha256,
    rulesVersion: result.rulesVersion, inputVersion: result.inputVersion, analyze,
  });
  assert.equal(again.status, "complete");
  assert.equal(calls.length, 2);
}));

test("unspecified length and promotion constraints remain unasserted", async () => withRoot(async root => {
  const { analyze } = fixtureAnalyze();
  const result = await startFull15Review({
    runRoot: root, manuscript, requirements: {}, references: { sources: [] },
    profile: "no_corpus", analyze,
  });
  assert.equal(result.status, "complete", JSON.stringify(result.error));
  const frozen = JSON.parse(await readFile(join(dirname(result.runDir), "requirements.json"), "utf8"));
  assert.deepEqual(frozen, { c05_applicable: false });
  const report = JSON.parse(await readFile(result.report.path, "utf8"));
  assert.equal(report.checks.find(item => item.id === "C05").status, "not_applicable");
  assert.equal(report.checks.find(item => item.id === "C06").status, "not_evaluated");
}));

test("progress waits for async persistence, reports saved chunk counts, and ignores callback rejection", async () => withRoot(async root => {
  const fixture = fixtureAnalyze();
  const events = [];
  let releaseCreated;
  let createdEntered;
  const createdGate = new Promise(resolve => { releaseCreated = resolve; });
  const createdSeen = new Promise(resolve => { createdEntered = resolve; });
  const pending = startFull15Review({
    runRoot: root, manuscript, requirements: {}, profile: "no_corpus",
    analyze: fixture.analyze,
    onProgress: async event => {
      if (event.type === "created") { createdEntered(); await createdGate; }
      events.push(event);
      if (event.type === "prepared") throw new Error("synthetic UI persistence failure");
    },
  });
  await createdSeen;
  assert.equal(fixture.calls.length, 0, "dispatch must wait for the created progress checkpoint");
  releaseCreated();
  const result = await pending;
  assert.equal(result.status, "complete", JSON.stringify(result.error));
  const saved = events.filter(event => event.type === "stage_saved");
  assert.equal(saved.length, 2);
  assert.ok(saved.every(event => event.chunkCount > 0));
  assert.deepEqual(saved.map(event => event.chunkCount), saved.map(event => event.readIndices.length));
}));

test("a stalled progress callback is bounded and cannot change the review result", async () => withRoot(async root => {
  const fixture = fixtureAnalyze();
  const result = await startFull15Review({
    runRoot: root, manuscript, requirements: {}, profile: "no_corpus",
    analyze: fixture.analyze,
    onProgress: event => event.type === "created" ? new Promise(() => {}) : undefined,
  });
  assert.equal(result.status, "complete", JSON.stringify(result.error));
  assert.equal(fixture.calls.length, 2);
}));

test("saved cold stage resumes once without repeating its provider call", async () => withRoot(async root => {
  const { analyze, calls } = fixtureAnalyze();
  const paused = await startFull15Review({
    runRoot: root, manuscript, requirements: { c05_applicable: false },
    profile: "no_corpus", analyze, stopAfterStage: "cold_read",
  });
  assert.equal(paused.status, "queued");
  assert.equal(paused.progress.completedStages, 1);
  assert.equal(calls.length, 1);
  const resumed = await resumeFull15Review({
    runDir: paused.runDir, manuscriptSha256: manuscript.sha256,
    rulesVersion: paused.rulesVersion, inputVersion: paused.inputVersion, analyze,
  });
  assert.equal(resumed.status, "complete", JSON.stringify(resumed.error));
  assert.equal(calls.length, 2);
}));

test("concurrent resume never dispatches the same check twice", async () => withRoot(async root => {
  const fixture = fixtureAnalyze();
  const paused = await startFull15Review({
    runRoot: root, manuscript, requirements: {}, profile: "no_corpus",
    analyze: fixture.analyze, stopAfterStage: "cold_read",
  });
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let checkCalls = 0;
  const analyze = async input => {
    checkCalls++;
    entered();
    await gate;
    return fixture.analyze(input);
  };
  const args = {
    runDir: paused.runDir, manuscriptSha256: manuscript.sha256,
    rulesVersion: paused.rulesVersion, inputVersion: paused.inputVersion, analyze,
  };
  const first = resumeFull15Review(args);
  await started;
  const live = await readFull15Progress({ runDir: paused.runDir });
  assert.equal(live.status, "running");
  const concurrent = await resumeFull15Review(args);
  assert.equal(concurrent.status, "running");
  assert.equal(checkCalls, 1);
  release();
  assert.equal((await first).status, "complete");
  assert.equal(checkCalls, 1);
}));

test("missing provider output is preserved as failed check and never auto-retried", async () => withRoot(async root => {
  const { analyze, calls } = fixtureAnalyze({ emptyOutput: true });
  const result = await startFull15Review({
    runRoot: root, manuscript, requirements: { c05_applicable: false },
    profile: "no_corpus", analyze,
  });
  assert.equal(result.status, "needs_attention");
  assert.equal(result.error.code, "provider_outcome_unknown");
  assert.equal(calls.length, 1);
  const resumed = await resumeFull15Review({
    runDir: result.runDir, manuscriptSha256: manuscript.sha256,
    rulesVersion: result.rulesVersion, inputVersion: result.inputVersion, analyze,
  });
  assert.equal(resumed.status, "needs_attention");
  assert.equal(calls.length, 1);
}));

test("missing check output keeps the completed cold stage but has no report", async () => withRoot(async root => {
  const { analyze, calls } = fixtureAnalyze({ emptyStage: "check" });
  const result = await startFull15Review({
    runRoot: root, manuscript, requirements: { c05_applicable: false },
    profile: "no_corpus", analyze,
  });
  assert.equal(result.status, "needs_attention");
  assert.equal(result.error.code, "provider_outcome_unknown");
  assert.equal(result.progress.completedStages, 1);
  assert.equal(result.report, null);
  assert.equal(calls.length, 2);
}));

test("server-owned persistent runRoot works outside the temporary tree", async () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const root = await mkdtemp(join(testDir, "full15-persist-test-"));
  try {
    const { analyze } = fixtureAnalyze();
    const result = await startFull15Review({
      runRoot: root, manuscript, requirements: { c05_applicable: false },
      profile: "no_corpus", analyze,
    });
    assert.equal(result.status, "complete", JSON.stringify(result.error));
    assert.ok(result.runDir.startsWith(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reused provider context blocks completion and retains original output", async () => withRoot(async root => {
  const { analyze } = fixtureAnalyze({ reuseContext: true });
  const result = await startFull15Review({
    runRoot: root, manuscript, requirements: { c05_applicable: false },
    profile: "no_corpus", analyze,
  });
  assert.equal(result.status, "needs_attention");
  assert.equal(result.error.code, "provider_context_reused");
  assert.equal(result.progress.completedStages, 1);
  const events = await readFile(join(result.runDir, "..", "events.ndjson"), "utf8");
  const returns = events.trim().split("\n").map(JSON.parse).filter(event => event.type === "provider_returned");
  assert.equal(returns.length, 2);
  assert.equal(returns[1].receipt.contextId, "fixture-shared");
}));

test("cancelled provider late return cannot become current success", async () => withRoot(async root => {
  const controller = new AbortController();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fixture = fixtureAnalyze({ delay: gate });
  const analyze = async input => {
    const pending = fixture.analyze(input);
    controller.abort();
    return pending;
  };
  const pending = startFull15Review({
    runRoot: root, manuscript, requirements: { c05_applicable: false },
    profile: "no_corpus", analyze, signal: controller.signal,
  });
  const result = await pending;
  assert.equal(result.status, "cancelled");
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  const state = await readFull15Progress({ runDir: result.runDir });
  assert.equal(state.status, "cancelled");
  assert.equal(state.progress.completedStages, 0);
  const events = await readFile(join(result.runDir, "..", "events.ndjson"), "utf8");
  assert.match(events, /late_return_ignored/);
}));
