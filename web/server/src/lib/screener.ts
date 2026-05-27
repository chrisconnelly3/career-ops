import fs from "node:fs/promises";
import path from "node:path";

import { getAnthropicClient, getAnthropicModel } from "./anthropic";
import { repoRoot } from "./paths";

export type ScreenerVerdict = "PASS" | "FAIL" | "UNKNOWN";

export type ScreenerResult = {
  verdict: ScreenerVerdict;
  actionList: string[];
  markdown: string;
};

/**
 * Stage 3 of the 4-prompt resume stack: the ATS gatekeeper.
 * Runs after Recruiter parts are produced, before the PDF is rendered.
 *
 * Receives the Recruiter's JSON parts (already-rewritten CV content), the JD,
 * and the Scout's gap section (block B of the eval report) so it can verify
 * the HIGH/MED keywords actually landed in the right places.
 *
 * Returns a structured verdict + ranked action list. The action list is fed
 * back into the Recruiter on retry.
 */
export async function runScreener(input: {
  parts: unknown;
  jd: string;
  scoutGapSection: string;
  log: (line: string) => void;
}): Promise<ScreenerResult> {
  const { parts, jd, scoutGapSection, log } = input;

  const screenerMode = await fs.readFile(
    path.join(repoRoot, "modes", "screener.md"),
    "utf-8",
  );

  const client = getAnthropicClient();
  const model = getAnthropicModel();

  const today = new Date().toISOString().slice(0, 10);

  const system = [
    "You are The Screener — an Applicant Tracking System (ATS) trained to evaluate whether a resume passes through to a human recruiter.",
    "You are adversarial. You are looking for reasons to filter this resume OUT.",
    "",
    `Today's date is ${today}. Use this as the reference point for any date-related check. Do NOT flag dates that are at or before ${today} as "future-dated" — those are valid past or present dates.`,
    "",
    "OUTPUT RULES (strict):",
    "- Return ONLY clean markdown — no code fences, no preamble.",
    "- Open with the verdict on its own line: either `**VERDICT: PASS**` or `**VERDICT: FAIL**`. Never use 'maybe'.",
    "- Then the four mandatory sections in this exact order:",
    "  ## Formatting Issues",
    "  ## Keyword Density Check",
    "  ## Structural Issues",
    "  ## Action List",
    "- The Keyword Density Check MUST be a markdown table with the columns: Keyword | Impact | In First Half-Page? | Anywhere? | Stuffed?",
    "- The Action List MUST be a numbered list, ranked by impact. Each item quotes the offending CV field and provides an exact replacement string.",
    "",
    "VERDICT RULES:",
    "- FAIL if any HIGH-impact keyword from the Scout gap list is missing from the first half-page (summaryText, competencies, or first bullet of the most recent role).",
    "- FAIL if any keyword is stuffed (3+ instances within 5 lines).",
    "- FAIL if any bullet is a vague duty without specifics (e.g., 'improved processes', 'drove results').",
    "- FAIL if any role has zero bullets.",
    "- Otherwise PASS.",
    "",
    "NEVER praise the resume. NEVER invent ATS rules outside this spec.",
  ].join("\n");

  const userPrompt = [
    "## Mode instructions (screener.md)",
    screenerMode,
    "\n## Scout gap analysis (from evaluation report — these are the keywords the Recruiter was supposed to weave in)",
    scoutGapSection || "(no Scout gap section was provided — verify against the JD directly)",
    "\n## Job description",
    jd,
    "\n## Recruiter output (JSON parts to verify)",
    "```json",
    JSON.stringify(parts, null, 2),
    "```",
  ].join("\n\n");

  const resp = await client.messages.create({
    model,
    max_tokens: 4000,
    temperature: 0.1,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });

  let md = resp.content
    .map((b) => ("text" in b ? b.text : ""))
    .join("")
    .trim();
  md = md
    .replace(/^```(?:markdown|md)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();

  const verdict: ScreenerVerdict = /\*\*VERDICT:\s*PASS\*\*/i.test(md)
    ? "PASS"
    : /\*\*VERDICT:\s*FAIL\*\*/i.test(md)
    ? "FAIL"
    : "UNKNOWN";

  const actionList = extractActionList(md);

  log(`Screener verdict: ${verdict} — ${actionList.length} action items`);

  return { verdict, actionList, markdown: md };
}

function extractActionList(md: string): string[] {
  const idx = md.search(/^##\s*Action List/im);
  if (idx === -1) return [];
  const tail = md.slice(idx);
  const lines = tail.split("\n").slice(1);
  const items: string[] = [];
  let current = "";
  for (const raw of lines) {
    if (/^##\s/.test(raw)) break;
    const m = /^\s*\d+\.\s+(.*)$/.exec(raw);
    if (m) {
      if (current) items.push(current.trim());
      current = m[1] ?? "";
    } else if (current) {
      current += " " + raw.trim();
    }
  }
  if (current.trim()) items.push(current.trim());
  return items.filter(Boolean);
}
