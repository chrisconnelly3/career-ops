import { getAnthropicClient, getAnthropicModel } from "./anthropic";
import type { CareerApplication } from "./applications";

/**
 * Lightweight LLM call to pull the company name + role title out of a JD.
 * Used by the pre-flight dupe check so we can compare against existing
 * applications before kicking off the expensive full evaluation. About
 * 200 tokens in, 30 tokens out per call.
 */
export async function extractJobIdentity(
  jdText: string,
): Promise<{ company: string; role: string }> {
  const client = getAnthropicClient();
  const model = getAnthropicModel();

  // Cap the input so we never blow past ~1k input tokens on this cheap call.
  const sample = jdText.slice(0, 3500);

  const resp = await client.messages.create({
    model,
    max_tokens: 200,
    temperature: 0,
    system:
      "Extract the company name and the role/job title from this job description. " +
      'Return ONLY a JSON object: {"company": "<name>", "role": "<title>"}. ' +
      "No markdown, no preamble, no trailing prose. " +
      'If the JD does not clearly state a company or role, return "Unknown" for that field.',
    messages: [{ role: "user", content: sample }],
  });

  let raw = resp.content.map((b) => ("text" in b ? b.text : "")).join("").trim();
  raw = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();

  try {
    const parsed = JSON.parse(raw);
    return {
      company: typeof parsed.company === "string" ? parsed.company.trim() : "Unknown",
      role: typeof parsed.role === "string" ? parsed.role.trim() : "Unknown",
    };
  } catch {
    return { company: "Unknown", role: "Unknown" };
  }
}

/** Lowercase, strip common corporate suffixes + punctuation, collapse whitespace. */
function normalizeCompanyForMatch(name: string): string {
  let s = name.toLowerCase().trim();
  for (const suffix of [
    " inc.",
    " inc",
    " llc",
    " ltd.",
    " ltd",
    " corp.",
    " corp",
    " corporation",
    " co.",
    " co",
    " technologies",
    " technology",
    " group",
    " labs",
    ", inc.",
    ", inc",
    ", llc",
  ]) {
    if (s.endsWith(suffix)) s = s.slice(0, -suffix.length).trim();
  }
  return s.replace(/[^a-z0-9]+/g, "");
}

/** Tokenize, drop short words, lowercase. */
function roleTokens(role: string): Set<string> {
  const stop = new Set([
    "of",
    "the",
    "a",
    "an",
    "for",
    "and",
    "or",
    "at",
    "in",
    "on",
    "with",
    "to",
  ]);
  const tokens = role
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !stop.has(t));
  return new Set(tokens);
}

/** Jaccard similarity of two role-title token sets. */
function roleSimilarity(a: string, b: string): number {
  const ta = roleTokens(a);
  const tb = roleTokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return inter / union;
}

/**
 * Match the candidate {company, role} against an existing applications list.
 * Returns the apps that look like duplicates: same normalized company AND
 * roughly the same role title (Jaccard >= 0.5 on role tokens).
 */
export function findPotentialDupes(
  candidate: { company: string; role: string },
  apps: CareerApplication[],
): CareerApplication[] {
  if (!candidate.company || candidate.company.toLowerCase() === "unknown") {
    return [];
  }
  const normCandidate = normalizeCompanyForMatch(candidate.company);
  if (!normCandidate) return [];

  const matches: CareerApplication[] = [];
  for (const app of apps) {
    if (!app.company) continue;
    const normExisting = normalizeCompanyForMatch(app.company);
    if (normExisting !== normCandidate) continue;
    // Same company. Now check role similarity.
    const sim = roleSimilarity(candidate.role || "", app.role || "");
    if (sim >= 0.5) {
      matches.push(app);
    }
  }
  return matches;
}
