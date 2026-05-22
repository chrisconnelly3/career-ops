import React, { useEffect, useMemo, useState } from "react";

import { createEvaluateJob, createPipelineJob, createScanJob, getApplications, getJob, patchStatus, readReport, readScreener, regeneratePdf, runScript } from "./api";
import type { CareerApplication, Job, ScanJobResult } from "./api";
import { Chat } from "./Chat";
import type { InterviewContext } from "./Chat";
import { ReportView } from "./ReportView";

type View = "pipeline" | "evaluate" | "report" | "chat";

function InfoTip({ children }: { children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label="More info"
        onClick={() => setShow((v) => !v)}
        onBlur={() => setShow(false)}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-zinc-800/80 text-[9px] font-bold leading-none text-zinc-400 hover:bg-zinc-700/80 hover:text-zinc-200 transition"
      >
        i
      </button>
      {show && (
        <div className="absolute top-full right-0 z-50 mt-2 w-72 rounded-xl bg-zinc-800 p-4 text-[12px] leading-relaxed text-zinc-300 shadow-xl shadow-black/50 ring-1 ring-white/10">
          {children}
          <span className="absolute bottom-full right-3 border-[6px] border-transparent border-b-zinc-800" />
        </div>
      )}
    </span>
  );
}

const canonicalStatuses = ["Evaluated", "Applied", "Responded", "Interview", "Offer", "Rejected", "Discarded", "SKIP"] as const;

function classNames(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(" ");
}

function scanResultMessage(job: Job | null): string | null {
  if (!job || job.state !== "succeeded" || job.type !== "scan" || job.result == null) return null;
  const r = job.result as Partial<ScanJobResult>;
  return typeof r.message === "string" ? r.message : null;
}

/** YYYY-MM-DD, optional time (HH:mm or HH:mm:ss), or ISO; missing → sort last */
function parseAppDate(s: string): number | null {
  if (!s || s.trim() === "" || s === "—") return null;
  const t = s.trim();
  let ms = Date.parse(t);
  if (Number.isNaN(ms) && /^\d{4}-\d{2}-\d{2}$/.test(t)) {
    ms = Date.parse(`${t}T12:00:00`);
  }
  return Number.isNaN(ms) ? null : ms;
}

/** Report # as integer; missing / non-numeric → sort last */
function parseReportNumber(s: string): number | null {
  if (!s || s.trim() === "" || s === "—") return null;
  const n = parseInt(s.replace(/\D/g, ""), 10);
  return Number.isNaN(n) ? null : n;
}

export function App() {
  const [view, setView] = useState<View>("pipeline");
  const [apps, setApps] = useState<CareerApplication[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [activeStatus, setActiveStatus] = useState<string>("all");
  const [scoreSort, setScoreSort] = useState<"none" | "asc" | "desc">("none");
  /** Default: most recent first (same calendar day → higher report # first). */
  const [dateSort, setDateSort] = useState<"none" | "asc" | "desc">("desc");
  const [numSort, setNumSort] = useState<"none" | "asc" | "desc">("none");

  const [reportPath, setReportPath] = useState<string | null>(null);
  const [reportMd, setReportMd] = useState<string>("");

  const [jdUrl, setJdUrl] = useState("");
  const [jdText, setJdText] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [jobPoll, setJobPoll] = useState<number | null>(null);
  const [showJobLogs, setShowJobLogs] = useState(false);
  const [interviewContext, setInterviewContext] = useState<InterviewContext | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const data = await getApplications();
      setApps(data.apps);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!jobId) return;
    const id = window.setInterval(async () => {
      const data = await getJob(jobId);
      setJob(data.job);
      if (data.job.state === "succeeded" || data.job.state === "failed") {
        window.clearInterval(id);
        setJobPoll(null);
        // refresh pipeline since tracker/report may have changed
        void refresh();
      }
    }, 1000);
    setJobPoll(id);
    return () => window.clearInterval(id);
  }, [jobId]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const result = apps.filter((a) => {
      if (activeStatus !== "all") {
        if ((a.status || "").toLowerCase() !== activeStatus.toLowerCase()) return false;
      }
      if (!qq) return true;
      return (
        a.company.toLowerCase().includes(qq) ||
        a.role.toLowerCase().includes(qq) ||
        (a.notes || "").toLowerCase().includes(qq)
      );
    });
    if (numSort !== "none") {
      result.sort((a, b) => {
        const na = parseReportNumber(a.reportNumber);
        const nb = parseReportNumber(b.reportNumber);
        if (na === null && nb === null) return 0;
        if (na === null) return 1;
        if (nb === null) return -1;
        return numSort === "desc" ? nb - na : na - nb;
      });
    } else if (dateSort !== "none") {
      result.sort((a, b) => {
        const ta = parseAppDate(a.date);
        const tb = parseAppDate(b.date);
        let cmp = 0;
        if (ta === null && tb === null) cmp = 0;
        else if (ta === null) cmp = 1;
        else if (tb === null) cmp = -1;
        else cmp = dateSort === "desc" ? tb - ta : ta - tb;
        if (cmp !== 0) return cmp;
        const na = parseReportNumber(a.reportNumber);
        const nb = parseReportNumber(b.reportNumber);
        if (na === null && nb === null) return 0;
        if (na === null) return 1;
        if (nb === null) return -1;
        return dateSort === "desc" ? nb - na : na - nb;
      });
    } else if (scoreSort !== "none") {
      result.sort((a, b) => (scoreSort === "desc" ? b.score - a.score : a.score - b.score));
    }
    return result;
  }, [apps, q, activeStatus, scoreSort, dateSort, numSort]);

  const scanJobSummaryMessage = scanResultMessage(job);

  async function openReport(app: CareerApplication) {
    if (!app.reportPath) return;
    setReportPath(app.reportPath);
    setView("report");
    const data = await readReport(app.reportPath);
    setReportMd(data.markdown);
  }

  async function openScreener(app: CareerApplication) {
    if (!app.reportNumber) return;
    try {
      const data = await readScreener(app.reportNumber);
      setReportPath(`Screener verdict — ${app.company} (#${app.reportNumber})`);
      setReportMd(data.markdown);
      setView("report");
    } catch (e) {
      // Most likely no screener .md exists yet for older reports — fall back to the report.
      void openReport(app);
    }
  }

  async function rerunPdf(app: CareerApplication) {
    if (!app.reportNumber) return;
    const created = await regeneratePdf(app.reportNumber);
    setJobId(created.jobId);
    setJob(null);
  }

  function startInterview(app: CareerApplication) {
    if (!app.reportNumber || !app.company) return;
    setInterviewContext({
      reportNumber: app.reportNumber,
      company: app.company,
      role: app.role || "(unknown role)",
    });
    setView("chat");
  }

  function exitInterview() {
    setInterviewContext(null);
    setView("pipeline");
  }

  async function updateStatus(app: CareerApplication, status: string) {
    await patchStatus(app.reportNumber, status);
    await refresh();
  }

  async function startEvaluate() {
    const payload: { jdText?: string; jdUrl?: string } = {};
    if (jdUrl.trim()) payload.jdUrl = jdUrl.trim();
    if (jdText.trim()) payload.jdText = jdText.trim();
    const created = await createEvaluateJob(payload);
    setJobId(created.jobId);
    setJob(null);
  }

  async function startScan() {
    const created = await createScanJob();
    setJobId(created.jobId);
    setJob(null);
  }

  async function startPipeline() {
    const created = await createPipelineJob(5);
    setJobId(created.jobId);
    setJob(null);
  }

  async function startScript(name: "merge" | "verify" | "normalize" | "dedup") {
    const created = await runScript(name);
    setJobId(created.jobId);
    setJob(null);
  }

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-7xl px-6 py-6">
        <header className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <AvatarIllustration />
            <div>
              <div className="text-lg font-semibold tracking-tight">Jessica&apos;s Job Tracker</div>
              <div className="text-sm text-zinc-400">Local dashboard</div>
            </div>
          </div>

          <nav className="flex items-center gap-2 rounded-2xl bg-zinc-900/60 p-1 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
            <NavButton active={view === "pipeline" || view === "report"} onClick={() => setView("pipeline")}>Pipeline</NavButton>
            <NavButton active={view === "evaluate"} onClick={() => setView("evaluate")}>Evaluate</NavButton>
            <NavButton active={view === "chat"} onClick={() => setView("chat")}>Chat</NavButton>
          </nav>
        </header>

        <main className="mt-6">
          {view === "pipeline" && (
            <section className="rounded-3xl bg-zinc-900/30 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div className="flex items-center gap-3">
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search company, role, notes…"
                    className="w-full md:w-96 rounded-xl bg-zinc-950/60 px-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
                  />
                  <button
                    onClick={() => void refresh()}
                    className="rounded-xl bg-zinc-950/60 px-3 py-2 text-sm text-zinc-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-zinc-950/80"
                  >
                    {loading ? "Loading…" : "Refresh"}
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center">
                    <button
                      onClick={() => void startScan()}
                      className="rounded-xl bg-zinc-950/60 px-3 py-2 text-xs text-zinc-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.10)] hover:bg-zinc-950/80"
                    >
                      Scan
                    </button>
                    <InfoTip>
                      <div className="font-semibold text-zinc-100 mb-1.5">Scan job portals</div>
                      <div className="mb-2 text-amber-200/90">
                        The table above is your evaluation tracker (<span className="font-mono text-cyan-400">applications.md</span>). Scan adds new roles to <span className="font-mono text-cyan-400">data/pipeline.md</span> (Pending) — they appear here only after you run Process pipeline or merge tracker entries.
                      </div>
                      <div className="mb-2">Opens a headless browser and visits every company careers page listed in <span className="font-mono text-cyan-400">portals.yml</span>. Scrapes all job links, filters them against your title keywords, and deduplicates against previously seen URLs.</div>
                      <div className="grid gap-1.5 text-[11px]">
                        <div><span className="font-medium text-zinc-100">Reads:</span> portals.yml, data/scan-history.tsv, data/pipeline.md</div>
                        <div><span className="font-medium text-zinc-100">Writes:</span> new URLs added to data/pipeline.md under "Pending"; scan-history.tsv updated with seen URLs</div>
                        <div><span className="font-medium text-zinc-100">When to use:</span> periodically (every few days) to discover new job postings across your tracked companies</div>
                        <div><span className="font-medium text-zinc-100">Duration:</span> 1–5 min depending on how many companies are in your portals config</div>
                      </div>
                    </InfoTip>
                  </span>
                  <span className="inline-flex items-center">
                    <button
                      onClick={() => void startPipeline()}
                      className="rounded-xl bg-zinc-950/60 px-3 py-2 text-xs text-zinc-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.10)] hover:bg-zinc-950/80"
                    >
                      Process pipeline
                    </button>
                    <InfoTip>
                      <div className="font-semibold text-zinc-100 mb-1.5">Process pending pipeline URLs</div>
                      <div className="mb-2">Takes the first 5 unchecked URLs from <span className="font-mono text-cyan-400">data/pipeline.md</span> and runs a full A–F evaluation on each one. For every URL it: extracts the JD via headless browser, calls the AI to generate an evaluation report, writes the report to <span className="font-mono text-cyan-400">reports/</span>, creates a tracker TSV, merges it into the tracker, and generates a tailored PDF resume.</div>
                      <div className="grid gap-1.5 text-[11px]">
                        <div><span className="font-medium text-zinc-100">Reads:</span> data/pipeline.md, cv.md, profile.yml, modes/*.md</div>
                        <div><span className="font-medium text-zinc-100">Writes:</span> one report + one PDF + one tracker entry per URL evaluated</div>
                        <div><span className="font-medium text-zinc-100">When to use:</span> after a Scan has added new URLs, or after manually adding URLs to pipeline.md</div>
                        <div><span className="font-medium text-zinc-100">Duration:</span> 3–8 min per URL (AI evaluation + PDF generation)</div>
                        <div><span className="font-medium text-zinc-100">Requires:</span> ANTHROPIC_API_KEY set in .env</div>
                      </div>
                    </InfoTip>
                  </span>
                  <span className="inline-flex items-center">
                    <button
                      onClick={() => void startScript("merge")}
                      className="rounded-xl bg-zinc-950/60 px-3 py-2 text-xs text-zinc-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.10)] hover:bg-zinc-950/80"
                    >
                      Merge tracker
                    </button>
                    <InfoTip>
                      <div className="font-semibold text-zinc-100 mb-1.5">Merge batch results into tracker</div>
                      <div className="mb-2">Reads all <span className="font-mono text-cyan-400">.tsv</span> files from <span className="font-mono text-cyan-400">batch/tracker-additions/</span> and merges them into the pipeline table (<span className="font-mono text-cyan-400">data/applications.md</span>). Deduplicates by company + role — if a duplicate is found with a higher score, it updates the existing entry in-place. Processed TSVs are moved to a <span className="font-mono text-cyan-400">merged/</span> subfolder.</div>
                      <div className="grid gap-1.5 text-[11px]">
                        <div><span className="font-medium text-zinc-100">Reads:</span> batch/tracker-additions/*.tsv, data/applications.md</div>
                        <div><span className="font-medium text-zinc-100">Writes:</span> updated data/applications.md; moves TSVs to merged/</div>
                        <div><span className="font-medium text-zinc-100">When to use:</span> after evaluations complete, or if the pipeline table seems out of sync with your reports</div>
                        <div><span className="font-medium text-zinc-100">Duration:</span> instant (under 1 second)</div>
                      </div>
                    </InfoTip>
                  </span>

                  <label className="flex items-center gap-2 rounded-xl bg-zinc-950/40 px-3 py-2 text-xs text-zinc-300 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.10)]">
                    <span className="text-zinc-400">Status</span>
                    <select
                      value={activeStatus}
                      onChange={(e) => setActiveStatus(e.target.value)}
                      className="rounded-lg bg-zinc-950/60 px-2 py-1 text-xs text-zinc-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
                      aria-label="Filter by status"
                    >
                      <option value="all">All</option>
                      {canonicalStatuses.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              <div className="mt-5 overflow-hidden rounded-2xl shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
                <table className="w-full text-left text-sm">
                  <thead className="bg-zinc-950/40 text-zinc-300">
                    <tr>
                      <th
                        onClick={() => {
                          setNumSort((s) => {
                            const next = s === "none" ? "desc" : s === "desc" ? "asc" : "none";
                            if (next !== "none") {
                              setDateSort("none");
                              setScoreSort("none");
                            }
                            return next;
                          });
                        }}
                        className="px-4 py-3 text-xs font-semibold uppercase tracking-wide cursor-pointer select-none hover:text-zinc-100 transition"
                      >
                        #{" "}
                        <span className="text-zinc-500">
                          {numSort === "desc" ? "↓" : numSort === "asc" ? "↑" : "⇅"}
                        </span>
                      </th>
                      <th
                        onClick={() => {
                          setDateSort((s) => {
                            const next = s === "none" ? "desc" : s === "desc" ? "asc" : "none";
                            if (next !== "none") {
                              setScoreSort("none");
                              setNumSort("none");
                            }
                            return next;
                          });
                        }}
                        className="px-4 py-3 text-xs font-semibold uppercase tracking-wide cursor-pointer select-none hover:text-zinc-100 transition"
                      >
                        Date{" "}
                        <span className="text-zinc-500">
                          {dateSort === "desc" ? "↓" : dateSort === "asc" ? "↑" : "⇅"}
                        </span>
                      </th>
                      <Th>Company</Th>
                      <Th>Role</Th>
                      <th
                        onClick={() => {
                          setScoreSort((s) => {
                            const next = s === "none" ? "desc" : s === "desc" ? "asc" : "none";
                            if (next !== "none") {
                              setDateSort("none");
                              setNumSort("none");
                            }
                            return next;
                          });
                        }}
                        className="px-4 py-3 text-xs font-semibold uppercase tracking-wide cursor-pointer select-none hover:text-zinc-100 transition"
                      >
                        Score{" "}
                        <span className="text-zinc-500">
                          {scoreSort === "desc" ? "↓" : scoreSort === "asc" ? "↑" : "⇅"}
                        </span>
                      </th>
                      <Th>Status</Th>
                      <Th>ATS</Th>
                      <Th>Actions</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/80 bg-zinc-950/20">
                    {filtered.map((a) => (
                      <tr key={`${a.reportNumber}-${a.company}-${a.role}`} className="hover:bg-zinc-950/35">
                        <Td className="text-zinc-400">{a.reportNumber || "—"}</Td>
                        <Td className="text-zinc-400">{a.date || "—"}</Td>
                        <Td className="font-medium">{a.company}</Td>
                        <Td className="text-zinc-200">{a.role}</Td>
                        <Td>
                          <span className="rounded-lg bg-zinc-950/60 px-2 py-1 text-xs text-zinc-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
                            {a.scoreRaw || "—"}
                          </span>
                        </Td>
                        <Td>
                          <select
                            value={a.status}
                            onChange={(e) => void updateStatus(a, e.target.value)}
                            className="rounded-xl bg-zinc-950/60 px-3 py-2 text-sm text-zinc-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
                          >
                            {canonicalStatuses.map((s) => (
                              <option key={s} value={s}>{s}</option>
                            ))}
                          </select>
                        </Td>
                        <Td>
                          <ScreenerBadge
                            verdict={a.screenerVerdict}
                            attempts={a.screenerAttempts}
                            onClick={() => void openScreener(a)}
                          />
                        </Td>
                        <Td>
                          <div className="flex flex-wrap gap-2">
                            {a.jobUrl && (
                              <a
                                href={a.jobUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="rounded-xl bg-zinc-950/60 px-3 py-2 text-xs text-zinc-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-zinc-950/80"
                              >
                                Open JD
                              </a>
                            )}
                            {a.reportPath && (
                              <button
                                onClick={() => void openReport(a)}
                                className="rounded-xl bg-gradient-to-r from-cyan-500/20 to-fuchsia-500/20 px-3 py-2 text-xs text-zinc-100 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)] hover:from-cyan-500/30 hover:to-fuchsia-500/30"
                              >
                                View report
                              </button>
                            )}
                            {a.reportNumber && (
                              <button
                                onClick={() => void rerunPdf(a)}
                                title="Re-run Recruiter + Screener and regenerate the PDF for this report"
                                className="rounded-xl bg-zinc-950/60 px-3 py-2 text-xs text-zinc-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-zinc-950/80"
                              >
                                Re-run
                              </button>
                            )}
                            {a.reportNumber && (
                              <button
                                onClick={() => startInterview(a)}
                                title="Open a Decision Maker mock interview scoped to this role"
                                className="rounded-xl bg-fuchsia-500/15 px-3 py-2 text-xs text-fuchsia-100 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.10)] hover:bg-fuchsia-500/25"
                              >
                                Interview prep
                              </button>
                            )}
                          </div>
                        </Td>
                      </tr>
                    ))}
                    {filtered.length === 0 && (
                      <tr>
                        <td colSpan={8} className="p-8 text-center text-zinc-400">
                          No results. Run an evaluation first.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {view === "evaluate" && (
            <section className="mx-auto max-w-2xl rounded-3xl bg-zinc-900/30 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
              <div className="text-base font-semibold">New evaluation</div>
              <div className="mt-1 text-sm text-zinc-400">
                Paste a job URL or JD text. This will write a report under <span className="text-zinc-200">reports/</span> and update your tracker.
              </div>

              <div className="mt-4 grid gap-3">
                <label className="grid gap-1">
                  <span className="text-xs text-zinc-400">Job URL (optional)</span>
                  <input
                    value={jdUrl}
                    onChange={(e) => setJdUrl(e.target.value)}
                    placeholder="https://..."
                    className="rounded-xl bg-zinc-950/60 px-4 py-2 text-sm shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-xs text-zinc-400">Job description text (optional)</span>
                  <textarea
                    value={jdText}
                    onChange={(e) => setJdText(e.target.value)}
                    rows={10}
                    placeholder="Paste the JD here…"
                    className="rounded-xl bg-zinc-950/60 px-4 py-3 text-sm shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
                  />
                </label>
                <button
                  onClick={() => void startEvaluate()}
                  className="mt-1 rounded-2xl bg-gradient-to-r from-cyan-400 to-fuchsia-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:opacity-95"
                >
                  Start evaluation
                </button>
                <div className="text-xs text-zinc-400">
                  Note: set <span className="text-zinc-200">ANTHROPIC_API_KEY</span> before running evaluations.
                </div>
              </div>
            </section>
          )}

          {view === "chat" && (
            <Chat interviewContext={interviewContext} onExitInterview={exitInterview} />
          )}

          {view === "report" && (
            <section>
              {!reportPath ? (
                <div className="rounded-3xl bg-zinc-900/30 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] text-sm text-zinc-400">
                  Open a report from the Pipeline tab.
                </div>
              ) : (
                <ReportView
                  markdown={reportMd}
                  reportPath={reportPath}
                  onBack={() => setView("pipeline")}
                />
              )}
            </section>
          )}
        </main>
      </div>

      {jobId && (
        <div className="fixed bottom-0 inset-x-0 z-50 border-t border-zinc-800/60 bg-zinc-950/95 backdrop-blur-lg">
          <div className="mx-auto max-w-7xl px-6 py-3">
            <div className="flex items-start gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xs text-zinc-400">Job</span>
                  <span className="truncate text-xs text-zinc-200">{jobId}</span>
                  <span
                    className={classNames(
                      "rounded-lg px-2 py-0.5 text-xs shadow-[inset_0_0_0_1px_rgba(255,255,255,0.10)]",
                      job?.state === "succeeded" && "bg-emerald-500/15 text-emerald-200",
                      job?.state === "failed" && "bg-rose-500/15 text-rose-200",
                      (job?.state === "running" || job?.state === "queued" || !job) && "bg-zinc-900/80 text-zinc-200"
                    )}
                  >
                    {job?.state || "queued"}
                  </span>
                  {jobPoll && <span className="h-2 w-2 animate-pulse rounded-full bg-cyan-400" />}
                </div>
                <div className="mt-1 text-sm text-zinc-200">
                  {job?.progress?.step || "Waiting…"}
                  {job?.progress?.detail && <span className="ml-2 text-xs text-zinc-400">{job.progress.detail}</span>}
                </div>
                {scanJobSummaryMessage && (
                  <div className="mt-1 text-sm text-emerald-200/95">{scanJobSummaryMessage}</div>
                )}
                {job?.error && <div className="mt-1 text-xs text-rose-300">{job.error}</div>}
              </div>

              <button
                onClick={() => setShowJobLogs((p) => !p)}
                className="shrink-0 rounded-lg bg-zinc-900/80 px-2.5 py-1.5 text-xs text-zinc-300 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-zinc-900"
              >
                {showJobLogs ? "Hide logs" : "Show logs"}
              </button>

              {(job?.state === "succeeded" || job?.state === "failed") && (
                <button
                  onClick={() => { setJobId(null); setJob(null); setShowJobLogs(false); }}
                  className="shrink-0 rounded-lg bg-zinc-900/80 px-2.5 py-1.5 text-xs text-zinc-300 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-zinc-900"
                >
                  Dismiss
                </button>
              )}
            </div>

            {showJobLogs && (
              <pre className="mt-2 max-h-48 overflow-auto rounded-xl bg-zinc-950/60 p-3 text-xs leading-relaxed text-zinc-300 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
                {(job?.logs || []).slice(-200).join("\n") || "—"}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NavButton(props: { active: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      disabled={props.disabled}
      onClick={props.onClick}
      className={classNames(
        "rounded-2xl px-4 py-2 text-sm transition",
        props.active
          ? "bg-zinc-950/70 text-zinc-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]"
          : "text-zinc-300 hover:bg-zinc-950/50",
        props.disabled && "opacity-40 hover:bg-transparent"
      )}
    >
      {props.children}
    </button>
  );
}

function AvatarIllustration() {
  return (
    <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-zinc-900/80 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
      <svg viewBox="0 0 64 64" className="h-10 w-10" aria-hidden="true">
        <rect x="0" y="0" width="64" height="64" rx="14" fill="#18181b" />
        <path d="M16 61c1-12 9-18 16-18s15 6 16 18" fill="#f472b6" opacity="0.85" />
        <ellipse cx="32" cy="28" rx="16" ry="18" fill="#4a2f24" />
        <path d="M18 29c0-12 7-20 14-20 10 0 16 8 16 18 0 3-1 6-2 8-2-4-6-7-11-7-7 0-13 5-17 10-1-3 0-6 0-9Z" fill="#5b3728" />
        <circle cx="32" cy="31" r="12" fill="#f4c7a1" />
        {/* Two separate brows — a single path here read as one connected line (unibrow) */}
        <path d="M21 28 Q25 25.5 29 28" stroke="#5b3728" strokeWidth="1.75" strokeLinecap="round" fill="none" />
        <path d="M35 28 Q39 25.5 43 28" stroke="#5b3728" strokeWidth="1.75" strokeLinecap="round" fill="none" />
        <circle cx="28" cy="32" r="1.4" fill="#3f2a1f" />
        <circle cx="36" cy="32" r="1.4" fill="#3f2a1f" />
        <path d="M29 37c1 1 2 1.5 3 1.5s2-.5 3-1.5" stroke="#b4536a" strokeWidth="2" strokeLinecap="round" fill="none" />
        <path d="M21 27c1-8 6-14 11-14 8 0 13 5 15 13-3-3-8-5-14-5-5 0-9 2-12 6Z" fill="#3f2a1f" />
        <circle cx="48" cy="14" r="4" fill="#22d3ee" opacity="0.9" />
      </svg>
    </div>
  );
}

function ScreenerBadge(props: {
  verdict?: "PASS" | "FAIL" | "UNKNOWN";
  attempts?: number;
  onClick: () => void;
}) {
  const { verdict, attempts, onClick } = props;
  if (!verdict) {
    return <span className="text-xs text-zinc-500">—</span>;
  }
  const cls =
    verdict === "PASS"
      ? "bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
      : verdict === "FAIL"
      ? "bg-rose-500/20 text-rose-200 hover:bg-rose-500/30"
      : "bg-zinc-700/40 text-zinc-200 hover:bg-zinc-700/60";
  const label = verdict === "PASS" ? "PASS" : verdict === "FAIL" ? "FAIL" : "?";
  const detail =
    attempts && attempts > 1
      ? `Click to see why (${attempts} attempts)`
      : "Click to see Screener details";
  return (
    <button
      onClick={onClick}
      title={detail}
      className={classNames(
        "inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-semibold tracking-wide shadow-[inset_0_0_0_1px_rgba(255,255,255,0.10)] transition",
        cls,
      )}
    >
      <span>{label}</span>
      {attempts && attempts > 1 && (
        <span className="text-[10px] font-normal opacity-80">×{attempts}</span>
      )}
    </button>
  );
}

function Th(props: { children: React.ReactNode }) {
  return <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide">{props.children}</th>;
}

function Td(props: { children: React.ReactNode; className?: string }) {
  return <td className={classNames("px-4 py-3 align-top", props.className)}>{props.children}</td>;
}

