/**
 * Parses a career-ops evaluation report markdown into structured data
 * for rendering as a rich SaaS-style UI.
 */

export type MatchItem = {
  requirement: string;
  evidence: string;
  strength: "strong" | "moderate" | "gap" | "mitigable";
};

export type GapItem = {
  gap: string;
  severity: string;
  adjacent: string;
  mitigation: string;
};

export type ScoreDimension = {
  dimension: string;
  score: number;
  notes: string;
};

export type CompData = {
  label: string;
  range: string;
  source: string;
};

export type StarStory = {
  num: number;
  requirement: string;
  story: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  reflection: string;
};

export type RedFlagQA = {
  question: string;
  response: string;
};

export type PersonalizationItem = {
  num: number;
  section: string;
  current: string;
  proposed: string;
  why: string;
};

export type RoleSummaryItem = {
  dimension: string;
  detail: string;
};

export type CompSummary = {
  base: string;
  variable: string;
  totalEstimate: string;
};

export type ParsedReport = {
  title: string;
  company: string;
  role: string;
  url: string;
  date: string;
  archetype: string;
  score: number;
  scoreLabel: string;
  recommendation: "apply" | "apply-caution" | "consider" | "skip";

  screener: { verdict: "PASS" | "FAIL" | "UNKNOWN"; attempts: number } | null;

  compSummary: CompSummary | null;

  roleSummary: RoleSummaryItem[];
  tldr: string;

  matches: MatchItem[];
  matchStats: { strong: number; moderate: number; gap: number; mitigable: number };
  gaps: GapItem[];

  levelVerdict: string;
  levelTips: string[];

  compData: CompData[];
  compAssessment: string;
  compScore: number | null;

  scoreDimensions: ScoreDimension[];

  cvChanges: PersonalizationItem[];
  linkedinChanges: PersonalizationItem[];

  starStories: StarStory[];
  caseStudy: string;
  redFlags: RedFlagQA[];

  sections: { id: string; title: string; content: string }[];
  rawMarkdown: string;
};

function extractHeaderField(md: string, field: string): string {
  const re = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, "i");
  const m = md.match(re);
  return m?.[1]?.trim() || "";
}

function parseMarkdownTable(block: string): string[][] {
  const lines = block.split("\n").filter((l) => l.trim().startsWith("|"));
  if (lines.length < 3) return [];
  const separatorIdx = lines.findIndex((l) => /^\|\s*[-:]+/.test(l));
  if (separatorIdx === -1) return [];
  const dataLines = lines.slice(separatorIdx + 1);
  return dataLines.map((l) =>
    l.split("|").map((c) => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length)
  );
}

function classifyStrength(raw: string): MatchItem["strength"] {
  const l = raw.toLowerCase();
  if (l.includes("gap") && !l.includes("mitigable")) return "gap";
  if (l.includes("mitigable")) return "mitigable";
  if (l.includes("moderate")) return "moderate";
  return "strong";
}

function sectionsBetween(md: string): { id: string; title: string; content: string }[] {
  const parts: { id: string; title: string; content: string }[] = [];
  const re = /^## ([A-F]\) .+)$/gm;
  let last: { id: string; title: string; start: number } | null = null;

  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    if (last) {
      parts.push({ ...last, content: md.slice(last.start, m.index).trim() });
    }
    const letter = m[1]!.charAt(0).toLowerCase();
    last = { id: letter, title: m[1]!, start: m.index };
  }
  if (last) {
    const scoringIdx = md.indexOf("## Scoring Summary", last.start);
    const end = scoringIdx !== -1 ? scoringIdx : md.length;
    parts.push({ ...last, content: md.slice(last.start, end).trim() });
  }
  return parts;
}

export function parseReport(md: string): ParsedReport {
  const title = (md.match(/^# (.+)/m)?.[1] || "").trim();
  const titleParts = title.replace(/^Evaluation:\s*/i, "").split("—").map((s) => s.trim());
  const company = titleParts[0] || "";
  const role = titleParts.slice(1).join(" — ") || "";

  const url = extractHeaderField(md, "URL");
  const date = extractHeaderField(md, "Date");
  const archetype = extractHeaderField(md, "Archetype");
  const scoreRaw = extractHeaderField(md, "Score");
  const score = parseFloat(scoreRaw) || 0;
  const scoreLabel = scoreRaw || `${score}/5`;

  let recommendation: ParsedReport["recommendation"] = "skip";
  if (score >= 4.5) recommendation = "apply";
  else if (score >= 4.0) recommendation = "apply-caution";
  else if (score >= 3.5) recommendation = "consider";

  // ATS Screener verdict — appended to the report as a footer line by the eval
  // pipeline: "**ATS Screener:** FAIL (2 attempts) — see `output/screen-...md`".
  let screener: ParsedReport["screener"] = null;
  const screenerLine = extractHeaderField(md, "ATS Screener");
  if (screenerLine) {
    const v = /\bPASS\b/i.test(screenerLine)
      ? "PASS"
      : /\bFAIL\b/i.test(screenerLine)
      ? "FAIL"
      : "UNKNOWN";
    const attempts = parseInt(screenerLine.match(/(\d+)\s*attempt/i)?.[1] || "0", 10);
    screener = { verdict: v, attempts };
  }

  const sections = sectionsBetween(md);

  // A) Role Summary
  const sectionA = sections.find((s) => s.id === "a")?.content || "";
  const roleSummaryRows = parseMarkdownTable(sectionA);
  const roleSummary: RoleSummaryItem[] = roleSummaryRows
    .map((r) => ({ dimension: (r[0] || "").replace(/\*\*/g, ""), detail: r[1] || "" }))
    .filter((r) => r.dimension && !r.dimension.toLowerCase().includes("tl;dr"));
  const tldrRow = roleSummaryRows.find((r) => (r[0] || "").toLowerCase().includes("tl;dr"));
  const tldr = tldrRow?.[1] || "";

  // B) Match
  const sectionB = sections.find((s) => s.id === "b")?.content || "";
  const reqTableStart = sectionB.indexOf("| JD Requirement");
  const gapTableStart = sectionB.indexOf("| Gap");

  let matchBlock = "";
  if (reqTableStart !== -1) {
    const end = gapTableStart !== -1 ? gapTableStart : sectionB.length;
    matchBlock = sectionB.slice(reqTableStart, end);
  }
  const matchRows = parseMarkdownTable(matchBlock);
  const matches: MatchItem[] = matchRows.map((r) => ({
    requirement: (r[0] || "").replace(/\*\*/g, ""),
    evidence: (r[1] || "").replace(/\*\*/g, ""),
    strength: classifyStrength(r[2] || ""),
  }));

  const matchStats = {
    strong: matches.filter((m) => m.strength === "strong").length,
    moderate: matches.filter((m) => m.strength === "moderate").length,
    gap: matches.filter((m) => m.strength === "gap").length,
    mitigable: matches.filter((m) => m.strength === "mitigable").length,
  };

  let gapBlock = "";
  if (gapTableStart !== -1) {
    gapBlock = sectionB.slice(gapTableStart);
  }
  const gapRows = parseMarkdownTable(gapBlock);
  const gaps: GapItem[] = gapRows.map((r) => ({
    gap: r[0] || "",
    severity: r[1] || "",
    adjacent: r[2] || "",
    mitigation: r[3] || "",
  }));

  // C) Level
  const sectionC = sections.find((s) => s.id === "c")?.content || "";
  const verdictMatch = sectionC.match(/\*\*Verdict:\*\*\s*(.+)/);
  const levelVerdict = verdictMatch?.[1]?.trim() || "";
  const levelTips = (sectionC.match(/^- .+$/gm) || []).map((l) => l.replace(/^- /, "").trim());

  // D) Comp
  const sectionD = sections.find((s) => s.id === "d")?.content || "";
  const compTableStart = sectionD.indexOf("| Data Point");
  let compBlock = "";
  if (compTableStart !== -1) {
    const nextSection = sectionD.indexOf("\n\n", compTableStart);
    compBlock = sectionD.slice(compTableStart, nextSection !== -1 ? nextSection : undefined);
  }
  const compRows = parseMarkdownTable(compBlock);
  const compData: CompData[] = compRows.map((r) => ({
    label: r[0] || "",
    range: r[1] || "",
    source: r[2] || "",
  }));
  const compAssessmentMatch = sectionD.match(/\*\*Assessment:\*\*\s*(.+)/);
  const compAssessment = compAssessmentMatch?.[1]?.trim() || "";
  const compScoreMatch = sectionD.match(/Comp score:\s*([\d.]+)/i);
  const compScore = compScoreMatch ? parseFloat(compScoreMatch[1]!) : null;

  // Comp summary (surface at top of report)
  const compSummary = buildCompSummary(roleSummary, sectionD);

  // E) Personalization Plan
  const sectionE = sections.find((s) => s.id === "e")?.content || "";
  const cvTableStart = sectionE.indexOf("| #");
  let cvChanges: PersonalizationItem[] = [];
  let linkedinChanges: PersonalizationItem[] = [];

  if (cvTableStart !== -1) {
    const linkedinHeading = sectionE.indexOf("### Top 5 LinkedIn");
    const cvEnd = linkedinHeading !== -1 ? linkedinHeading : sectionE.length;
    const cvBlock = sectionE.slice(cvTableStart, cvEnd);
    const cvRows = parseMarkdownTable(cvBlock);
    cvChanges = cvRows.map((r) => ({
      num: parseInt(r[0] || "0"),
      section: (r[1] || "").replace(/\*\*/g, ""),
      current: (r[2] || "").replace(/\*\*/g, ""),
      proposed: (r[3] || "").replace(/\*\*/g, ""),
      why: (r[4] || "").replace(/\*\*/g, ""),
    }));

    if (linkedinHeading !== -1) {
      const liTableStart = sectionE.indexOf("| #", linkedinHeading);
      if (liTableStart !== -1) {
        const liBlock = sectionE.slice(liTableStart);
        const liRows = parseMarkdownTable(liBlock);
        linkedinChanges = liRows.map((r) => ({
          num: parseInt(r[0] || "0"),
          section: (r[1] || "").replace(/\*\*/g, ""),
          current: "",
          proposed: (r[2] || "").replace(/\*\*/g, ""),
          why: "",
        }));
      }
    }
  }

  // Scoring Summary — explicit table or synthesized from available data
  const scoringIdx = md.indexOf("## Scoring Summary");
  let scoreDimensions: ScoreDimension[] = [];
  if (scoringIdx !== -1) {
    const scoringBlock = md.slice(scoringIdx);
    const rows = parseMarkdownTable(scoringBlock);
    scoreDimensions = rows.map((r) => ({
      dimension: r[0] || "",
      score: parseFloat(r[1] || "0"),
      notes: r[2] || "",
    }));
  }

  if (scoreDimensions.length === 0 && score > 0) {
    const total = matches.length;
    const strongPct = total > 0 ? matchStats.strong / total : 0;
    const matchScore = Math.round((1 + strongPct * 4) * 10) / 10;

    scoreDimensions.push({ dimension: "Overall fit", score, notes: "Top-level evaluation score" });
    if (total > 0) {
      scoreDimensions.push({
        dimension: "Requirements match",
        score: Math.min(matchScore, 5),
        notes: `${matchStats.strong}/${total} strong`,
      });
    }
    if (compScore !== null) {
      scoreDimensions.push({ dimension: "Compensation", score: compScore, notes: "" });
    }
  }

  // F) Interview Prep
  const sectionF = sections.find((s) => s.id === "f")?.content || "";
  const starTableStart = sectionF.indexOf("| #");
  let starBlock = "";
  if (starTableStart !== -1) {
    const nextHeading = sectionF.indexOf("###", starTableStart + 10);
    starBlock = sectionF.slice(starTableStart, nextHeading !== -1 ? nextHeading : undefined);
  }
  const starRows = parseMarkdownTable(starBlock);
  const starStories: StarStory[] = starRows.map((r) => ({
    num: parseInt(r[0] || "0"),
    requirement: r[1] || "",
    story: r[2] || "",
    situation: r[3] || "",
    task: r[4] || "",
    action: r[5] || "",
    result: r[6] || "",
    reflection: r[7] || "",
  }));

  const caseStudyMatch = sectionF.match(/### Recommended Case Study[\s\S]*?\n\n([\s\S]*?)(?=\n###|\n---|\n## |$)/);
  const caseStudy = caseStudyMatch?.[1]?.trim().replace(/\*\*/g, "") || "";

  const redFlagStart = sectionF.indexOf("| Question");
  let redFlagBlock = "";
  if (redFlagStart !== -1) {
    redFlagBlock = sectionF.slice(redFlagStart);
  }
  const redFlagRows = parseMarkdownTable(redFlagBlock);
  const redFlags: RedFlagQA[] = redFlagRows.map((r) => ({
    question: (r[0] || "").replace(/^"|"$/g, ""),
    response: (r[1] || "").replace(/^"|"$/g, ""),
  }));

  return {
    title, company, role, url, date, archetype, score, scoreLabel, recommendation,
    screener,
    compSummary,
    roleSummary, tldr,
    matches, matchStats, gaps,
    levelVerdict, levelTips,
    compData, compAssessment, compScore,
    cvChanges, linkedinChanges,
    scoreDimensions,
    starStories, caseStudy, redFlags,
    sections,
    rawMarkdown: md,
  };
}

function buildCompSummary(
  roleSummary: RoleSummaryItem[],
  sectionD: string
): CompSummary | null {
  const compRow = roleSummary.find((r) =>
    /^comp/i.test(r.dimension.replace(/\*\*/g, "").trim())
  );
  const rawComp = compRow?.detail || "";

  let base = "";
  let variable = "";

  const dollarRange = rawComp.match(/\$[\d,.]+[KkMm]?\s*[-–]\s*\$[\d,.]+[KkMm]?/);
  if (dollarRange) {
    base = dollarRange[0];
  } else {
    const singleDollar = rawComp.match(/\$[\d,.]+[KkMm]?\+?/);
    if (singleDollar) base = singleDollar[0];
  }

  const variablePatterns = [
    /\+\s*(.+(?:variable|bonus|commission|incentive|OTE|quarterly|annual)[^|]*)/i,
    /(variable|bonus|commission|incentive|OTE|quarterly\s+(?:variable|bonus))[^|]*/i,
    /(?:sales\s+incentive\s*\/?\s*commission[^|]*)/i,
  ];
  for (const pat of variablePatterns) {
    const m = rawComp.match(pat);
    if (m) {
      variable = m[0].replace(/^\+\s*/, "").trim();
      break;
    }
  }

  if (!variable && sectionD) {
    const varRow = sectionD.match(/\|\s*Variable\s*\|([^|]+)\|/i);
    if (varRow) variable = varRow[1]!.trim();
    if (!variable) {
      const bonusLine = sectionD.match(/(quarterly|annual)\s+(variable|bonus)[^.\n]*/i);
      if (bonusLine) variable = bonusLine[0].trim();
    }
  }

  let totalEstimate = "";
  if (sectionD) {
    const tcMatch = sectionD.match(/(?:total\s*comp|TC)\s*(?:could\s+)?(?:reach|land|hit)?\s*\$[\d,.]+[KkMm]?\s*[-–]?\s*\$?[\d,.]*[KkMm]?/i);
    if (tcMatch) totalEstimate = tcMatch[0].trim();
    if (!totalEstimate) {
      const oteLine = sectionD.match(/OTE\s*(?:of\s+|at\s+|lands?\s+at\s+)?\$[\d,.]+[KkMm]?\+?/i);
      if (oteLine) totalEstimate = oteLine[0].trim();
    }
  }

  if (!base && !variable) return null;

  return { base, variable, totalEstimate };
}
