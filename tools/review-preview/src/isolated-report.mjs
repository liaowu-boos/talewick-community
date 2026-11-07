import {adaptIsolatedReading} from './isolated-reading.mjs';

const entities = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};

// Unvalidated replies can contain any JSON value. Insert all evidence as text only.
function escapeText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (text ?? '').replace(/[&<>"']/g, character => entities[character]);
}

function diagnostics(check) {
  const errors = check.errors ?? check.inspection?.errors;
  if (!errors?.length) return '';
  return `<details><summary>查看失败原因（${errors.length} 项）</summary><pre><code>${escapeText(errors)}</code></pre></details>`;
}

function conclusion(record) {
  return `<p><strong>${escapeText(record.label)}</strong></p>
    <p>复核范围：${escapeText(record.scope ?? '尚无已绑定的范围说明')}</p>
    <p class="prose">${escapeText(record.summary)}</p>`;
}

const preferences = new Map([
  ['A', '倾向 A'], ['B', '倾向 B'], ['tradeoff', '各有取舍（tradeoff）'],
  ['no_clear_preference', '无明确偏好（no_clear_preference）'],
]);

function preferenceText(value, missing) {
  return escapeText(value == null ? missing : (preferences.get(value) ?? value));
}

function preferenceSection(preference) {
  if (!preference.applicable) return `<p>${escapeText(preference.label)}。本路没有偏好票。</p>`;
  return `<dl><dt>原始回包自报偏好</dt><dd>${preferenceText(preference.raw, '无记录')}</dd>
    <dt>机械核验有效偏好</dt><dd>${preferenceText(preference.validated, '尚无有效偏好')}</dd></dl>
    <p>${escapeText(preference.label)}</p>`;
}

function responseSection(row) {
  if (row.returnState !== 'returned') return '<p>当前快照没有可读的回包记录。</p>';
  const reading = row.opinion?.freeReading;
  const assessment = row.opinion?.overall?.assessment;
  return `<p>已收到回包</p>
    ${typeof reading === 'string' && reading.trim() ? `<blockquote class="prose">${escapeText(reading)}</blockquote>` : ''}
    ${typeof assessment === 'string' && assessment.trim() ? `<p class="prose"><strong>总体读感</strong>　${escapeText(assessment)}</p>` : ''}
    <details><summary>完整原始回包</summary><pre><code>${escapeText(row.rawText)}</code></pre></details>`;
}

function duplicateIds(ids) {
  const seen = new Set();
  const duplicates = new Set();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return duplicates;
}

function factEvidenceSection(row) {
  const facts = row.opinion?.factualChecks;
  if (!Array.isArray(facts) || facts.length === 0) return '';
  const original = row.originalResponse?.evidence;
  const inspection = row.protocolValidation.inspection;
  // Validation retains the first catalog hit even when a later definition reuses its ID.
  // Such an ID cannot identify which passage the author of a claim meant to cite.
  const definitions = Array.isArray(original) ? original : [];
  const repeatedDefinitions = duplicateIds(definitions.map(item => item?.id));
  const resolved = inspection?.bindingValid ? inspection.resolvedEvidence : [];
  const byId = new Map(resolved.map(item => [item.id, item]));
  const repeatedFacts = duplicateIds(facts.map(fact => fact?.id));

  function renderFact(fact, index) {
    const scope = row.mode === 'single' ? 'X' : fact?.scope;
    const ids = Array.isArray(fact?.evidenceIds) ? fact.evidenceIds : [];
    const repeatedRefs = duplicateIds(ids);
    const quotes = [...new Set(ids)].map(id => {
      const entry = byId.get(id);
      let issue;
      if (repeatedFacts.has(fact?.id)) issue = '主张 ID 重复';
      else if (repeatedRefs.has(id) || repeatedDefinitions.has(id)) issue = '证据 ID 重复';
      else if (!entry) issue = '缺少已绑定的冻结定位';
      else if (scope !== 'both' && entry.version !== scope) issue = '引文稿别与主张范围不符';
      if (issue) return `<li>${escapeText(id)} · 未可靠定位（${issue}）</li>`;
      const location = entry.field === 'title' ? '章题' : '正文';
      return `<li><span class="muted">${escapeText(id)} · ${escapeText(entry.version)} 稿 · ${escapeText(entry.chapterId)} · ${location}</span>
        <blockquote class="prose">${escapeText(entry.quote)}</blockquote></li>`;
    });
    // A two-version claim may resolve an individual quote yet still lack one required side.
    const claimErrors = inspection?.errors.filter(error => error.path === `/factualChecks/${index}/evidenceIds`) ?? [];
    return `<div class="fact"><h4>${escapeText(fact?.id ?? `主张 ${index + 1}`)} · ${escapeText(scope ?? '范围待核')}</h4>
      <p class="prose">${escapeText(fact?.claim ?? '主张内容无法解析')}</p>
      ${quotes.length ? `<ul>${quotes.join('')}</ul>` : '<p>未可靠定位（缺少证据 ID）</p>'}
      ${claimErrors.length ? '<p>本条引用未满足协议要求。请核对主张覆盖的稿别和引文。</p>' : ''}
    </div>`;
  }
  return `<details><summary>事实主张与冻结原句</summary>
    <p>原句取自本路校验记录。请对照稿别和章节，判断引文能支持主张的哪一部分。</p>
    ${facts.map(renderFact).join('\n')}</details>`;
}

function requestSection(row, execution) {
  const inspection = row.protocolValidation.inspection;
  const receipt = execution.inspection?.records.find(record => record.requestId === row.requestId);
  return `<article>
    <h2>${escapeText(row.label)}</h2><p class="muted">${escapeText(row.method)}</p>
    <h3>回包与读感</h3>${responseSection(row)}
    <h3>协议与绑定</h3><p>${escapeText(row.protocolValidation.label)}</p>${diagnostics(row.protocolValidation)}
    ${inspection?.rawSHA256 ? `<p class="fingerprint">回包 SHA256　<code>${escapeText(inspection.rawSHA256)}</code></p>` : ''}
    <h3>人工语义复核</h3>${conclusion(row.semanticReview)}${factEvidenceSection(row)}
    <h3>稿间偏好</h3>${preferenceSection(row.preference)}
    <h3>执行存档</h3><p>${escapeText(execution.label)}</p>
    ${receipt ? `<details><summary>本路执行记录</summary><pre><code>${escapeText(receipt)}</code></pre></details>` : ''}
  </article>`;
}

const styles = `
  * { box-sizing: border-box }
  body { margin: 0; background: #f6f5f0; color: #242722; font: 1rem/1.65 system-ui, sans-serif }
  main { max-width: 54rem; margin: auto; padding: 2rem 1rem 4rem; overflow-wrap: anywhere }
  header, article, section { margin: 0 0 1rem; padding: clamp(1rem, 3vw, 2rem) }
  header { border-bottom: .2rem solid #315745 }
  article, section { background: #fff; border: 1px solid #c8cdc6; border-radius: .6rem }
  h1, h2, h3 { line-height: 1.35; margin: 0 0 .5rem }
  h1 { font-size: clamp(1.65rem, 4vw, 2.4rem) } h2 { font-size: 1.3rem }
  h3 { margin-top: 1.25rem; font-size: 1rem; color: #315745 } p { margin: .35rem 0 }
  .muted, .fingerprint { color: #4d584f } .fingerprint { font-size: .875rem }
  .prose, pre { white-space: pre-wrap; overflow-wrap: anywhere }
  blockquote, pre { margin: .6rem 0; background: #f4f6f3; padding: .75rem 1rem }
  blockquote { border-left: .2rem solid #52705f } pre { font-size: .875rem }
  summary { cursor: pointer; font-weight: 600; padding: .35rem 0; color: #244e3d }
  summary:focus-visible { outline: 2px solid currentColor; outline-offset: 2px }
  .fact { border-top: 1px solid #c8cdc6; padding-block: .65rem } .fact h4 { margin: .25rem 0 }
  .fact ul { padding-inline-start: 1.4rem }
  dl { margin: .25rem 0 } dt { font-weight: 600 } dd { margin: 0 0 .4rem }
`;

export function renderIsolatedReport(adapterInput, {synthetic = false} = {}) {
  const view = adaptIsolatedReading(adapterInput);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>三路独立阅读报告</title><style>${styles}</style></head>
<body><main>
<header><h1>三路独立阅读报告</h1>
${synthetic === true ? '<p><strong>合成演示 · 无真实评阅</strong></p>' : ''}
<p><strong>本报告可能包含私有正文和原始评语，请按原材料的共享范围保管。</strong></p>
<p>本次阅读范围：${escapeText(view.chapterIds.join('、'))}</p>
<p class="fingerprint">计划 SHA256　<code>${escapeText(view.planSHA256)}</code></p></header>
${view.requests.map(row => requestSection(row, view.execution)).join('\n')}
<section><h2>三路执行核验</h2><p>${escapeText(view.execution.label)}</p>${diagnostics(view.execution)}</section>
<section><h2>编辑决定</h2>${conclusion(view.editorialDecision)}
<p><strong>全稿未验收。</strong>本报告仅展示当前记录中的决定。</p></section>
</main></body></html>`;
}
