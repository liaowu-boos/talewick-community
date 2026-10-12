"""Bounded lexical overlap inspection with exact source-character citations.

This module has no file or process access.  ``sha256`` values identify the raw
bytes read by the caller; they are deliberately not recomputed from ``text``.
All character offsets are half-open Python Unicode code-point offsets.
"""

from __future__ import annotations

import posixpath
import unicodedata
from typing import Any


MAX_CANDIDATES = 50
MAX_DISPLAY_MATCHES = 5
MAX_ANCHORS_PER_SOURCE = 16
COMPACT_PUNCTUATION = frozenset("，。！？、；：“”‘’…,.!?;:'\"—-")


def _validate_source(source: dict[str, Any], label: str) -> None:
    if not isinstance(source, dict):
        raise ValueError(f"{label} must be a source dictionary")
    for field in ("source_id", "path", "text", "sha256"):
        if not isinstance(source.get(field), str):
            raise ValueError(f"{label}.{field} must be a string")
        if field != "text" and not source[field]:
            raise ValueError(f"{label}.{field} must not be empty")


def _path_key(path: str) -> str:
    # Pure lexical normalization; resolving symlinks or relative/absolute aliases
    # is the caller's responsibility, not a hidden filesystem operation here.
    return posixpath.normpath(unicodedata.normalize("NFC", path))


def _compact_with_offsets(text: str) -> tuple[str, list[int]]:
    characters: list[str] = []
    offsets: list[int] = []
    for offset, character in enumerate(text):
        if character.isspace() or character in COMPACT_PUNCTUATION:
            continue
        characters.append(character)
        offsets.append(offset)
    return "".join(characters), offsets


def _ngram_index(text: str, size: int) -> tuple[dict[str, int], set[str]]:
    first_positions: dict[str, int] = {}
    repeated: set[str] = set()
    for offset in range(len(text) - size + 1):
        ngram = text[offset : offset + size]
        if ngram in first_positions:
            repeated.add(ngram)
        else:
            first_positions[ngram] = offset
    return first_positions, repeated


def _extend_anchor(
    draft: str, reference: str, draft_start: int, reference_start: int, size: int
) -> tuple[int, int, int, int]:
    draft_end = draft_start + size
    reference_end = reference_start + size
    while (
        draft_start > 0
        and reference_start > 0
        and draft[draft_start - 1] == reference[reference_start - 1]
    ):
        draft_start -= 1
        reference_start -= 1
    while (
        draft_end < len(draft)
        and reference_end < len(reference)
        and draft[draft_end] == reference[reference_end]
    ):
        draft_end += 1
        reference_end += 1
    return draft_start, draft_end, reference_start, reference_end


def _selected_blocks(
    draft: str,
    reference: str,
    draft_positions: dict[str, int],
    reference_positions: dict[str, int],
    size: int,
) -> tuple[list[tuple[int, int, int, int]], bool]:
    blocks: list[tuple[int, int, int, int]] = []
    for ngram, reference_start in reference_positions.items():
        draft_start = draft_positions.get(ngram)
        if draft_start is None:
            continue
        if any(
            left_start <= draft_start
            and draft_start + size <= left_end
            and right_start <= reference_start
            and reference_start + size <= right_end
            and draft_start - left_start == reference_start - right_start
            for left_start, left_end, right_start, right_end in blocks
        ):
            continue
        if len(blocks) == MAX_ANCHORS_PER_SOURCE:
            return blocks, True
        blocks.append(
            _extend_anchor(draft, reference, draft_start, reference_start, size)
        )
    return blocks, False


def _citation(
    source: dict[str, Any], offsets: list[int], start: int, end: int
) -> dict[str, Any]:
    original_start = offsets[start]
    original_end = offsets[end - 1] + 1
    return {
        "source_id": source["source_id"],
        "source_sha256": source["sha256"],
        "start_char": original_start,
        "end_char": original_end,
        "quote": source["text"][original_start:original_end],
    }


def scan_similarity(
    draft: dict,
    references: list[dict],
    ngram_size: int = 12,
    match_limit: int = 5,
) -> dict:
    """Inspect at most 50 supplied references without changing any source.

    ``overlap_ngram_count`` is the exact cardinality of the intersection of
    distinct compacted ngrams, not a count of occurrence pairs.  Display search
    uses each shared ngram's first occurrence and at most 16 anchor expansions
    per reference.  It never enumerates the Cartesian product of repeated
    positions.  For a fixed ngram size the work per reference is linear in the
    texts' lengths, with that fixed expansion bound.

    Each source's ``normalized_match_length`` is the longest *selected anchor
    expansion*, not a claim about the global longest match or total coverage.
    Each displayed match carries its own independently recomputable length.
    ``display_truncated`` also covers unsearched repeated occurrences; the
    output intentionally never claims an exhaustive set of matching locations.

    Candidate order breaks ties, so the same inputs produce the same output.
    More than 50 references, or invalid sizes/limits, raise ``ValueError`` rather
    than silently selecting a different candidate pool.  ``match_limit=0`` is
    allowed for statistics-only callers; every eligible source is still scanned.
    """
    if type(ngram_size) is not int or ngram_size < 1:
        raise ValueError("ngram_size must be a positive integer")
    if type(match_limit) is not int or not 0 <= match_limit <= MAX_DISPLAY_MATCHES:
        raise ValueError("match_limit must be an integer from 0 through 5")
    if not isinstance(references, list):
        raise ValueError("references must be a list")
    if len(references) > MAX_CANDIDATES:
        raise ValueError("references exceed the hard candidate limit of 50")
    _validate_source(draft, "draft")
    for index, reference in enumerate(references):
        _validate_source(reference, f"references[{index}]")

    draft_text, draft_offsets = _compact_with_offsets(draft["text"])
    draft_positions, draft_repeated = _ngram_index(draft_text, ngram_size)
    draft_path = _path_key(draft["path"])
    excluded: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    # Store only bounded span coordinates until the global display cap is known.
    candidates: list[dict[str, Any]] = []
    reference_data: list[tuple[dict[str, Any], list[int]]] = []

    for reference in references:
        exclusion = None
        if _path_key(reference["path"]) == draft_path:
            exclusion = "same_path"
        elif reference["sha256"].lower() == draft["sha256"].lower():
            exclusion = "same_sha256"
        if exclusion is not None:
            excluded.append(
                {
                    "source_id": reference["source_id"],
                    "source_sha256": reference["sha256"],
                    "path": reference["path"],
                    "reason": exclusion,
                }
            )
            continue

        reference_text, reference_offsets = _compact_with_offsets(reference["text"])
        reference_positions, reference_repeated = _ngram_index(
            reference_text, ngram_size
        )
        # Count every shared key before the bounded display search starts.
        shared = draft_positions.keys() & reference_positions.keys()
        repeated_shared = bool(shared & (draft_repeated | reference_repeated))
        blocks, anchor_limited = _selected_blocks(
            draft_text, reference_text, draft_positions, reference_positions, ngram_size
        )
        source_index = len(sources)
        reference_data.append((reference, reference_offsets))
        sources.append(
            {
                "source_id": reference["source_id"],
                "source_sha256": reference["sha256"],
                "path": reference["path"],
                "normalized_length": len(reference_text),
                "unique_ngram_count": len(reference_positions),
                "overlap_ngram_count": len(shared),
                "normalized_match_length": max(
                    (end - start for start, end, _, _ in blocks), default=0
                ),
                "anchor_expansions": len(blocks),
                "anchor_search_limited": anchor_limited,
                "matching_ngrams_have_repeated_occurrences": repeated_shared,
                "selected_anchor_match_count": len(blocks),
                "displayed_match_count": 0,
                "display_exhaustive": False,
                "display_truncated": anchor_limited or repeated_shared,
            }
        )
        for block in blocks:
            candidates.append(
                {
                    "source_index": source_index,
                    "block": block,
                    "normalized_match_length": block[1] - block[0],
                }
            )

    candidates.sort(
        key=lambda item: (
            -item["normalized_match_length"],
            item["source_index"],
            item["block"][0],
            item["block"][2],
        )
    )
    matches: list[dict[str, Any]] = []
    for candidate in candidates[:match_limit]:
        source_index = candidate["source_index"]
        reference, offsets = reference_data[source_index]
        left_start, left_end, right_start, right_end = candidate["block"]
        matches.append(
            {
                "normalized_match_length": candidate["normalized_match_length"],
                "draft": _citation(draft, draft_offsets, left_start, left_end),
                "reference": _citation(reference, offsets, right_start, right_end),
            }
        )
        sources[source_index]["displayed_match_count"] += 1

    for source in sources:
        if source["displayed_match_count"] < source["selected_anchor_match_count"]:
            source["display_truncated"] = True

    return {
        "candidate_count": len(references),
        "candidate_limit": MAX_CANDIDATES,
        "scanned_count": len(sources),
        "excluded_sources": excluded,
        "ngram_size": ngram_size,
        "draft_normalized_length": len(draft_text),
        "draft_unique_ngram_count": len(draft_positions),
        "overlap_count_basis": "distinct_normalized_ngram_intersection",
        "normalized_match_length_basis": "longest_selected_anchor_expansion",
        "match_limit": match_limit,
        "anchor_limit_per_source": MAX_ANCHORS_PER_SOURCE,
        "sources": sources,
        "matches": matches,
        "display_exhaustive": False,
        "display_truncated": any(source["display_truncated"] for source in sources),
        "limitations": [
            "Only the supplied eligible candidates are compared; this is not a whole-library scan.",
            "Only first occurrences seed anchors; repeated-location matches are not exhaustively enumerated.",
            "At most 16 anchor expansions per source and 5 displayed matches globally are retained.",
            "Normalized match lengths describe selected anchor expansions, not total overlap or a guaranteed global longest match.",
        ],
    }
