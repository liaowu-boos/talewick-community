# Versioned analysis revision core

Service-only API; no HTTP/UI change. One process still owns a store.

```js
const current = await library.get(sourceId, { includeAnalysis: true });
const attempt = await library.reviseAnalysis(sourceId, {
  expectedAnalysisVersion: current.analysis.version,
  instructions: '核对说话人及推断依据，保留有根据的多种可能。',
});
await library.getRevision(sourceId, attempt.revisionId);
await library.listRevisions(sourceId);
await library.readAnalysis(sourceId, { analysisVersion: current.analysis.version });
await library.readReference(savedMaterial.references[0]);
```

`reviseAnalysis` queues a separate attempt and returns its record. Instructions are preserved exactly, must contain non-whitespace content, and are capped at 8000 JS characters. A source can have at most 100 attempts. Aliases resolve to their canonical source. `VERSION_CONFLICT` rejects a stale expected version; `TASK_BUSY` prevents overlapping source work. A rejected or protocol-failed parent can be revised. `cancel(sourceId)` also cancels a revision. `close()` interrupts work, and reopening reconciles unfinished attempts without automatic model calls.

`getRevision` returns the explicit full attempt, including response text, diagnostics, candidate and review when available. `listRevisions` returns only bounded summaries. Statuses: queued, running, reviewing, needs_review (review disabled), rejected (valid rejection), failed (call/format/literal/storage failure), cancelled, interrupted, published. An approved candidate may be journaled as approved just before publication. Approval is not publication.

`analysis-versions/<sourceId>-<hash(analysisVersion)>.json` stores immutable analysis snapshots bound to source hash and text version. Parent analysis is snapshotted before queuing. `analysis-revisions/<sourceId>-<revisionId>.json` journals each independent attempt, its parent/text binding, instructions, original unedited analysis/review responses and diagnostics. Original objects, drafts and review history are not rewritten. A revision receives a unique analysis version even if its content is unchanged; `contentVersion` retains the candidate content digest, and `parentAnalysisVersion`/`revisionId` record lineage. New review history belongs to the new analysis; the parent's history stays in its snapshot.

Each attempt makes one `library-analysis-revision` call. Literal failure stops before review. A valid candidate receives a separate `library-review` call using the current six-check prompt, or the configured injected reviewer. `reviewAnalysis: null` saves a candidate without publishing. No automatic retry, format repair, external model call or key access is introduced by storage code. The real adapter must explicitly route the new analysis stage with its intended token/thinking policy.

Only a literal-valid, independently approved candidate becomes the current analysis. Index construction and analysis/index pointer change occur in the same service transaction; retrieval reads a transaction-bound row/index snapshot. Queued, rejected, failed and cancelled attempts leave the previous published analysis/index available. An interrupted filesystem commit can leave an index incompatible with the catalog; startup marks it stale and explicit index-only repair uses the current catalog analysis without a model call. This is recoverable multi-file storage, not an OS-level atomic transaction across files.

`readAnalysis` requires an exact version; it never silently substitutes current content. Old packet text references still work through `readSource`. `readReference` additionally validates source/text/analysis, optional units and optional review identity before returning the exact original text range and bound analysis. Raw references may omit unitIds and reviewRecordId. It does not store or reconstruct whole packets; callers retain their original packet/material content and SHA. Retrieval has no historical-version filter.

Review recovery: `retryRevisionReview(sourceId, revisionId, { expectedAnalysisVersion })` creates a new review-only attempt from an eligible literal-valid candidate; it never calls the analysis model. See REVISION-REVIEW-RECOVERY.md for eligibility, fingerprint and strict-rubric rules. A valid rejection requires content revision, not review retry. Existing `retry({stage:'index'})` rebuilds only the current analysis index and never invokes a model or promotes an unpublished candidate. After a source gains revision history, legacy analysis retry is rejected with VERSIONED_REVISION_REQUIRED, preventing in-place mutation of an archived parent's review. Content fixes must use the versioned entry point; eligible review-call/format failures can use the separate review-only entry point. No literary-quality claim follows from these deterministic tests.

Review-bound range contract: unitIds must be unique. With reviewRecordId, the requested inclusive range must be fully covered by the union of the listed unit locators; overlapping and directly adjacent locators may combine, but an uncovered intervening line cannot be bridged. Covered subranges are allowed. Every listed unit must intersect the requested range, so unrelated extra units are rejected. This matches generated merged references and also permits narrowing them. Without reviewRecordId, raw references retain arbitrary valid source ranges; no analysis-coverage condition applies. Identity and supplied unit validity/uniqueness checks still apply.

Immutable snapshot writes first create a unique same-directory temporary file with wx, then publish the completed file using fs.link. This atomic no-replacement publish permits identical existing content to be reused and rejects different existing content with VERSION_CONFLICT. Finally removes the temporary name, including after partial writes or failed publication. No ordinary rename overwrites a final snapshot. Existing corrupt historical files are not automatically repaired or replaced. This avoids a partial write reserving a final version name; it is not an fsync/power-loss durability guarantee.
