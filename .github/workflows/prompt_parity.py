#!/usr/bin/env python3
"""Fail when this repo's lecture prompt has drifted from LectureAI's.

The summary prompt and the action-item rules exist twice: in LectureAI as
intake/schemas.py, which a Mac on its own keys runs, and here as
src/prompts.ts, which every managed account runs. They have drifted twice.
The second time shipped an older set of action-item rules to the managed
path, and it took a benchmark showing different output to notice.

Compared as text with whitespace and the two languages' line continuations
normalized away, so reformatting either file is fine and changing what it
says is not.

    python3 prompt_parity.py <schemas.py> <prompts.ts>
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

# Each rule is matched by a short, distinctive opening rather than by position,
# so reordering the bullets does not produce a mystery failure.
ANCHORS = [
    "- An action item is something the instructor assigned",
    "- Capture every assignment that clears that bar",
    "- Do not invent action items, and do not invent deadlines",
    "- Keep each action item's task to the errand alone",
    "- For each action item, resolve any relative deadline",
]


# Where each file's LECTURE prompt starts and ends. Slicing first is what keeps
# an anchor that also appears in the call prompt from matching there: two of the
# five occur twice per file, so before this the check passed only because
# LECTURE happens to be defined before CALL in both files.
LECTURE_SPANS = {
    "schemas.py": ("LECTURE_SYSTEM_PROMPT = ", '"""'),
    "prompts.ts": ("const LECTURE_SYSTEM = ", "`;"),
}


def lecture_prompt(text: str, kind: str, source: str) -> str:
    start_marker, end_marker = LECTURE_SPANS[kind]
    start = text.find(start_marker)
    if start < 0:
        sys.exit(f"{source}: no {start_marker!r} in this file. Did it move or get renamed?")
    body = text[start + len(start_marker):]
    end = body.find(end_marker, 1)
    return body if end < 0 else body[:end]


def normalize(text: str) -> str:
    """One line, single-spaced, with either language's continuations removed."""
    return re.sub(r"\s+", " ", text.replace("\\\n", "").replace("\\", "")).strip()


def rule(text: str, anchor: str, source: str) -> str:
    start = text.find(anchor)
    if start < 0:
        sys.exit(f"{source}: cannot find the rule starting {anchor!r}.\n"
                 f"If it was deliberately reworded, update ANCHORS in this script "
                 f"in the same PR, in both repos.")
    # To the next bullet, or the end of the prompt literal.
    rest = text[start + len(anchor):]
    ends = [m.start() for m in re.finditer(r"\n-\s", rest)]
    return normalize(anchor + (rest[: ends[0]] if ends else rest))


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        sys.exit("usage: prompt_parity.py <schemas.py> <prompts.ts>")
    python_side = lecture_prompt(Path(argv[1]).read_text(), "schemas.py", "LectureAI/intake/schemas.py")
    worker_side = lecture_prompt(Path(argv[2]).read_text(), "prompts.ts", "src/prompts.ts")

    drifted = []
    for anchor in ANCHORS:
        a = rule(python_side, anchor, "LectureAI/intake/schemas.py")
        b = rule(worker_side, anchor, "src/prompts.ts")
        if a == b:
            print(f"match   {anchor[2:60]}...")
        else:
            drifted.append((anchor, a, b))
            print(f"DRIFTED {anchor[2:60]}...")

    if drifted:
        print("\nThe lecture prompt differs between the two repos. A Mac on its own")
        print("keys and a managed account would summarize the same lecture by")
        print("different rules.\n")
        for anchor, a, b in drifted:
            print(f"--- {anchor}")
            print(f"  LectureAI: {a}")
            print(f"  this repo: {b}\n")
        return 1

    print(f"\nall {len(ANCHORS)} action-item rules match LectureAI")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
