import fs from "node:fs/promises";
import YAML from "yaml";

import { chromium } from "playwright";

import { userPaths } from "./paths";

type TrackedCompany = {
  name: string;
  careers_url: string;
  enabled?: boolean;
  api?: string;
};

type PortalsConfig = {
  title_filter?: {
    positive?: string[];
    negative?: string[];
  };
  tracked_companies?: TrackedCompany[];
};

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function includesAny(haystack: string, needles: string[]) {
  const h = haystack.toLowerCase();
  return needles.some((n) => n && h.includes(n.toLowerCase()));
}

/** e.g. job-boards.greenhouse.io/anthropic → anthropic */
export function greenhouseBoardToken(careersUrl: string): string | null {
  const m = careersUrl.match(
    /(?:job-boards|boards)\.(?:eu\.)?greenhouse\.io\/([^/?#]+)/i
  );
  return m?.[1]?.trim() || null;
}

/** jobs.lever.co/acme → acme */
export function leverBoardSlug(careersUrl: string): string | null {
  const m = careersUrl.match(/jobs\.lever\.(?:co|[a-z]+)\/([^/?#]+)/i);
  return m?.[1]?.trim() || null;
}

async function fetchGreenhouseJobs(
  boardToken: string,
  log: (l: string) => void
): Promise<Array<{ title: string; url: string }>> {
  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs`;
  log(`Greenhouse API: GET ${apiUrl}`);
  const res = await fetch(apiUrl);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = (await res.json()) as { jobs?: Array<{ title?: string; absolute_url?: string }> };
  const jobs = data.jobs ?? [];
  return jobs
    .filter((j) => j.title && j.absolute_url)
    .map((j) => ({
      title: String(j.title).replace(/\s+/g, " ").trim(),
      url: String(j.absolute_url).trim()
    }));
}

async function fetchLeverJobs(boardSlug: string, log: (l: string) => void): Promise<Array<{ title: string; url: string }>> {
  const apiUrl = `https://api.lever.co/v0/postings/${encodeURIComponent(boardSlug)}?mode=json`;
  log(`Lever API: GET ${apiUrl}`);
  const res = await fetch(apiUrl);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const arr = (await res.json()) as unknown;
  if (!Array.isArray(arr)) {
    return [];
  }
  return arr
    .map((posting: { text?: string; hostedUrl?: string; applyUrl?: string; urls?: { show?: string } }) => {
      const title = String(posting?.text ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const url =
        String(posting?.hostedUrl || posting?.urls?.show || posting?.applyUrl || "").trim();
      return title && url ? { title, url } : null;
    })
    .filter((x): x is { title: string; url: string } => x !== null);
}

async function readSeenUrls(): Promise<Set<string>> {
  try {
    const tsv = await fs.readFile(userPaths.scanHistoryTsv, "utf-8");
    const seen = new Set<string>();
    for (const line of tsv.split("\n")) {
      const [url] = line.split("\t");
      if (url && url !== "url") seen.add(url.trim());
    }
    return seen;
  } catch {
    return new Set();
  }
}

async function readPipelineUrls(): Promise<Set<string>> {
  try {
    const md = await fs.readFile(userPaths.pipelineMd, "utf-8");
    const urls = new Set<string>();
    for (const line of md.split("\n")) {
      const m = line.match(/https?:\/\/[^\s|)]+/);
      if (m?.[0]) urls.add(m[0].replace(/[),.;]+$/, ""));
    }
    return urls;
  } catch {
    return new Set();
  }
}

async function ensureFiles() {
  await fs.mkdir(userPaths.reportsDir, { recursive: true });
  await fs.mkdir(userPaths.outputDir, { recursive: true });
  await fs.mkdir(userPaths.jdsDir, { recursive: true });
  await fs.mkdir("data", { recursive: true }).catch(() => {});

  try {
    await fs.access(userPaths.scanHistoryTsv);
  } catch {
    await fs.writeFile(userPaths.scanHistoryTsv, "url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n", "utf-8");
  }
  try {
    await fs.access(userPaths.pipelineMd);
  } catch {
    await fs.writeFile(userPaths.pipelineMd, ["# Pipeline", "", "## Pending", "", "## Done", ""].join("\n"), "utf-8");
  }
}

type TryAddOutcome = "added" | "dup" | "neg" | "pos" | "";

function tryAddJob(
  title: string,
  url: string,
  company: string,
  source: string,
  positive: string[],
  negative: string[],
  seen: Set<string>,
  inPipeline: Set<string>,
  found: Array<{ company: string; title: string; url: string; source: string }>
): TryAddOutcome {
  if (!title.trim()) return "";
  if (negative.length && includesAny(title, negative)) return "neg";
  if (positive.length && !includesAny(title, positive)) return "pos";
  if (seen.has(url) || inPipeline.has(url)) return "dup";
  found.push({ company, title, url, source });
  seen.add(url);
  return "added";
}

export type ScanDiagnostics = {
  trackedCompanies: number;
  /** Raw rows from ATS APIs before filters */
  apiJobRows: number;
  /** Link rows collected from Playwright before keyword filter */
  playwrightRows: number;
  filteredPositive: number;
  filteredNegative: number;
  duplicateUrl: number;
};

export type ScanJobResult = {
  added: number;
  companiesScanned: number;
  greenhouseBoards: number;
  leverBoards: number;
  playwrightPages: number;
  failures: Array<{ company: string; error: string }>;
  diagnostics: ScanDiagnostics;
  /** User-facing summary for the dashboard */
  message: string;
};

function buildEmptyMessage(params: {
  failures: Array<{ company: string; error: string }>;
  trackedCompanies: number;
  diagnostics: ScanDiagnostics;
}): string {
  const { failures, trackedCompanies, diagnostics: d } = params;
  if (trackedCompanies === 0) {
    return 'No sites to scan — your portals list has no active companies with career URLs. Add entries under tracked companies or copy portals list from example template.';
  }
  const allFailed =
    failures.length > 0 && failures.length >= trackedCompanies && d.apiJobRows === 0 && d.playwrightRows === 0;
  if (allFailed) {
    return `Scan could not load job listings (${failures.length} problem(s)). Open job logs for detail — often fixes: network/timeouts or site blocking automated browsers.`;
  }
  const parts: string[] = [];
  parts.push('No new openings added.');
  if (failures.length > 0) {
    parts.push(`${failures.length} site(s) had errors — see logs below.`);
  }
  const sawJobs = d.apiJobRows + d.playwrightRows > 0;
  if (!sawJobs && failures.length === 0) {
    parts.push(
      'No obvious job links were found on scraped pages (many careers sites hide listings behind buttons or SPA loads). Prefer Greenhouse or Lever career URLs where possible.'
    );
  }
  const totalSeenApprox = d.apiJobRows + d.playwrightRows;
  if (
    sawJobs &&
    d.duplicateUrl > 0 &&
    totalSeenApprox > 0 &&
    d.filteredPositive === 0 &&
    d.filteredNegative === 0 &&
    d.duplicateUrl >= totalSeenApprox
  ) {
    parts.push(
      'Every listing was already captured — same links as your inbox list or scan history.'
    );
  }
  if (d.filteredPositive > 0) {
    parts.push(
      `${d.filteredPositive} role title(s) were skipped — none contained your keyword list (title filter positive). Relax or widen those words in portals list under title filter positive.`
    );
  }
  if (d.filteredNegative > 0 && d.filteredPositive === 0) {
    parts.push(`${d.filteredNegative} role(s) were skipped by exclusion keywords (title filter negative).`);
  }
  if (parts.length === 1) {
    return parts[0];
  }
  return parts.join(' ');
}

export async function runScanJob(opts: {
  log: (l: string) => void;
  setProgress: (s: string, d?: string) => void;
}): Promise<ScanJobResult> {
  await ensureFiles();
  opts.setProgress("Reading portals.yml");
  const portalsYml = await fs.readFile(userPaths.portalsYml, "utf-8");
  const cfg = YAML.parse(portalsYml) as PortalsConfig;

  const positive = cfg.title_filter?.positive ?? [];
  const negative = cfg.title_filter?.negative ?? [];
  const companies = (cfg.tracked_companies ?? []).filter((c) => c.enabled !== false && c.careers_url);

  const seen = await readSeenUrls();
  const inPipeline = await readPipelineUrls();

  const found: Array<{ company: string; title: string; url: string; source: string }> = [];
  const failures: Array<{ company: string; error: string }> = [];
  let greenhouseBoards = 0;
  let leverBoards = 0;
  let playwrightPages = 0;

  const diagnostics: ScanDiagnostics = {
    trackedCompanies: companies.length,
    apiJobRows: 0,
    playwrightRows: 0,
    filteredPositive: 0,
    filteredNegative: 0,
    duplicateUrl: 0
  };

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    for (const c of companies) {
      opts.setProgress("Scanning", c.name);

      const ghToken = greenhouseBoardToken(c.careers_url);
      if (ghToken) {
        greenhouseBoards++;
        try {
          opts.log(`Scanning ${c.name} via Greenhouse API (board: ${ghToken})`);
          const jobs = await fetchGreenhouseJobs(ghToken, opts.log);
          opts.log(`  → ${jobs.length} open roles from API`);
          diagnostics.apiJobRows += jobs.length;
          for (const job of jobs) {
            const o = tryAddJob(job.title, job.url, c.name, c.careers_url, positive, negative, seen, inPipeline, found);
            if (o === "pos") diagnostics.filteredPositive++;
            else if (o === "neg") diagnostics.filteredNegative++;
            else if (o === "dup") diagnostics.duplicateUrl++;
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          failures.push({ company: c.name, error: msg });
          opts.log(`Greenhouse API failed for ${c.name}: ${msg}`);
        }
        continue;
      }

      const leverSlug = leverBoardSlug(c.careers_url);
      if (leverSlug) {
        leverBoards++;
        try {
          opts.log(`Scanning ${c.name} via Lever API (slug: ${leverSlug})`);
          const jobs = await fetchLeverJobs(leverSlug, opts.log);
          opts.log(`  → ${jobs.length} open roles from API`);
          diagnostics.apiJobRows += jobs.length;
          for (const job of jobs) {
            const o = tryAddJob(job.title, job.url, c.name, c.careers_url, positive, negative, seen, inPipeline, found);
            if (o === "pos") diagnostics.filteredPositive++;
            else if (o === "neg") diagnostics.filteredNegative++;
            else if (o === "dup") diagnostics.duplicateUrl++;
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          failures.push({ company: c.name, error: msg });
          opts.log(`Lever API failed for ${c.name}: ${msg}`);
        }
        continue;
      }

      if (!browser) {
        opts.setProgress("Launching browser");
        browser = await chromium.launch({ headless: true });
      }
      playwrightPages++;
      const page = await browser.newPage();
      try {
        opts.log(`Scanning ${c.name} (Playwright): ${c.careers_url}`);
        // `networkidle` hangs forever on sites with long-polling / analytics
        // beacons. DOM-content-loaded is enough — the waitForTimeout below
        // gives SPA job boards a beat to hydrate before we read links.
        await page.goto(c.careers_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(2000);
        const links = await page.evaluate(() => {
          const jobLikeHref = (href: string) =>
            /\/(job|jobs|jobboard|opening|posting|position|vacancy|requisition)s?\b|[?&/](job|opening)\=/i.test(
              href
            ) ||
            /greenhouse|lever\.co|workdayjobs|smartrecruiters|ashbyhq|icims|taleo|myworkdaysite/i.test(href);

          const anchors = Array.from(document.querySelectorAll("a[href]"));
          type Row = { href: string; text: string };
          const rows: Row[] = [];
          for (const node of anchors) {
            const a = node as Element & { href: string };
            const href = String(a.href || "");
            if (!href.startsWith("http")) continue;

            let text = String(a.textContent || "")
              .replace(/\s+/g, " ")
              .trim();
            if (!text.length) {
              text = (
                String(a.getAttribute?.("aria-label") || "") ||
                String(a.getAttribute?.("title") || "") ||
                ""
              ).trim();
            }

            const minLen = jobLikeHref(href) ? 3 : 6;
            if (text.length >= minLen) {
              rows.push({ href, text });
            }
          }
          return rows;
        });

        diagnostics.playwrightRows += links.length;
        let addedHere = 0;
        for (const l of links) {
          const title = l.text.replace(/\s+/g, " ").trim();
          if (!title) continue;
          const o = tryAddJob(title, l.href, c.name, c.careers_url, positive, negative, seen, inPipeline, found);
          if (o === "pos") diagnostics.filteredPositive++;
          else if (o === "neg") diagnostics.filteredNegative++;
          else if (o === "dup") diagnostics.duplicateUrl++;
          else if (o === "added") addedHere++;
        }
        opts.log(`  → ${links.length} job-like links scraped, ${addedHere} newly added URLs from this site`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push({ company: c.name, error: msg });
        opts.log(`Scan failed for ${c.name}: ${msg}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  opts.setProgress("Writing pipeline + scan history");
  const pipeline = await fs.readFile(userPaths.pipelineMd, "utf-8");
  const lines = pipeline.split("\n");
  let pendingIdx = lines.findIndex((l) => l.trim().toLowerCase() === "## pending");
  if (pendingIdx === -1) {
    lines.unshift("## Pending", "");
    pendingIdx = 0;
  }
  const insertAt = pendingIdx + 1;
  const newLines = found.map((f) => `- [ ] ${f.url} | ${f.company} | ${f.title}`);
  lines.splice(insertAt, 0, ...newLines, "");
  await fs.writeFile(userPaths.pipelineMd, lines.join("\n"), "utf-8");

  const scanRows = found.map((f) => `${f.url}\t${todayYmd()}\tscan\t${f.title}\t${f.company}\tadded`);
  const scanPrev = await fs.readFile(userPaths.scanHistoryTsv, "utf-8");
  await fs.writeFile(userPaths.scanHistoryTsv, scanPrev.trimEnd() + "\n" + scanRows.join("\n") + "\n", "utf-8");

  const companiesScanned = companies.length;
  let message: string;
  if (found.length === 0) {
    message = buildEmptyMessage({ failures, trackedCompanies: companies.length, diagnostics });
  } else {
    message = `Added ${found.length} new URL(s) to pipeline pending list — use Process pipeline when you want evaluations.`;
  }

  return {
    added: found.length,
    companiesScanned,
    greenhouseBoards,
    leverBoards,
    playwrightPages,
    failures,
    diagnostics,
    message
  };
}
