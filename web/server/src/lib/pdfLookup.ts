import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

import { userPaths } from "./paths";

/** Extract the company name from a report file's H1 ("# Evaluation: Company — Role"). */
async function companyForReport(reportNum: string): Promise<string | null> {
  const padded = reportNum.padStart(3, "0");
  let entries: string[];
  try {
    entries = await fs.readdir(userPaths.reportsDir);
  } catch {
    return null;
  }
  const reportFile = entries.find(
    (f) => f.startsWith(`${padded}-`) && f.endsWith(".md"),
  );
  if (!reportFile) return null;
  try {
    const content = await fs.readFile(
      path.join(userPaths.reportsDir, reportFile),
      "utf-8",
    );
    const h1 = content.split("\n").find((l) => l.startsWith("# "));
    if (!h1) return null;
    const stripped = h1
      .replace(/^#\s+/, "")
      .replace(/^Evaluation:\s*/i, "")
      .replace(/^Evaluaci[oó]n:\s*/i, "")
      .trim();
    const parts = stripped.split("—").map((s) => s.trim());
    return parts[0] || null;
  } catch {
    return null;
  }
}

export async function findPdfForReport(
  reportNum: string,
): Promise<{ found: boolean; filename?: string }> {
  let files: string[];
  try {
    files = await fs.readdir(userPaths.outputDir);
  } catch {
    return { found: false };
  }

  // New pattern: "{Candidate Name} {YYYY} - {Company}.pdf"
  const company = await companyForReport(reportNum);
  if (company) {
    const suffix = ` - ${company}.pdf`.toLowerCase();
    const newMatch = files.find((f) => f.toLowerCase().endsWith(suffix));
    if (newMatch) return { found: true, filename: newMatch };
  }

  // Legacy pattern (back-compat for pre-rename runs): "cv-{slug}-{NNN}.pdf"
  const padded = reportNum.padStart(3, "0");
  const legacy = new RegExp(`^cv-.+-${padded}\\.pdf$`, "i");
  const legacyMatch = files.find((f) => legacy.test(f));
  if (legacyMatch) return { found: true, filename: legacyMatch };

  return { found: false };
}

export function getPdfAbsolutePath(filename: string): string | null {
  const safe = path.basename(filename);
  const full = path.join(userPaths.outputDir, safe);
  try {
    const fsSync = require("node:fs") as typeof import("node:fs");
    fsSync.accessSync(full);
    return full;
  } catch {
    return null;
  }
}

export async function revealPdfInExplorer(filename: string): Promise<void> {
  const safe = path.basename(filename);
  const full = path.join(userPaths.outputDir, safe);
  await fs.access(full);

  const platform = process.platform;
  return new Promise((resolve, reject) => {
    if (platform === "win32") {
      execFile("explorer.exe", ["/select,", full], (err) => {
        // explorer.exe returns exit code 1 even on success
        resolve();
      });
    } else if (platform === "darwin") {
      execFile("open", ["-R", full], (err) => {
        if (err) reject(err);
        else resolve();
      });
    } else {
      execFile("xdg-open", [path.dirname(full)], (err) => {
        if (err) reject(err);
        else resolve();
      });
    }
  });
}
