import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { getAnthropicClient, getAnthropicModel } from "./anthropic";
import { repoRoot } from "./paths";

const execFileAsync = promisify(execFile);

export type ScreenerVerdict = "PASS" | "FAIL" | "UNKNOWN";

export type ScreenerResult = {
  verdict: ScreenerVerdict;
  actionList: string[];
  /** Genuine experience gaps the candidate cannot claim without fabricating.
   *  Advisory only — these never cause a FAIL. */
  domainGaps: string[];
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
  /** The candidate's real CV — the source of truth for defect-vs-gap classification. */
  cv: string;
  log: (line: string) => void;
}): Promise<ScreenerResult> {
  const { parts, jd, scoutGapSection, cv, log } = input;

  const screenerMode = await fs.readFile(
    path.join(repoRoot, "modes", "screener.md"),
    "utf-8",
  );

  const client = getAnthropicClient();
  // The pre-render gate makes a nuanced DEFECT-vs-GAP judgment and produces the
  // verdict the user trusts before submitting — it runs on the main (Sonnet)
  // model for consistency. (The post-render extract screener below is a simpler
  // structural check and stays on the cheaper screener model.)
  const model = getAnthropicModel();

  const today = new Date().toISOString().slice(0, 10);

  const system = [
    "You are The Screener — an Applicant Tracking System (ATS) trained to evaluate whether a resume passes through to a human recruiter.",
    "You are adversarial about DEFECTS — but you must NEVER pressure the candidate to fabricate experience they do not have.",
    "",
    `Today's date is ${today}. Use this as the reference point for any date-related check. Do NOT flag dates that are at or before ${today} as "future-dated" — those are valid past or present dates.`,
    "",
    "CORE DISTINCTION (the single most important rule):",
    "You are given the candidate's REAL CV (cv.md). For every required JD keyword that is missing or weak in the Recruiter output, classify it as exactly ONE of:",
    "- DEFECT (placeable): the underlying experience/skill IS present somewhere in cv.md or the Recruiter parts, but it is absent from the first half-page, buried deep, or hidden in a 'Familiar With'/disclaimer bucket. The Recruiter can fix this TRUTHFULLY by surfacing real evidence. DEFECTS drive the verdict.",
    "- GAP (genuine): the experience is NOT in cv.md at all — the candidate genuinely lacks it. Adding it would be FABRICATION. A genuine gap is NOT a defect and must NEVER cause a FAIL. Record it under '## Domain Gaps' so the human can decide whether the role is worth applying to.",
    "When you are unsure whether the candidate truly has the experience, treat it as a GAP. Never push fabrication.",
    "",
    "OUTPUT RULES (strict):",
    "- Return ONLY clean markdown — no code fences, no preamble.",
    "- Open with the verdict on its own line: either `**VERDICT: PASS**` or `**VERDICT: FAIL**`. Never use 'maybe'.",
    "- Then these sections in this exact order:",
    "  ## Formatting Issues",
    "  ## Keyword Density Check",
    "  ## Structural Issues",
    "  ## Domain Gaps",
    "  ## Action List",
    "- The Keyword Density Check MUST be a markdown table with the columns: Keyword | Impact | In CV? | In First Half-Page? | Classification. Classification is one of DEFECT, GAP, or OK.",
    "- Domain Gaps MUST be a bullet list of the genuine gaps (each: the JD keyword + one phrase on why it is a true gap, e.g. 'no healthcare/PHI experience anywhere in cv.md'). If there are none, write exactly 'None'.",
    "- The Action List MUST be a numbered list of DEFECT fixes ONLY, ranked by impact. Each item quotes the offending field and gives an exact replacement built ONLY from experience already present in cv.md. If a 'fix' would require asserting experience cv.md does not support, DO NOT write it — it belongs in Domain Gaps.",
    "",
    "VERDICT RULES:",
    "- FAIL only if one or more DEFECTS remain:",
    "  - a HIGH-impact keyword that IS supported by cv.md but is missing from the first half-page (summaryText, competencies, or first bullet of the most recent role);",
    "  - any keyword stuffed (3+ instances within ~5 lines) — INCLUDING a personal-brand phrase the Recruiter coined and repeated across tagline + summary + competencies + a bullet;",
    "  - a vague duty bullet without specifics (e.g., 'improved processes', 'drove results');",
    "  - any role with zero bullets;",
    "  - an internal contradiction (two fields stating different numbers or conflicting claims).",
    "- PASS if no DEFECTS remain — EVEN IF Domain Gaps exist. Genuine gaps NEVER cause a FAIL.",
    "- Match like a real ATS: stem and accept close variants ('strategy'/'strategies', 'design token'/'design tokens'). Do NOT FAIL over singular-vs-plural or exact-verbatim-token mismatches.",
    "",
    "NEVER praise the resume. NEVER invent ATS rules outside this spec. NEVER instruct fabrication.",
  ].join("\n");

  // cv.md + screener.md are identical across every eval → cache them. The CV is
  // the source of truth the Screener uses to classify each missing keyword as a
  // fixable DEFECT (present in CV, just buried) vs a genuine GAP (not in CV).
  const modeBlock = [
    "## Candidate CV (cv.md) — the source of truth for what the candidate ACTUALLY has",
    cv,
    "\n## Mode instructions (screener.md)",
    screenerMode,
  ].join("\n\n");
  const perEvalBlock = [
    "## Scout gap analysis (from evaluation report — these are the keywords the Recruiter was supposed to weave in)",
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
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{
      role: "user",
      content: [
        { type: "text", text: modeBlock, cache_control: { type: "ephemeral" } },
        { type: "text", text: perEvalBlock },
      ],
    }],
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
  const domainGaps = extractBulletSection(md, /^##\s*Domain Gaps/im);

  log(`Screener verdict: ${verdict} — ${actionList.length} action items, ${domainGaps.length} domain gaps`);

  return { verdict, actionList, domainGaps, markdown: md };
}

/** Collect bullet items under a markdown heading, stopping at the next `##`.
 *  Drops a lone "None" placeholder. */
function extractBulletSection(md: string, heading: RegExp): string[] {
  const idx = md.search(heading);
  if (idx === -1) return [];
  const lines = md.slice(idx).split("\n").slice(1);
  const items: string[] = [];
  for (const raw of lines) {
    if (/^##\s/.test(raw)) break;
    const m = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (m && m[1] && !/^none\.?$/i.test(m[1].trim())) items.push(m[1].trim());
  }
  return items;
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

/**
 * Extract text from a rendered PDF using the `pdftotext` binary. This is the
 * same tool most ATS parsers rely on (or a close cousin), so the output is a
 * faithful approximation of what a real recruiter-side parser will see.
 *
 * Returns null when the binary is unavailable on the host — the caller should
 * treat that as "extract screener skipped" rather than a hard failure, because
 * not every dev machine ships with poppler-utils.
 */
export async function extractPdfText(pdfPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("pdftotext", [pdfPath, "-"], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout;
  } catch {
    return null;
  }
}

export type ExtractedTextScreenerResult = {
  verdict: ScreenerVerdict;
  markdown: string;
  /** Section headers detected, in extraction order. Used for downstream display. */
  detectedSections: string[];
  /** Job-entry count parsed from the EXPERIENCE section of the extract. */
  detectedJobCount: number;
};

/**
 * Stage 3.5 of the resume stack — the post-render extract screener.
 *
 * Runs AFTER the PDF has been rendered, against the actual text a real ATS
 * parser would see. Catches positional / layout failures that the JSON-parts
 * screener cannot see:
 *  - Decorative sidebar content leaking into the parser-visible text flow
 *  - Phantom job entries from interleaved sidebar cards
 *  - Section reordering accidentally hiding key blocks
 *  - Two-column interleaving when Playwright pagination misbehaves
 *
 * Verdict is informational. A FAIL here does NOT trigger a Recruiter retry
 * (regenerating the JSON parts wouldn't fix template/layout issues). It IS
 * surfaced in the eval report so the user knows the rendered PDF needs a
 * manual look before sending.
 */
export async function runExtractedTextScreener(input: {
  pdfText: string;
  expectedJobCount: number;
  expectedSections: string[];
  log: (line: string) => void;
}): Promise<ExtractedTextScreenerResult> {
  const { pdfText, expectedJobCount, expectedSections, log } = input;

  const client = getAnthropicClient();
  // Runs on the main model too — Haiku hallucinated phantom "interleaving" from
  // well-formed bullets, so this structural check needs the same consistency as
  // the pre-render gate.
  const model = getAnthropicModel();

  const system = [
    "You are The Extract Screener — the final gate that inspects the actual text an ATS parser will read from a rendered resume PDF.",
    "You are adversarial. You assume the parser is unsophisticated and looks for reasons to fail.",
    "",
    "INPUTS YOU RECEIVE:",
    "- The full pdftotext output of the rendered resume PDF.",
    "- Ground-truth metadata: expectedJobCount (how many real work-experience entries should exist) and expectedSections (the section headers the resume should contain).",
    "",
    "WHAT TO CHECK:",
    "1. **Section coverage** — every expectedSection must appear, spelled recognizably (case-insensitive, letter-spaced renderings like 'E D U C A T I O N' are acceptable, decorative variants are not).",
    "2. **Phantom sections** — flag any section-header-looking lines in the extract that are NOT standard ATS sections (e.g. 'MOST PROUD OF', 'UX PHILOSOPHY', 'A DAY IN THE LIFE', 'METHODOLOGIES', 'STRENGTHS / ABILITIES'). Their presence indicates sidebar content leaked into parser-visible text.",
    "3. **Job-count check** — count company+date-range pairs inside the EXPERIENCE block. Compare against expectedJobCount. If the extracted count is GREATER than expected, that means non-experience content (project entries, sidebar cards, time-slot labels) is being parsed as phantom job entries.",
    "4. **Section order** — confirm Profile/Summary appears before Experience, and Experience appears before Education/Skills/Projects. Order matters to many ATS systems.",
    "5. **Interleaving** — look for evidence of two columns of text extracted row-by-row (sentences that don't make grammatical sense; fragments from clearly-different content adjacent without a section break). This is the canonical sidebar-leak symptom.",
    "",
    "OUTPUT RULES (strict):",
    "- Return ONLY clean markdown. No code fences. No preamble.",
    "- Open with the verdict on its own line: `**VERDICT: PASS**` or `**VERDICT: FAIL**`.",
    "- Then in this exact order:",
    "  ## Detected Sections",
    "  ## Detected Job Count",
    "  ## Phantom Sections",
    "  ## Interleaving Evidence",
    "  ## Action List",
    "- The Detected Sections section MUST emit a markdown table of all section headers found, in extraction order, marked as 'expected' or 'phantom'.",
    "- The Detected Job Count section MUST emit `Found: N · Expected: M · Verdict: MATCH | OVER | UNDER`.",
    "- The Action List is the user's punch list for fixing the template — concrete, ranked, one item per fix.",
    "",
    "VERDICT RULES:",
    "- PASS only if: no phantom sections, job count matches exactly, no interleaving evidence, all expected sections present.",
    "- Otherwise FAIL.",
  ].join("\n");

  const userPrompt = [
    "## Ground truth",
    `Expected job count: ${expectedJobCount}`,
    `Expected sections: ${expectedSections.join(", ")}`,
    "",
    "## Extracted text from the rendered PDF (what an ATS will see)",
    "```text",
    pdfText.slice(0, 25000),
    "```",
  ].join("\n");

  const resp = await client.messages.create({
    model,
    max_tokens: 3000,
    temperature: 0.1,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userPrompt }],
  });

  let md = resp.content.map((b) => ("text" in b ? b.text : "")).join("").trim();
  md = md.replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();

  const verdict: ScreenerVerdict = /\*\*VERDICT:\s*PASS\*\*/i.test(md)
    ? "PASS"
    : /\*\*VERDICT:\s*FAIL\*\*/i.test(md)
    ? "FAIL"
    : "UNKNOWN";

  // Parse the Detected Job Count line for downstream surfacing.
  const jobCountMatch = md.match(/Found:\s*(\d+)/i);
  const detectedJobCount = jobCountMatch?.[1] ? Number.parseInt(jobCountMatch[1], 10) : -1;

  // Extract just the section names from the Detected Sections table.
  const detectedSections: string[] = [];
  const sectionsBlockMatch = md.match(/##\s*Detected Sections[\s\S]*?(?=\n##\s|$)/i);
  if (sectionsBlockMatch) {
    const rows = sectionsBlockMatch[0].split("\n").filter((l) => /^\|/.test(l) && !/\|---/.test(l) && !/^\|\s*Section/i.test(l));
    for (const row of rows) {
      const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
      if (cells[0]) detectedSections.push(cells[0]);
    }
  }

  log(`Extract Screener verdict: ${verdict} · detected ${detectedJobCount} jobs · ${detectedSections.length} sections`);

  return { verdict, markdown: md, detectedSections, detectedJobCount };
}
