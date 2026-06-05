import React, { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { parseReport, type ParsedReport } from "./reportParser";
import { getPdfInfo, pdfServeUrl, revealPdf } from "./api";

function cn(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(" ");
}

/* ─── Score ring ────────────────────────────────────── */

function ScoreRing({ score, size = 72, stroke = 5 }: { score: number; size?: number; stroke?: number }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.min(score / 5, 1);
  const offset = circumference * (1 - pct);
  const color =
    score >= 4.5 ? "#22d3ee" : score >= 4.0 ? "#34d399" : score >= 3.5 ? "#fbbf24" : "#f87171";

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.6s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg font-bold leading-none" style={{ color }}>{score.toFixed(1)}</span>
        <span className="text-[10px] text-zinc-500 leading-none mt-0.5">/5</span>
      </div>
    </div>
  );
}

/* ─── Mini score bar (for dimension rows) ───────────── */

function MiniBar({ score, max = 5 }: { score: number; max?: number }) {
  const pct = Math.min(score / max, 1) * 100;
  const color =
    score >= 4.5 ? "bg-cyan-400" : score >= 4.0 ? "bg-emerald-400" : score >= 3.5 ? "bg-amber-400" : "bg-rose-400";
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="h-1.5 flex-1 rounded-full bg-zinc-800">
        <div className={cn("h-full rounded-full transition-all duration-500", color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-zinc-300">{score.toFixed(1)}</span>
    </div>
  );
}

/* ─── Strength chip ─────────────────────────────────── */

function StrengthChip({ strength }: { strength: string }) {
  const map: Record<string, { bg: string; text: string; label: string }> = {
    strong: { bg: "bg-emerald-500/15", text: "text-emerald-300", label: "Strong" },
    moderate: { bg: "bg-amber-500/15", text: "text-amber-300", label: "Moderate" },
    gap: { bg: "bg-rose-500/15", text: "text-rose-300", label: "Gap" },
    mitigable: { bg: "bg-sky-500/15", text: "text-sky-300", label: "Mitigable" },
  };
  const m = map[strength] || map.moderate!;
  return (
    <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium", m.bg, m.text)}>
      {m.label}
    </span>
  );
}

/* ─── Recommendation badge ──────────────────────────── */

function RecommendationBadge({ rec }: { rec: ParsedReport["recommendation"] }) {
  const map: Record<string, { bg: string; text: string; label: string; icon: string }> = {
    apply: { bg: "bg-emerald-500/15 border-emerald-500/25", text: "text-emerald-200", label: "Recommended — Apply", icon: "✓" },
    "apply-caution": { bg: "bg-amber-500/15 border-amber-500/25", text: "text-amber-200", label: "Worth pursuing — review gaps", icon: "◐" },
    consider: { bg: "bg-sky-500/15 border-sky-500/25", text: "text-sky-200", label: "Worth considering — significant gaps", icon: "?" },
    skip: { bg: "bg-zinc-500/15 border-zinc-500/25", text: "text-zinc-400", label: "Weak fit — not recommended", icon: "✗" },
  };
  const m = map[rec] || map.skip!;
  return (
    <div className={cn("inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-medium", m.bg, m.text)}>
      <span className="text-base">{m.icon}</span>
      {m.label}
    </div>
  );
}

/* ─── ATS Screener badge ────────────────────────────── */

function ScreenerBadge({ screener }: { screener: NonNullable<ParsedReport["screener"]> }) {
  const pass = screener.verdict === "PASS";
  const m = pass
    ? { bg: "bg-emerald-500/15 border-emerald-500/25", text: "text-emerald-200", icon: "✓", label: "ATS Screener: PASS" }
    : screener.verdict === "FAIL"
    ? { bg: "bg-rose-500/15 border-rose-500/25", text: "text-rose-200", icon: "✗", label: "ATS Screener: FAIL" }
    : { bg: "bg-zinc-500/15 border-zinc-500/25", text: "text-zinc-300", icon: "?", label: "ATS Screener: Unknown" };
  const attemptsLabel = screener.attempts > 0 ? `${screener.attempts} attempt${screener.attempts === 1 ? "" : "s"}` : "";
  const tip = pass
    ? "The tailored CV passed the simulated ATS keyword + structure gate."
    : "The tailored CV still trips the simulated ATS gate. Open the screener verdict file for the action list before sending.";
  return (
    <div
      title={tip}
      className={cn("inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-medium", m.bg, m.text)}
    >
      <span className="text-base">{m.icon}</span>
      {m.label}
      {attemptsLabel && <span className="text-xs opacity-70">· {attemptsLabel}</span>}
    </div>
  );
}

/* ─── Accordion ─────────────────────────────────────── */

function Accordion({
  title,
  subtitle,
  defaultOpen = false,
  children,
}: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-2xl bg-zinc-900/40 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-5 py-4 text-left"
      >
        <span className={cn("text-zinc-400 transition-transform duration-200 text-xs", open && "rotate-90")}>▶</span>
        <span className="flex-1 text-sm font-medium text-zinc-100">{title}</span>
        {subtitle && <span className="text-xs text-zinc-500">{subtitle}</span>}
      </button>
      {open && <div className="border-t border-zinc-800/60 px-5 py-4">{children}</div>}
    </div>
  );
}

/* ─── Main component ────────────────────────────────── */

export function ReportView({
  markdown,
  onBack,
  reportPath,
}: {
  markdown: string;
  onBack: () => void;
  reportPath: string;
}) {
  const rpt = useMemo(() => parseReport(markdown), [markdown]);
  const [showRaw, setShowRaw] = useState(false);
  const [pdfFilename, setPdfFilename] = useState<string | null>(null);
  const [showPdfViewer, setShowPdfViewer] = useState(false);

  useEffect(() => {
    const numMatch = reportPath.match(/(\d{3})/);
    if (!numMatch) return;
    getPdfInfo(numMatch[1]!).then((info) => {
      setPdfFilename(info.found && info.filename ? info.filename : null);
    }).catch(() => setPdfFilename(null));
  }, [reportPath]);

  const rawHtml = useMemo(() => {
    return DOMPurify.sanitize(String(marked.parse(markdown)));
  }, [markdown]);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_240px]">
      {/* ─── Main column ─────────────────────────────── */}
      <div className="grid gap-5">
        {/* ── Executive summary header ──────────────── */}
        <section className="rounded-2xl bg-zinc-900/40 p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
          <div className="flex flex-col gap-5 md:flex-row md:items-start md:gap-8">
            <ScoreRing score={rpt.score} size={88} stroke={6} />
            <div className="flex-1 min-w-0">
              <h1 className="text-xl font-bold tracking-tight text-zinc-50">{rpt.company}</h1>
              <p className="mt-0.5 text-sm text-zinc-300">{rpt.role}</p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                <span className="rounded-md bg-zinc-800/60 px-2 py-0.5">{rpt.archetype}</span>
                <span>{rpt.date}</span>
                {rpt.url && (
                  <a href={rpt.url} target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline truncate max-w-[200px]">
                    View posting →
                  </a>
                )}
              </div>
              {rpt.tldr && (
                <p className="mt-3 text-sm leading-relaxed text-zinc-300">{rpt.tldr}</p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <RecommendationBadge rec={rpt.recommendation} />
                {rpt.screener && <ScreenerBadge screener={rpt.screener} />}
                {pdfFilename && (
                  <button
                    onClick={() => setShowPdfViewer(true)}
                    className="lg:hidden rounded-xl bg-gradient-to-r from-cyan-500/20 to-fuchsia-500/20 px-3.5 py-2 text-xs text-zinc-100 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)] hover:from-cyan-500/30 hover:to-fuchsia-500/30 transition"
                  >
                    View tailored CV
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Comp callout — always visible when data exists */}
          {rpt.compSummary && (
            <div className="mt-5 flex flex-wrap items-stretch gap-3">
              {rpt.compSummary.base && (
                <div className="flex-1 min-w-[140px] rounded-xl bg-emerald-500/5 px-4 py-3 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.12)]">
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-emerald-400/70">Base salary</div>
                  <div className="mt-1 text-sm font-semibold text-emerald-200">{rpt.compSummary.base}</div>
                </div>
              )}
              {rpt.compSummary.variable && (
                <div className="flex-1 min-w-[140px] rounded-xl bg-amber-500/5 px-4 py-3 shadow-[inset_0_0_0_1px_rgba(251,191,36,0.12)]">
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-amber-400/70">Bonus / Commission</div>
                  <div className="mt-1 text-sm font-semibold text-amber-200">{rpt.compSummary.variable}</div>
                </div>
              )}
              {rpt.compSummary.totalEstimate && (
                <div className="flex-1 min-w-[140px] rounded-xl bg-cyan-500/5 px-4 py-3 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.12)]">
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-cyan-400/70">Est. total comp</div>
                  <div className="mt-1 text-sm font-semibold text-cyan-200">{rpt.compSummary.totalEstimate}</div>
                </div>
              )}
            </div>
          )}

          {/* Dimension scores — full breakdown or fallback overall bar */}
          {rpt.scoreDimensions.length > 0 ? (
            <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
              {rpt.scoreDimensions.map((d) => (
                <div key={d.dimension} className="flex items-center gap-3 rounded-xl bg-zinc-950/30 px-4 py-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]">
                  <span className="text-xs text-zinc-400 w-32 shrink-0">{d.dimension}</span>
                  <MiniBar score={d.score} />
                </div>
              ))}
            </div>
          ) : rpt.score > 0 ? (
            <div className="mt-5">
              <div className="flex items-center gap-3 rounded-xl bg-zinc-950/30 px-4 py-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]">
                <span className="text-xs text-zinc-400 w-32 shrink-0">Overall fit</span>
                <MiniBar score={rpt.score} />
              </div>
            </div>
          ) : null}
        </section>

        {/* ── Role snapshot ─────────────────────────── */}
        {rpt.roleSummary.length > 0 && (
          <Accordion title="Role Snapshot" subtitle={`${rpt.roleSummary.length} dimensions`} defaultOpen>
            <div className="grid gap-2 sm:grid-cols-2">
              {rpt.roleSummary.map((r) => (
                <div key={r.dimension} className="rounded-xl bg-zinc-950/30 px-4 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{r.dimension}</div>
                  <div className="mt-1 text-sm text-zinc-200">{r.detail}</div>
                </div>
              ))}
            </div>
          </Accordion>
        )}

        {/* ── Match analysis ────────────────────────── */}
        {rpt.matches.length > 0 && (
          <Accordion
            title="Requirements Match"
            subtitle={`${rpt.matchStats.strong} strong · ${rpt.matchStats.moderate} moderate · ${rpt.matchStats.gap + rpt.matchStats.mitigable} gaps`}
            defaultOpen
          >
            <div className="grid gap-2">
              {rpt.matches.map((m, i) => (
                <div key={i} className="flex items-start gap-3 rounded-xl bg-zinc-950/30 px-4 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]">
                  <StrengthChip strength={m.strength} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-zinc-200">{m.requirement}</div>
                    <div className="mt-0.5 text-xs text-zinc-400 leading-relaxed">{m.evidence}</div>
                  </div>
                </div>
              ))}
            </div>
          </Accordion>
        )}

        {/* ── Gaps & mitigation ─────────────────────── */}
        {rpt.gaps.length > 0 && (
          <Accordion title="Gaps & Mitigation" subtitle={`${rpt.gaps.length} items`} defaultOpen>
            <div className="grid gap-2">
              {rpt.gaps.map((g, i) => (
                <div key={i} className="rounded-xl bg-zinc-950/30 px-4 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">{g.gap}</span>
                    <span className="rounded-md bg-zinc-800/60 px-2 py-0.5 text-[10px] text-zinc-400">{g.severity}</span>
                  </div>
                  {g.adjacent && (
                    <div className="mt-1.5 text-xs text-zinc-400">
                      <span className="font-medium text-zinc-500">Adjacent experience:</span> {g.adjacent}
                    </div>
                  )}
                  {g.mitigation && (
                    <div className="mt-1.5 rounded-lg bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300/90 leading-relaxed">
                      {g.mitigation}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Accordion>
        )}

        {/* ── Comp & demand ─────────────────────────── */}
        {(rpt.compData.length > 0 || rpt.compAssessment) && (
          <Accordion
            title="Compensation & Market"
            subtitle={rpt.compScore ? `${rpt.compScore.toFixed(1)}/5` : undefined}
          >
            {rpt.compData.length > 0 && (
              <div className="grid gap-2 sm:grid-cols-2">
                {rpt.compData.map((c, i) => (
                  <div key={i} className="rounded-xl bg-zinc-950/30 px-4 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{c.label}</div>
                    <div className="mt-1 text-sm font-medium text-zinc-200">{c.range}</div>
                    <div className="text-xs text-zinc-500">{c.source}</div>
                  </div>
                ))}
              </div>
            )}
            {rpt.compAssessment && (
              <p className="mt-3 text-sm leading-relaxed text-zinc-300">{rpt.compAssessment}</p>
            )}
          </Accordion>
        )}

        {/* ── Level & strategy ──────────────────────── */}
        {(rpt.levelVerdict || rpt.levelTips.length > 0) && (
          <Accordion title="Level & Strategy" subtitle={rpt.levelVerdict ? "Verdict available" : undefined}>
            {rpt.levelVerdict && (
              <div className="rounded-xl bg-emerald-500/5 px-4 py-3 text-sm font-medium text-emerald-200 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.1)]">
                {rpt.levelVerdict}
              </div>
            )}
            {rpt.levelTips.length > 0 && (
              <ul className="mt-3 grid gap-1.5">
                {rpt.levelTips.map((t, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
                    <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-zinc-500" />
                    <span className="leading-relaxed">{t}</span>
                  </li>
                ))}
              </ul>
            )}
          </Accordion>
        )}

        {/* ── Personalization plan ────────────────────── */}
        {(rpt.cvChanges.length > 0 || rpt.linkedinChanges.length > 0) && (
          <Accordion
            title="Personalization Plan"
            subtitle={`${rpt.cvChanges.length} CV · ${rpt.linkedinChanges.length} LinkedIn`}
          >
            {rpt.cvChanges.length > 0 && (
              <>
                <div className="text-xs font-medium text-zinc-500 mb-2 uppercase tracking-wide">CV changes</div>
                <div className="grid gap-2 mb-4">
                  {rpt.cvChanges.map((c, i) => (
                    <div key={i} className="rounded-xl bg-zinc-950/30 px-4 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]">
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-zinc-800 text-[10px] font-bold text-zinc-400">{c.num}</span>
                        <span className="text-sm font-medium text-zinc-200">{c.section}</span>
                      </div>
                      {c.current && (
                        <div className="mt-1.5 text-xs text-zinc-500">
                          <span className="font-medium">Current:</span> {c.current}
                        </div>
                      )}
                      <div className="mt-1 text-xs text-emerald-300/90">
                        <span className="font-medium text-emerald-400/70">Proposed:</span> {c.proposed}
                      </div>
                      {c.why && <div className="mt-1 text-xs text-zinc-400">{c.why}</div>}
                    </div>
                  ))}
                </div>
              </>
            )}
            {rpt.linkedinChanges.length > 0 && (
              <>
                <div className="text-xs font-medium text-zinc-500 mb-2 uppercase tracking-wide">LinkedIn changes</div>
                <div className="grid gap-2">
                  {rpt.linkedinChanges.map((c, i) => (
                    <div key={i} className="rounded-xl bg-zinc-950/30 px-4 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]">
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-zinc-800 text-[10px] font-bold text-zinc-400">{c.num}</span>
                        <span className="text-sm font-medium text-zinc-200">{c.section}</span>
                      </div>
                      <div className="mt-1 text-xs text-cyan-300/90">{c.proposed}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Accordion>
        )}

        {/* ── Interview prep ────────────────────────── */}
        {(rpt.starStories.length > 0 || rpt.redFlags.length > 0) && (
          <Accordion title="Interview Prep" subtitle={`${rpt.starStories.length} stories · ${rpt.redFlags.length} red-flag Q&A`}>
            {rpt.caseStudy && (
              <div className="mb-4 rounded-xl bg-cyan-500/5 px-4 py-3 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.08)]">
                <div className="text-[11px] font-medium uppercase tracking-wide text-cyan-400/70">Recommended case study</div>
                <p className="mt-1 text-sm text-cyan-100/90 leading-relaxed">{rpt.caseStudy}</p>
              </div>
            )}

            {rpt.starStories.length > 0 && (
              <div className="grid gap-2">
                {rpt.starStories.map((s) => (
                  <StoryCard key={s.num} story={s} />
                ))}
              </div>
            )}

            {rpt.redFlags.length > 0 && (
              <div className="mt-4">
                <div className="text-xs font-medium text-zinc-500 mb-2 uppercase tracking-wide">Red-flag questions</div>
                <div className="grid gap-2">
                  {rpt.redFlags.map((r, i) => (
                    <div key={i} className="rounded-xl bg-zinc-950/30 px-4 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]">
                      <div className="text-sm font-medium text-rose-300/90">{r.question}</div>
                      <div className="mt-1.5 text-sm text-zinc-300 leading-relaxed">{r.response}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Accordion>
        )}

        {/* ── Full analysis (raw markdown toggle) ──── */}
        <Accordion title="Full Analysis" subtitle="Raw markdown">
          {showRaw ? (
            <pre className="overflow-auto rounded-xl bg-zinc-950/60 p-4 text-xs leading-relaxed text-zinc-300 max-h-[600px]">
              {markdown}
            </pre>
          ) : (
            <article className="prose prose-invert max-w-none text-sm">
              <div dangerouslySetInnerHTML={{ __html: rawHtml }} />
            </article>
          )}
          <button
            onClick={() => setShowRaw((v) => !v)}
            className="mt-3 text-xs text-zinc-500 hover:text-zinc-300 transition"
          >
            {showRaw ? "Show rendered" : "Show raw markdown"}
          </button>
        </Accordion>
      </div>

      {/* ─── Sticky action rail ───────────────────── */}
      <aside className="hidden lg:block">
        <div className="sticky top-6 grid gap-3">
          <div className="rounded-2xl bg-zinc-900/40 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
            <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 mb-2">Actions</div>
            <div className="grid gap-2">
              <button
                onClick={onBack}
                className="w-full rounded-xl bg-zinc-950/60 px-3 py-2.5 text-xs text-zinc-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-zinc-950/80 transition"
              >
                ← Back to pipeline
              </button>
              {rpt.url && (
                <a
                  href={rpt.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block w-full rounded-xl bg-zinc-950/60 px-3 py-2.5 text-center text-xs text-zinc-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-zinc-950/80 transition"
                >
                  View job posting →
                </a>
              )}
              {pdfFilename && (
                <button
                  onClick={() => setShowPdfViewer(true)}
                  className="w-full rounded-xl bg-gradient-to-r from-cyan-500/20 to-fuchsia-500/20 px-3 py-2.5 text-xs text-zinc-100 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)] hover:from-cyan-500/30 hover:to-fuchsia-500/30 transition"
                >
                  View tailored CV
                </button>
              )}
            </div>
          </div>

          {/* Quick stats */}
          <div className="rounded-2xl bg-zinc-900/40 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
            <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 mb-3">Quick Stats</div>
            <div className="grid gap-2.5">
              <QuickStat label="Overall" value={`${rpt.score.toFixed(1)}/5`} />
              <QuickStat label="Strong matches" value={String(rpt.matchStats.strong)} color="text-emerald-400" />
              <QuickStat label="Gaps" value={String(rpt.matchStats.gap + rpt.matchStats.mitigable)} color="text-amber-400" />
              <QuickStat label="STAR stories" value={String(rpt.starStories.length)} />
              {rpt.compScore !== null && <QuickStat label="Comp score" value={`${rpt.compScore.toFixed(1)}/5`} />}
            </div>
          </div>

          <div className="rounded-2xl bg-zinc-900/40 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
            <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 mb-1">Report file</div>
            <div className="text-xs text-zinc-400 break-all">{reportPath}</div>
          </div>
        </div>
      </aside>

      {showPdfViewer && pdfFilename && (
        <PdfViewerModal
          filename={pdfFilename}
          onClose={() => setShowPdfViewer(false)}
        />
      )}
    </div>
  );
}

/* ─── STAR story card ───────────────────────────────── */

function StoryCard({ story }: { story: ParsedReport["starStories"][0] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-xl bg-zinc-950/30 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]">
      <button onClick={() => setExpanded((v) => !v)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-zinc-800 text-[10px] font-bold text-zinc-400">
          {story.num}
        </span>
        <span className="flex-1 text-sm text-zinc-200">{story.requirement}</span>
        <span className={cn("text-zinc-500 text-xs transition-transform", expanded && "rotate-90")}>▶</span>
      </button>
      {expanded && (
        <div className="border-t border-zinc-800/40 px-4 py-3 grid gap-2">
          <StarRow label="Situation" value={story.situation} />
          <StarRow label="Task" value={story.task} />
          <StarRow label="Action" value={story.action} />
          <StarRow label="Result" value={story.result} />
          <StarRow label="Reflection" value={story.reflection} />
        </div>
      )}
    </div>
  );
}

function StarRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div>
      <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-400/60">{label}</span>
      <p className="text-sm text-zinc-300 leading-relaxed">{value}</p>
    </div>
  );
}

function PdfViewerModal({ filename, onClose }: { filename: string; onClose: () => void }) {
  const url = pdfServeUrl(filename);
  const [revealing, setRevealing] = useState(false);

  async function handleReveal() {
    setRevealing(true);
    try {
      await revealPdf(filename);
    } catch {
      // best-effort
    } finally {
      setRevealing(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="flex h-[90vh] w-[90vw] max-w-5xl flex-col rounded-2xl bg-zinc-900 shadow-2xl shadow-black/50 ring-1 ring-white/10">
        <div className="flex items-center justify-between gap-4 border-b border-zinc-800/60 px-5 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-sm font-medium text-zinc-100">Tailored CV</span>
            <span className="truncate text-xs text-zinc-500">{filename}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleReveal}
              disabled={revealing}
              className="rounded-xl bg-zinc-950/60 px-3 py-2 text-xs text-zinc-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-zinc-950/80 transition disabled:opacity-50"
            >
              {revealing ? "Opening…" : "Show on my computer"}
            </button>
            <a
              href={url}
              download={filename}
              className="rounded-xl bg-zinc-950/60 px-3 py-2 text-xs text-zinc-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-zinc-950/80 transition"
            >
              Download
            </a>
            <button
              onClick={onClose}
              className="rounded-xl bg-zinc-950/60 px-3 py-2 text-xs text-zinc-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-zinc-950/80 transition"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <iframe
            src={url}
            title="Tailored CV PDF"
            className="h-full w-full rounded-b-2xl"
          />
        </div>
      </div>
    </div>
  );
}

function QuickStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className={cn("text-xs font-medium tabular-nums", color || "text-zinc-200")}>{value}</span>
    </div>
  );
}
