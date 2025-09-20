import { estimateTokens, sanitizeText, splitIntoWindows } from '@/lib/text';
import type { Window as TextWindow } from '@/lib/text';

export type ChunkerOptions = {
  targetTokens?: number;       // default 1000
  overlapRatio?: number;       // default 0.15
  charsPerToken?: number;      // default 4
  respectParagraphs?: boolean; // default true
  minChunkChars?: number;      // default 300
  maxChunks?: number;          // optional cap
  sanitize?: boolean;          // default true
};

export type ChunkOut = {
  text: string;
  charStart: number; // offset in the (optionally sanitized) full text
  charEnd: number;   // exclusive
  tokens: number;    // approximate, integer
  pos: number;       // 0-based order
};

/**
 * Chunk long text into overlapping windows with stable offsets.
 * - Preserves paragraph boundaries when possible.
 * - Ensures the last trailing chunk is not tiny by merging with its predecessor.
 * - Optionally caps total chunk count with even sampling.
 */
export function chunkText(input: string, options: ChunkerOptions = {}): ChunkOut[] {
  const {
    targetTokens = 1000,
    overlapRatio = 0.15,
    charsPerToken = 4,
    respectParagraphs = true,
    minChunkChars = 300,
    maxChunks,
    sanitize = true,
  } = options;

  if (!input || !input.trim()) return [];

  // Pre-sanitize for stable offsets/newlines; do NOT collapse whitespace (keep offsets meaningful)
  const text = sanitize
    ? sanitizeText(input, {
        normalize: 'NFKC',
        removeControl: true,
        collapseWhitespace: false,
        preserveNewlines: true,
        decodeEntities: true,
      })
    : input;

  // Initial windows by paragraphs with overlap
  let windows: TextWindow[] = splitIntoWindows(text, {
    targetTokens,
    overlapRatio,
    charsPerToken,
    respectParagraphs,
  });

  if (windows.length === 0) return [];

  // Merge a tiny tail window back into previous window to avoid very small trailing chunk
  windows = rebalanceTail(text, windows, minChunkChars, charsPerToken);

  // Optionally cap total number of chunks with even sampling (preserve approxTokens)
  if (typeof maxChunks === 'number' && maxChunks > 0 && windows.length > maxChunks) {
    windows = sampleWindowsEvenly(windows, maxChunks);
  }

  // Final chunk objects with consistent token estimates
  const out: ChunkOut[] = windows.map((w, i) => ({
    text: w.text,
    charStart: w.charStart,
    charEnd: w.charEnd,
    tokens: Math.max(1, Math.round(w.approxTokens || estimateTokens(w.text, { charsPerToken }))),
    pos: i,
  }));

  return out;
}

/* -------------------------------- Internals -------------------------------- */

/**
 * If the last window is very small, merge it with the previous window by taking a single
 * contiguous slice from the original text. This preserves stable offsets and approxTokens.
 */
function rebalanceTail(
  fullText: string,
  windows: TextWindow[],
  minTailChars: number,
  charsPerToken: number
): TextWindow[] {
  if (windows.length <= 1) return windows;

  const out = windows.slice();

  // Merge repeatedly if still too small after a merge (rare but safe)
  while (out.length > 1 && out[out.length - 1].text.length < minTailChars) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];

    const start = prev.charStart;
    const end = last.charEnd;
    const mergedText = fullText.slice(start, end);

    const merged: TextWindow = {
      text: mergedText,
      charStart: start,
      charEnd: end,
      approxTokens: estimateTokens(mergedText, { charsPerToken }),
    };

    out.splice(out.length - 2, 2, merged);
  }

  return out;
}

/**
 * Evenly sample a list of windows down to a target size.
 * Keeps the first and last windows and spreads the rest uniformly.
 */
function sampleWindowsEvenly(windows: TextWindow[], k: number): TextWindow[] {
  const n = windows.length;
  if (k >= n) return windows.slice();
  if (k <= 0) return [];
  if (k === 1) return [windows[0]];
  if (k === 2) return [windows[0], windows[n - 1]];

  const indices = new Set<number>();
  indices.add(0);
  indices.add(n - 1);

  const innerK = k - 2;
  for (let i = 1; i <= innerK; i++) {
    const t = i / (innerK + 1); // (0,1)
    const idx = Math.round(t * (n - 1));
    indices.add(Math.min(n - 1, Math.max(0, idx)));
  }

  const sortedIdx = Array.from(indices).sort((a, b) => a - b);
  return sortedIdx.map((i) => windows[i]);
}