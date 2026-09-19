#!/usr/bin/env python3
"""Is an index enough to route on, and how small is it really?

Two questions, both of which have to be yes before the endpoint is rebuilt
around a third stage:

  1. How many tokens is an index entry per lecture, measured rather than
     guessed. Everything downstream is arithmetic on that number.
  2. Can Sonnet 5, given ONLY the index, name the lectures it needs? If it
     cannot, the whole design collapses into loading everything anyway.

Nothing here writes to the service. It builds the index from the same Drive
export the eval uses and asks the model to route, and nothing else.
"""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
import re
import sys

import anthropic

HERE = pathlib.Path(__file__).parent
EVAL = HERE / "syllabus-accounts" / "evals" / "assistant"
MAT = EVAL / "material"
MODEL = "claude-sonnet-5"

# --- Building an index entry out of a summary -------------------------------

HEADING = re.compile(r"^(?![*\-\d])([A-Z][^.!?]{3,70})$")

# Capitalized runs, plus the handful of lowercase things that behave like
# names. The index misses a question about a story told in class unless the
# story's proper nouns are in it: "the windshield wiper guy" is not a key
# term and never will be, and it was one of the two routing misses.
NAMED = re.compile(r"\b(?:[A-Z][\w&.'-]*\.?\s+){1,3}[A-Z][\w&.'-]*\b|\b[A-Z]{2,}(?:&[A-Z])?\b")
COMMON = {
    "The", "This", "That", "These", "Those", "There", "Their", "They", "It", "In", "On",
    "For", "And", "But", "Key", "Action", "Topic", "Chapter", "Step", "Example", "Note",
    "Using", "Because", "When", "What", "Which", "Other", "Both", "Under", "Over", "From",
    "Given", "Each", "Two", "Three", "Four", "Five", "First", "Second", "Third", "Worked",
    "Students", "Student", "Instructor", "Class", "Course", "Total", "Job", "Cost", "Costs",
}


def named_things(body: str, terms: list[str]) -> list[str]:
    """Proper nouns and named examples, commonest first, minus the key terms."""
    known = {t.lower() for t in terms}
    seen: dict[str, int] = {}
    for match in NAMED.findall(body):
        phrase = match.strip(" .,'")
        head = phrase.split()[0]
        if len(phrase) < 3 or head in COMMON or phrase.lower() in known:
            continue
        if all(w in COMMON for w in phrase.split()):
            continue
        seen[phrase] = seen.get(phrase, 0) + 1
    ranked = sorted(seen.items(), key=lambda kv: (-kv[1], kv[0]))
    return [p for p, n in ranked if n >= 2][:10]


def entry(course: str, date: str, slug: str, summary: str) -> dict:
    """One lecture, as the index would carry it.

    Three things, all already written by the summarizer: what the lecture
    covered (its section headings), the terms it defined, and anything with a
    deadline on it. Definitions are deliberately dropped: the index exists to
    say WHERE something is, and a definition is what opening the summary is
    for.
    """
    lines = [l.rstrip() for l in summary.splitlines()]
    covers, terms, due = [], [], []
    section = None
    for line in lines:
        low = line.strip().lower()
        if low in ("key terms", "action items"):
            section = low
            continue
        if not line.strip():
            continue
        if section == "key terms":
            if line.startswith("* "):
                terms.append(re.split(r"\s+[—-]\s+", line[2:], 1)[0].strip())
            continue
        if section == "action items":
            if line.startswith("* "):
                due.append(re.sub(r"\s+", " ", line[2:])[:110])
            continue
        if HEADING.match(line.strip()) and not line.startswith("Topic:"):
            covers.append(line.strip())
    body = "\n".join(l for l in lines if not l.startswith("* "))
    return {
        "id": f"{course}_{date}",
        "course": course,
        "date": date,
        "topic": slug.replace("-", " "),
        "covers": covers[:6],
        "terms": terms[:12],
        "named": named_things(body, terms),
        "due": due[:3],
    }


def render(e: dict) -> str:
    out = [f"{e['id']} | {e['topic']}"]
    if e["covers"]:
        out.append("  covers: " + "; ".join(e["covers"]))
    if e["terms"]:
        out.append("  terms: " + ", ".join(e["terms"]))
    if e["named"]:
        out.append("  names and examples: " + ", ".join(e["named"]))
    for d in e["due"]:
        out.append("  due: " + d)
    return "\n".join(out)


def build() -> list[dict]:
    index = json.loads((MAT / "index.json").read_text())
    entries = []
    for row in index:
        if row["kind"] != "summary" or row["course"] == "UNKNOWN":
            continue
        parts = row["name"].split("_")
        if len(parts) < 3:
            continue
        entries.append(entry(parts[0], parts[1], parts[2], (MAT / row["path"]).read_text()))
    return sorted(entries, key=lambda e: e["id"])


# --- The probe ---------------------------------------------------------------

ROUTER_SYSTEM = """You are the retrieval step of a study assistant. You are given an INDEX of every lecture a student has recorded: one entry per lecture, saying what it covered, which terms it defined, which people, companies and examples came up in it, and what was assigned.

You are not answering the question. You are deciding what to read, and reading costs money, so read the least that will answer it.

There are two things you can read. The NOTES for a lecture are a careful written summary: they carry the concepts, the definitions, the worked examples with their numbers, what the instructor emphasized, and what was assigned. The TRANSCRIPT is every word said in the room, and it is roughly thirty times larger.

- open_lectures is the normal answer. Name the ids whose notes would answer the question, as few as will do, usually one to three and never more than five.
- open_transcripts is a last resort, for the three things the notes genuinely do not carry: the instructor's exact wording when the student asks for it, a story or aside told in class, and reconciling specific figures against what was actually said. Wanting an answer to be accurate is not a reason to read a transcript; the notes are accurate. Name specific lectures, never a whole course.
- answer_from_index when the index itself answers the question: what is due, which lecture covered something, the shape of a course.
- not_in_notes when nothing in the index covers what was asked. Use this rather than answer_from_index whenever the honest answer to the student is that their notes do not have it, including anything about grades, the syllabus, or a topic the course has not reached.

Call exactly one tool."""


def tools() -> list[dict]:
    ids = {"type": "array", "items": {"type": "string"}, "description": "Lecture ids from the index."}
    return [
        {"name": "open_lectures", "description": "Read the study notes for these lectures.",
         "input_schema": {"type": "object", "properties": {"ids": ids}, "required": ["ids"]}},
        {"name": "open_transcripts", "description": "Read the full transcripts of these lectures, for the instructor's own words.",
         "input_schema": {"type": "object", "properties": {"ids": ids}, "required": ["ids"]}},
        {"name": "answer_from_index", "description": "The index already answers this.",
         "input_schema": {"type": "object", "properties": {"why": {"type": "string"}}, "required": ["why"]}},
        {"name": "not_in_notes", "description": "No lecture covers this.",
         "input_schema": {"type": "object", "properties": {"why": {"type": "string"}}, "required": ["why"]}},
    ]


# What a correct route looks like. Ids the answer genuinely needs, and the
# tool it should have reached for. Written from the material, before running.
EXPECTED = {
    "acct-equivalent-units": ("open_lectures", {"ACCT-4321_2026-09-15", "ACCT-4321_2026-09-17"}),
    "acct-markup-multiplier": ("open_lectures", {"ACCT-4321_2026-09-01", "ACCT-4321_2026-09-03"}),
    "acct-disposing-overhead": ("open_lectures", {"ACCT-4321_2026-09-10"}),
    "entr3306-creative-destruction": ("open_lectures", {"ENTR-3306_2026-09-03"}),
    "entr3306-brain-drain": ("open_lectures", {"ENTR-3306_2026-09-08"}),
    "entr4306-four-quadrants": ("open_lectures", {"ENTR-4306_2026-09-16", "ENTR-4306_2026-09-14"}),
    "entr4306-five-powers": ("open_lectures", {"ENTR-4306_2026-09-02"}),
    "reli-five-theories": ("open_lectures", {"RELI-3304_2026-09-18"}),
    "cross-whats-due": ("answer_from_index", set()),
    "cross-exam-flags": ("open_lectures", set()),
    "absent-my-grade": ("not_in_notes", set()),
    "absent-standard-costing": ("not_in_notes", set()),
    "course-wiper-story": ("open_transcripts", {"ENTR-3306_2026-09-03"}),
    "course-att-bell": ("open_transcripts", {"ENTR-4306_2026-09-14"}),
    "course-epiripto": ("open_transcripts", {"RELI-3304_2026-09-18"}),
    "course-flowpack-walkthrough": ("open_transcripts", {"ACCT-4321_2026-09-17"}),
    "course-brunel-numbers": ("open_transcripts", {"ACCT-4321_2026-09-10"}),
}


async def main() -> int:
    entries = build()
    text = ("Every lecture this student has recorded.\n\n"
            + "\n\n".join(render(e) for e in entries))
    client = anthropic.AsyncAnthropic()

    counted = await client.messages.count_tokens(
        model=MODEL, messages=[{"role": "user", "content": text}])
    per = counted.input_tokens / len(entries)
    print(f"index: {len(entries)} lectures, {counted.input_tokens:,} tokens, "
          f"{per:.0f} tokens a lecture\n")
    (HERE / "index-sample.txt").write_text(text)

    cases = {c["id"]: c for c in json.loads((EVAL / "cases.json").read_text())["cases"]}
    probes = [(cid, cases[cid]) for cid in EXPECTED if cid in cases]

    gate = asyncio.Semaphore(3)
    results = []

    async def probe(cid, case):
        async with gate:
            answer = await client.messages.create(
                model=MODEL, max_tokens=1500,
                thinking={"type": "adaptive"},
                output_config={"effort": "medium"},
                system=ROUTER_SYSTEM,
                tools=tools(),
                messages=[{"role": "user", "content": [
                    {"type": "text", "text": text, "cache_control": {"type": "ephemeral"}},
                    {"type": "text", "text": case["question"]},
                ]}],
            )
        call = next((b for b in answer.content if b.type == "tool_use"), None)
        want_tool, want_ids = EXPECTED[cid]
        got_tool = call.name if call else "none"
        got_ids = set(call.input.get("ids", [])) if call else set()
        # answer_from_index and not_in_notes both load nothing and both end
        # with the student being told what their notes do or do not have, so
        # confusing the two costs nothing and is not scored as a miss.
        no_read = {"answer_from_index", "not_in_notes"}
        tool_ok = got_tool == want_tool or {got_tool, want_tool} <= no_read
        # The named lectures are right when they include what the answer needs
        # and do not drag in a pile of others.
        ids_ok = (not want_ids) or (want_ids <= got_ids and len(got_ids) <= len(want_ids) + 2)
        results.append({
            "case": cid, "want": want_tool, "got": got_tool,
            "want_ids": sorted(want_ids), "got_ids": sorted(got_ids),
            "tool_ok": tool_ok, "ids_ok": ids_ok,
            "usage": {"in": answer.usage.input_tokens,
                      "read": getattr(answer.usage, "cache_read_input_tokens", 0) or 0,
                      "write": getattr(answer.usage, "cache_creation_input_tokens", 0) or 0,
                      "out": answer.usage.output_tokens},
        })
        mark = "ok " if tool_ok and ids_ok else "BAD"
        print(f"  {mark} {cid:32} wanted {want_tool}{sorted(want_ids) if want_ids else ''} "
              f"-> got {got_tool}{sorted(got_ids) if got_ids else ''}")

    await asyncio.gather(*[probe(cid, case) for cid, case in probes])

    tool_right = sum(r["tool_ok"] for r in results)
    both_right = sum(r["tool_ok"] and r["ids_ok"] for r in results)
    spend = sum((r["usage"]["in"] * 2 + r["usage"]["write"] * 2.5 + r["usage"]["read"] * 0.2
                 + r["usage"]["out"] * 10) / 1e6 for r in results)
    print(f"\nrouted to the right tool: {tool_right}/{len(results)}")
    print(f"right tool and right lectures: {both_right}/{len(results)}")
    print(f"routing cost: ${spend / len(results):.5f} a question")
    (HERE / "index-probe-results.json").write_text(json.dumps(results, indent=2))
    return 0


if __name__ == "__main__":
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY is not set")
    sys.exit(asyncio.run(main()))
