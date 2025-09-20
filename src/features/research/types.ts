import { z } from "zod";

/* --------------------------------- Basics --------------------------------- */

export const DepthSchema = z.enum(["quick", "normal", "deep"]);
export type Depth = z.infer<typeof DepthSchema>;

export const ClaimTypeSchema = z.enum([
  "quant",
  "causal",
  "definition",
  "opinion",
  "other",
]);
export type ClaimType = z.infer<typeof ClaimTypeSchema>;

/* ------------------------------- API Request ------------------------------ */

export const ResearchRequestSchema = z.object({
  question: z
    .string()
    .min(8, "Please provide a more specific question (min 8 chars)."),
  depth: DepthSchema.default("normal"),
  timeRange: z
    .object({
      from: z.string().optional(), // ISO date expected by backend; validated there
      to: z.string().optional(),
    })
    .optional(),
  region: z.string().optional(),
  allowedDomains: z.array(z.string()).optional(),
  disallowedDomains: z.array(z.string()).optional(),
});
export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

/* ----------------------------- Retrieval types ---------------------------- */

export const SearchResultSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  snippet: z.string().optional(),
  score: z.number().optional(),
  source: z.string().optional(), // provider label
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SourceSchema = z.object({
  id: z.string(), // ULID or UUID
  url: z.string().url(),
  domain: z.string(),
  title: z.string().nullable().optional(),
  publishedAt: z.string().nullable().optional(), // ISO string if known
  crawledAt: z.string().nullable().optional(), // ISO string
  lang: z.string().nullable().optional(),
});
export type Source = z.infer<typeof SourceSchema>;

export const ContextChunkSchema = z.object({
  sourceId: z.string(),
  chunkId: z.string().optional(),
  text: z.string(),
});
export type ContextChunk = z.infer<typeof ContextChunkSchema>;

export const ChunkSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  pos: z.number().int().nonnegative(),
  charStart: z.number().int().nonnegative(),
  charEnd: z.number().int().nonnegative(),
  text: z.string(),
  tokens: z.number().int().nonnegative(),
});
export type Chunk = z.infer<typeof ChunkSchema>;

/* ------------------------------- Citations -------------------------------- */

export const CitationSchema = z.object({
  id: z.string().optional(), // may not exist in verify step
  sourceId: z.string(),
  chunkId: z.string().optional(),
  quote: z.string(),
  charStart: z.number().int().nonnegative().optional(),
  charEnd: z.number().int().nonnegative().optional(),
  score: z.number().min(0).max(1).optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

/* --------------------------------- Claims --------------------------------- */

export const ClaimSchema = z.object({
  id: z.string().optional(), // server may assign after persist
  text: z.string(),
  claimType: ClaimTypeSchema,
  evidence: z.array(CitationSchema).default([]),
  supportScore: z.number().min(0).max(1),
  contradicted: z.boolean(),
  uncertaintyReason: z.string().optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

/* ------------------------------ Final answer ------------------------------ */

export const ResearchAnswerSchema = z.object({
  question: z.string(),
  markdown: z.string(),
  claims: z.array(ClaimSchema),
  citations: z.array(CitationSchema),
  sources: z.array(SourceSchema),
  confidence: z.number().min(0).max(1).optional(),
});
export type ResearchAnswer = z.infer<typeof ResearchAnswerSchema>;

/* ------------------------------ Plan response ----------------------------- */

export const PlanResponseSchema = z.object({
  intent: z.string(),
  subqueries: z.array(z.string()).min(1),
  focus: z.array(z.string()).optional().default([]),
  constraints: z
    .object({
      timeRange: z
        .object({
          from: z.string().optional(),
          to: z.string().optional(),
        })
        .nullable()
        .optional(),
      region: z.string().nullable().optional(),
      allowedDomains: z.array(z.string()).nullable().optional(),
      disallowedDomains: z.array(z.string()).nullable().optional(),
    })
    .default({}),
});
export type PlanResponse = z.infer<typeof PlanResponseSchema>;

/* ---------------------------- Verify claims resp -------------------------- */

export const VerifiedClaimSchema = z.object({
  text: z.string(),
  claimType: ClaimTypeSchema,
  supportScore: z.number().min(0).max(1),
  contradicted: z.boolean(),
  uncertaintyReason: z.string().optional(),
  evidence: z
    .array(
      z.object({
        sourceId: z.string(),
        chunkId: z.string().optional(),
        quote: z.string(),
        // optional offsets if available
        charStart: z.number().int().nonnegative().optional(),
        charEnd: z.number().int().nonnegative().optional(),
      })
    )
    .default([]),
});
export type VerifiedClaim = z.infer<typeof VerifiedClaimSchema>;

export const VerifyClaimsResponseSchema = z.object({
  claims: z.array(VerifiedClaimSchema),
});
export type VerifyClaimsResponse = z.infer<typeof VerifyClaimsResponseSchema>;

/* ------------------------------ NLI & trust -------------------------------- */

export const NLILabelSchema = z.enum(["entail", "contradict", "neutral"]);
export type NLILabel = z.infer<typeof NLILabelSchema>;

export const NLIResultSchema = z.object({
  label: NLILabelSchema,
  rationale: z.string(),
});
export type NLIResult = z.infer<typeof NLIResultSchema>;

export const SourceTrustResultSchema = z.object({
  score: z.number().min(0).max(1),
  reason: z.string(),
});
export type SourceTrustResult = z.infer<typeof SourceTrustResultSchema>;

/* ------------------------------- Progress/SSE ------------------------------ */

export const ProgressStageSchema = z.enum([
  "idle",
  "plan",
  "search",
  "read",
  "rank",
  "answer",
  "verify",
  "done",
  "error",
]);
export type ProgressStage = z.infer<typeof ProgressStageSchema>;

export const ProgressEventSchema = z.object({
  stage: ProgressStageSchema,
  message: z.string().optional(),
  // Fix for Zod versions that require both key and value types for record()
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;

// Streamed token is a raw string delta
export const TokenEventSchema = z.string();
export type TokenEvent = z.infer<typeof TokenEventSchema>;

export const DoneEventSchema = z.object({
  threadId: z.string(),
});
export type DoneEvent = z.infer<typeof DoneEventSchema>;

export const ErrorEventSchema = z.object({
  message: z.string(),
});
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

/* ------------------------------- Context pack ------------------------------ */

export const SourceRefSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  title: z.string().nullable().optional(),
  domain: z.string().nullable().optional(),
  index: z.number().int().min(1).optional(), // optional explicit index mapping
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const ContextPackSchema = z.object({
  sources: z.array(SourceRefSchema),
  chunks: z.array(
    z.object({
      sourceId: z.string(),
      chunkId: z.string().optional(),
      text: z.string(),
    })
  ),
});
export type ContextPack = z.infer<typeof ContextPackSchema>;
