"""Finite evidence validation and Markdown rendering; no file or model calls.

``sources`` maps an ID to ``{source_id, kind, text, sha256, path}``. The caller
must bind ``sha256`` to the actual source bytes; we compare that supplied hash
without re-encoding or normalizing the text. Offsets are zero-based Unicode
characters, with exclusive ends; line numbers start at one.

``render_report`` accepts the fields in report_fields.json. ``checks`` may be
an ID-keyed mapping or a list of objects carrying ``id`` / ``check_id``. Each
check has ``status`` and ``data``. ``evidence`` is a normalized citation list,
or an object with that list under ``citations``. Issues embed their normalized
citations. Rendering does not verify semantic truth or attest model calls.
"""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Mapping
import json
import re


_CHECK_NAMES = {
    "C01": "交付规格", "C02": "开篇三问", "C03": "明确知情矛盾",
    "C04": "明确物件状态矛盾", "C05": "四五章承接", "C06": "字面重合",
}
_STATUS_NAMES = {
    "checked": "已检查", "insufficient_evidence": "证据不足",
    "not_applicable": "不适用", "not_evaluated": "未评估", "incomplete": "未完成",
}
_ISSUE_FIELDS = {
    "id", "check_id", "kind", "rule_source_ids", "citations", "reasoning",
    "alternative_explanations", "uncertainty", "suggested_verification",
}
_REPORT_FIELDS = {
    "schema_version", "run_id", "diagnostic_notice", "input", "requirements",
    "execution", "checks", "issues", "priority_issue_ids", "limitations",
}
_BANNED_VERDICT = re.compile(r"QUALITY_PASS|PLATFORM_PASS|SYSTEM_GO|CLUSTER_GO", re.I)
_LINE_END = re.compile(r"\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]")


def _nonempty_string(value, name):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a nonempty string")
    return value


def _string_list(value, name, nonempty=False):
    if not isinstance(value, list) or (nonempty and not value):
        raise ValueError(f"{name} must be {'a nonempty' if nonempty else 'a'} list")
    return [_nonempty_string(item, name) for item in value]


def _reject_verdict(value):
    """Check result text, never quoted source text."""
    if isinstance(value, str) and _BANNED_VERDICT.search(value):
        raise ValueError("product release verdicts are not auxiliary diagnoses")
    if isinstance(value, Mapping):
        for key, item in value.items():
            _reject_verdict(key)
            _reject_verdict(item)
    elif isinstance(value, list):
        for item in value:
            _reject_verdict(item)


def normalize_citation(item, sources) -> dict:
    """Resolve one exact quote or reject ambiguity, altered offsets and hashes.

    Explicit offsets disambiguate repeated quotes; without offsets even
    overlapping occurrences count as ambiguous. Derived metadata is always
    taken from the source mapping, not from model-supplied line numbers/path.
    """
    if not isinstance(item, Mapping) or not isinstance(sources, Mapping):
        raise ValueError("citation and sources must be objects")
    allowed = {"source_id", "source_sha256", "start_char", "end_char", "quote",
               "line_start", "line_end", "path"}
    if set(item) - allowed:
        raise ValueError("unsupported citation fields")
    source_id = _nonempty_string(item.get("source_id"), "source_id")
    quote = _nonempty_string(item.get("quote"), "quote")
    source = sources.get(source_id)
    if not isinstance(source, Mapping) or source.get("source_id") != source_id:
        raise ValueError(f"unknown or inconsistent source_id: {source_id}")
    text = source.get("text")
    kind = source.get("kind")
    if not isinstance(text, str) or not isinstance(kind, str) or kind not in {"draft", "reference", "rule"}:
        raise ValueError("source must contain text and a supported kind")
    source_sha256 = _nonempty_string(source.get("sha256"), "source.sha256")
    path = source.get("path")
    if path is not None and not isinstance(path, str):
        raise ValueError("source.path must be a string or null")
    if "source_sha256" in item and item["source_sha256"] != source_sha256:
        raise ValueError("source_sha256 mismatch")
    has_start, has_end = "start_char" in item, "end_char" in item
    if has_start != has_end:
        raise ValueError("start_char and end_char must be supplied together")
    if has_start:
        start, end = item["start_char"], item["end_char"]
        if type(start) is not int or type(end) is not int:
            raise ValueError("citation offsets must be non-boolean integers")
        if not 0 <= start < end <= len(text):
            raise ValueError("citation offsets are outside source text")
        if text[start:end] != quote:
            raise ValueError("quote does not match the supplied offsets")
    else:
        start = text.find(quote)
        if start < 0:
            raise ValueError("quote not found in source text")
        if text.find(quote, start + 1) >= 0:
            raise ValueError("ambiguous quote requires explicit offsets")
        end = start + len(quote)
    line_starts = [0] + [match.end() for match in _LINE_END.finditer(text)]
    return {"source_id": source_id, "source_sha256": source_sha256,
            "start_char": start, "end_char": end, "quote": quote,
            "line_start": bisect_right(line_starts, start),
            "line_end": bisect_right(line_starts, end - 1), "path": path}


def normalize_issue(item, sources, allow_spec=False) -> dict:
    """Validate only the finite issue interface, not the literary conclusion.

    Rule IDs must equal the issue's check ID. C03/C04 need two non-overlapping
    evidence spans in the same draft, never a reference as the second end.
    An empty alternative_explanations list means none were supplied, not that
    all possible explanations have been excluded.
    """
    if not isinstance(item, Mapping):
        raise ValueError("issue must be an object")
    if set(item) != _ISSUE_FIELDS:
        raise ValueError("issue fields must match report_fields.json")
    check_id = item["check_id"]
    allowed_checks = {"C02", "C03", "C04", "C05"} | ({"C01"} if allow_spec else set())
    if not isinstance(check_id, str) or check_id not in allowed_checks:
        raise ValueError("unsupported issue check_id")
    expected_kind = "spec_violation" if check_id == "C01" else "novel_question"
    if item["kind"] != expected_kind:
        raise ValueError("issue kind does not match the permitted check")
    rule_ids = _string_list(item["rule_source_ids"], "rule_source_ids", nonempty=True)
    if len(rule_ids) != len(set(rule_ids)) or any(rule_id != check_id for rule_id in rule_ids):
        raise ValueError("rule_source_ids must contain only the issue's check_id")
    result = {"id": _nonempty_string(item["id"], "id"), "check_id": check_id,
              "kind": expected_kind, "rule_source_ids": list(rule_ids),
              "semantic_verification": "not_verified" if check_id != "C01" else "mechanical_spec"}
    for name in ("reasoning", "uncertainty", "suggested_verification"):
        result[name] = _nonempty_string(item[name], name)
    result["alternative_explanations"] = _string_list(
        item["alternative_explanations"], "alternative_explanations")
    _reject_verdict(result)
    if not isinstance(item["citations"], list) or not item["citations"]:
        raise ValueError("citations must be a nonempty list")
    citations = [normalize_citation(citation, sources) for citation in item["citations"]]
    if check_id in {"C03", "C04"}:
        draft_spans = [citation for citation in citations
                       if sources[citation["source_id"]]["kind"] == "draft"]
        has_pair = any(
            left["source_id"] == right["source_id"]
            and (left["end_char"] <= right["start_char"]
                 or right["end_char"] <= left["start_char"])
            for index, left in enumerate(draft_spans) for right in draft_spans[index + 1:])
        if not has_pair:
            raise ValueError("C03/C04 require two separate evidence spans in the same draft")
    result["citations"] = citations
    return result


def _literal(value, language="text"):
    text = value if isinstance(value, str) else json.dumps(
        value, ensure_ascii=False, indent=2, sort_keys=True)
    fence = "`" * max(3, 1 + max((len(run) for run in re.findall(r"`+", text)), default=0))
    return f"{fence}{language}\n{text}\n{fence}"


def _inline(value):
    text = str(value).replace("\r", "\\r").replace("\n", "\\n")
    fence = "`" * max(1, 1 + max((len(run) for run in re.findall(r"`+", text)), default=0))
    return f"{fence} {text} {fence}"


def _citation_markdown(citation):
    if not isinstance(citation, Mapping):
        raise ValueError("rendered citation must be an object")
    keys = ("source_id", "source_sha256", "start_char", "end_char", "line_start", "line_end", "path")
    if any(key not in citation for key in keys) or "quote" not in citation:
        raise ValueError("render_report requires normalized citations")
    return _literal({key: citation[key] for key in keys}, "json") + "\n\n" + _literal(citation["quote"])


def render_report(report, evidence) -> str:
    """Render supplied records without inventing counts, findings or approvals.

    Missing check records are visibly not_evaluated. Unknown statuses, duplicate
    checks/issues, or more than three priorities are rejected, never silently
    converted to a complete report. Untrusted text is enclosed in code fences
    chosen to be longer than any backtick run in that text.
    """
    if not isinstance(report, Mapping) or not _REPORT_FIELDS <= set(report):
        raise ValueError("report is missing fields from report_fields.json")
    raw_checks = report["checks"]
    if isinstance(raw_checks, Mapping):
        checks = dict(raw_checks)
    elif isinstance(raw_checks, list):
        checks = {}
        for item in raw_checks:
            if not isinstance(item, Mapping):
                raise ValueError("check must be an object")
            check_id = item.get("check_id", item.get("id"))
            if not isinstance(check_id, str) or check_id in checks:
                raise ValueError("invalid or duplicate check_id")
            checks[check_id] = item
    else:
        raise ValueError("checks must be an object or list")
    if set(checks) - set(_CHECK_NAMES):
        raise ValueError("report contains an unsupported check")
    for item in checks.values():
        if (not isinstance(item, Mapping) or not isinstance(item.get("status"), str)
                or item["status"] not in _STATUS_NAMES):
            raise ValueError("check status is invalid")
    issues = report["issues"]
    if not isinstance(issues, list) or any(not isinstance(item, Mapping) for item in issues):
        raise ValueError("issues must be a list of objects")
    by_id = {_nonempty_string(item.get("id"), "issue.id"): item for item in issues}
    if len(by_id) != len(issues):
        raise ValueError("duplicate issue ids")
    priorities = _string_list(report["priority_issue_ids"], "priority_issue_ids")
    if len(priorities) > 3 or len(set(priorities)) != len(priorities) or any(
            issue_id not in by_id for issue_id in priorities):
        raise ValueError("priority_issue_ids must select at most three distinct existing issues")
    limitations = _string_list(report["limitations"], "limitations")
    citations = evidence.get("citations") if isinstance(evidence, Mapping) else evidence
    if not isinstance(citations, list):
        raise ValueError("evidence must be a citation list or an object with citations")
    for citation in citations:
        _citation_markdown(citation)

    lines = ["# 小说辅助检查报告", "",
             "> **辅助诊断，不是正式审核票或产品放行凭证。** 本报告不改变主任务规则、角色或状态。",
             "", f"运行标识：{_inline(report['run_id'])}", "",
             "## 输入与适用要求", "", _literal(report["input"], "json"), "",
             _literal(report["requirements"], "json"), "",
             "本轮提供的诊断声明：", "", _literal(report["diagnostic_notice"]), "",
             "## 实际执行与检查范围", "",
             "以下展示调用方提供的执行记录；不按计划补填分析次数，不推断人工认可。", "",
             _literal(report["execution"], "json"), "",
             "`已检查` 只表示该项执行过，不表示整篇小说通过审核。缺失的检查记录列为未评估。", "",
             "| 检查 | 范围 | 本轮状态 |", "| --- | --- | --- |"]
    for check_id, name in _CHECK_NAMES.items():
        status = checks.get(check_id, {}).get("status", "not_evaluated")
        lines.append(f"| {check_id} | {name} | {_STATUS_NAMES[status]} |")
    lines += ["", "## 优先核对（最多三项）", ""]
    if not priorities:
        lines.append("本轮未列优先核对项；这不表示稿件不存在问题。")
    for number, issue_id in enumerate(priorities, 1):
        issue = by_id[issue_id]
        lines += [f"### {number}. {_inline(issue_id)} / {_inline(issue.get('check_id'))}", "",
                  _literal(issue.get("reasoning", "未提供推理")), "",
                  "建议核对动作：", "", _literal(issue.get("suggested_verification", "未提供")), ""]
    lines += ["", "## 六项检查数据", ""]
    for check_id, name in _CHECK_NAMES.items():
        item = checks.get(check_id, {"status": "not_evaluated", "data": {"reason": "未提供检查记录"}})
        lines += [f"### {check_id} {name}", "", _literal(item, "json"), ""]
    lines += ["## 问题与原文证据", ""]
    if not issues:
        lines.append("本轮没有记录问题条目；请结合检查状态和限制阅读。")
    for issue in issues:
        lines += [f"### {_inline(issue['id'])} / {_inline(issue.get('check_id'))}", "",
                  "语义判断：" + _inline(issue.get("semantic_verification", "not_verified")) + "；引文定位不证明事件顺序或判断成立。", "",
                  "适用检查来源：", "", _literal(issue.get("rule_source_ids", []), "json"), ""]
        for title, field in (("判断理由", "reasoning"), ("其他解释", "alternative_explanations"),
                             ("不确定性", "uncertainty"), ("建议核对动作", "suggested_verification")):
            value = issue.get(field)
            if field == "alternative_explanations" and value == []:
                value = "未提供其他解释；不能据此认为已排除所有解释。"
            lines += [f"**{title}**", "", _literal(value), ""]
        for number, citation in enumerate(issue.get("citations", []), 1):
            lines += [f"**原文证据 {number}**", "", _citation_markdown(citation), ""]
    lines += ["## 证据登记与限制", "",
              f"本轮 evidence.json 提供 {len(citations)} 条引用记录。该数量不代表问题数或审核票数。", "",
              "证据定位只能证明摘句存在，不能单独证明文学判断正确或修改建议没有误伤。", "",
              "本流程不判断商业表现、法律抄袭或正式放行；没有人工意见记录时，不声称建议已获认可。", ""]
    if limitations:
        for number, limitation in enumerate(limitations, 1):
            lines += [f"**限制 {number}**", "", _literal(limitation), ""]
    else:
        lines += ["调用方未提供额外限制说明；不可据此推断不存在限制。", ""]
    return "\n".join(lines).rstrip() + "\n"
