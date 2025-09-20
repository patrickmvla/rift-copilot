/* eslint-disable @typescript-eslint/no-explicit-any */
import "server-only";
import { logger, startSpan, logError } from "@/lib/logger";
import { findQuoteOffsets } from "@/lib/text";
import { buildVerifyClaimsPrompt, buildNLIPrompt } from "../prompts";
import {
  VerifyClaimsResponse,
  VerifyClaimsResponseSchema,
  NLIResultSchema,
} from "../types";
import { generateCompletion, type GroqProviderOptions } from "./groq";

/* --------------------------------- Types ---------------------------------- */

export type Snippet = {
  sourceId: string;
  chunkId?: string;
  text: string;
};

export type VerifyInput = {
  answerMarkdown: string;
  snippets: Snippet[];
};

export type VerifyOptions = {
  maxClaims?: number; // default 12
  abortSignal?: AbortSignal; // AI SDK v5 uses abortSignal
  groqOptions?: GroqProviderOptions; // providerOptions.groq overrides
  // Bind offsets from chunk text (supply a map or a loader)
  bindOffsets?: boolean; // default true
  chunkTextById?:
    | Map<string, string>
    | ((chunkId: string) => Promise<string | null> | string | null | undefined);
  // Optional: contradiction check using NLI between top quotes per claim
  nliContradictionCheck?: boolean; // default false
  nliMaxPairsPerClaim?: number; // default 1
};

/* ------------------------------- Main entry -------------------------------- */

/**
 * Verify claims for an assistant answer using provided source snippets.
 * Returns a validated VerifyClaimsResponse.
 */
export async function verifyClaims(
  input: VerifyInput,
  opts: VerifyOptions = {}
): Promise<VerifyClaimsResponse> {
  const log = logger.child({ mod: "verify" });
  const span = startSpan(log, "verifyClaims");

  const { answerMarkdown, snippets } = input;

  const {
    maxClaims = 12,
    abortSignal,
    groqOptions,
    bindOffsets = true,
    chunkTextById,
    nliContradictionCheck = false,
    nliMaxPairsPerClaim = 1,
  } = opts;

  try {
    // 1) Build prompt
    const prompt = buildVerifyClaimsPrompt({
      answerMarkdown,
      snippets,
      maxClaims,
    });

    // 2) Call model (JSON-only)
    const res = await generateCompletion({
      model: "verify",
      system: prompt.system,
      prompt: prompt.user,
      temperature: 0,
      maxOutputTokens: 1200,
      abortSignal,
      groqOptions,
    });

    // 3) Parse & validate
    const raw = parseJSON(res.text);
    const parsed = VerifyClaimsResponseSchema.safeParse(raw);
    const verified: VerifyClaimsResponse = parsed.success
      ? parsed.data
      : { claims: [] };

    // 4) Optionally bind char offsets for evidence quotes
    if (bindOffsets && verified.claims.length > 0 && chunkTextById) {
      await bindEvidenceOffsetsInPlace(verified, chunkTextById);
    }

    // 5) Optional contradiction check (NLI) between quotes in the same claim
    if (nliContradictionCheck && verified.claims.length > 0) {
      await flagContradictionsInPlace(verified, {
        abortSignal,
        groqOptions,
        maxPairsPerClaim: nliMaxPairsPerClaim,
      });
    }

    span.end({ claims: verified.claims.length });
    return verified;
  } catch (e) {
    logError(log, e, "verifyClaims failed");
    span.end({ error: true });
    return { claims: [] };
  }
}

/* -------------------------- Evidence offset binding ------------------------ */

/**
 * Mutates the VerifyClaimsResponse in place by assigning charStart/charEnd
 * for each evidence quote when chunkId text is available.
 */
export async function bindEvidenceOffsetsInPlace(
  verified: VerifyClaimsResponse,
  chunkTextById:
    | Map<string, string>
    | ((chunkId: string) => Promise<string | null> | string | null | undefined)
): Promise<void> {
  const getText = async (id: string): Promise<string | null> => {
    if (typeof chunkTextById === "function") {
      const r = await chunkTextById(id);
      return r ?? null;
    }
    return chunkTextById.get(id) ?? null;
  };

  // Deduplicate chunk loads
  const needed = new Set<string>();
  for (const c of verified.claims) {
    for (const ev of c.evidence) {
      if (
        ev.chunkId &&
        (ev.charStart === undefined || ev.charEnd === undefined)
      ) {
        needed.add(ev.chunkId);
      }
    }
  }
  const textMap = new Map<string, string>();
  await Promise.all(
    Array.from(needed).map(async (cid) => {
      const t = await getText(cid);
      if (typeof t === "string") textMap.set(cid, t);
    })
  );

  for (const claim of verified.claims) {
    for (const ev of claim.evidence) {
      if (!ev.chunkId) continue;
      if (ev.charStart !== undefined && ev.charEnd !== undefined) continue;

      const hay = textMap.get(ev.chunkId);
      if (!hay) continue;

      const off = findQuoteOffsets(hay, ev.quote, {
        ignoreCase: true,
        ignoreWhitespace: true,
        normalizeQuotes: true,
        normalizeDashes: true,
      });

      if (off) {
        ev.charStart = off.start;
        ev.charEnd = off.end;
      }
    }
  }
}

/* ---------------------------- Contradiction (NLI) -------------------------- */

export async function flagContradictionsInPlace(
  verified: VerifyClaimsResponse,
  opts: {
    abortSignal?: AbortSignal;
    groqOptions?: GroqProviderOptions;
    maxPairsPerClaim?: number;
  } = {}
): Promise<void> {
  const { abortSignal, groqOptions, maxPairsPerClaim = 1 } = opts;

  for (const claim of verified.claims) {
    if (!claim.evidence || claim.evidence.length < 2) continue;

    // Create lightweight pairs of quotes from different sources, limited by maxPairsPerClaim
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < claim.evidence.length; i++) {
      for (let j = i + 1; j < claim.evidence.length; j++) {
        const a = claim.evidence[i];
        const b = claim.evidence[j];
        if (a.sourceId !== b.sourceId && a.quote && b.quote) {
          pairs.push([a.quote, b.quote]);
          if (pairs.length >= maxPairsPerClaim) break;
        }
      }
      if (pairs.length >= maxPairsPerClaim) break;
    }
    if (pairs.length === 0) continue;

    // Run NLI on selected pairs
    let contradicts = false;
    for (const [qa, qb] of pairs) {
      const p = buildNLIPrompt(qa, qb);
      const res = await generateCompletion({
        model: "verify", // small model is sufficient
        system: p.system,
        prompt: p.user,
        temperature: 0,
        maxOutputTokens: 200,
        abortSignal,
        groqOptions,
      });

      const obj = parseJSON(res.text);
      const nli = NLIResultSchema.safeParse(obj);
      if (nli.success && nli.data.label === "contradict") {
        contradicts = true;
        break;
      }
    }
    if (contradicts) {
      claim.contradicted = true;
      if (!claim.uncertaintyReason) {
        claim.uncertaintyReason =
          "Conflicting evidence detected between sources.";
      }
      // Optionally down-weight supportScore lightly
      claim.supportScore = clamp01(claim.supportScore - 0.15);
    }
  }
}

/* -------------------------------- Utilities -------------------------------- */

function parseJSON(s: string): any {
  const t = (s ?? "").trim();
  if (!t) return {};
  // Unwrap code fences if present
  const unwrapped = t.startsWith("```")
    ? t.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "")
    : t;
  try {
    return JSON.parse(unwrapped);
  } catch {
    // Attempt to find first/last braces
    const first = unwrapped.indexOf("{");
    const last = unwrapped.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      const slice = unwrapped.slice(first, last + 1);
      try {
        return JSON.parse(slice);
      } catch {
        /* ignore */
      }
    }
    return {};
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
