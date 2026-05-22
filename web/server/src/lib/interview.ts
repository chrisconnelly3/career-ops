import fs from "node:fs/promises";
import path from "node:path";

import { repoRoot, userPaths } from "./paths";
import type { ChatContext } from "./chat";

/**
 * Find the report file for a given report number, parse its filename for the slug
 * (`{num}-{slug}-{date}.md`), parse the H1 for company + role, and return the full
 * markdown content as ChatContext for the Decision Maker.
 */
export async function loadReportContext(reportNumber: string): Promise<ChatContext> {
  const padded = reportNumber.padStart(3, "0");
  let entries: string[];
  try {
    entries = await fs.readdir(userPaths.reportsDir);
  } catch {
    throw new Error(`No reports directory at ${userPaths.reportsDir}`);
  }
  const match = entries.find((f) => f.startsWith(`${padded}-`) && f.endsWith(".md"));
  if (!match) throw new Error(`No report found for number ${padded}`);

  const filename = match;
  // Pattern: NNN-slug-YYYY-MM-DD.md → slug is everything between the leading number
  // and the trailing date (which is 10 chars + ".md").
  const slugMatch = /^\d{3}-(.+?)-\d{4}-\d{2}-\d{2}\.md$/.exec(filename);
  const reportSlug = slugMatch?.[1] ?? filename.replace(/\.md$/, "");

  const reportPath = path.join(userPaths.reportsDir, filename);
  const reportContent = await fs.readFile(reportPath, "utf-8");

  // Parse "# Evaluation: Company — Role" from the first H1.
  let company: string | undefined;
  let role: string | undefined;
  const h1 = reportContent.split("\n").find((l) => l.startsWith("# "));
  if (h1) {
    const stripped = h1
      .replace(/^#\s+/, "")
      .replace(/^Evaluation:\s*/i, "")
      .replace(/^Evaluaci[oó]n:\s*/i, "")
      .trim();
    const parts = stripped.split("—").map((s) => s.trim());
    if (parts.length >= 2) {
      company = parts[0];
      role = parts.slice(1).join("—").trim();
    } else {
      company = stripped;
    }
  }

  return { reportNumber: padded, reportContent, reportSlug, company, role };
}

/**
 * Persist a Decision Maker chat transcript to `interview-prep/{num}-{slug}.md`.
 * Overwrites any prior transcript for the same report — the chat client always
 * POSTs the full current state so this is just a snapshot of the latest session.
 */
export async function saveInterviewTranscript(
  reportNumber: string,
  transcript: string,
): Promise<{ absPath: string; relPath: string }> {
  const ctx = await loadReportContext(reportNumber);
  const dir = path.join(repoRoot, "interview-prep");
  await fs.mkdir(dir, { recursive: true });
  const filename = `${ctx.reportNumber}-${ctx.reportSlug}.md`;
  const absPath = path.join(dir, filename);

  const header = [
    `# Interview Prep Transcript — ${ctx.company ?? "Company"} — ${ctx.role ?? "Role"}`,
    "",
    `**Report:** #${ctx.reportNumber}`,
    `**Last saved:** ${new Date().toISOString()}`,
    "",
    "> Decision Maker (mock hiring manager) interview. Latest session below.",
    "",
    "---",
    "",
  ].join("\n");

  await fs.writeFile(absPath, header + transcript, "utf-8");
  return {
    absPath,
    relPath: path.relative(repoRoot, absPath).replace(/\\/g, "/"),
  };
}
