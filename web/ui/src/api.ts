export type ScreenerVerdict = "PASS" | "FAIL" | "UNKNOWN";

export type CareerApplication = {
  number: number;
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
  screenerVerdict?: ScreenerVerdict;
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

export type Job = {
  id: string;
  type: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  state: "queued" | "running" | "succeeded" | "failed";
  progress?: { step: string; detail?: string };
  logs: string[];
  result?: unknown;
  error?: string;
};

/** Returned when `job.type === "scan"` and job succeeded */
export type ScanJobResult = {
  added: number;
  companiesScanned: number;
  greenhouseBoards: number;
  leverBoards?: number;
  playwrightPages: number;
  failures: Array<{ company: string; error: string }>;
  diagnostics?: {
    trackedCompanies: number;
    apiJobRows: number;
    playwrightRows: number;
    filteredPositive: number;
    filteredNegative: number;
    duplicateUrl: number;
  };
  message: string;
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function getApplications() {
  return api<{ apps: CareerApplication[]; metrics: PipelineMetrics }>("/api/applications");
}

export function patchStatus(reportNumber: string, status: string) {
  return api<{ ok: true }>(`/api/applications/${encodeURIComponent(reportNumber)}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status })
  });
}

export function listReports() {
  return api<{ reports: { filename: string; relPath: string; mtimeMs: number }[] }>("/api/reports");
}

export function readReport(path: string) {
  return api<{ ok: true; markdown: string }>(`/api/reports/raw?path=${encodeURIComponent(path)}`);
}

export function createEvaluateJob(payload: { jdText?: string; jdUrl?: string }) {
  return api<{ ok: true; jobId: string }>("/api/jobs/evaluate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export function getJob(id: string) {
  return api<{ ok: true; job: Job }>(`/api/jobs/${encodeURIComponent(id)}`);
}

export function createScanJob() {
  return api<{ ok: true; jobId: string }>("/api/jobs/scan", { method: "POST" });
}

export function createPipelineJob(max?: number) {
  return api<{ ok: true; jobId: string }>("/api/jobs/pipeline", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(max ? { max } : {})
  });
}

export function runScript(name: "merge" | "verify" | "normalize" | "dedup") {
  return api<{ ok: true; jobId: string }>(`/api/jobs/scripts/${name}`, { method: "POST" });
}

export function getPdfInfo(reportNum: string) {
  return api<{ ok: true; found: boolean; filename?: string }>(`/api/pdf/info?reportNum=${encodeURIComponent(reportNum)}`);
}

export function pdfServeUrl(filename: string) {
  return `/api/pdf/serve/${encodeURIComponent(filename)}`;
}

export function revealPdf(filename: string) {
  return api<{ ok: true }>("/api/pdf/reveal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename }),
  });
}

export function regeneratePdf(reportNum: string) {
  return api<{ ok: true; jobId: string }>("/api/pdf/regenerate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reportNum }),
  });
}

export function readScreener(reportNum: string) {
  return api<{ ok: true; markdown: string }>(
    `/api/screener/raw?reportNum=${encodeURIComponent(reportNum)}`,
  );
}

export function saveInterviewTranscript(reportNumber: string, transcript: string) {
  return api<{ ok: true; path: string }>("/api/interview/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reportNumber, transcript }),
  });
}

export function getTtsStatus() {
  return api<{ ok: true; available: boolean; voice?: string; reason?: string }>("/api/tts/status");
}

/** Returns a blob URL the caller can hand to an <audio> element. Caller is
 *  responsible for revoking the URL with URL.revokeObjectURL() when done. */
export async function speakWithPiper(text: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch("/api/tts/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

