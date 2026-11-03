# Independent review evidence utilities

These opt-in utilities separate exact text checks from factual interpretation and literary acceptance. They make no model calls and do not change the default GUI review transport or automatically adopt a manuscript.

## Prompt evidence policy and literal differences

[independent-review-evidence-policy.mjs](independent-review-evidence-policy.mjs) exports:

- `computeDifferenceAudit(before, after)`: compare ordered arrays of `{id, title, body}` chapters without trimming. Both arrays must have the same chapter IDs in the same order. Titles, whitespace and every body code unit count. Changed bodies include a single enclosing replacement, not a minimal edit script. Offsets use UTF-16 code units.
- `augmentReviewPrompt(args, differenceAudit)`: add evidence rules to `{stage, system, user}` while retaining the frozen `JSON.parse(user).packet`. Rules distinguish dialogue from established events, require textual support for identity and attribution, and clarify that example anchor IDs are examples. Save both the original protocol hash and the returned delivered prompt hashes.
- `inspectLiteralIdentityAssertions(raw, differenceAudit)`: flag a narrow set of Chinese claims that the entire pair is identical when computed differences exist. Negated/qualified mentions require human review. It neither rewrites model output nor establishes semantic accuracy or quality. No flag means only that this narrow rule found none.

The transport must enforce the review stage order and seal the first six blind responses before calling augmentation for `independent-review:goal-audit`. Only that stage receives a separate top-level `supplement.computedDifferenceAudit`. The helper does not itself enforce workflow history. Do not reveal the difference audit in blind packets or treat the original protocol hash as a hash of the augmented request.

```js
import { computeDifferenceAudit, augmentReviewPrompt } from './independent-review-evidence-policy.mjs';

const differenceAudit = computeDifferenceAudit(baselineChapters, candidateChapters);
const { prompt, binding } = augmentReviewPrompt(preparedTransportArgs, differenceAudit);
// Persist prompt + binding, and send exactly prompt.system / prompt.user.
// Keep the original protocol input hash separately for protocol replay.
```

## Short exact quotations

[independent-review-short-anchors.mjs](independent-review-short-anchors.mjs) provides `prepareCodexAnchorPacket`, `codexResponseSchema`, `resolveCodexAnchorResponse`, and `checkCodexAnchorFiles`. The Codex names identify the independent response contract; the helper itself has no provider or credential dependency.

Prepare a pair with `caseId`, `manuscripts: [{blindId: 'A', chapters}, {blindId: 'B', chapters}]`, and optional `readingFocusDefinitions`. Supply anonymous texts without authorship, revision rationale, prior reviews or computed differences. The packet includes complete bodies split into at most 240 UTF-16 units, preserving whitespace, CRLF and surrogate pairs. Evidence quotes are limited to 160 UTF-16 units and must be exact, unique substrings of the cited anchor. Cross-anchor quotes must be shortened or represented as separate citations; they are never silently repaired.

Save the prompt as JSON containing `user: JSON.stringify({packet, responseContract: codexResponseSchema()})`. Preserve the raw response as closed JSON matching the schema. The resolver verifies the packet hash and body/catalog bindings, checks manuscript ownership, and derives offsets locally. Wrong anchors, ambiguous quotations, extra fields, guessed offsets and incomplete coverage fail validation. Derived output is returned only when all checks pass; the raw response stays unchanged.

```sh
node modules/validation/runtime/independent-review-short-anchors.mjs prompt.json raw-response.txt
node --test modules/validation/tests/independent-review-evidence-policy.test.mjs
```

Exit status is 0 for schema and citation integrity, 1 for validation failure, and 2 for unavailable input. `passed` refers only to schema/citation checks. `semanticSupportVerified` remains false and `qualityPass` remains `NOT_COMPUTED`, even if every quotation matches. Hashes establish content consistency, not authorship or authenticity. Treat generated reports, prompts and difference spans as private if they contain private manuscripts.

## 发布范围

本次公开的是可显式接入的证据规则、逐字差异核验与短引用检查工具，以及独立合成回归。默认界面尚未接入这些新工具。评语事实是否成立仍需结合全文复核；引用定位成功、流程完成、事实纠错和文学质量通过是不同结论。真实稿件、模型回包、实验轮次配置与人工核实记录不包含在仓库中。
