# The study assistant's eval

Does `/proxy/assist` hold up on Claude Sonnet 5 rather than Claude Opus 5?

That question is worth $5.94 a month on every Pro account and it is the whole
of the $22-vs-$29 Pro decision, so it was answered by running real study
questions against real lectures rather than by arithmetic.

## What ran, 2026-09-19

Sonnet 5 at effort medium, the Worker's own prompt, 36 graded questions,
scored by Claude Opus 4.8 against a five-part rubric with the same lectures
in front of it.

| Path | Cases | Acceptable | Rubric | Cost a question |
|---|---:|---:|---:|---:|
| Course summaries | 32 | **96.9%** | 99.4% | $0.085 |
| One course's transcripts | 4 | **50.0%** | 85.0% | $0.459 |

**The split is the finding.** On summaries, which is what most of a study
session is, Sonnet is as good as this rubric can measure. On full transcripts
both failures are the same fault and it is the dangerous one: it invented
numbers the transcript does not contain, with no change in how confident it
sounded. Both were the accounting course, where answering means reconciling
figures across 55k tokens; the narrative transcript questions (a story in
ENTR-3306, a story in ENTR-4306) came back faithful.

Four cases are parked in `results.misgraded.jsonl` rather than counted: three
multi-turn conversations the harness graded against the wrong question, and
the quiz, which the grader marked down for asking one question and waiting,
which is exactly what the mode instruction tells it to do. Both faults were
this runner's, both are fixed, and neither says anything about the model. The
three study guides never ran: they open a whole course each and the account
ran out of credit.

**What this does NOT measure.** The escalation rate. The `course` label on
these questions is a judgment about these questions, not a claim about how
often real students need a whole course. That number only comes from real
sessions, which is why the endpoint counts it from the first one it serves
and `npm run escalation` reads it back.

## The sizes are not what HOME-STRETCH models

Measured on 17 real lectures, four weeks into a semester:

| | Modeled | Measured today | Projected at finals |
|---|---:|---:|---:|
| Every course's summaries | 15k tokens | **46k** | ~307k |
| One course's transcripts | 240k tokens | **55k** | ~218k |

A session costs `context x $4.1/M + $0.06` on Sonnet (one cache write, eight
reads, eight 800-token answers), which reproduces both of HOME-STRETCH's
figures exactly, so the arithmetic there is right and only the sizes are
wrong. The consequence is that the default path grows with the whole semester
while the escalation path grows with one course, and by finals loading every
summary costs more than opening one course's transcripts. Two-stage context
stops paying for itself somewhere in the middle of a term.

## Running it

    pip install anthropic
    export ANTHROPIC_API_KEY=...          # this spends real money
    python3 run.py --variant v1 --model claude-sonnet-5 --grader pointwise

The material is NOT in this repo and never should be: it is somebody's
coursework and this repo is public. `run.py --material <dir>` wants a folder
holding an `index.json` and the lecture files beside it, which is what the
Drive export produces. `evals/assistant/material/` is gitignored for it.

The system prompt and the mode instructions are read out of `src/prompts.ts`
at startup rather than copied here, so this cannot quietly grade a prompt the
service does not send. If an anchor moves, the runner exits instead of
guessing. Changing either file, or the runner, trips the harness gate: read
the diff, then pass `--approve-harness` once.

Results land in `.claude/hillclimb/assistant/<variant>/`, which is gitignored
for the same reason the material is: the traces are full of lecture content.

## What is still open

- Re-run the four parked cases and the three study guides. About $2.
- The transcript path needs more than four cases before anyone concludes
  anything from 50%. The cheap version is six more accounting questions that
  turn on figures, since that is where both failures were.
- If that pattern holds, the fix is a line in the system prompt telling it to
  quote figures rather than recompute or reconcile them, not a more expensive
  model. Opus does not fit in a $22 plan at any quality, so a model that gets
  arithmetic right is not an option that is actually on the table.
