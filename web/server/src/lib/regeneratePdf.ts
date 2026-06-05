import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import { generateTailoredPdf } from "./pdf";
import { userPaths } from "./paths";

type Ctx = {
  log: (line: string) => void;
  setProgress: (step: string, detail?: string) => void;
};

async function extractJdFromUrl(jdUrl: string, log: (l: string) => void): Promise<string> {
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
    return text.replace(/\s+\n/g, "\n").trim();
  } finally {
    await browser.close();
  }
}

function slugifyCompany(name: string) {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Re-runs ONLY the PDF generation step for a previously-evaluated report.
 * Reads the existing report file, pulls URL + company out of it, re-scrapes
 * the JD, and produces a fresh cv-<slug>-<num>.pdf using the current template
 * + pdf.ts. The underlying report markdown is left untouched.
 */
export async function regeneratePdfForReport(reportNum: string, ctx: Ctx) {
  const paddedNum = reportNum.padStart(3, "0");
  ctx.setProgress("Locating report file");

  const reportsDir = userPaths.reportsDir;
  const entries = await fs.readdir(reportsDir);
  const reportFile = entries.find((f) => f.startsWith(`${paddedNum}-`) && f.endsWith(".md"));
  if (!reportFile) {
    throw new Error(`No report file found for report number ${paddedNum}`);
  }

  const reportPath = path.join(reportsDir, reportFile);
  const reportMd = await fs.readFile(reportPath, "utf-8");

  const h1 = reportMd.split("\n").find((l) => l.startsWith("# "));
  if (!h1) throw new Error("Report has no H1 title.");
  const titleBody = h1.replace(/^#\s+/, "").replace(/^Evaluation:\s*/i, "").replace(/^Evaluaci[oó]n:\s*/i, "");
  const [companyRaw, ...rest] = titleBody.split("—").map((s) => s.trim());
  const company = (companyRaw || "company").trim();
  const role = rest.join(" — ").trim() || "role";
  const slug = slugifyCompany(company);

  const urlMatch = reportMd.match(/\*\*URL:\*\*\s*(\S+)/i);
  const jdUrl = urlMatch?.[1];
  if (!jdUrl) {
    throw new Error(`Report ${paddedNum} has no **URL:** — cannot re-scrape JD.`);
  }

  ctx.setProgress("Re-scraping job description", jdUrl);
  const jd = await extractJdFromUrl(jdUrl, ctx.log);
  if (jd.length < 100) {
    throw new Error(`Scraped JD is too short (${jd.length} chars) — URL may be expired or behind auth.`);
  }

  ctx.log(`Regenerating PDF for ${company} — ${role} (report ${paddedNum})`);
  const result = await generateTailoredPdf({
    company,
    slug,
    num: paddedNum,
    jd,
    reportRel: path.relative(path.resolve(reportsDir, ".."), reportPath).replace(/\\/g, "/"),
    reportPath,
    log: ctx.log,
    setProgress: ctx.setProgress,
  });

  ctx.setProgress("Done", `Wrote ${path.basename(result.pdfPath)}`);
  return { pdfPath: result.pdfPath, htmlPath: result.htmlPath, company, role, slug };
}
