# The study assistant's eval

Does `/proxy/assist` hold up on Claude Sonnet 5 rather than Claude Opus 5?

That question is worth $5.94 a month on every Pro account and it is the whole
of the $22-vs-$29 Pro decision, so it was answered by running real study
questions against real lectures rather than by arithmetic.

## What ran, 2026-09-19

Sonnet 5 at effort medium, the Worker's own prompt, all 43 questions, scored
by Claude Opus 4.8 against a five-part rubric with the same lectures in front
of it.

| Path | Cases | Acceptable | Rubric | Cost a question |
|---|---:|---:|---:|---:|
| Course summaries | 36 | **97.2%** | 98.9% | $0.098 |
| One course's transcripts | 7 | **71.4%** | 91.4% | $0.487 |
| — of those, study guides | 3 | 100% | 100% | $0.525 |
| — of those, verbatim and arithmetic | 4 | **50.0%** | 85.0% | $0.459 |
| Everything | 43 | **93.0%** | 97.7% | $0.162 |

Routing was right on 97.6% of the 41 labeled cases: one question that wanted
a transcript was answered from the summaries instead.

**The split is the finding.** On summaries, which is what most of a study
session is, Sonnet is as good as this rubric can measure, and it writes a
clean study guide from a whole course. The failures are all in one place:
four questions that turn on the instructor's exact figures, two of which came
back with numbers the transcript does not contain, asserted in the tone of
the answers that were right. Both were the accounting course, where answering
means reconciling figures across 55k tokens. The narrative transcript
questions came back faithful.

Three of these cases were scored as failures on the first pass and are not:
the harness showed the grader a multi-turn conversation's last answer beside
its FIRST question, so a follow-up answer was marked nonresponsive for
answering the follow-up, and the quiz was marked down for asking one question
and waiting, which is what the mode instruction tells it to do. Both faults
were the runner's. Both are fixed, and all four cases pass on the re-run.

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

## The index probe

Whether a third stage would work, measured rather than argued, in
`index_probe.py`.

An index entry built out of what the summarizer already writes — the
lecture's section headings, its key terms, its assignments, and the proper
nouns in its body — is **372 tokens a lecture, measured**. At a full
semester's 112 lectures that is a 42k index against 307k of summaries.

Asked to route on the index alone, with tools to open notes, open transcripts,
answer from the index, or say it is not covered, Sonnet got 13 of 17 to the
right tool and 10 of 17 to the right tool AND the right lectures. Not
shippable, and all three causes are known:

1. **Two lectures shared an id.** `COURSE_DATE` is not unique: this student
   recorded ACCT-4321 twice on 2026-09-01. The model invented a
   disambiguated id rather than picking wrongly, which is the good failure,
   but it is still a miss. The id needs the topic slug in it.
2. **Anecdotes are not in the index and cannot be found in it.** Grep the
   index for "AT&T" or "wiper" and there are no hits, because a story told
   once in a lecture is not a key term and is not a section heading. Both
   anecdote questions misrouted, one of them to the wrong course. This is
   what the summarizer would have to start emitting: a `mentions` field, the
   named examples and stories, alongside `key_terms`.
3. **An index is a table of contents and the model will try to answer from
   it.** Tightening the prompt away from over-reading transcripts pushed it
   into under-reading: three concept questions came back
   `answer_from_index`, which would have answered a question about
   Schumpeter from a list of twelve term names.

None of that says the design is wrong. It says the retrieval step is its own
piece of work with its own eval, and that the index has to be built by the
summarizer rather than scraped out of prose afterwards.

## What is still open

- The transcript path needs more than four cases before anyone concludes
  anything from 50%. The cheap version is six more accounting questions that
  turn on figures, since that is where both failures were.
- If that pattern holds, the fix is a line in the system prompt telling it to
  quote figures rather than recompute or reconcile them, not a more expensive
  model. Opus does not fit in a $22 plan at any quality, so a model that gets
  arithmetic right is not an option that is actually on the table.
- A routing eval, if the third stage is built: the questions here grade an
  answer, and routing needs its own labeled set.
