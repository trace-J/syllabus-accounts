#!/usr/bin/env node
/**
 * What each transcription provider actually served, and what it cost.
 *
 * `wrangler d1 execute --json` answers the question and buries it: two rows
 * of data inside thirty lines of result metadata. This reads that and prints
 * the table, because a number nobody can read is the same as a number nobody
 * has.
 *
 * The dollars are an ESTIMATE from published per-hour rates, not a bill. They
 * exist because "5.6 hours on openai" is not the question anybody is asking;
 * "that month cost $1.01 instead of $0.62" is. Keep RATES in step with the
 * providers in src/proxy.ts, and check a real invoice before trusting a
 * forecast built on them.
 */

/** $/audio hour, from each provider's published pricing. */
const RATES = { groq: 0.111, openai: 0.18 };

const SQL = `SELECT period, provider, COUNT(*) AS calls, SUM(units) AS seconds
               FROM usage
              WHERE kind = 'transcribe' AND state = 'final'
              GROUP BY period, provider
              ORDER BY period DESC, seconds DESC`;

// Imported inside the function, not at the top: the tests import render()
// from here, and they run in the Workers pool, which has no child_process.
// A static import would fail the whole module before a single row is drawn.
async function query() {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "syllabus-accounts", "--remote", "--json", "--command", SQL],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  // --json still prints wrangler's banner on some versions, so find the JSON
  // rather than assuming the whole of stdout is it.
  const start = out.indexOf("[");
  if (start < 0) throw new Error("no JSON in wrangler output");
  return JSON.parse(out.slice(start))[0].results ?? [];
}

function money(n) {
  return "$" + n.toFixed(2);
}

/**
 * The rows as a table. Pure, so the arithmetic that decides what a month cost
 * can be tested without a database or a network.
 */
export function render(rows) {
  if (rows.length === 0) return "No settled transcriptions yet.";

  const out = [];
  // Grouped by period so each month totals on its own and the shares mean
  // something; a share across all time would answer nobody's question.
  const periods = new Map();
  for (const r of rows) {
    if (!periods.has(r.period)) periods.set(r.period, []);
    periods.get(r.period).push(r);
  }

  for (const [period, group] of periods) {
    const totalSeconds = group.reduce((n, r) => n + r.seconds, 0);
    out.push(`\n  ${period}`);
    out.push("  " + "provider".padEnd(14) + "calls".padStart(7) + "hours".padStart(9) + "share".padStart(8) + "est. cost".padStart(12));
    out.push("  " + "-".repeat(50));

    let cost = 0;
    let priced = true;
    for (const r of group) {
      const name = r.provider || "unrecorded";
      const hours = r.seconds / 3600;
      const share = totalSeconds ? (r.seconds / totalSeconds) * 100 : 0;
      const rate = RATES[r.provider];
      // An unrecorded row predates the provider column. Pricing it at either
      // provider's rate would be inventing the very number this table exists
      // to stop guessing at.
      if (rate === undefined) priced = false;
      else cost += hours * rate;
      out.push(
        "  " + name.padEnd(14) +
          String(r.calls).padStart(7) +
          hours.toFixed(2).padStart(9) +
          (share.toFixed(0) + "%").padStart(8) +
          (rate === undefined ? "unknown" : money(hours * rate)).padStart(12),
      );
    }

    const hours = totalSeconds / 3600;
    out.push("  " + "-".repeat(50));
    out.push(
      "  " + "total".padEnd(14) +
        String(group.reduce((n, r) => n + r.calls, 0)).padStart(7) +
        hours.toFixed(2).padStart(9) +
        "".padStart(8) +
        (priced ? money(cost) : "\u2265 " + money(cost)).padStart(12),
    );
    if (!priced) out.push("  (\u2265 because unrecorded rows predate the provider column and are not priced)");

    // The line the whole thing is for: what an hour of lecture actually cost,
    // against what a forecast on Groq alone would have assumed.
    if (priced && hours > 0) {
      const actual = cost / hours;
      out.push(`\n  Effective: ${money(actual)}/audio hour (all-Groq would be ${money(RATES.groq)}, all-OpenAI ${money(RATES.openai)})`);
    }
  }
  return out.join("\n") + "\n";
}

// Run only as a CLI, so importing this for a test does not hit the network.
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(render(await query()));
}
