import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs ops script, no types
import { render } from "../scripts/split.mjs";

/** One hour of audio, in the seconds the usage table stores. */
const HOUR = 3600;

describe("the transcription split, as a person reads it", () => {
  it("prices each provider at its own rate and says what the hour really cost", () => {
    const out = render([
      { period: "2026-10", provider: "groq", calls: 90, seconds: 9 * HOUR },
      { period: "2026-10", provider: "openai", calls: 10, seconds: 1 * HOUR },
    ]);
    // 9h groq at $0.111 = $0.999, 1h openai at $0.18 = $0.18, total $1.18.
    expect(out).toContain("$1.18");
    // The number the table exists for: the blend, not either list price.
    expect(out).toContain("Effective: $0.12/audio hour");
    expect(out).toContain("90%");
    expect(out).toContain("10%");
  });

  it("refuses to price rows from before the provider was recorded", () => {
    const out = render([
      { period: "2026-09", provider: "", calls: 50, seconds: 5 * HOUR },
      { period: "2026-09", provider: "groq", calls: 1, seconds: 1 * HOUR },
    ]);
    expect(out).toContain("unrecorded");
    expect(out).toContain("unknown");
    // A floor, not a total: guessing a rate for those rows is the one thing
    // this table must not do.
    expect(out).toContain("≥ $0.11");
    expect(out).not.toContain("Effective:");
  });

  it("keeps months apart, so one busy month cannot flatter another", () => {
    const out = render([
      { period: "2026-10", provider: "groq", calls: 1, seconds: 1 * HOUR },
      { period: "2026-09", provider: "openai", calls: 1, seconds: 1 * HOUR },
    ]);
    expect(out).toContain("2026-10");
    expect(out).toContain("2026-09");
    expect(out).toContain("Effective: $0.11/audio hour");
    expect(out).toContain("Effective: $0.18/audio hour");
  });

  it("says so plainly when nothing has been transcribed", () => {
    expect(render([])).toBe("No settled transcriptions yet.");
  });
});
