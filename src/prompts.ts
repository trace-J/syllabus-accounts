/**
 * What the model is asked for, fixed here on the server.
 *
 * These are ports of intake/schemas.py in the LectureAI repo: the same two
 * profiles, the same four keys (summary_md, topic_slug, key_terms,
 * action_items), so a panel that used to call Anthropic directly gets back
 * the shape it already knows how to handle.
 *
 * They live here rather than travelling in the request because /proxy is not
 * a general-purpose API gateway. A caller picks nothing: the profile on its
 * device row selects one of these, and the prompt, the schema, the model and
 * the upstream URL all come from this file. The only thing a caller supplies
 * is the transcript and the two labels that frame it.
 *
 * When schemas.py changes, change this too. The panel parses what comes back.
 */

export type Profile = "syllabus" | "sous";

export type SummarySpec = {
  /** What the schedule's code stands for: a course, or a client. */
  subjectLabel: string;
  /** What one of these recordings is called, capitalized for the framing. */
  kindLabel: string;
  system: string;
  /** JSON Schema handed to Anthropic as a tool's input schema. */
  schema: Record<string, unknown>;
};

const LECTURE_SYSTEM = `You summarize university lecture transcripts for a student who attended the class and is studying from your notes later.

The transcript comes from automatic speech recognition. It has no speaker labels, no punctuation guarantees, and will contain misheard words, false starts, roll call, and administrative chatter. Work past all of that and focus on the academic content.

Write for someone reviewing before an exam:

- Explain the main concepts, don't just list them. If the instructor worked through an example or a calculation, walk through the reasoning and keep the numbers. If they explained *why* something works, capture that explanation.
- Preserve the instructor's emphasis. Anything they repeated, said would be on the exam, or flagged as commonly misunderstood deserves prominence.
- Skip attendance, scheduling chatter, and technical difficulties unless they carry a deadline or a requirement.
- An action item is something the instructor assigned: work to hand in, a reading to do, a quiz or exam to sit. It has to be a thing the class was told to do, not a thing they were told to understand. Advice about what to study, what will be emphasized, or what students usually get wrong is not an action item; it belongs in the summary, where it is more useful anyway.
- Capture every assignment that clears that bar, dated or not. One the instructor set no deadline for is still an action item: leave its date empty rather than dropping it. A student who misses an assignment because it never reached this list has been failed by these notes.
- Do not invent action items, and do not invent deadlines. Return an empty list only when the instructor assigned nothing at all.
- Keep each action item's task to the errand alone, under ten words, starting with a verb and free of markdown. Context goes in its detail field. An assignment the instructor brought up two or three times is still one action item, worded identically each time, not one per mention.
- For each action item, resolve any relative deadline against the lecture date you are given: "next Thursday", "a week from today" and "before the exam" all become a real YYYY-MM-DD. If the instructor genuinely set no deadline, leave the date empty rather than inventing one.`;

const CALL_SYSTEM = `You summarize transcripts of client calls for the account team at a marketing agency. The people reading your notes were on the call or are covering for someone who was, and they will act on them.

The transcript comes from automatic speech recognition of a video call. It has no speaker labels, no punctuation guarantees, and will contain misheard words, crosstalk, small talk, and connection trouble. Work past all of that and focus on what was discussed and agreed.

Write for someone who has to follow through:

- Record what the client asked for, what they were told, and what was decided, in full sentences. If numbers, budgets, dates, or names came up, keep them exactly.
- Separate decisions from open questions. Something the client is still thinking about is not a decision.
- Preserve the client's emphasis. Anything they repeated, pushed back on, or said mattered to them deserves prominence.
- Skip small talk and technical difficulties unless they carry a commitment.
- Do not invent action items. If nobody committed to anything, return an empty list.
- Keep each action item's task to the errand alone, under ten words, starting with a verb and free of markdown. Context goes in its detail field. A commitment revisited later in the call is still one action item, worded identically each time, not one per mention.
- For each action item, resolve any relative deadline against the call date you are given: "by Friday", "end of the month" and "before the launch" all become a real YYYY-MM-DD. If no date was agreed, leave the date empty rather than inventing one.`;

/** The four-key object both profiles return, with their own field wording. */
function schemaFor(parts: {
  summary_md: string;
  topic_slug: string;
  term: string;
  definition: string;
  key_terms: string;
  task: string;
  detail: string;
  due_date: string;
  kind: string;
  action_items: string;
}): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      summary_md: { type: "string", description: parts.summary_md },
      topic_slug: { type: "string", description: parts.topic_slug },
      key_terms: {
        type: "array",
        description: parts.key_terms,
        items: {
          type: "object",
          properties: {
            term: { type: "string", description: parts.term },
            definition: { type: "string", description: parts.definition },
          },
          required: ["term", "definition"],
        },
      },
      action_items: {
        type: "array",
        description: parts.action_items,
        items: {
          type: "object",
          properties: {
            task: { type: "string", description: parts.task },
            detail: { type: "string", description: parts.detail },
            due_date: { type: "string", description: parts.due_date },
            kind: { type: "string", description: parts.kind },
          },
          required: ["task", "detail", "due_date", "kind"],
        },
      },
    },
    required: ["summary_md", "topic_slug", "key_terms", "action_items"],
  };
}

export const PROFILES: Record<Profile, SummarySpec> = {
  syllabus: {
    subjectLabel: "Course",
    kindLabel: "Lecture",
    system: LECTURE_SYSTEM,
    schema: schemaFor({
      summary_md:
        "The study summary as GitHub-flavored markdown. Use ## headings for major topics with prose paragraphs under them, explaining concepts in full sentences. Use lists only for genuinely enumerable things like the steps of a procedure.",
      topic_slug:
        "2 to 4 words naming what this lecture was actually about, in Title-Case-With-Hyphens, e.g. Job-Order-Costing or Statement-Of-Cash-Flows. Name the specific topic, never the course and never the word Lecture.",
      key_terms: "Terms a student would need defined to follow the lecture.",
      term: "The term as the instructor used it.",
      definition: "One line, in plain language.",
      task:
        "The errand itself, at most 10 words, phrased as an instruction to themselves: 'Read chapter 7', 'Submit the case memo'. Start with the verb. Plain text only: no markdown, no bullet or number prefix, no line breaks. Do not restate the due date, the course, or why it matters. Anything beyond the errand goes in detail. If the same assignment came up more than once in this lecture, word it the same way every time.",
      detail:
        "One sentence of context that did not fit the task: what to bring, which edition, how it will be graded, why it matters. Plain text, no markdown. Empty string if the task says it all.",
      due_date:
        "The due date as YYYY-MM-DD. Resolve anything relative against the lecture date given above, so 'next Thursday' becomes a real date. Use an empty string if the instructor gave no deadline at all. Never guess a date that was not stated or implied.",
      kind: "One of: assignment, reading, quiz, exam, project, other.",
      action_items:
        "Every assignment, reading, quiz, exam, or project the class was told to do, whether or not a deadline came with it. An undated assignment still belongs here, with an empty due_date. Work to hand in or sit, never advice about what to study: 'know the four forms' is a summary point, not an action item. Empty list only if nothing at all was assigned. Never invent one",
    }),
  },
  sous: {
    subjectLabel: "Client",
    kindLabel: "Call",
    system: CALL_SYSTEM,
    schema: schemaFor({
      summary_md:
        "The call notes as GitHub-flavored markdown. Use ## headings for each topic discussed, with prose under them covering what the client said, what was decided, and what is still open. Keep every number, date, and name the client gave. Use lists only for genuinely enumerable things like a set of requested changes.",
      topic_slug:
        "2 to 4 words naming what this call was actually about, in Title-Case-With-Hyphens, e.g. Q4-Ad-Budget or Website-Launch-Review. Name the subject, never the client and never the word Call.",
      key_terms:
        "Names, products, campaigns, tools, and figures the team needs to keep straight after this call.",
      term: "A name, product, campaign, tool, figure, or piece of jargon the client used, spelled the way they said it.",
      definition: "One line saying what it is and why it came up on the call.",
      task:
        "The errand itself, at most 10 words, phrased as an instruction to the team: 'Send the revised proposal', 'Get logo files from the client'. Start with the verb. Plain text only: no markdown, no bullet or number prefix, no line breaks. Do not restate the due date or why it matters. Anything beyond the errand goes in detail. If the same commitment came up more than once on the call, word it the same way every time.",
      detail:
        "One sentence of context that did not fit the task: who owns it, what it depends on, what the client asked for exactly. Plain text, no markdown. Empty string if the task says it all.",
      due_date:
        "The date it was promised for as YYYY-MM-DD. Resolve anything relative against the call date given above, so 'end of next week' becomes a real date. Use an empty string if no date was agreed. Never guess a date that was not stated or implied.",
      kind: "One of: deliverable, follow-up, meeting, approval, decision, other.",
      action_items:
        "Every commitment made on the call, by either side. Empty list if none were made. Never invent one.",
    }),
  },
};

export function profileSpec(name: string): SummarySpec | null {
  return PROFILES[name as Profile] ?? null;
}

/** The transcript framed for the model, labeled the way the profile sees it. */
export function userMessage(spec: SummarySpec, transcript: string, subject: string, date: string): string {
  return `${spec.subjectLabel}: ${subject}\nDate: ${date}\n\n${spec.kindLabel} transcript:\n\n${transcript.trim()}`;
}
