import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

import { getAnthropicClient, getAnthropicModel } from "./anthropic";
import { batchPaths, repoRoot, userPaths } from "./paths";
import { runNodeScript } from "./scripts";
import { generateTailoredPdf } from "./pdf";
import { markPdfGenerated } from "./pdfUpdate";

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

/** Local YYYY-MM-DD HH:mm for tracker / applications.md (ordering within same day). */
function nowTrackerDateTime() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Create the tracker file with a markdown table header if it doesn't exist.
 * merge-tracker.mjs requires this file or it silently exits without merging.
 */
async function ensureApplicationsTracker(log: (line: string) => void) {
  try {
    await fs.access(userPaths.applicationsMd);
    return; // exists, nothing to do
  } catch {
    // not found, seed it
  }
  await ensureDir(path.dirname(userPaths.applicationsMd));
  const header =
    "# Career-Ops Application Tracker\n\n" +
    "| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n" +
    "|---|------|---------|------|-------|--------|-----|--------|-------|\n";
  await fs.writeFile(userPaths.applicationsMd, header, "utf-8");
  log(`Seeded ${path.relative(repoRoot, userPaths.applicationsMd)} (tracker file did not exist)`);
}

async function nextReportNumber(): Promise<string> {
  await ensureDir(userPaths.reportsDir);
  const files = await fs.readdir(userPaths.reportsDir);
  let max = 0;
  for (const f of files) {
    const m = /^(\d{3})-/.exec(f);
    if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
  }
  return String(max + 1).padStart(3, "0");
}

function slugifyCompany(name: string) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function extractJdFromUrl(jdUrl: string, log: (l: string) => void) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    log(`Navigating to ${jdUrl}`);
    // `networkidle` hangs forever on sites with long-polling / analytics
    // beacons (LinkedIn is the canonical offender). DOM-content-loaded
    // is enough — most job listings inject body text on first paint.
    await page.goto(jdUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // Give SPA frameworks a beat to hydrate before we grab innerText.
    await page.waitForTimeout(2500);

    const text = await page.evaluate(() => {
      const d = (globalThis as any).document;
      return d?.body?.innerText || "";
    });
    const trimmed = text.replace(/\s+\n/g, "\n").trim();
    return trimmed;
  } finally {
    await browser.close();
  }
}

function extractCompanyAndRoleFromReport(md: string): { company: string; role: string } {
  // Prefer first header: "# Evaluación: Company — Role" or "# Evaluation: ..."
  const h1 = md.split("\n").find((l) => l.startsWith("# "));
  if (h1) {
    const s = h1.replace(/^#\s+/, "").trim();
    // Try split on em-dash or dash
    const parts = s.split("—").map((p) => p.trim());
    if (parts.length >= 2) {
      const left = parts[0]!;
      const right = parts.slice(1).join("—").trim();
      // remove "Evaluación:" prefix if present
      const company = left.replace(/^Evaluación:\s*/i, "").replace(/^Evaluation:\s*/i, "").trim();
      return { company, role: right };
    }
  }
  return { company: "company", role: "role" };
}

export async function runEvaluateJob(
  input: { jdText?: string; jdUrl?: string },
  ctx: { log: (line: string) => void; setProgress: (step: string, detail?: string) => void }
) {
  ctx.setProgress("Loading context");

  const [cv, shared, profileMd, profileYml] = await Promise.all([
    fs.readFile(userPaths.cv, "utf-8"),
    fs.readFile(userPaths.sharedMd, "utf-8"),
    fs.readFile(userPaths.profileMd, "utf-8"),
    fs.readFile(userPaths.profileYml, "utf-8")
  ]);

  let articleDigest = "";
  try {
    articleDigest = await fs.readFile(userPaths.articleDigest, "utf-8");
  } catch {
    // optional
  }

  let jd = input.jdText?.trim() || "";
  if (!jd && input.jdUrl) {
    ctx.setProgress("Extracting JD from URL");
    jd = await extractJdFromUrl(input.jdUrl, ctx.log);
  }
  if (!jd || jd.length < 200) {
    throw new Error("JD extraction failed or JD too short. Paste the JD text and retry.");
  }

  ctx.setProgress("Generating A–F evaluation");
  const client = getAnthropicClient();
  const model = getAnthropicModel();

  const today = todayYmd();

  const system = [
    "You are career-ops, a professional job fit analysis platform.",
    `Today's date is ${today}. ALWAYS use this date verbatim in the **Date:** field of the report header — never substitute a date from your training data.`,
    "Return ONLY clean markdown. No code fences. No preamble text before the heading.",
    "",
    "REPORT FORMATTING RULES (critical):",
    "- The report is rendered in a SaaS dashboard, not read as raw text.",
    "- Write like a product, not a chatbot. No filler phrases like 'Let me analyze...' or 'Here is your report'.",
    "- Use direct, decisive language: 'Strong match', 'Gap, mitigable', 'Not recommended unless...'",
    "- Every section must earn its space. Cut fluff, keep signal.",
    "",
    "HEADER FORMAT (exact):",
    "# Evaluation: {Company} — {Role}",
    "",
    "**URL:** {url if provided}",
    `**Date:** ${today}`,
    "**Archetype:** {detected archetype}",
    "**Score:** {X.X} / 5",
    "",
    "TABLE FORMATTING:",
    "- Use markdown tables for structured data (role summary, matches, gaps, comp, scores).",
    "- In the Match table, the Strength column MUST use exactly: ✅ Strong, ✅ Moderate, ⚠️ Gap, or ⚠️ Mitigable.",
    "- In the Gaps table, columns are: Gap | Blocker? | Adjacent Experience | Mitigation.",
    "",
    "SECTION HEADERS (exact, English):",
    "## A) Role Summary",
    "## B) Match with CV",
    "## C) Level & Strategy",
    "## D) Comp & Demand",
    "## E) Personalization Plan",
    "## F) Interview Prep",
    "## Scoring Summary",
    "",
    "BLOCK B IS SCOUT-FLAVORED (critical):",
    "- B plays the role of The Scout: a forensic talent analyst. Be ruthless, do not grade on a curve, quote specific cv.md lines for every gap, distinguish 'missing entirely' vs 'present but weak', never invent skills.",
    "- B MUST include these sub-sections in order, with these exact headings:",
    "  ### B.1 — Match Table   (Requirement | CV Evidence (quoted) | Strength)",
    "  ### B.2 — Fit Sub-Scores   (table: Keyword Match / Skills Alignment / Experience Relevance / Seniority Signal, each X/25, with reasoning column)",
    "  ### B.3 — Keyword Gap   (top 10 JD phrases missing/buried in CV. Columns: JD Phrase | Count in JD | Closest CV Reference (or 'none') | Impact (HIGH/MED/LOW))",
    "  ### B.4 — Skills Gap   (top 5 skills/tools/certs the JD requires that CV does not claim; mark each as credibly addable or honest gap)",
    "  ### B.5 — Positioning Gaps   (top 3 story disconnects between CV and role; quote offending CV lines)",
    "  ### B.6 — Gap Mitigation   (per gap: blocker? adjacent? portfolio? concrete mitigation)",
    "  ### B.7 — Ruthless Verdict   (one paragraph. If CV is wrong / under / over for this role, say it.)",
    "- The B.3 Keyword Gap table is consumed downstream by the PDF generation step — be specific and quote real JD phrases verbatim.",
    "",
    "SCORING SUMMARY TABLE (must appear at the end):",
    "| Dimension | Score | Notes |",
    "Dimensions (in this order): Keyword Match, Skills Alignment, Experience Relevance, Seniority Signal, North Star alignment, Comp, Cultural signals.",
    "Each score is X.X out of 5. The first four are the B.2 sub-scores normalized from /25 to /5 (divide by 5).",
    "",
    "TONE: professional analyst delivering a brief to a hiring committee. Concise, structured, opinionated."
  ].join("\n");

  // Everything except the JD is identical across every evaluation, so it gets
  // a cache breakpoint. Anthropic caches the prefix up to and including the
  // marked block: back-to-back evals in a session reuse it (5-min window,
  // refreshed on each hit), cutting latency + ~90% of the input-token cost.
  const staticContext = [
    "## System context (_shared.md)",
    shared,
    "\n## User profile overrides (_profile.md)",
    profileMd,
    "\n## Candidate profile (profile.yml)",
    profileYml,
    "\n## Candidate CV (cv.md)",
    cv,
    articleDigest ? "\n## Article digest (optional)\n" + articleDigest : "",
    "\n## Mode instructions (oferta.md)",
    await fs.readFile(path.join(repoRoot, "modes", "oferta.md"), "utf-8"),
  ].filter(Boolean).join("\n\n");

  const jobBlock = [
    "## Job description",
    input.jdUrl ? `URL: ${input.jdUrl}` : "",
    jd
  ].filter(Boolean).join("\n\n");

  const resp = await client.messages.create({
    model,
    max_tokens: 8192,
    temperature: 0.2,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{
      role: "user",
      content: [
        { type: "text", text: staticContext, cache_control: { type: "ephemeral" } },
        { type: "text", text: jobBlock },
      ],
    }],
  });

  let reportMd = resp.content
    .map((b) => ("text" in b ? b.text : ""))
    .join("")
    .trim();

  // Strip markdown code fences the model sometimes wraps output in
  reportMd = reportMd.replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();

  // Backstop: rewrite the **Date:** line to today regardless of what the LLM emitted
  // (models drift toward training-cutoff dates if they ignore the system prompt).
  reportMd = reportMd.replace(/^\*\*Date:\*\*\s*[^\n]*$/m, `**Date:** ${today}`);

  // If there's preamble text before the first heading, extract from the heading onward
  if (!reportMd.startsWith("#")) {
    const headingIdx = reportMd.indexOf("\n#");
    if (headingIdx !== -1) {
      reportMd = reportMd.slice(headingIdx + 1).trim();
    }
  }

  if (!reportMd.startsWith("#")) {
    ctx.log("Model output did not start with '#'. First 300 chars:");
    ctx.log(reportMd.slice(0, 300));
    throw new Error("Model output did not look like a markdown report.");
  }

  const num = await nextReportNumber();
  const ymd = todayYmd();
  const trackerWhen = nowTrackerDateTime();
  const { company, role } = extractCompanyAndRoleFromReport(reportMd);
  const slug = slugifyCompany(company) || "company";
  const reportFilename = `${num}-${slug}-${ymd}.md`;
  const reportRel = `reports/${reportFilename}`;
  const reportPath = path.join(userPaths.reportsDir, reportFilename);

  ctx.setProgress("Writing report", reportRel);
  await ensureDir(userPaths.reportsDir);
  await fs.writeFile(reportPath, reportMd, "utf-8");

  ctx.setProgress("Writing tracker addition TSV");
  await ensureDir(batchPaths.additionsDir);
  const tsvPath = path.join(batchPaths.additionsDir, `${num}-${slug}.tsv`);
  const scoreMatch = reportMd.match(/\*\*Score:\*\*\s*([0-9.]+)\s*\/\s*5/i);
  const score = scoreMatch?.[1] ? `${Number.parseFloat(scoreMatch[1]).toFixed(1)}/5` : "0.0/5";
  const status = "Evaluated";
  const pdfEmoji = "❌";
  const notes = "Web dashboard evaluation";
  const tsvLine = [num, trackerWhen, company, role, status, score, pdfEmoji, `[${num}](${reportRel})`, notes].join("\t");
  await fs.writeFile(tsvPath, tsvLine, "utf-8");

  // Auto-seed data/applications.md if missing. The merge script bails when
  // it can't find the tracker file, leaving evals invisible to the dashboard.
  await ensureApplicationsTracker(ctx.log);

  ctx.setProgress("Merging tracker");
  await runNodeScript("merge-tracker.mjs", [], { log: ctx.log });

  ctx.setProgress("Generating tailored PDF");
  const pdf = await generateTailoredPdf({
    company,
    slug,
    num,
    jd,
    reportRel,
    reportPath,
    log: ctx.log,
    setProgress: ctx.setProgress
  });
  await markPdfGenerated(num);
  ctx.log(`PDF generated: ${pdf.pdfPath}`);

  // Append the Screener verdict line to the report so the dashboard surfaces it
  // next to the eval (the PDF column in the tracker only shows ✅/❌).
  if (pdf.screenerVerdict) {
    const gaps = pdf.screenerDomainGaps ?? [];
    // A FAIL driven only by genuine experience gaps (nothing left to truthfully
    // fix) is a fit signal, not a defect — say so plainly so the line isn't read
    // as "the PDF is broken".
    const gapLine = gaps.length
      ? `\n**Domain gaps (cannot be added without fabricating — weigh before applying):** ${gaps.join("; ")}`
      : "";
    const appendLine = `\n\n**ATS Screener:** ${pdf.screenerVerdict} (${pdf.screenerAttempts} attempt${pdf.screenerAttempts === 1 ? "" : "s"})${pdf.screenerPath ? ` — see \`${path.relative(repoRoot, pdf.screenerPath).replace(/\\/g, "/")}\`` : ""}${gapLine}\n`;
    try {
      await fs.appendFile(reportPath, appendLine, "utf-8");
    } catch (e) {
      ctx.log(`Could not append Screener verdict to report: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  ctx.setProgress("Done");
  return { reportRel, reportPath, tsvPath, pdf };
}

