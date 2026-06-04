import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";
import YAML from "yaml";

import { getAnthropicClient, getAnthropicModel } from "./anthropic";
import { repoRoot, userPaths } from "./paths";
import { runNodeScript } from "./scripts";
import { runScreener, type ScreenerResult } from "./screener";

function safeReplaceAll(s: string, map: Record<string, string>) {
  let out = s;
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  return out;
}

// Per-field hard caps. Used by both the Zod schema and the pre-parse sanitizer
// so the LLM's verbosity drift can't take down an entire eval.
const LIMITS = {
  tagline: 160,
  proudTitle: 50,
  proudDesc: 320,
  strength: 60,
  methodName: 50,
  dayTime: 24,
  dayActivity: 120,
  philQuote: 400,
  philAuthor: 80,
  competency: 80,
} as const;

const PdfPartsSchema = z.object({
  lang: z.enum(["en", "es"]).default("en"),
  brandPrimary: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#1a1a2e"),
  brandAccent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#2d6a6a"),
  tagline: z.string().min(4).max(LIMITS.tagline),
  summaryText: z.string().min(10),
  competencies: z.array(z.string().min(2).max(LIMITS.competency)).min(4).max(12),
  experienceHtml: z.string().min(10),
  projectsHtml: z.string().min(0).default(""),
  educationHtml: z.string().min(0).default(""),
  certificationsHtml: z.string().min(0).default(""),
  skillsHtml: z.string().min(10),
  lifePhilosophy: z
    .object({
      quote: z.string().min(8).max(LIMITS.philQuote),
      author: z.string().min(2).max(LIMITS.philAuthor),
    })
    .nullable()
    .default(null),
  mostProudOf: z
    .array(
      z.object({
        title: z.string().min(2).max(LIMITS.proudTitle),
        description: z.string().min(8).max(LIMITS.proudDesc),
      }),
    )
    .max(4)
    .default([]),
  strengths: z.array(z.string().min(2).max(LIMITS.strength)).max(8).default([]),
  methodologies: z
    .array(
      z.object({
        name: z.string().min(1).max(LIMITS.methodName),
        level: z.number().int().min(1).max(4),
      }),
    )
    .max(6)
    .default([]),
  dayInTheLife: z
    .array(z.object({ time: z.string().min(1).max(LIMITS.dayTime), activity: z.string().min(2).max(LIMITS.dayActivity) }))
    .max(6)
    .default([]),
});

/**
 * Truncate any string field that exceeds the per-field cap, in place, before
 * we hand the JSON to Zod. The LLM occasionally writes verbose Most Proud Of
 * descriptions or taglines, and we'd rather render the slightly-truncated
 * version than fail the entire eval.
 */
function truncate(s: unknown, max: number): unknown {
  if (typeof s !== "string") return s;
  if (s.length <= max) return s;
  // Truncate cleanly at the last word boundary within the limit if possible,
  // then trim trailing punctuation/whitespace, then ensure terminal period.
  const slice = s.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > max - 40 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[\s,;:—–-]+$/, "").replace(/\.+$/, "") + ".";
}

function sanitizePdfParts(raw: any): any {
  if (!raw || typeof raw !== "object") return raw;
  if (typeof raw.tagline === "string") raw.tagline = truncate(raw.tagline, LIMITS.tagline);
  if (Array.isArray(raw.competencies)) {
    raw.competencies = raw.competencies.map((c: unknown) => truncate(c, LIMITS.competency));
  }
  if (Array.isArray(raw.mostProudOf)) {
    for (const item of raw.mostProudOf) {
      if (item && typeof item === "object") {
        item.title = truncate(item.title, LIMITS.proudTitle);
        item.description = truncate(item.description, LIMITS.proudDesc);
      }
    }
  }
  if (Array.isArray(raw.strengths)) {
    raw.strengths = raw.strengths.map((s: unknown) => truncate(s, LIMITS.strength));
  }
  if (Array.isArray(raw.methodologies)) {
    for (const m of raw.methodologies) {
      if (m && typeof m === "object") m.name = truncate(m.name, LIMITS.methodName);
    }
  }
  if (Array.isArray(raw.dayInTheLife)) {
    for (const d of raw.dayInTheLife) {
      if (d && typeof d === "object") {
        d.time = truncate(d.time, LIMITS.dayTime);
        d.activity = truncate(d.activity, LIMITS.dayActivity);
      }
    }
  }
  if (raw.lifePhilosophy && typeof raw.lifePhilosophy === "object") {
    raw.lifePhilosophy.quote = truncate(raw.lifePhilosophy.quote, LIMITS.philQuote);
    raw.lifePhilosophy.author = truncate(raw.lifePhilosophy.author, LIMITS.philAuthor);
  }
  return raw;
}

type PdfParts = z.infer<typeof PdfPartsSchema>;

export async function generateTailoredPdf(params: {
  company: string;
  slug: string;
  num: string;
  jd: string;
  reportRel: string;
  reportPath?: string;
  log: (l: string) => void;
  setProgress: (s: string, d?: string) => void;
}) {
  const { company, slug, num, jd, log, setProgress, reportPath } = params;

  const [cv, profileYml, profileMd, sharedMd, pdfMode, template] = await Promise.all([
    fs.readFile(userPaths.cv, "utf-8"),
    fs.readFile(userPaths.profileYml, "utf-8"),
    fs.readFile(userPaths.profileMd, "utf-8"),
    fs.readFile(userPaths.sharedMd, "utf-8"),
    fs.readFile(path.join(repoRoot, "modes", "pdf.md"), "utf-8"),
    fs.readFile(path.join(repoRoot, "templates", "cv-template.html"), "utf-8"),
  ]);

  let scoutGapSection = "";
  if (reportPath) {
    try {
      const reportMd = await fs.readFile(reportPath, "utf-8");
      scoutGapSection = extractScoutGapSection(reportMd);
      if (scoutGapSection) {
        log(`Loaded Scout gap section from ${path.basename(reportPath)} (${scoutGapSection.length} chars)`);
      } else {
        log(`Report ${path.basename(reportPath)} had no parseable Scout gap section — proceeding without it`);
      }
    } catch (e) {
      log(`Could not read report for Scout gap injection: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const profile = YAML.parse(profileYml) as any;
  const candidate = profile?.candidate ?? {};
  const fullName = candidate.full_name || "Candidate";
  const portfolioUrl: string = candidate.portfolio_url || candidate.portfolio || "";
  const portfolioDisplay: string = portfolioUrl
    ? portfolioUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")
    : "";
  const portfolioPassword: string = candidate.portfolio_password || "";
  const email = candidate.email || "";
  const linkedin = candidate.linkedin || "";
  const location = candidate.location || candidate.city || "";
  const phone = candidate.phone || "";

  setProgress("Generating PDF content (LLM)");
  const client = getAnthropicClient();
  const model = getAnthropicModel();

  const system = [
    "You generate infographic-style, ATS-friendly resume content for a two-column magazine layout.",
    "Return ONLY valid JSON, no markdown, no backticks.",
    "HTML fields MUST be fragments only (no <html>, <body>).",
    "",
    "BRAND COLORS (required):",
    "Return `brandPrimary` and `brandAccent` as hex strings (#RRGGBB).",
    "These MUST match the target company's actual brand palette.",
    "brandPrimary = the company's dominant brand color (used for the header banner and accents).",
    "brandAccent = a complementary color from their palette (used for section rules and highlights).",
    "Examples: Salesforce → #00A1E0/#032D60, HubSpot → #FF7A59/#2D3E50, Anthropic → #D97757/#191919, Wellhub → #FF6132/#1C1C1C.",
    "If you cannot identify the company, use #1a1a2e/#2d6a6a.",
    "",
    "CONTENT GUIDELINES (every length cap below is a HARD limit — exceeding it fails validation):",
    "- If User overrides (_profile.md) contain a heading like 'Tailored CV / PDF', treat those bullets as mandatory (they supersede conflicting defaults below).",
    "- tagline: ONE short personal brand line (6–12 words, MAX 150 characters). Align with any brand mandated in _profile.",
    '- summaryText: 3–5 sentence executive profile, dense with JD keywords, written in 1st-person-implied prose (no "I"). Closing sentence must obey any explicit ending/placement narrative required in User overrides.',
    "- competencies: 6–10 short keyword phrases from the JD, MAX 70 characters each. Example: 'Revenue Enablement Strategy'.",
    "- mostProudOf: 3 items. Title: 1–3 words, MAX 45 characters. Description: ONE punchy sentence, MAX 200 characters (target ~120). Example titles: Ingenuity, Growth, Expertise, Leadership, Impact, Craft. If your description runs long, cut it shorter — terseness beats verbosity here.",
    "- strengths: 5–7 strengths/abilities phrases (2–5 words each, MAX 55 characters). Example: 'Transformative Leadership', 'Consultative Selling'.",
    "- methodologies: 3–5 domain-relevant frameworks with proficiency level 1–4. Name MAX 45 characters. For sales-enablement roles use MEDDPICC/BANT/CoM/SPIN/Challenger. For eng roles use SOLID/TDD/DDD/REST/GraphQL. Pick what fits the candidate and JD.",
    "- dayInTheLife: time slot MAX 20 characters; activity MAX 100 characters. If cv.md has an '## A Day in the Life' section with literal 'TimeSlot: activity' lines (e.g., 'Morning: Creative exploration...'), use them VERBATIM — split on the first colon, time before, activity after. Do not paraphrase the activity. OMIT (return empty array) only if cv.md has no such section.",
    "- lifePhilosophy: quote MAX 350 characters. OMIT (return null) unless the candidate's profile includes a personal quote; do NOT fabricate.",
    "",
    "BULLET REWRITING — THE RECRUITER (critical):",
    "Every experience bullet MUST follow the Google XYZ formula: 'Accomplished X, as measured by Y, by doing Z.'",
    "  X = the outcome (what changed because of the candidate).",
    "  Y = the metric (the measurable proof).",
    "  Z = the method (what they specifically did).",
    "Example transformation:",
    "  BEFORE: 'Managed marketing team and ran campaigns.'",
    "  AFTER:  'Increased qualified pipeline 47% (X), measured by SQL volume in Salesforce (Y), by launching account-based campaigns targeting Fortune 500 finance buyers (Z).'",
    "ALWAYS: lead with outcome where possible; weave in 1–2 keywords from the Scout's keyword gap list (provided below) per bullet — natural integration, no stuffing; use strong action verbs (Led, Launched, Scaled, Architected, Negotiated, Shipped).",
    "NEVER: invent metrics. If cv.md has no number for a bullet, keep the bullet qualitative — do NOT fabricate '+30%' or 'doubled' numbers. NEVER replace concrete duties with vague phrases ('improved processes'). NEVER add accomplishments not present in cv.md or _profile.md.",
    "KEYWORD PLACEMENT: every HIGH-impact keyword from the Scout gap list must appear at least once in the first half-page (summaryText, competencies, or the first bullet of the most recent role). Every MED-impact keyword should appear at least once anywhere ATS-readable.",
    "",
    "HTML STRUCTURE for experienceHtml (use these CSS classes, in reverse-chronological order):",
    '<div class="job"><div class="job-header"><div class="job-title-block"><div class="job-role">Vice President of Revenue Enablement</div><div class="job-company">Enable</div></div><div class="job-meta"><div class="job-period">Sep 2024 – May 2025</div><div class="job-location">Remote</div></div></div><ul><li>Accomplished X, as measured by <strong>Y</strong>, by doing Z.</li></ul></div>',
    "",
    "HTML STRUCTURE for projectsHtml (optional, omit by returning empty string):",
    '<div class="project"><span class="project-title">Name</span><div class="project-desc">Description</div><div class="project-tech">Tech/context</div></div>',
    "INCLUDE EVERY project listed under cv.md's 'Selected Entrepreneurial Projects' section. Do not curate or drop entries. The candidate's portfolio breadth across years is part of the resume signal; cutting old projects hides relevant range. If page space is tight, shorten each project's description rather than dropping projects.",
    "If a project mentions a URL in cv.md (e.g., 'conelo.co' or 'chrismadethat.design'), wrap that URL in an anchor tag inside the project-desc so it's clickable in the PDF. Example: <a href=\"https://conelo.co\">conelo.co</a>. Add https:// prefix to the href when the URL is bare.",
    "",
    "HTML STRUCTURE for educationHtml:",
    '<div class="edu-item"><div class="edu-header"><span class="edu-title"><span class="edu-org">School</span> — Degree</span><span class="edu-year">Year</span></div></div>',
    "",
    "HTML STRUCTURE for certificationsHtml (omit if none):",
    '<div class="cert-item"><span class="cert-title"><span class="cert-org">Issuer</span> — Cert Name</span><span class="cert-year">Year</span></div>',
    "",
    "HTML STRUCTURE for skillsHtml:",
    '<div class="skills-grid"><div class="skill-item"><span class="skill-category">Category:</span> item1, item2, item3</div></div>',
    'Include Modern AI tooling (e.g., ChatGPT, Cursor, Claude, MCP servers) under a labeled category row when CV or overrides list them.',
  ].join("\n");

  const baseUser = [
    "## System rules (_shared.md)",
    sharedMd,
    "\n## User overrides (_profile.md)",
    profileMd,
    "\n## Mode instructions (pdf.md)",
    pdfMode,
    "\n## Candidate CV (cv.md)",
    cv,
    scoutGapSection
      ? "\n## Scout gap analysis (from evaluation report — Recruiter consumes this)\n" + scoutGapSection
      : "",
    "\n## Job description",
    jd,
  ].filter(Boolean).join("\n\n");

  const generateParts = async (fixInstructions: string, attemptLabel: string): Promise<PdfParts> => {
    setProgress(`Generating PDF content (${attemptLabel})`);
    const userContent =
      baseUser +
      (fixInstructions
        ? "\n\n## Screener fix instructions (apply ALL of these — they are mandatory)\n" + fixInstructions
        : "") +
      "\n\nReturn JSON with keys: lang, brandPrimary, brandAccent, tagline, summaryText, competencies (string[]), mostProudOf (array of {title, description}), strengths (string[]), methodologies (array of {name, level}), dayInTheLife (array of {time, activity}), lifePhilosophy ({quote, author} or null), experienceHtml, projectsHtml, educationHtml, certificationsHtml, skillsHtml.";

    const resp = await client.messages.create({
      model,
      max_tokens: 8000,
      temperature: 0.2,
      system,
      messages: [{ role: "user", content: userContent }],
    });

    let jsonText = resp.content.map((b) => ("text" in b ? b.text : "")).join("").trim();
    jsonText = jsonText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
    try {
      const raw = JSON.parse(jsonText);
      const cleaned = sanitizePdfParts(raw);
      return PdfPartsSchema.parse(cleaned);
    } catch (e) {
      log(`Failed to parse PDF JSON (${attemptLabel}). Raw response (first 400 chars):`);
      log(jsonText.slice(0, 400));
      throw e instanceof Error ? e : new Error(String(e));
    }
  };

  // Stage 1: Recruiter draft.
  let parsed = await generateParts("", "Recruiter draft");

  // Stage 2: Screener. On FAIL, feed the action list back to the Recruiter once and re-screen.
  let screener: ScreenerResult | null = null;
  const screenerHistory: ScreenerResult[] = [];
  const MAX_SCREENER_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_SCREENER_ATTEMPTS; attempt++) {
    setProgress(`Screening (ATS gatekeeper) — attempt ${attempt}/${MAX_SCREENER_ATTEMPTS}`);
    try {
      screener = await runScreener({ parts: parsed, jd, scoutGapSection, log });
    } catch (e) {
      log(`Screener call failed: ${e instanceof Error ? e.message : String(e)} — continuing without re-screen`);
      break;
    }
    screenerHistory.push(screener);
    if (screener.verdict === "PASS") {
      log(`Screener PASS on attempt ${attempt}`);
      break;
    }
    if (attempt >= MAX_SCREENER_ATTEMPTS) {
      log(`Screener still FAIL after ${MAX_SCREENER_ATTEMPTS} attempts — rendering PDF with verdict attached`);
      break;
    }
    if (screener.actionList.length === 0) {
      log(`Screener FAIL but emitted no action list — cannot retry`);
      break;
    }
    log(`Screener FAIL on attempt ${attempt} — regenerating with ${screener.actionList.length} fix instructions`);
    const fixInstructions = screener.actionList.map((a, i) => `${i + 1}. ${a}`).join("\n");
    parsed = await generateParts(fixInstructions, `Recruiter retry ${attempt + 1}`);
  }

  const competenciesHtml = parsed.competencies
    .map((c) => `<span class="competency-tag">${escapeHtml(c)}</span>`)
    .join("\n");

  const mostProudOfHtml = parsed.mostProudOf
    .map((item, i) => {
      const icons = ["lightbulb", "rocket", "trophy", "star"] as const;
      const icon = renderIconSvg(icons[i % icons.length]);
      return `<div class="proud-item"><div class="proud-icon">${icon}</div><div class="proud-body"><div class="proud-title">${escapeHtml(item.title)}</div><div class="proud-desc">${escapeHtml(item.description)}</div></div></div>`;
    })
    .join("\n");

  const strengthsHtml = parsed.strengths
    .map((s) => `<li>${escapeHtml(s)}</li>`)
    .join("\n");

  const methodologiesHtml = parsed.methodologies
    .map((m) => {
      const filled = "●".repeat(m.level);
      const empty = "○".repeat(Math.max(0, 4 - m.level));
      return `<div class="method-item"><span class="method-name">${escapeHtml(m.name)}</span><span class="method-dots" aria-label="${m.level} of 4">${filled}${empty}</span></div>`;
    })
    .join("\n");

  const dayInTheLifeHtml = parsed.dayInTheLife
    .map((d) => `<div class="day-item"><span class="day-time">${escapeHtml(d.time)}</span><span class="day-activity">${escapeHtml(d.activity)}</span></div>`)
    .join("\n");

  const lifePhilosophyHtml = parsed.lifePhilosophy
    ? `<blockquote class="philosophy-quote">“${escapeHtml(parsed.lifePhilosophy.quote)}”</blockquote><div class="philosophy-author">— ${escapeHtml(parsed.lifePhilosophy.author)}</div>`
    : "";

  const lang = parsed.lang || "en";
  const pageWidth = "8.5in";

  const sections =
    lang === "es"
      ? {
          SECTION_SUMMARY: "Perfil Ejecutivo",
          SECTION_COMPETENCIES: "Competencias Clave",
          SECTION_EXPERIENCE: "Experiencia",
          SECTION_PROJECTS: "Proyectos",
          SECTION_EDUCATION: "Formación",
          SECTION_CERTIFICATIONS: "Certificaciones",
          SECTION_SKILLS: "Herramientas y Habilidades",
          SECTION_PROUD: "Logros Destacados",
          SECTION_STRENGTHS: "Fortalezas",
          SECTION_METHODOLOGIES: "Metodologías",
          SECTION_PHILOSOPHY: "Filosofía",
          SECTION_DAY: "Un Día en la Vida",
        }
      : {
          SECTION_SUMMARY: "Executive Profile",
          SECTION_COMPETENCIES: "Core Competencies",
          SECTION_EXPERIENCE: "Experience",
          SECTION_PROJECTS: "Projects",
          SECTION_EDUCATION: "Education",
          SECTION_CERTIFICATIONS: "Certifications",
          SECTION_SKILLS: "Tools & Skills",
          SECTION_PROUD: "Most Proud Of",
          SECTION_STRENGTHS: "Strengths / Abilities",
          SECTION_METHODOLOGIES: "Methodologies",
          SECTION_PHILOSOPHY: "Life Philosophy",
          SECTION_DAY: "A Day in the Life",
        };

  const linkedinDisplay = linkedin
    ? linkedin.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")
    : "";
  // Ensure LinkedIn href is absolute so PDF renders an active hyperlink. Without
  // the protocol prefix, Playwright treats it as a relative path and the link
  // either breaks or opens in the wrong context.
  const linkedinHref = linkedin
    ? (linkedin.startsWith("http") ? linkedin : `https://${linkedin}`)
    : "";

  const hasProud = parsed.mostProudOf.length > 0;
  const hasStrengths = parsed.strengths.length > 0;
  const hasMethodologies = parsed.methodologies.length > 0;
  const hasPhilosophy = parsed.lifePhilosophy !== null;
  const hasDay = parsed.dayInTheLife.length > 0;
  const hasProjects = parsed.projectsHtml.trim().length > 0;
  const hasCertifications = parsed.certificationsHtml.trim().length > 0;
  const hasPhone = phone.trim().length > 0;
  const sidebarHasContent = hasProud || hasStrengths || hasMethodologies || hasPhilosophy || hasDay;

  let template2 = template;
  if (!sidebarHasContent) {
    template2 = template2.replace('<aside class="sidebar">', '<aside class="sidebar sidebar-collapsed">');
  }

  const filled = safeReplaceAll(template2, {
    "{{LANG}}": lang,
    "{{PAGE_WIDTH}}": pageWidth,
    "{{BRAND_PRIMARY}}": parsed.brandPrimary,
    "{{BRAND_ACCENT}}": parsed.brandAccent,
    "{{NAME}}": escapeHtml(fullName),
    "{{TAGLINE}}": escapeHtml(parsed.tagline),
    "{{EMAIL}}": escapeHtml(email),
    "{{PHONE}}": escapeHtml(phone),
    "{{PHONE_DISPLAY}}": hasPhone ? "flex" : "none",
    "{{LINKEDIN_URL}}": linkedinHref || "#",
    "{{LINKEDIN_DISPLAY}}": linkedinDisplay,
    "{{LOCATION}}": escapeHtml(location),
    "{{PORTFOLIO_URL}}": portfolioUrl || "#",
    "{{PORTFOLIO_TEXT}}": escapeHtml(portfolioDisplay),
    "{{PORTFOLIO_DISPLAY}}": portfolioUrl ? "flex" : "none",
    "{{PORTFOLIO_PASSWORD}}": escapeHtml(portfolioPassword),
    "{{PORTFOLIO_PASSWORD_DISPLAY}}": portfolioPassword ? "inline" : "none",

    "{{SECTION_SUMMARY}}": sections.SECTION_SUMMARY,
    "{{SUMMARY_TEXT}}": parsed.summaryText,

    "{{SECTION_COMPETENCIES}}": sections.SECTION_COMPETENCIES,
    "{{COMPETENCIES}}": competenciesHtml,

    "{{SECTION_EXPERIENCE}}": sections.SECTION_EXPERIENCE,
    "{{EXPERIENCE}}": parsed.experienceHtml,

    "{{SECTION_PROJECTS}}": sections.SECTION_PROJECTS,
    "{{PROJECTS}}": parsed.projectsHtml,
    "{{PROJECTS_DISPLAY}}": hasProjects ? "block" : "none",

    "{{SECTION_EDUCATION}}": sections.SECTION_EDUCATION,
    "{{EDUCATION}}": parsed.educationHtml,

    "{{SECTION_CERTIFICATIONS}}": sections.SECTION_CERTIFICATIONS,
    "{{CERTIFICATIONS}}": parsed.certificationsHtml,
    "{{CERTIFICATIONS_DISPLAY}}": hasCertifications ? "block" : "none",

    "{{SECTION_SKILLS}}": sections.SECTION_SKILLS,
    "{{SKILLS}}": parsed.skillsHtml,

    "{{SECTION_PROUD}}": sections.SECTION_PROUD,
    "{{PROUD}}": mostProudOfHtml,
    "{{PROUD_DISPLAY}}": hasProud ? "block" : "none",

    "{{SECTION_STRENGTHS}}": sections.SECTION_STRENGTHS,
    "{{STRENGTHS}}": strengthsHtml,
    "{{STRENGTHS_DISPLAY}}": hasStrengths ? "block" : "none",

    "{{SECTION_METHODOLOGIES}}": sections.SECTION_METHODOLOGIES,
    "{{METHODOLOGIES}}": methodologiesHtml,
    "{{METHODOLOGIES_DISPLAY}}": hasMethodologies ? "block" : "none",

    "{{SECTION_PHILOSOPHY}}": sections.SECTION_PHILOSOPHY,
    "{{PHILOSOPHY}}": lifePhilosophyHtml,
    "{{PHILOSOPHY_DISPLAY}}": hasPhilosophy ? "block" : "none",

    "{{SECTION_DAY}}": sections.SECTION_DAY,
    "{{DAY_IN_THE_LIFE}}": dayInTheLifeHtml,
    "{{DAY_DISPLAY}}": hasDay ? "block" : "none",
  });

  setProgress("Rendering PDF (Playwright)");
  const tmpDir = path.join(userPaths.outputDir, "_tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const htmlPath = path.join(tmpDir, `cv-${num}-${slug}.html`);
  // User-facing filename: "{Candidate Name} {Year} - {Company}.pdf". Internal
  // HTML stays slug+num so temp files dedupe across regenerations.
  const year = new Date().getFullYear();
  // Strip only Windows-forbidden filename characters; keep spaces, hyphens, and
  // parens so names like "Flats or Spikes" or "Korbyt (formerly RMG)" stay readable.
  const safeCompany = company.replace(/[<>:"/\\|?*]/g, "").trim() || "Company";
  const pdfFilename = `${fullName} ${year} - ${safeCompany}.pdf`;
  const pdfPath = path.join(userPaths.outputDir, pdfFilename);
  await fs.writeFile(htmlPath, filled, "utf-8");

  await runNodeScript("generate-pdf.mjs", [htmlPath, pdfPath, "--format=letter"], { log });

  // Persist Screener verdict alongside the PDF so the user can audit what changed
  // between attempts and what (if anything) is still flagged.
  let screenerPath: string | undefined;
  if (screener) {
    screenerPath = path.join(userPaths.outputDir, `screen-${slug}-${num}.md`);
    const header = [
      `# Screener Verdict — ${company} (#${num})`,
      "",
      `**Final verdict:** ${screener.verdict}`,
      `**Attempts:** ${screenerHistory.length} of ${MAX_SCREENER_ATTEMPTS}`,
      "",
      "---",
      "",
    ].join("\n");
    const body = screenerHistory
      .map((s, i) => `## Attempt ${i + 1} — ${s.verdict}\n\n${s.markdown}`)
      .join("\n\n---\n\n");
    await fs.writeFile(screenerPath, header + body, "utf-8");
    log(`Screener verdict written to ${path.basename(screenerPath)}`);
  }

  return {
    htmlPath,
    pdfPath,
    screenerPath,
    screenerVerdict: screener?.verdict,
    screenerAttempts: screenerHistory.length,
  };
}

/**
 * Generate a portfolio-version CV PDF: no JD, no Scout, no Screener loop.
 * Renders cv.md content faithfully through the same template the tailored
 * flow uses, with brand colors fixed by the caller (defaults to #ff5a1f on
 * a deep navy accent so it matches the user's portfolio).
 *
 * Output: output/cv-portfolio.pdf
 */
export async function generatePortfolioPdf(params: {
  brandPrimary?: string;
  brandAccent?: string;
  log: (l: string) => void;
  setProgress: (s: string, d?: string) => void;
}) {
  const { log, setProgress } = params;
  const brandPrimary = (params.brandPrimary || "#ff5a1f").toLowerCase();
  const brandAccent = (params.brandAccent || "#1a1a2e").toLowerCase();

  const [cv, profileYml, profileMd, sharedMd, pdfMode, template] = await Promise.all([
    fs.readFile(userPaths.cv, "utf-8"),
    fs.readFile(userPaths.profileYml, "utf-8"),
    fs.readFile(userPaths.profileMd, "utf-8"),
    fs.readFile(userPaths.sharedMd, "utf-8"),
    fs.readFile(path.join(repoRoot, "modes", "pdf.md"), "utf-8"),
    fs.readFile(path.join(repoRoot, "templates", "cv-template.html"), "utf-8"),
  ]);

  const profile = YAML.parse(profileYml) as any;
  const candidate = profile?.candidate ?? {};
  const fullName = candidate.full_name || "Candidate";
  const email = candidate.email || "";
  const linkedin = candidate.linkedin || "";
  const location = candidate.location || candidate.city || "";
  const phone = candidate.phone || "";
  const portfolioUrl: string = candidate.portfolio_url || candidate.portfolio || "";
  const portfolioDisplay: string = portfolioUrl
    ? portfolioUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")
    : "";
  const portfolioPassword: string = candidate.portfolio_password || "";

  setProgress("Generating portfolio PDF content (LLM)");
  const client = getAnthropicClient();
  const model = getAnthropicModel();

  const system = [
    "You generate the candidate's PORTFOLIO-VERSION resume content for a two-column magazine layout.",
    "Return ONLY valid JSON, no markdown, no backticks.",
    "HTML fields MUST be fragments only (no <html>, <body>).",
    "",
    "PORTFOLIO MODE (critical):",
    "- This resume is NOT tailored to any specific job description. It lives on the candidate's portfolio site as the canonical, role-agnostic version.",
    "- Render cv.md content FAITHFULLY. Do not inject role-targeted keywords, do not paraphrase to optimize for a specific industry, do not over-claim.",
    "- summaryText: distill cv.md's Executive Profile into 3-5 sentences. Keep the candidate's voice and the breadth of their experience. Do not optimize for any one role; lean into 'Senior/Staff Product Designer with nearly 10 years of enterprise SaaS UX, hybrid design + frontend + AI-tooling, security-domain depth' as the framing.",
    "- competencies: 6-10 short keyword phrases drawn from the candidate's actual skill set (cv.md Skills section + _profile.md cross-cutting advantage). Generic phrasings (e.g., 'Product Design Leadership', 'Design Systems Architecture', 'AI-Assisted Engineering Workflows') beat any single-JD keyword.",
    "- mostProudOf: use cv.md's Most Proud Of section verbatim (titles + one-sentence descriptions). Do NOT rewrite. 3 items.",
    "- strengths: pull from cv.md Skills > Strengths/Abilities + _profile.md cross-cutting strengths. 5-7 items.",
    "- methodologies: pull from cv.md Methodologies/Frameworks. 3-5 items with proficiency 3-4 (this is the candidate's home turf).",
    "- dayInTheLife: use cv.md's literal 'TimeSlot: activity' lines verbatim.",
    "- lifePhilosophy: use cv.md's literal quote.",
    "",
    "BRAND COLORS (FIXED, do not override):",
    `brandPrimary = ${brandPrimary}`,
    `brandAccent = ${brandAccent}`,
    "",
    "LENGTH CAPS (HARD limits — exceeding fails validation):",
    "- tagline: MAX 150 characters",
    "- mostProudOf descriptions: MAX 200 characters each",
    "- competency: MAX 70 characters each",
    "- strength: MAX 55 characters each",
    "- methodology name: MAX 45 characters",
    "- dayInTheLife time: MAX 20 chars; activity: MAX 100 chars",
    "- lifePhilosophy quote: MAX 350 characters",
    "",
    "HTML STRUCTURE for experienceHtml (reverse-chronological, render every role from cv.md):",
    '<div class="job"><div class="job-header"><div class="job-title-block"><div class="job-role">Title</div><div class="job-company">Company</div></div><div class="job-meta"><div class="job-period">Month YYYY – Month YYYY</div><div class="job-location">Location</div></div></div><ul><li>Bullet in Google XYZ form (cv.md is already in XYZ; render bullets faithfully, do not over-edit).</li></ul></div>',
    "",
    "HTML STRUCTURE for projectsHtml:",
    '<div class="project"><span class="project-title">Name (year range)</span><div class="project-desc">Description</div><div class="project-tech">Tech/context</div></div>',
    "INCLUDE EVERY project listed under cv.md's 'Selected Entrepreneurial Projects' section. Do not drop entries.",
    'If a project mentions a URL in cv.md (e.g., "conelo.co"), wrap it in <a href="https://...">url</a> inside project-desc.',
    "",
    "HTML STRUCTURE for educationHtml, certificationsHtml, skillsHtml: same as tailored mode. Faithful render of cv.md.",
  ].join("\n");

  const userContent = [
    "## System rules (_shared.md)",
    sharedMd,
    "\n## User overrides (_profile.md)",
    profileMd,
    "\n## Mode instructions (pdf.md)",
    pdfMode,
    "\n## Candidate CV (cv.md) — render this faithfully, no JD targeting",
    cv,
    "\n\nReturn JSON with keys: lang, brandPrimary, brandAccent, tagline, summaryText, competencies (string[]), mostProudOf (array of {title, description}), strengths (string[]), methodologies (array of {name, level}), dayInTheLife (array of {time, activity}), lifePhilosophy ({quote, author} or null), experienceHtml, projectsHtml, educationHtml, certificationsHtml, skillsHtml.",
  ].join("\n\n");

  const resp = await client.messages.create({
    model,
    max_tokens: 8000,
    temperature: 0.2,
    system,
    messages: [{ role: "user", content: userContent }],
  });

  let jsonText = resp.content.map((b) => ("text" in b ? b.text : "")).join("").trim();
  jsonText = jsonText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
  let parsed: PdfParts;
  try {
    const raw = JSON.parse(jsonText);
    // Force brand colors regardless of what the LLM returned
    raw.brandPrimary = brandPrimary;
    raw.brandAccent = brandAccent;
    const cleaned = sanitizePdfParts(raw);
    parsed = PdfPartsSchema.parse(cleaned);
  } catch (e) {
    log("Failed to parse portfolio PDF JSON. Raw response (first 400 chars):");
    log(jsonText.slice(0, 400));
    throw e instanceof Error ? e : new Error(String(e));
  }

  // Render — same flow as tailored, just into output/cv-portfolio.{html,pdf}
  const competenciesHtml = parsed.competencies
    .map((c) => `<span class="competency-tag">${escapeHtml(c)}</span>`)
    .join("\n");

  const mostProudOfHtml = parsed.mostProudOf
    .map((item, i) => {
      const icons = ["lightbulb", "rocket", "trophy", "star"] as const;
      const icon = renderIconSvg(icons[i % icons.length]);
      return `<div class="proud-item"><div class="proud-icon">${icon}</div><div class="proud-body"><div class="proud-title">${escapeHtml(item.title)}</div><div class="proud-desc">${escapeHtml(item.description)}</div></div></div>`;
    })
    .join("\n");

  const strengthsHtml = parsed.strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join("\n");

  const methodologiesHtml = parsed.methodologies
    .map((m) => {
      const filled = "●".repeat(m.level);
      const empty = "○".repeat(Math.max(0, 4 - m.level));
      return `<div class="method-item"><span class="method-name">${escapeHtml(m.name)}</span><span class="method-dots" aria-label="${m.level} of 4">${filled}${empty}</span></div>`;
    })
    .join("\n");

  const dayInTheLifeHtml = parsed.dayInTheLife
    .map((d) => `<div class="day-item"><span class="day-time">${escapeHtml(d.time)}</span><span class="day-activity">${escapeHtml(d.activity)}</span></div>`)
    .join("\n");

  const lifePhilosophyHtml = parsed.lifePhilosophy
    ? `<blockquote class="philosophy-quote">“${escapeHtml(parsed.lifePhilosophy.quote)}”</blockquote><div class="philosophy-author">— ${escapeHtml(parsed.lifePhilosophy.author)}</div>`
    : "";

  const lang = parsed.lang || "en";
  const pageWidth = "8.5in";

  const sections = {
    SECTION_SUMMARY: "Executive Profile",
    SECTION_COMPETENCIES: "Core Competencies",
    SECTION_EXPERIENCE: "Experience",
    SECTION_PROJECTS: "Projects",
    SECTION_EDUCATION: "Education",
    SECTION_CERTIFICATIONS: "Certifications",
    SECTION_SKILLS: "Tools & Skills",
    SECTION_PROUD: "Most Proud Of",
    SECTION_STRENGTHS: "Strengths / Abilities",
    SECTION_METHODOLOGIES: "Methodologies",
    SECTION_PHILOSOPHY: "Life Philosophy",
    SECTION_DAY: "A Day in the Life",
  };

  const linkedinDisplay = linkedin
    ? linkedin.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")
    : "";
  const linkedinHref = linkedin
    ? (linkedin.startsWith("http") ? linkedin : `https://${linkedin}`)
    : "";

  const hasProud = parsed.mostProudOf.length > 0;
  const hasStrengths = parsed.strengths.length > 0;
  const hasMethodologies = parsed.methodologies.length > 0;
  const hasPhilosophy = parsed.lifePhilosophy !== null;
  const hasDay = parsed.dayInTheLife.length > 0;
  const hasProjects = parsed.projectsHtml.trim().length > 0;
  const hasCertifications = parsed.certificationsHtml.trim().length > 0;
  const hasPhone = phone.trim().length > 0;
  const sidebarHasContent = hasProud || hasStrengths || hasMethodologies || hasPhilosophy || hasDay;

  let template2 = template;
  if (!sidebarHasContent) {
    template2 = template2.replace('<aside class="sidebar">', '<aside class="sidebar sidebar-collapsed">');
  }

  const filled = safeReplaceAll(template2, {
    "{{LANG}}": lang,
    "{{PAGE_WIDTH}}": pageWidth,
    "{{BRAND_PRIMARY}}": parsed.brandPrimary,
    "{{BRAND_ACCENT}}": parsed.brandAccent,
    "{{NAME}}": escapeHtml(fullName),
    "{{TAGLINE}}": escapeHtml(parsed.tagline),
    "{{EMAIL}}": escapeHtml(email),
    "{{PHONE}}": escapeHtml(phone),
    "{{PHONE_DISPLAY}}": hasPhone ? "flex" : "none",
    "{{LINKEDIN_URL}}": linkedinHref || "#",
    "{{LINKEDIN_DISPLAY}}": linkedinDisplay,
    "{{LOCATION}}": escapeHtml(location),
    "{{PORTFOLIO_URL}}": portfolioUrl || "#",
    "{{PORTFOLIO_TEXT}}": escapeHtml(portfolioDisplay),
    "{{PORTFOLIO_DISPLAY}}": portfolioUrl ? "flex" : "none",
    "{{PORTFOLIO_PASSWORD}}": escapeHtml(portfolioPassword),
    "{{PORTFOLIO_PASSWORD_DISPLAY}}": portfolioPassword ? "inline" : "none",
    "{{SECTION_SUMMARY}}": sections.SECTION_SUMMARY,
    "{{SUMMARY_TEXT}}": parsed.summaryText,
    "{{SECTION_COMPETENCIES}}": sections.SECTION_COMPETENCIES,
    "{{COMPETENCIES}}": competenciesHtml,
    "{{SECTION_EXPERIENCE}}": sections.SECTION_EXPERIENCE,
    "{{EXPERIENCE}}": parsed.experienceHtml,
    "{{SECTION_PROJECTS}}": sections.SECTION_PROJECTS,
    "{{PROJECTS}}": parsed.projectsHtml,
    "{{PROJECTS_DISPLAY}}": hasProjects ? "block" : "none",
    "{{SECTION_EDUCATION}}": sections.SECTION_EDUCATION,
    "{{EDUCATION}}": parsed.educationHtml,
    "{{SECTION_CERTIFICATIONS}}": sections.SECTION_CERTIFICATIONS,
    "{{CERTIFICATIONS}}": parsed.certificationsHtml,
    "{{CERTIFICATIONS_DISPLAY}}": hasCertifications ? "block" : "none",
    "{{SECTION_SKILLS}}": sections.SECTION_SKILLS,
    "{{SKILLS}}": parsed.skillsHtml,
    "{{SECTION_PROUD}}": sections.SECTION_PROUD,
    "{{PROUD}}": mostProudOfHtml,
    "{{PROUD_DISPLAY}}": hasProud ? "block" : "none",
    "{{SECTION_STRENGTHS}}": sections.SECTION_STRENGTHS,
    "{{STRENGTHS}}": strengthsHtml,
    "{{STRENGTHS_DISPLAY}}": hasStrengths ? "block" : "none",
    "{{SECTION_METHODOLOGIES}}": sections.SECTION_METHODOLOGIES,
    "{{METHODOLOGIES}}": methodologiesHtml,
    "{{METHODOLOGIES_DISPLAY}}": hasMethodologies ? "block" : "none",
    "{{SECTION_PHILOSOPHY}}": sections.SECTION_PHILOSOPHY,
    "{{PHILOSOPHY}}": lifePhilosophyHtml,
    "{{PHILOSOPHY_DISPLAY}}": hasPhilosophy ? "block" : "none",
    "{{SECTION_DAY}}": sections.SECTION_DAY,
    "{{DAY_IN_THE_LIFE}}": dayInTheLifeHtml,
    "{{DAY_DISPLAY}}": hasDay ? "block" : "none",
  });

  setProgress("Rendering portfolio PDF (Playwright)");
  const tmpDir = path.join(userPaths.outputDir, "_tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const htmlPath = path.join(tmpDir, `cv-portfolio.html`);
  const pdfPath = path.join(userPaths.outputDir, `cv-portfolio.pdf`);
  await fs.writeFile(htmlPath, filled, "utf-8");

  await runNodeScript("generate-pdf.mjs", [htmlPath, pdfPath, "--format=letter"], { log });

  return { htmlPath, pdfPath, brandPrimary, brandAccent };
}

/**
 * Pull the Scout block out of a generated evaluation report so the PDF step can
 * feed the keyword/skills/positioning gap analysis into the Recruiter prompt.
 * Returns the slice from "## B) Match with CV" up to the next H2, or "" if not found.
 */
function extractScoutGapSection(reportMd: string): string {
  const start = reportMd.search(/^##\s*B\)\s*Match with CV/m);
  if (start === -1) return "";
  const rest = reportMd.slice(start);
  const nextH2 = rest.slice(2).search(/^##\s/m);
  if (nextH2 === -1) return rest.trim();
  return rest.slice(0, nextH2 + 2).trim();
}

function escapeHtml(s: string) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Simple outline SVG icon set for the "Most Proud Of" sidebar card. Accent-colored via currentColor. */
function renderIconSvg(kind: "lightbulb" | "rocket" | "trophy" | "star"): string {
  const common = 'width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
  switch (kind) {
    case "lightbulb":
      return `<svg ${common}><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z"/></svg>`;
    case "rocket":
      return `<svg ${common}><path d="M14 4c3 0 7 4 7 7 0 0-3 1-5 3l-4-4c2-2 2-6 2-6Z"/><path d="M6 14c-2 2-3 7-3 7s5-1 7-3"/><path d="M9 11l4 4"/><circle cx="15" cy="9" r="1"/></svg>`;
    case "trophy":
      return `<svg ${common}><path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0V4Z"/><path d="M17 4h3v3a3 3 0 0 1-3 3"/><path d="M7 4H4v3a3 3 0 0 0 3 3"/></svg>`;
    case "star":
    default:
      return `<svg ${common}><polygon points="12 2 15 9 22 10 17 15 18 22 12 18 6 22 7 15 2 10 9 9"/></svg>`;
  }
}
