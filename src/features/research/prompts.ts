/**
 * Prompt builders for the Evidence-First Deep Research Copilot.
 *
 * Goals:
 * - Keep prompts centralized and versionable.
 * - Enforce evidence-first behavior (inline numeric citations [1], [2], …).
 * - Provide deterministic, parseable outputs for verification steps.
 *
 * Usage (examples):
 *  const { system, user } = buildAnswerPrompt({ question, sources, chunks });
 *  await streamText({ model, system, prompt: user });
 */

export type Depth = "quick" | "normal" | "deep";

export type SourceRef = {
  id: string;
  url: string;
  title?: string | null;
  domain?: string | null;
  // Optional explicit index to pin mapping; if omitted, order defines [1..N].
  index?: number;
};

export type ContextChunk = {
  sourceId: string;
  chunkId?: string;
  text: string;
};

export type AnswerPromptOptions = {
  question: string;
  sources: SourceRef[];
  chunks: ContextChunk[];
  style?: "neutral" | "concise" | "detailed";
  maxSections?: number; // guidance for structuring answer
};

export type PlanPromptOptions = {
  question: string;
  depth: Depth;
  region?: string;
  timeRange?: { from?: string; to?: string };
  allowedDomains?: string[];
  disallowedDomains?: string[];
  maxSubqueries?: number; // guidance only; model may return <= this
};

export type VerifyPromptOptions = {
  answerMarkdown: string;
  snippets: { sourceId: string; chunkId?: string; text: string }[];
  maxClaims?: number; // guidance only
};

/* --------------------------------- Helpers -------------------------------- */

export function formatSourcesList(sources: SourceRef[]): string {
  // Stable [1..N] mapping in the given order unless a custom index is provided.
  const rows = sources.map((s, i) => {
    const idx = (s.index ?? i) + 1;
    const domain = s.domain || tryGetDomain(s.url);
    const title = s.title?.trim() || s.url;
    return `[${idx}] ${title} (${domain}) — ${s.url}`;
  });
  return rows.join("\n");
}

export function formatContextFromChunks(
  chunks: ContextChunk[],
  sources: SourceRef[],
  limitPerSource = 3,
  maxCharsPerChunk = 800
): string {
  // Group chunks by source and include up to limitPerSource excerpts per source.
  const bySource = new Map<string, ContextChunk[]>();
  for (const c of chunks) {
    if (!bySource.has(c.sourceId)) bySource.set(c.sourceId, []);
    bySource.get(c.sourceId)!.push(c);
  }

  // Build an index mapping sourceId -> [n]
  const indexMap = new Map<string, number>();
  sources.forEach((s, i) => {
    indexMap.set(s.id, (s.index ?? i) + 1);
  });

  const lines: string[] = [];
  for (const s of sources) {
    const idx = indexMap.get(s.id);
    if (!idx) continue;
    const group = (bySource.get(s.id) || []).slice(0, limitPerSource);
    if (!group.length) continue;
    lines.push(`# [${idx}] ${s.title || s.url}`);
    for (const g of group) {
      const body =
        g.text.length > maxCharsPerChunk
          ? g.text.slice(0, maxCharsPerChunk) + " …"
          : g.text;
      const tag = g.chunkId ? `chunk:${g.chunkId}` : "chunk:unknown";
      lines.push(`- (${tag}) ${body}`);
    }
  }
  return lines.join("\n");
}

function tryGetDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

/* ------------------------------- Answer prompt ---------------------------- */

const ANSWER_PRINCIPLES = `
You are a careful research assistant. Your answers must be:
- Evidence-first and verifiable.
- Neutral, precise, and concise.
- Grounded strictly in the provided sources.
- Transparent about uncertainty and gaps.

Citations:
- Use inline numeric citations like [1], [2] that map to the SOURCES list.
- Place citations immediately after the claim they support.
- Use multiple citations (e.g., [1][3]) when multiple sources support a claim.
- Do not fabricate sources or facts. If evidence is insufficient, state that and suggest follow-ups.

Style:
- Prioritize clarity. Avoid marketing or flowery language.
- Prefer short sentences. Keep paragraphs tight.
- Only quote directly when wording matters; otherwise paraphrase faithfully.
- If the question is ambiguous, list assumptions and ask for clarification.
`.trim();

export function buildAnswerPrompt(opts: AnswerPromptOptions): {
  system: string;
  user: string;
} {
  const styleNote =
    opts.style === "concise"
      ? "Keep it succinct: 4–7 short paragraphs or bullet points."
      : opts.style === "detailed"
      ? "Be thorough but structured. Use section headings if helpful."
      : "Aim for crisp, structured paragraphs or bullets.";

  const system = [
    ANSWER_PRINCIPLES,
    "",
    "Output constraints:",
    "- Output Markdown only (no HTML).",
    "- Use inline numeric citations [n] that match SOURCES.",
    "- Do not include a bibliography; inline citations are sufficient.",
    "- If the answer depends on recency, mention dates from sources.",
    "- Do not speculate beyond the provided context.",
    "",
    `Guidance: ${styleNote}`,
  ].join("\n");

  const sourcesBlock = formatSourcesList(opts.sources);
  const contextBlock = formatContextFromChunks(opts.chunks, opts.sources);

  const user = [
    `Question: ${opts.question}`,
    "",
    "SOURCES:",
    "```",
    sourcesBlock,
    "```",
    "",
    "CONTEXT EXCERPTS:",
    "```",
    contextBlock || "(no excerpts available)",
    "```",
    "",
    "Instructions:",
    "- Answer the question using only the SOURCES and CONTEXT EXCERPTS.",
    "- When a statement comes from a source, cite it inline using [n].",
    "- If evidence is weak or conflicting, say so explicitly and describe the uncertainty.",
  ].join("\n");

  return { system, user };
}

/* -------------------------------- Plan prompt ----------------------------- */

const PLAN_SYSTEM = `
You generate targeted web subqueries to gather high-quality evidence.
Return a strict JSON object with fields:
{
  "intent": string,                  // what the user truly wants to know
  "subqueries": string[],            // 2–6 precise queries
  "focus": string[],                 // optional focus keywords/entities
  "constraints": {                   // inferred operational constraints
    "timeRange": { "from"?: string, "to"?: string } | null,
    "region"?: string | null,
    "allowedDomains"?: string[] | null,
    "disallowedDomains"?: string[] | null
  }
}
Rules:
- Subqueries should be specific, de-duplicated, and diverse (docs, primary sources, reputable news, academic).
- Include variant phrasings if they target different credible sources.
- No prose, no code fences. JSON only.
`.trim();

export function buildPlanPrompt(opts: PlanPromptOptions): {
  system: string;
  user: string;
} {
  const {
    question,
    depth,
    region,
    timeRange,
    allowedDomains,
    disallowedDomains,
  } = opts;
  const cap =
    typeof opts.maxSubqueries === "number" && opts.maxSubqueries > 0
      ? Math.min(6, Math.max(2, opts.maxSubqueries))
      : depth === "deep"
      ? 6
      : depth === "quick"
      ? 3
      : 4;

  const constraintsDesc = JSON.stringify(
    {
      depth,
      region: region ?? null,
      timeRange: timeRange ?? null,
      allowedDomains: allowedDomains ?? null,
      disallowedDomains: disallowedDomains ?? null,
      maxSubqueries: cap,
    },
    null,
    2
  );

  const user = [
    `Question: ${question}`,
    "",
    "Operational constraints (guidance):",
    constraintsDesc,
  ].join("\n");

  return { system: PLAN_SYSTEM, user };
}

/* ---------------------------- Verify claims prompt ------------------------ */

const CLAIM_SCHEMA_DOC = `
Return strict JSON with this shape:
{
  "claims": [
    {
      "text": string,                              // atomic claim in your own words
      "claimType": "quant" | "causal" | "definition" | "opinion" | "other",
      "supportScore": number,                      // 0..1 confidence from evidence quality/consistency/recency
      "contradicted": boolean,                     // true if conflicting evidence is present
      "uncertaintyReason"?: string,                // when supportScore < 0.6 or contradicted
      "evidence": [
        {
          "sourceId": string,
          "chunkId"?: string,
          "quote": string                          // short exact quote supporting the claim
        }
      ]
    }
  ]
}
Rules:
- Extract only verifiable, atomic claims (1 fact per claim).
- Prefer 1–2 short quotes per claim from the provided snippets.
- If a claim cannot be supported by any snippet, omit that claim.
- JSON only. No code fences, no prose.
`.trim();

const VERIFY_SYSTEM = `
You extract and verify atomic claims from an answer using provided snippets.
Be strict and conservative. Do not infer beyond the snippets.
${CLAIM_SCHEMA_DOC}
`.trim();

export function buildVerifyClaimsPrompt(opts: VerifyPromptOptions): {
  system: string;
  user: string;
} {
  const capped =
    typeof opts.maxClaims === "number" && opts.maxClaims > 0
      ? opts.maxClaims
      : 12;

  const snippetsBlock = opts.snippets
    .map((s, i) => {
      const tag = s.chunkId ? `chunk:${s.chunkId}` : `chunk:unknown`;
      return `(${i + 1}) [source:${s.sourceId} ${tag}]\n${s.text}`;
    })
    .join("\n---\n");

  const user = [
    `Max claims to extract: ${capped}`,
    "",
    "Answer (markdown):",
    "```markdown",
    opts.answerMarkdown,
    "```",
    "",
    "Snippets:",
    "```text",
    snippetsBlock || "(no snippets)",
    "```",
    "",
    "Extract claims supported by the snippets. JSON only.",
  ].join("\n");

  return { system: VERIFY_SYSTEM, user };
}

/* -------------------------- Optional: NLI contradiction ------------------- */

const NLI_SYSTEM = `
Decide the relationship between two quotes:
- entail: quoteB is supported by quoteA
- contradict: quoteB conflicts with quoteA
- neutral: neither
Return JSON: { "label": "entail" | "contradict" | "neutral", "rationale": string }
No code fences.
`.trim();

export function buildNLIPrompt(
  quoteA: string,
  quoteB: string
): {
  system: string;
  user: string;
} {
  const user = [
    "Quote A:",
    "```",
    quoteA,
    "```",
    "Quote B:",
    "```",
    quoteB,
    "```",
    "Return JSON only.",
  ].join("\n");
  return { system: NLI_SYSTEM, user };
}

/* -------------------------- Optional: Source trust ------------------------ */

const TRUST_SYSTEM = `
Classify source trust on a 0..1 scale (heuristic):
- 0.9–1.0: official, peer-reviewed, gov/edu, primary docs
- 0.7–0.9: major news, vendor docs, reputable orgs
- 0.4–0.7: reputable blogs, community, secondary summaries
- 0.0–0.4: unknown, low-quality, unsourced
Return JSON: { "score": number, "reason": string }
No code fences.
`.trim();

export function buildSourceTrustPrompt(
  src: SourceRef,
  snippet?: string
): {
  system: string;
  user: string;
} {
  const meta = {
    url: src.url,
    title: src.title ?? null,
    domain: src.domain ?? tryGetDomain(src.url),
  };
  const user = [
    "Source metadata:",
    JSON.stringify(meta, null, 2),
    "",
    "Optional snippet:",
    snippet ? "```" : "(none)",
    snippet ?? "",
    snippet ? "```" : "",
    "",
    "Return JSON only.",
  ].join("\n");
  return { system: TRUST_SYSTEM, user };
}
