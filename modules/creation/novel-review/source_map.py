"""Pure, offset-preserving helpers for the finite Full15 novel review.

Offsets are zero-based Unicode character offsets into ``text``; ends are
exclusive. Lines/paragraphs are numbered from one. ATX Markdown headings,
plain ``第N章`` headings, and explicitly labelled book titles are structural
lines, not body text. Text before the first chapter is retained.
"""

from __future__ import annotations

import re
import unicodedata


_MARKDOWN_HEADING = re.compile(r"^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*$")
_CHAPTER = re.compile(r"^第[ \t]*([0-9０-９零〇一二两三四五六七八九十百千]+)[ \t]*章(.*)$")
_CHAPTER_LIKE = re.compile(r"^第[^\r\n]{1,20}章")
_EXPLICIT_TITLE = re.compile(r"^(?:标题|书名)[：:]")
_UNNUMBERED_CHAPTERS = {"序章", "楔子", "终章", "尾声", "番外"}


def _integer(value, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a non-negative integer")
    return value


def _chapter_number(label: str) -> int | None:
    if label.isdecimal():
        number = int(label)
        return number if number > 0 else None
    digits = dict(zip("零〇一二两三四五六七八九", (0, 0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9)))
    units = {"十": 10, "百": 100, "千": 1000}
    total, pending, previous_unit = 0, None, 10000
    for char in label:
        if char in digits:
            if pending not in (None, 0):
                return None
            pending = digits[char]
        elif char in units:
            unit = units[char]
            if unit >= previous_unit or pending == 0:
                return None
            total += (1 if pending is None else pending) * unit
            pending, previous_unit = None, unit
        else:
            return None
    number = total + (pending or 0)
    return number if number > 0 else None


def _line_records(text: str) -> list[dict]:
    result, offset = [], 0
    for number, raw in enumerate(text.splitlines(keepends=True), 1):
        content = raw.rstrip("\r\n")
        result.append({"number": number, "start_char": offset,
                       "end_char": offset + len(content),
                       "full_end_char": offset + len(raw)})
        offset += len(raw)
    return result


def _heading(content: str) -> dict | None:
    markdown = _MARKDOWN_HEADING.fullmatch(content)
    label = markdown.group(1).strip() if markdown else content.strip()
    if markdown:
        label = re.sub(r"[ \t]+#+$", "", label).rstrip()
    match = _CHAPTER.fullmatch(label)
    if match:
        remainder = match.group(2)
        # A plain prose line beginning "第一章结束了" is not a clear heading.
        explicit = bool(markdown) or not remainder or remainder[0] in " \t：:、.．—-"
        if explicit:
            return {"kind": "chapter", "label": label,
                    "number": _chapter_number(match.group(1))}
        return {"kind": "uncertain_chapter", "label": label, "number": None}
    if _CHAPTER_LIKE.match(label) or label in _UNNUMBERED_CHAPTERS:
        return {"kind": "uncertain_chapter", "label": label, "number": None}
    if markdown or _EXPLICIT_TITLE.match(label) or label in {"导读", "前言", "序言", "后记"}:
        return {"kind": "heading", "label": label, "number": None}
    return None


def _body_ranges(start: int, end: int, headings: list[dict]) -> list[dict]:
    ranges, cursor = [], start
    for heading in headings:
        if heading["kind"] == "uncertain_chapter" and not heading["structural"]:
            continue
        left, right = heading["start_char"], heading["end_char"]
        if cursor < left:
            ranges.append({"start_char": cursor, "end_char": left})
        cursor = max(cursor, right)
    if cursor < end:
        ranges.append({"start_char": cursor, "end_char": end})
    return ranges


def _paragraphs(text: str, lines: list[dict], ranges: list[dict]) -> list[dict]:
    paragraphs, current = [], None
    for line in lines:
        spans = [(max(line["start_char"], item["start_char"]),
                  min(line["end_char"], item["end_char"])) for item in ranges]
        spans = [(start, end) for start, end in spans if start < end and text[start:end].strip()]
        if not spans:
            if current is not None:
                paragraphs.append(current)
                current = None
            continue
        start, end = spans[0]
        if current is None:
            current = {"number": len(paragraphs) + 1, "start_char": start,
                       "end_char": end, "line_start": line["number"],
                       "line_end": line["number"]}
        else:
            current.update(end_char=end, line_end=line["number"])
    if current is not None:
        paragraphs.append(current)
    return paragraphs


def build_source_map(text, source_id, source_sha256, path=None,
                     body_start=0, body_end=None) -> dict:
    """Describe supplied text without reading files, normalizing or truncating it.

    The caller supplies the hash of the source bytes; this function does not
    claim to verify it against re-encoded text. ``text`` is retained in the map
    so window offsets can be computed without a second file read.
    """
    if not isinstance(text, str):
        raise ValueError("text must be a string")
    if not isinstance(source_id, str) or not isinstance(source_sha256, str):
        raise ValueError("source_id and source_sha256 must be strings")
    start = _integer(body_start, "body_start")
    end = len(text) if body_end is None else _integer(body_end, "body_end")
    if not 0 <= start <= end <= len(text):
        raise ValueError("body bounds must be within text and in ascending order")

    lines = _line_records(text)
    headings, issues = [], []
    for line in lines:
        if line["full_end_char"] <= start or line["start_char"] >= end:
            continue
        content = text[line["start_char"]:line["end_char"]]
        heading = _heading(content)
        if heading is None:
            continue
        if line["start_char"] < start or line["end_char"] > end:
            issues.append({"code": "partial_heading_at_body_boundary",
                           "start_char": max(start, line["start_char"]),
                           "end_char": min(end, line["full_end_char"])})
            continue
        heading.update(start_char=line["start_char"],
                       end_char=min(end, line["full_end_char"]), line=line["number"],
                       structural=bool(_MARKDOWN_HEADING.fullmatch(content))
                       or heading["kind"] != "uncertain_chapter"
                       or content.strip() in _UNNUMBERED_CHAPTERS)
        headings.append(heading)
        if heading["kind"] == "uncertain_chapter" or (
                heading["kind"] == "chapter" and heading["number"] is None):
            issues.append({"code": "unresolved_chapter_heading",
                           "start_char": heading["start_char"], "label": heading["label"]})

    markers = [item for item in headings if item["kind"] in {"chapter", "uncertain_chapter"}]
    chapters = []
    for index, marker in enumerate(markers):
        if marker["number"] is None:
            continue
        chapter_end = markers[index + 1]["start_char"] if index + 1 < len(markers) else end
        chapters.append({"number": marker["number"], "start_char": marker["end_char"],
                         "end_char": chapter_end, "heading_start_char": marker["start_char"],
                         "heading_end_char": marker["end_char"], "title": marker["label"]})
    numbers = [chapter["number"] for chapter in chapters]
    if not numbers:
        issues.append({"code": "no_explicit_chapters"})
    elif len(numbers) != len(set(numbers)):
        issues.append({"code": "duplicate_chapter_numbers", "numbers": numbers})
    elif any(right != left + 1 for left, right in zip(numbers, numbers[1:])):
        issues.append({"code": "nonconsecutive_chapter_numbers", "numbers": numbers})

    ranges = _body_ranges(start, end, headings)
    body = "".join(text[item["start_char"]:item["end_char"]] for item in ranges)
    han_count = sum(char == "〇" or unicodedata.name(char, "").startswith(
        ("CJK UNIFIED IDEOGRAPH-", "CJK COMPATIBILITY IDEOGRAPH-")) for char in body)
    non_whitespace_count = sum(not char.isspace() for char in body)
    exceeded = []
    if non_whitespace_count > 20000:
        exceeded.append("body_non_whitespace_limit")
    if len(chapters) > 20:
        exceeded.append("explicit_chapter_limit")
    return {"schema_version": "full15-source-map-1", "source_id": source_id,
            "source_sha256": source_sha256, "path": None if path is None else str(path),
            "text": text, "raw_char_count": len(text), "body_start": start, "body_end": end,
            "body_ranges": ranges, "body_han_count": han_count,
            "body_non_whitespace_count": non_whitespace_count,
            "explicit_chapter_count": len(chapters), "chapter_boundaries_known": not issues,
            "chapter_boundary_issues": issues, "chapters": chapters, "headings": headings,
            "lines": lines, "paragraphs": _paragraphs(text, lines, ranges),
            "limits_exceeded": exceeded}


def check_spec(source_map, requirements) -> dict:
    """Check only explicit length/chapter bounds; no implicit writing defaults."""
    if not isinstance(requirements, dict):
        raise ValueError("requirements must be an object")
    basis = requirements.get("count_basis")
    if basis not in (None, "han", "non_whitespace"):
        raise ValueError("count_basis must be han or non_whitespace when supplied")
    bounds = {}
    for kind in ("body_length", "chapters"):
        lower, upper = requirements.get(f"min_{kind}"), requirements.get(f"max_{kind}")
        if lower is not None:
            _integer(lower, f"min_{kind}")
        if upper is not None:
            _integer(upper, f"max_{kind}")
        if lower is not None and upper is not None and lower > upper:
            raise ValueError(f"min_{kind} must not exceed max_{kind}")
        bounds[kind] = (lower, upper)
    data = {key: source_map[key] for key in (
        "body_han_count", "body_non_whitespace_count", "explicit_chapter_count",
        "chapter_boundaries_known")}
    data.update(chapter_count=source_map["explicit_chapter_count"], count_basis=basis)
    violations, unknown = [], False
    for kind, result_key in (("body_length", "length_result"), ("chapters", "chapter_result")):
        lower, upper = bounds[kind]
        data[f"{kind}_range"] = {"min": lower, "max": upper}
        if lower is None and upper is None:
            data[result_key] = "statistics_only"
            continue
        if (kind == "body_length" and basis is None) or (
                kind == "chapters" and not source_map["chapter_boundaries_known"]):
            data[result_key] = "insufficient_evidence"
            unknown = True
            continue
        actual = (source_map[f"body_{basis}_count"] if kind == "body_length"
                  else source_map["explicit_chapter_count"])
        result, limit = "satisfied", None
        if lower is not None and actual < lower:
            result, limit = "below_minimum", lower
        elif upper is not None and actual > upper:
            result, limit = "above_maximum", upper
        data[result_key] = result
        if limit is not None:
            violations.append({"field": kind, "code": result, "actual": actual,
                               "limit": limit, "count_basis": basis if kind == "body_length" else None})
    return {"status": "insufficient_evidence" if unknown else "checked",
            "data": data, "violations": violations}


def window_spans(source_map, which, limit) -> list[dict]:
    """Return original-text spans within a body non-whitespace character budget.

    Chapter windows return [] when chapter boundaries are unresolved or the
    requested numbered chapter is absent. Callers must expose that limitation.
    """
    if which not in {"body_prefix", "ch4_suffix", "ch5_prefix"}:
        raise ValueError("unsupported window")
    _integer(limit, "limit")
    if limit == 0:
        return []
    ranges = source_map["body_ranges"]
    if which != "body_prefix":
        if not source_map["chapter_boundaries_known"]:
            return []
        number = 4 if which == "ch4_suffix" else 5
        chapters = [item for item in source_map["chapters"] if item["number"] == number]
        if len(chapters) != 1:
            return []
        chapter = chapters[0]
        ranges = [{"start_char": max(item["start_char"], chapter["start_char"]),
                   "end_char": min(item["end_char"], chapter["end_char"])} for item in ranges]
    suffix = which == "ch4_suffix"
    text, spans, remaining = source_map["text"], [], limit
    for item in reversed(ranges) if suffix else ranges:
        positions = [index for index in range(item["start_char"], item["end_char"])
                     if not text[index].isspace()]
        if not positions:
            continue
        selected = positions[-remaining:] if suffix else positions[:remaining]
        spans.append({"start_char": selected[0], "end_char": selected[-1] + 1})
        remaining -= len(selected)
        if remaining == 0:
            break
    return sorted(spans, key=lambda item: item["start_char"])
