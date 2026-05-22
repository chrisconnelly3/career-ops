import fs from "node:fs/promises";
import path from "node:path";

import { userPaths, batchPaths } from "./paths";

export type ScreenerVerdict = "PASS" | "FAIL" | "UNKNOWN";

export type CareerApplication = {
  number: number; // row index (1-based within file parsing)
  date: string;
  company: string;
  role: string;
  scoreRaw: string;
  score: number;
  status: string;
  hasPdf: boolean;
  reportNumber: string;
  reportPath: string;
  notes: string;
  jobUrl?: string;
  /** Result of the last ATS Screener run, derived from the report footer or screen-*.md file. */
  screenerVerdict?: ScreenerVerdict;
  /** Number of Screener attempts in the most recent run (1 or 2). */
  screenerAttempts?: number;
};

export type PipelineMetrics = {
  total: number;
  actionable: number;
  withPdf: number;
  avgScore: number;
  topScore: number;
  byStatus: Record<string, number>;
};

const reReportLink = /\[(\d+)\]\(([^)]+)\)/;
const reScoreValue = /(\d+\.?\d*)\/5/;
const reReportURL = /(^|\n)\*\*URL:\*\*\s*(https?:\/\/\S+)/m;
const reBatchID = /(^|\n)\*\*Batch ID:\*\*\s*(\d+)/m;
const reScreenerLine = /\*\*ATS Screener:\*\*\s*(PASS|FAIL|UNKNOWN)\s*\((\d+)\s*attempt/i;

function normalizeCompany(name: string) {
  let s = name.toLowerCase().trim();
  for (const suffix of [
    " inc.",
    " inc",
    " llc",
    " ltd",
    " corp",
    " corporation",
    " technologies",
    " technology",
    " group",
    " co."
  ]) {
    if (s.endsWith(suffix)) s = s.slice(0, -suffix.length).trim();
  }
  return s;
}

export function normalizeStatus(raw: string): string {
  let s = raw.replaceAll("**", "").trim().toLowerCase();
  const idx = s.indexOf(" 202");
  if (idx > 0) s = s.slice(0, idx).trim();

  switch (true) {
    case s.includes("no aplicar") || s.includes("no_aplicar") || s === "skip" || s.includes("geo blocker"):
      return "skip";
    case s.includes("interview") || s.includes("entrevista"):
      return "interview";
    case s === "offer" || s.includes("oferta"):
      return "offer";
    case s.includes("responded") || s.includes("respondido"):
      return "responded";
    case s.includes("applied") || s.includes("aplicado") || s === "enviada" || s === "aplicada" || s === "sent":
      return "applied";
    case s.includes("rejected") || s.includes("rechazado") || s === "rechazada":
      return "rejected";
    case s.includes("discarded") ||
      s.includes("descartado") ||
      s === "descartada" ||
      s === "cerrada" ||
      s === "cancelada" ||
      s.startsWith("duplicado") ||
      s.startsWith("dup"):
      return "discarded";
    case s.includes("evaluated") ||
      s.includes("evaluada") ||
      s === "condicional" ||
      s === "hold" ||
      s === "monitor" ||
      s === "evaluar" ||
      s === "verificar":
      return "evaluated";
    default:
      return s;
  }
}

export function statusPriority(status: string): number {
  switch (normalizeStatus(status)) {
    case "interview": return 0;
    case "offer": return 1;
    case "responded": return 2;
    case "applied": return 3;
    case "evaluated": return 4;
    case "skip": return 5;
    case "rejected": return 6;
    case "discarded": return 7;
    default: return 8;
  }
}

export async function parseApplications(): Promise<CareerApplication[]> {
  let content: string;
  try {
    content = await fs.readFile(userPaths.applicationsMd, "utf-8");
  } catch {
    return [];
  }

  const lines = content.split("\n");
  const apps: CareerApplication[] = [];
  let num = 0;

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith("# ")) continue;
    if (line.startsWith("|---")) continue;
    if (line.startsWith("| #")) continue;
    if (!line.startsWith("|")) continue;

    // support mixed formats (pipe table vs tab-separated under leading pipe)
    let fields: string[] = [];
    if (line.includes("\t")) {
      line = line.replace(/^\|/, "").trim();
      const parts = line.split("\t");
      for (const p of parts) fields.push(p.trim().replace(/^\|/, "").replace(/\|$/, "").trim());
    } else {
      line = line.replace(/^\|/, "").replace(/\|$/, "");
      const parts = line.split("|");
      for (const p of parts) fields.push(p.trim());
    }

    if (fields.length < 8) continue;

    num++;
    const app: CareerApplication = {
      number: num,
      date: fields[1] ?? "",
      company: fields[2] ?? "",
      role: fields[3] ?? "",
      scoreRaw: fields[4] ?? "",
      score: 0,
      status: fields[5] ?? "",
      hasPdf: (fields[6] ?? "").includes("✅"),
      reportNumber: "",
      reportPath: "",
      notes: fields[8] ?? ""
    };

    const sm = reScoreValue.exec(app.scoreRaw);
    if (sm) app.score = Number.parseFloat(sm[1] ?? "0") || 0;

    const rm = reReportLink.exec(fields[7] ?? "");
    if (rm) {
      app.reportNumber = rm[1] ?? "";
      app.reportPath = rm[2] ?? "";
    }

    apps.push(app);
  }

  await enrichJobUrls(apps);
  return apps;
}

async function enrichJobUrls(apps: CareerApplication[]) {
  const batchUrls = await loadBatchInputUrls();
  const reportNumUrls = await loadReportNumUrlsFromBatchState();

  for (const app of apps) {
    if (!app.reportPath) continue;
    const fullReportPath = path.join(userPaths.reportsDir, path.basename(app.reportPath));
    let reportContent: string;
    try {
      reportContent = await fs.readFile(fullReportPath, "utf-8");
    } catch {
      continue;
    }

    let header = reportContent.slice(0, 1000);

    // The Screener verdict line is appended near the tail of the report — scan the
    // last 2KB rather than the header.
    const tail = reportContent.slice(Math.max(0, reportContent.length - 2000));
    const screenMatch = reScreenerLine.exec(tail);
    if (screenMatch) {
      const verdictRaw = (screenMatch[1] ?? "").toUpperCase();
      app.screenerVerdict = (verdictRaw === "PASS" || verdictRaw === "FAIL" || verdictRaw === "UNKNOWN")
        ? (verdictRaw as ScreenerVerdict)
        : undefined;
      const attempts = Number.parseInt(screenMatch[2] ?? "", 10);
      if (!Number.isNaN(attempts)) app.screenerAttempts = attempts;
    }

    const urlMatch = reReportURL.exec(header);
    if (urlMatch?.[2]) {
      app.jobUrl = urlMatch[2];
      continue;
    }

    const batchMatch = reBatchID.exec(header);
    if (batchMatch?.[2] && batchUrls[batchMatch[2]]) {
      app.jobUrl = batchUrls[batchMatch[2]];
      continue;
    }

    if (app.reportNumber && reportNumUrls[app.reportNumber]) {
      app.jobUrl = reportNumUrls[app.reportNumber];
      continue;
    }
  }

  await enrichFromScanHistory(apps);
  await enrichFromBatchInputByCompany(apps);
}

async function loadBatchInputUrls(): Promise<Record<string, string>> {
  let input: string;
  try {
    input = await fs.readFile(batchPaths.batchInputTsv, "utf-8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of input.split("\n")) {
    const fields = line.split("\t");
    if (fields.length < 4) continue;
    if (fields[0] === "id") continue;
    const id = fields[0]!.trim();
    const notes = fields[3]!.trim();
    const idx = notes.lastIndexOf("| ");
    if (idx >= 0) {
      const u = notes.slice(idx + 2).trim();
      if (u.startsWith("http")) { out[id] = u; continue; }
    }
    if ((fields[1] ?? "").startsWith("http")) out[id] = fields[1]!.trim();
  }
  return out;
}

async function loadReportNumUrlsFromBatchState(): Promise<Record<string, string>> {
  let input: string;
  let state: string;
  try {
    input = await fs.readFile(batchPaths.batchInputTsv, "utf-8");
    state = await fs.readFile(batchPaths.batchStateTsv, "utf-8");
  } catch {
    return {};
  }

  // parse batch-input entries keyed by id
  const entries: Record<string, { url: string }> = {};
  for (const line of input.split("\n")) {
    const fields = line.split("\t");
    if (fields.length < 4) continue;
    if (fields[0] === "id") continue;
    const id = fields[0]!.trim();
    const notes = fields[3]!.trim();
    let url = "";
    const idx = notes.lastIndexOf("| ");
    if (idx >= 0) {
      const u = notes.slice(idx + 2).trim();
      if (u.startsWith("http")) url = u;
    }
    if (!url && (fields[1] ?? "").startsWith("http")) url = fields[1]!.trim();
    if (url) entries[id] = { url };
  }

  const reportToUrl: Record<string, string> = {};
  for (const line of state.split("\n")) {
    const fields = line.split("\t");
    if (fields.length < 6) continue;
    if (fields[0] === "id") continue;
    const id = fields[0]!.trim();
    const status = (fields[2] ?? "").trim();
    const reportNum = (fields[5] ?? "").trim();
    if (status !== "completed" || !reportNum || reportNum === "-") continue;
    const entry = entries[id];
    if (!entry) continue;
    reportToUrl[reportNum] = entry.url;
    if (reportNum.length < 3) reportToUrl[reportNum.padStart(3, "0")] = entry.url;
  }
  return reportToUrl;
}

async function enrichFromScanHistory(apps: CareerApplication[]) {
  let scan: string;
  try {
    scan = await fs.readFile(userPaths.scanHistoryTsv, "utf-8");
  } catch {
    return;
  }

  type ScanEntry = { url: string; company: string; title: string };
  const byCompany: Record<string, ScanEntry[]> = {};

  for (const line of scan.split("\n")) {
    const fields = line.split("\t");
    if (fields.length < 5) continue;
    if (fields[0] === "url") continue;
    const url = (fields[0] ?? "").trim();
    const title = (fields[3] ?? "").trim();
    const company = (fields[4] ?? "").trim();
    if (!url.startsWith("http")) continue;
    const key = normalizeCompany(company);
    (byCompany[key] ??= []).push({ url, company, title });
  }

  for (const app of apps) {
    if (app.jobUrl) continue;
    const key = normalizeCompany(app.company);
    const matches = byCompany[key] ?? [];
    if (matches.length === 1) {
      app.jobUrl = matches[0]!.url;
    } else if (matches.length > 1) {
      const appRole = app.role.toLowerCase();
      let bestUrl = matches[0]!.url;
      let bestScore = -1;
      for (const m of matches) {
        const title = m.title.toLowerCase();
        let score = 0;
        for (const w of appRole.split(/\s+/)) {
          if (w.length > 2 && title.includes(w)) score++;
        }
        if (score > bestScore) { bestScore = score; bestUrl = m.url; }
      }
      app.jobUrl = bestUrl;
    }
  }
}

async function enrichFromBatchInputByCompany(apps: CareerApplication[]) {
  let input: string;
  try {
    input = await fs.readFile(batchPaths.batchInputTsv, "utf-8");
  } catch {
    return;
  }

  type Entry = { role: string; url: string };
  const byCompany: Record<string, Entry[]> = {};

  for (const line of input.split("\n")) {
    const fields = line.split("\t");
    if (fields.length < 4) continue;
    if (fields[0] === "id") continue;
    const notes = (fields[3] ?? "").trim();
    let url = "";
    const idx = notes.lastIndexOf("| ");
    if (idx >= 0) {
      const u = notes.slice(idx + 2).trim();
      if (u.startsWith("http")) url = u;
    }
    if (!url && (fields[1] ?? "").startsWith("http")) url = (fields[1] ?? "").trim();
    if (!url) continue;

    let notesPart = notes;
    const pipeIdx = notesPart.indexOf(" | ");
    if (pipeIdx >= 0) notesPart = notesPart.slice(0, pipeIdx);
    const atIdx = notesPart.lastIndexOf(" @ ");
    if (atIdx < 0) continue;

    const role = notesPart.slice(0, atIdx).trim();
    const company = notesPart.slice(atIdx + 3).trim();
    const key = normalizeCompany(company);
    (byCompany[key] ??= []).push({ role, url });
  }

  for (const app of apps) {
    if (app.jobUrl) continue;
    const key = normalizeCompany(app.company);
    const matches = byCompany[key] ?? [];
    if (matches.length === 1) {
      app.jobUrl = matches[0]!.url;
    } else if (matches.length > 1) {
      const appRole = app.role.toLowerCase();
      let bestUrl = matches[0]!.url;
      let bestScore = -1;
      for (const m of matches) {
        const role = m.role.toLowerCase();
        let score = 0;
        for (const w of appRole.split(/\s+/)) {
          if (w.length > 2 && role.includes(w)) score++;
        }
        if (score > bestScore) { bestScore = score; bestUrl = m.url; }
      }
      app.jobUrl = bestUrl;
    }
  }
}

export function computeMetrics(apps: CareerApplication[]): PipelineMetrics {
  const m: PipelineMetrics = {
    total: apps.length,
    actionable: 0,
    withPdf: 0,
    avgScore: 0,
    topScore: 0,
    byStatus: {}
  };

  let totalScore = 0;
  let scored = 0;

  for (const app of apps) {
    const s = normalizeStatus(app.status);
    m.byStatus[s] = (m.byStatus[s] ?? 0) + 1;

    if (app.score > 0) {
      totalScore += app.score;
      scored++;
      if (app.score > m.topScore) m.topScore = app.score;
    }
    if (app.hasPdf) m.withPdf++;
    if (s !== "skip" && s !== "rejected" && s !== "discarded") m.actionable++;
  }

  if (scored > 0) m.avgScore = totalScore / scored;
  return m;
}

