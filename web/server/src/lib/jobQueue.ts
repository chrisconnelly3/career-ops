import pLimit from "p-limit";

export type JobState = "queued" | "running" | "succeeded" | "failed";

export type Job = {
  id: string;
  type: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  state: JobState;
  progress?: { step: string; detail?: string };
  logs: string[];
  result?: unknown;
  error?: string;
};

export type EnqueueOptions = {
  type: string;
  run: (ctx: {
    log: (line: string) => void;
    setProgress: (step: string, detail?: string) => void;
  }) => Promise<unknown>;
};

// How many jobs (evals) run at once. Shared-file writes inside an eval
// (report numbering, tracker merge, PDF-status update) are guarded by an
// in-process lock (see fileLock.ts), so concurrent evals are safe. Each
// concurrent eval launches its own headless Chromium, so keep this modest to
// bound memory. Tune with EVAL_CONCURRENCY in .env.
const CONCURRENCY = Math.max(1, Number(process.env.EVAL_CONCURRENCY) || 3);
const limit = pLimit(CONCURRENCY);
const jobs = new Map<string, Job>();

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function enqueueJob(opts: EnqueueOptions): Job {
  const id = newId();
  const job: Job = {
    id,
    type: opts.type,
    createdAt: nowIso(),
    state: "queued",
    logs: []
  };
  jobs.set(id, job);

  void limit(async () => {
    job.state = "running";
    job.startedAt = nowIso();

    const log = (line: string) => {
      job.logs.push(`[${new Date().toLocaleTimeString()}] ${line}`);
      if (job.logs.length > 2000) job.logs.splice(0, job.logs.length - 2000);
    };
    const setProgress = (step: string, detail?: string) => {
      job.progress = { step, detail };
    };

    try {
      const result = await opts.run({ log, setProgress });
      job.state = "succeeded";
      job.result = result;
    } catch (e) {
      job.state = "failed";
      job.error = e instanceof Error ? e.message : String(e);
    } finally {
      job.finishedAt = nowIso();
    }
  });

  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return Array.from(jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

