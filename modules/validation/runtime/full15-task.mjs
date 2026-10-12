import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  appendFile, lstat, mkdir, mkdtemp, open, readFile, realpath, unlink, writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const TOOL_DIR = fileURLToPath(new URL("../../creation/novel-review/", import.meta.url));
const REVIEW = join(TOOL_DIR, "review.py");
const RULE_FILES = [
  "checks.json", "report_fields.json", "prompts/cold_read.md", "prompts/check.md",
  "SOURCE_SNAPSHOTS.json", "source-snapshots/public-check-rules.md",
];
const TOOL_FILES = ["review.py", "source_map.py", "evidence.py", "similarity.py"];
const SCHEMA = "full15-product-task-1";
const STAGES = ["cold_read", "check"];
const PROGRESS_TIMEOUT_MS = 2000;

const sha256 = value => createHash("sha256").update(value).digest("hex");
const exactIndices = count => Array.from({ length: count }, (_, index) => index);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const nonempty = value => typeof value === "string" && value.trim().length > 0;
const asError = (code, message, stage, recoverable = false) => ({
  code, message: String(message), ...(stage ? { stage } : {}), recoverable,
});
export const analysisFailureCode = error => typeof error?.code === "string" && error.code.trim()
  ? error.code.trim() : "provider_outcome_unknown";
export function analysisFailureEvidence(error) {
  const evidence = {};
  if (error?.providerResponseComplete === true) evidence.providerResponseComplete = true;
  if (["length", "content_filter", "insufficient_system_resource"].includes(error?.finishReason)) evidence.finishReason = error.finishReason;
  if (Number.isSafeInteger(error?.maxOutputTokens) && error.maxOutputTokens > 0) evidence.maxOutputTokens = error.maxOutputTokens;
  const receipt = error?.receipt;
  if (receipt && [receipt.provider, receipt.invocationId, receipt.contextId, receipt.packetSha256].every(nonempty)
    && Array.isArray(receipt.deliveredChunkIndices) && receipt.deliveredChunkIndices.every(Number.isSafeInteger)) {
    evidence.receipt = { provider: receipt.provider, invocationId: receipt.invocationId, contextId: receipt.contextId,
      packetSha256: receipt.packetSha256, deliveredChunkIndices: receipt.deliveredChunkIndices };
  }
  return evidence;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

async function fingerprint(files) {
  const rows = [];
  for (const name of files) rows.push(name + "\0" + sha256(await readFile(join(TOOL_DIR, name))));
  return sha256(rows.join("\n"));
}

export async function getFull15Versions() {
  return {
    rulesVersion: await fingerprint(RULE_FILES),
    toolVersion: sha256(
      (await fingerprint(TOOL_FILES)) + "\0"
      + sha256(await readFile(fileURLToPath(import.meta.url))),
    ),
  };
}

async function trustedRoot(runRoot) {
  const root = runRoot ?? await realpath(tmpdir());
  if (!isAbsolute(root) || root.split(sep).includes("..")) {
    throw new Error("runRoot must be a server-configured absolute path without traversal");
  }
  await mkdir(root, { recursive: true });
  let current = resolve(root);
  while (current !== dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error("runRoot may not contain symlinks");
    current = dirname(current);
  }
  return resolve(root);
}

async function cli(root, args) {
  try {
    const { stdout } = await execFileAsync("python3", ["-B", REVIEW, ...args], {
      cwd: TOOL_DIR,
      env: { ...process.env, FULL15_TRUSTED_RUN_ROOT: root },
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    let diagnostic;
    try { diagnostic = JSON.parse(error.stderr?.trim() || ""); } catch { /* keep original */ }
    const failure = new Error(diagnostic?.message || error.message);
    failure.code = diagnostic?.error || "cli_failed";
    throw failure;
  }
}

async function loadTask(runDir) {
  const task = JSON.parse(await readFile(join(dirname(runDir), "task.json"), "utf8"));
  if (task.schemaVersion !== SCHEMA || task.runDir !== resolve(runDir)) {
    throw new Error("task metadata does not match runDir");
  }
  return task;
}

async function eventsFor(task) {
  const path = join(dirname(task.runDir), "events.ndjson");
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  return text.trim() ? text.trimEnd().split("\n").map(line => JSON.parse(line)) : [];
}

async function notifyProgress(onProgress, event) {
  if (typeof onProgress !== "function") return;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => onProgress(event)),
      new Promise(resolve => { timer = setTimeout(resolve, PROGRESS_TIMEOUT_MS); }),
    ]);
  } catch { /* UI persistence cannot mutate run outcome */ }
  finally { clearTimeout(timer); }
}

async function record(task, type, fields = {}, onProgress) {
  const event = { at: new Date().toISOString(), type, ...fields };
  await appendFile(join(dirname(task.runDir), "events.ndjson"), JSON.stringify(event) + "\n");
  await notifyProgress(onProgress, event);
  return event;
}

function last(events, type, stage) {
  return [...events].reverse().find(event => event.type === type && (!stage || event.stage === stage));
}

function stageState(events, stage) {
  const saved = last(events, "stage_saved", stage);
  const prepared = last(events, stage === "cold_read" ? "prepared" : "check_prepared");
  return {
    status: saved ? "completed" : last(events, "dispatch_started", stage) ? "dispatched" : prepared ? "ready" : "waiting",
    ...(prepared ? { packetSha256: prepared.packetSha256, chunkCount: prepared.chunkCount } : {}),
    ...(saved ? { invocationId: saved.receipt.invocationId } : {}),
  };
}

function outstanding(events) {
  return STAGES.some(stage => last(events, "dispatch_started", stage) && !last(events, "stage_saved", stage));
}

async function activeRun(task) {
  let lock;
  try { lock = await readFile(join(dirname(task.runDir), "active.lock"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  let pid;
  try { pid = JSON.parse(lock).pid; } catch { return true; } // Lock is being created.
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

async function resultFor(task, current = {}) {
  const events = await eventsFor(task);
  const versions = await getFull15Versions();
  const manuscriptChanged = current.currentManuscriptSha256 && current.currentManuscriptSha256 !== task.manuscriptSha256;
  const ruleChanged = (current.currentRulesVersion && current.currentRulesVersion !== task.rulesVersion)
    || versions.rulesVersion !== task.rulesVersion;
  const toolChanged = versions.toolVersion !== task.toolVersion;
  const inputChanged = current.currentInputVersion && current.currentInputVersion !== task.inputVersion;
  let status = "queued";
  if (manuscriptChanged || ruleChanged || toolChanged || inputChanged) status = "stale";
  else if (last(events, "cancel_requested")) status = "cancelled";
  else if (last(events, "failed")) status = "needs_attention";
  else if (outstanding(events)) status = await activeRun(task) ? "running" : "needs_attention";
  else if (last(events, "verified")) status = last(events, "verified").coverageComplete ? "complete" : "incomplete";
  else if (last(events, "finalized")) status = "queued";
  const cold = stageState(events, "cold_read");
  const check = stageState(events, "check");
  let report = null;
  if (last(events, "verified")) {
    const path = join(task.runDir, "report.json");
    const raw = await readFile(path);
    const body = JSON.parse(raw);
    report = {
      path, sha256: sha256(raw), checks: body.checks,
      coverageComplete: body.execution?.coverage_complete === true,
    };
  }
  const errorEvent = last(events, "failed") || last(events, "cancel_requested");
  return {
    schemaVersion: SCHEMA, status, runDir: task.runDir,
    manuscriptSha256: task.manuscriptSha256,
    rulesVersion: task.rulesVersion, toolVersion: task.toolVersion,
    inputVersion: task.inputVersion,
    stages: { cold_read: cold, check },
    progress: {
      phase: events.at(-1)?.type || "created",
      completedChunks: (cold.status === "completed" ? cold.chunkCount : 0)
        + (check.status === "completed" ? check.chunkCount : 0),
      totalChunks: (cold.chunkCount || 0) + (check.chunkCount || 0),
      completedStages: Number(cold.status === "completed") + Number(check.status === "completed"),
    },
    report,
    error: errorEvent ? asError(errorEvent.code || "cancelled", errorEvent.message || errorEvent.type,
      errorEvent.stage, false) : null,
  };
}

export async function readFull15Progress({
  runDir, currentManuscriptSha256, currentRulesVersion, currentInputVersion,
}) {
  const task = await loadTask(resolve(runDir));
  return resultFor(task, { currentManuscriptSha256, currentRulesVersion, currentInputVersion });
}

async function packetFor(task, stage) {
  const root = task.runRoot;
  const manifest = await cli(root, [
    "packet-manifest", "--run-dir", task.runDir, "--stage", stage,
  ]);
  const filename = stage === "cold_read" ? "cold-read-input.json" : "check-input.json";
  const raw = await readFile(join(task.runDir, filename));
  if (sha256(raw) !== manifest.packet_sha256) throw new Error("frozen packet hash changed");
  const chunks = [];
  for (let index = 0; index < manifest.chunk_count; index++) {
    const chunk = await cli(root, [
      "packet-chunk", "--run-dir", task.runDir, "--stage", stage, "--index", String(index),
    ]);
    if (chunk.index !== index || chunk.packet_sha256 !== manifest.packet_sha256
        || chunk.start_char !== (chunks.at(-1)?.end_char || 0)
        || sha256(Buffer.from(chunk.content, "utf8")) !== chunk.sha256) {
      throw new Error("packet chunk coverage/hash mismatch");
    }
    chunks.push({
      index, start_char: chunk.start_char, end_char: chunk.end_char,
      sha256: chunk.sha256, text: chunk.content,
    });
  }
  if (chunks.map(item => item.text).join("") !== raw.toString("utf8")) {
    throw new Error("packet chunks do not reconstruct frozen input");
  }
  return { manifest, chunks };
}

async function lateReturn(task, stage, value) {
  const parent = dirname(task.runDir);
  const suffix = randomUUID();
  if (typeof value?.outputText === "string") {
    await writeFile(join(parent, stage + "-late-" + suffix + ".raw.txt"), value.outputText, { flag: "wx" });
  }
  await record(task, "late_return_ignored", {
    stage, receipt: value?.receipt || null,
    message: "Cancellation preceded provider return; not accepted as stage success.",
  });
}

async function invokeWithAbort(analyze, payload, task, stage, signal) {
  if (signal?.aborted) return { kind: "aborted" };
  let settled = false;
  let abortHandler;
  const answer = Promise.resolve().then(() => analyze(payload));
  const done = new Promise(resolve => {
    abortHandler = () => {
      if (settled) return;
      settled = true;
      resolve({ kind: "aborted" });
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
    answer.then(
      value => {
        if (settled) { void lateReturn(task, stage, value).catch(() => {}); return; }
        settled = true;
        resolve({ kind: "ok", value });
      },
      error => {
        if (settled) {
          void record(task, "late_error_ignored", { stage, message: String(error) }).catch(() => {});
          return;
        }
        settled = true;
        resolve({ kind: "error", error });
      },
    );
  });
  const outcome = await done;
  signal?.removeEventListener("abort", abortHandler);
  return outcome;
}

async function fail(task, code, message, stage, onProgress, evidence = {}) {
  await record(task, "failed", { code, message: String(message), ...(stage ? { stage } : {}), ...evidence }, onProgress);
  return resultFor(task);
}

async function cancel(task, stage, onProgress) {
  await record(task, "cancel_requested", {
    code: "cancelled", stage, message: "Check cancelled; any later provider result is ignored.",
  }, onProgress);
  return resultFor(task);
}

async function analyzeStage(task, stage, analyze, signal, onProgress) {
  if (signal?.aborted) return cancel(task, stage, onProgress);
  const { manifest, chunks } = await packetFor(task, stage);
  const contextKey = randomUUID();
  const prompt = await readFile(join(TOOL_DIR, "prompts", stage === "cold_read" ? "cold_read.md" : "check.md"), "utf8");
  await record(task, "dispatch_started", {
    stage, contextKey, packetSha256: manifest.packet_sha256, chunkCount: manifest.chunk_count,
  }, onProgress);
  const outcome = await invokeWithAbort(analyze, {
    stage, contextKey, prompt, manifest, packetSha256: manifest.packet_sha256,
    chunks, sourceSha256: task.manuscriptSha256, rulesVersion: task.rulesVersion, signal,
  }, task, stage, signal);
  if (outcome.kind === "aborted") return cancel(task, stage, onProgress);
  if (signal?.aborted) {
    if (outcome.kind === "ok") await lateReturn(task, stage, outcome.value);
    return cancel(task, stage, onProgress);
  }
  if (outcome.kind === "error") {
    const evidence = analysisFailureEvidence(outcome.error);
    if (evidence.providerResponseComplete === true && evidence.receipt) {
      await record(task, "provider_returned", {
        stage, receipt: evidence.receipt, finishReason: evidence.finishReason,
        providerResponseComplete: true, semanticAccepted: false,
        ...(evidence.maxOutputTokens ? { maxOutputTokens: evidence.maxOutputTokens } : {}),
      }, onProgress);
    }
    return fail(task, analysisFailureCode(outcome.error), outcome.error?.message || outcome.error, stage, onProgress,
      evidence);
  }
  const { outputText, receipt } = outcome.value || {};
  await record(task, "provider_returned", {
    stage, receipt: receipt ?? null,
    outputSha256: typeof outputText === "string" ? sha256(Buffer.from(outputText, "utf8")) : null,
  }, onProgress);
  const parent = dirname(task.runDir);
  if (typeof outputText !== "string" || !outputText.trim()) {
    return fail(task, "provider_outcome_unknown", "Provider returned no raw output text.", stage, onProgress);
  }
  let output;
  try { output = JSON.parse(outputText); } catch {
    await writeFile(join(parent, stage + "-invalid.raw.txt"), outputText, { flag: "wx" });
    return fail(task, "model_output_invalid", "Provider output is not JSON.", stage, onProgress);
  }
  const indices = exactIndices(manifest.chunk_count);
  const prior = last(await eventsFor(task), "stage_saved", "cold_read");
  if (!receipt || !nonempty(receipt.provider) || !nonempty(receipt.invocationId)
      || !nonempty(receipt.contextId) || !nonempty(receipt.packetSha256)) {
    await writeFile(join(parent, stage + "-unaccepted.raw.txt"), outputText, { flag: "wx" });
    return fail(task, "provider_receipt_missing", "Actual provider invocation/context receipt required.", stage, onProgress);
  }
  if (prior && (prior.receipt.contextId === receipt.contextId
      || prior.receipt.invocationId === receipt.invocationId)) {
    await writeFile(join(parent, stage + "-unaccepted.raw.txt"), outputText, { flag: "wx" });
    return fail(task, "provider_context_reused", "Cold and check require distinct provider contexts and calls.", stage, onProgress);
  }
  if (receipt.packetSha256 !== manifest.packet_sha256
      || !same(receipt.deliveredChunkIndices, indices)) {
    await writeFile(join(parent, stage + "-unaccepted.raw.txt"), outputText, { flag: "wx" });
    return fail(task, "packet_delivery_incomplete", "Provider receipt does not cover the frozen packet.", stage, onProgress);
  }
  if (output?.source_sha256 !== task.manuscriptSha256 || output?.scope?.full_text_read !== true
      || !same(output?.scope?.read_chunks, indices)) {
    await writeFile(join(parent, stage + "-unaccepted.raw.txt"), outputText, { flag: "wx" });
    return fail(task, "model_read_incomplete", "Model output does not claim the exact full frozen packet.", stage, onProgress);
  }
  const name = stage === "cold_read" ? "cold-output.json" : "check-output.json";
  await writeFile(join(task.runDir, name), outputText, { flag: "wx" });
  await record(task, "stage_saved", {
    stage, outputSha256: sha256(Buffer.from(outputText, "utf8")),
    packetSha256: manifest.packet_sha256, readIndices: indices,
    chunkCount: manifest.chunk_count, receipt,
  }, onProgress);
  return null;
}

async function continueRunUnlocked(task, analyze, signal, onProgress, stopAfterStage) {
  if (typeof analyze !== "function") throw new TypeError("analyze callback required");
  let events = await eventsFor(task);
  if (last(events, "failed") || last(events, "cancel_requested") || outstanding(events)) return resultFor(task);
  if (last(events, "verified")) return resultFor(task);
  if (!last(events, "prepared")) {
    try {
      const alreadyPrepared = existsSync(task.runDir);
      if (!alreadyPrepared) {
        await cli(task.runRoot, [
          "prepare", "--draft", join(dirname(task.runDir), "draft.md"),
          "--requirements", join(dirname(task.runDir), "requirements.json"),
          ...(task.profile === "standard" ? ["--references", join(dirname(task.runDir), "references.json")] : []),
          "--run-dir", task.runDir, "--profile", task.profile,
        ]);
      } else if (!existsSync(join(task.runDir, "prepare.json"))
          || !existsSync(join(task.runDir, "cold-read-input.json"))) {
        return fail(task, "prepare_rejected", "Partial prepare exists; preserve it for inspection.", null, onProgress);
      }
      const { manifest } = await packetFor(task, "cold_read");
      const packet = JSON.parse(await readFile(join(task.runDir, "cold-read-input.json"), "utf8"));
      await record(task, "prepared", {
        packetSha256: manifest.packet_sha256, chunkCount: manifest.chunk_count,
        limits: packet.limits, recovered: alreadyPrepared,
      }, onProgress);
      if (packet.limits?.length) return fail(task, "prepare_rejected", packet.limits.join("; "), null, onProgress);
    } catch (error) { return fail(task, "prepare_rejected", error.message, null, onProgress); }
  }
  events = await eventsFor(task);
  if (!last(events, "stage_saved", "cold_read")) {
    try {
      const result = await analyzeStage(task, "cold_read", analyze, signal, onProgress);
      if (result) return result;
    } catch (error) { return fail(task, "model_output_invalid", error.message, "cold_read", onProgress); }
  }
  if (stopAfterStage === "cold_read") return resultFor(task);
  events = await eventsFor(task);
  if (!last(events, "check_prepared")) {
    try {
      const alreadyPrepared = existsSync(join(task.runDir, "check-prepare.json"))
        && existsSync(join(task.runDir, "check-input.json"));
      if (!alreadyPrepared) {
        if (existsSync(join(task.runDir, "check-prepare.json"))
            || existsSync(join(task.runDir, "check-input.json"))) {
          return fail(task, "prepare_rejected", "Partial check packet exists; preserve it for inspection.",
            "check", onProgress);
        }
        await cli(task.runRoot, [
          "prepare", "--run-dir", task.runDir, "--after-cold", join(task.runDir, "cold-output.json"),
        ]);
      }
      const { manifest } = await packetFor(task, "check");
      await record(task, "check_prepared", {
        packetSha256: manifest.packet_sha256, chunkCount: manifest.chunk_count,
        recovered: alreadyPrepared,
      }, onProgress);
    } catch (error) { return fail(task, "model_output_invalid", error.message, "cold_read", onProgress); }
  }
  events = await eventsFor(task);
  if (!last(events, "stage_saved", "check")) {
    try {
      const result = await analyzeStage(task, "check", analyze, signal, onProgress);
      if (result) return result;
    } catch (error) { return fail(task, "model_output_invalid", error.message, "check", onProgress); }
  }
  if (signal?.aborted) return cancel(task, "finalize", onProgress);
  events = await eventsFor(task);
  if (!last(events, "finalized")) {
    try {
      if (existsSync(join(task.runDir, "report.json"))
          && existsSync(join(task.runDir, "run-manifest.json"))) {
        const report = JSON.parse(await readFile(join(task.runDir, "report.json"), "utf8"));
        await record(task, "finalized", {
          coverageComplete: report.execution?.coverage_complete === true,
          errors: report.execution?.output_errors || [], recovered: true,
        }, onProgress);
      } else {
        if (existsSync(join(task.runDir, "report.json"))
            || existsSync(join(task.runDir, "run-manifest.json"))) {
          return fail(task, "finalize_failed", "Partial finalized output exists; preserve it for inspection.",
            null, onProgress);
        }
        const stages = STAGES.map(stage => last(events, "stage_saved", stage));
        const observations = {
          schema_version: "full15-observations-1",
          records: stages.map(saved => ({
            stage: saved.stage, kind: "provider_call", status: "completed",
            task_id: saved.receipt.invocationId,
            input_sha256: saved.packetSha256, output_sha256: saved.outputSha256,
            packet_read: { packet_sha256: saved.packetSha256, read_indices: saved.readIndices },
            provider_receipt: {
              provider: saved.receipt.provider,
              invocation_id: saved.receipt.invocationId,
              context_id: saved.receipt.contextId,
              packet_sha256: saved.receipt.packetSha256,
              delivered_chunk_indices: saved.receipt.deliveredChunkIndices,
            },
            note: "Provider receipt supplied by analyze callback; not independently verified billing evidence.",
          })),
        };
        const observationText = JSON.stringify(observations, null, 2) + "\n";
        const observationPath = join(task.runDir, "observations-input.json");
        if (existsSync(observationPath)) {
          if (await readFile(observationPath, "utf8") !== observationText) {
            return fail(task, "finalize_failed", "Saved observations differ from stage receipts.",
              null, onProgress);
          }
        } else {
          await writeFile(observationPath, observationText, { flag: "wx" });
        }
        const final = await cli(task.runRoot, [
          "finalize", "--run-dir", task.runDir,
          "--cold-read", join(task.runDir, "cold-output.json"),
          "--analysis", join(task.runDir, "check-output.json"),
          "--observations", observationPath,
        ]);
        await record(task, "finalized", { coverageComplete: final.coverage_complete, errors: final.errors }, onProgress);
      }
    } catch (error) { return fail(task, "finalize_failed", error.message, null, onProgress); }
  }
  try {
    const verified = await cli(task.runRoot, ["verify", "--run-dir", task.runDir]);
    const report = JSON.parse(await readFile(join(task.runDir, "report.json"), "utf8"));
    await record(task, "verified", {
      integrity: verified.integrity, coverageComplete: report.execution?.coverage_complete === true,
    }, onProgress);
  } catch (error) { return fail(task, "verify_failed", error.message, null, onProgress); }
  return resultFor(task);
}

async function continueRun(task, analyze, signal, onProgress, stopAfterStage) {
  const lockPath = join(dirname(task.runDir), "active.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const current = await resultFor(task);
    if (current.status === "running") return current;
    return current.status === "queued" ? {
      ...current, status: "needs_attention",
      error: asError("task_locked", "Another worker owns this run; no stage was dispatched by this worker.", null, true),
    } : current;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n");
    return await continueRunUnlocked(task, analyze, signal, onProgress, stopAfterStage);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function startFull15Review({
  runRoot, manuscript, requirements = {}, references = { sources: [] },
  profile = "standard", analyze, signal, onProgress, previousRunDir = null,
  stopAfterStage = null,
}) {
  if (!manuscript || typeof manuscript.text !== "string" || !nonempty(manuscript.sha256)) {
    throw new TypeError("manuscript.text and manuscript.sha256 required");
  }
  const manuscriptSha256 = sha256(Buffer.from(manuscript.text, "utf8"));
  if (manuscriptSha256 !== manuscript.sha256) {
    return {
      schemaVersion: SCHEMA, status: "needs_attention", runDir: null,
      manuscriptSha256, report: null,
      error: asError("manuscript_hash_mismatch", "Submitted text differs from its expected SHA-256."),
    };
  }
  if (!["standard", "no_corpus"].includes(profile)) throw new TypeError("unsupported profile");
  if (!requirements || typeof requirements !== "object" || Array.isArray(requirements)) {
    throw new TypeError("requirements must be an object of explicitly known constraints");
  }
  const normalizedRequirements = { ...requirements };
  if (!Object.hasOwn(normalizedRequirements, "c05_applicable")) {
    normalizedRequirements.c05_applicable = false;
  }
  const root = await trustedRoot(runRoot);
  const parent = await mkdtemp(join(root, "full15-task-"));
  const runDir = join(parent, "run");
  const versions = await getFull15Versions();
  const requirementsText = JSON.stringify(canonical(normalizedRequirements), null, 2) + "\n";
  const referencesText = JSON.stringify(canonical(references), null, 2) + "\n";
  const inputVersion = sha256(requirementsText + "\0" + referencesText + "\0" + profile);
  const task = {
    schemaVersion: SCHEMA, runRoot: root, runDir, createdAt: new Date().toISOString(),
    manuscriptSha256, requirementsSha256: sha256(requirementsText),
    referencesSha256: sha256(referencesText), inputVersion, profile,
    ...versions, previousRunDir,
  };
  await writeFile(join(parent, "draft.md"), manuscript.text, { flag: "wx" });
  await writeFile(join(parent, "requirements.json"), requirementsText, { flag: "wx" });
  await writeFile(join(parent, "references.json"), referencesText, { flag: "wx" });
  await writeFile(join(parent, "task.json"), JSON.stringify(task, null, 2) + "\n", { flag: "wx" });
  await record(task, "created", { previousRunDir }, onProgress);
  return continueRun(task, analyze, signal, onProgress, stopAfterStage);
}

export async function resumeFull15Review({
  runDir, manuscriptSha256, rulesVersion, inputVersion, analyze, signal, onProgress,
}) {
  if (![runDir, manuscriptSha256, rulesVersion, inputVersion].every(nonempty)) {
    throw new TypeError("resume requires runDir and the frozen manuscript/rules/input versions");
  }
  const task = await loadTask(resolve(runDir));
  const current = await resultFor(task, {
    currentManuscriptSha256: manuscriptSha256,
    currentRulesVersion: rulesVersion,
    currentInputVersion: inputVersion,
  });
  if (current.status === "stale" || current.status === "complete" || current.status === "running"
      || current.status === "cancelled" || current.status === "needs_attention") return current;
  return continueRun(task, analyze, signal, onProgress);
}
