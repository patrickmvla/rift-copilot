export type TokenEstimateMethod = "chars" | "words" | "hybrid";

export type TokenStats = {
  chars: number;
  codePoints: number;
  ascii: number;
  nonAscii: number;
  whitespace: number;
  punctuation: number;
  words: number;
};

export type Window = {
  text: string;
  charStart: number;
  charEnd: number;
  approxTokens: number;
};

const DEFAULT_CHARS_PER_TOKEN = 4;

export function estimateTokens(
  s: string,
  opts?: { method?: TokenEstimateMethod; charsPerToken?: number }
): number {
  const method = opts?.method ?? "hybrid";
  const cpt = Math.max(1, opts?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN);
  const stats = countTokenStats(s);
  const byChars = Math.ceil(stats.chars / cpt);
  const byWords = Math.ceil(stats.words * 1.25 + stats.punctuation * 0.2);
  if (method === "chars") return byChars;
  if (method === "words") return byWords;
  const penalty = Math.ceil(stats.nonAscii * 0.02);
  return Math.max(byChars, byWords) + penalty;
}

export function truncateByTokens(
  s: string,
  maxTokens: number,
  opts?: {
    charsPerToken?: number;
    suffix?: string;
    preferSentenceBoundary?: boolean;
    extraCharBuffer?: number;
  }
): string {
  if (!s) return s;
  if (maxTokens <= 0) return "";
  const cpt = Math.max(1, opts?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN);
  const maxChars = Math.max(1, Math.floor(maxTokens * cpt));
  if (s.length <= maxChars) return s;
  const suffix = opts?.suffix ?? "…";
  const buffer = opts?.extraCharBuffer ?? 240;
  const preferSentence = opts?.preferSentenceBoundary ?? true;
  const slice = s.slice(0, Math.min(s.length, maxChars + buffer));
  let cut = Math.min(slice.length, maxChars);
  if (preferSentence) {
    const reSentence = /[.!?][)"'```]?(?:\s|\n|$)/g;
    let m: RegExpExecArray | null;
    while ((m = reSentence.exec(slice))) {
      if (m.index + m[0].length <= maxChars) cut = m.index + m[0].length;
    }
  }
  if (cut === maxChars) {
    const ws = slice.lastIndexOf(" ", maxChars);
    const nl = slice.lastIndexOf("\n", maxChars);
    const idx = Math.max(ws, nl);
    if (idx > 0) cut = idx;
  }
  const out = slice.slice(0, cut).trimEnd();
  return out.length < s.length ? out + suffix : out;
}

export function splitIntoWindows(
  s: string,
  opts?: {
    targetTokens?: number;
    overlapRatio?: number;
    charsPerToken?: number;
    respectParagraphs?: boolean;
  }
): Window[] {
  const targetTokens = Math.max(50, opts?.targetTokens ?? 1000);
  const overlapRatio = Math.min(0.9, Math.max(0, opts?.overlapRatio ?? 0.15));
  const cpt = Math.max(1, opts?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN);
  const targetChars = Math.floor(targetTokens * cpt);
  const overlapChars = Math.floor(targetChars * overlapRatio);
  if (!s || s.length <= targetChars) {
    return [
      {
        text: s,
        charStart: 0,
        charEnd: s.length,
        approxTokens: estimateTokens(s),
      },
    ];
  }
  if (opts?.respectParagraphs !== false) {
    const paras = splitParagraphs(s);
    const windows: Window[] = [];
    let buf = "";
    let bufStart = paras.length ? paras[0].start : 0;
    let lastEnd = bufStart;
    for (const p of paras) {
      const add = (buf ? "\n\n" : "") + p.text;
      if ((buf + add).length > targetChars && buf) {
        const charStart = bufStart;
        const charEnd = lastEnd;
        windows.push({
          text: buf,
          charStart,
          charEnd,
          approxTokens: estimateTokens(buf),
        });
        const overlapStart = Math.max(charStart, charEnd - overlapChars);
        const overlapText = s.slice(overlapStart, charEnd);
        buf = overlapText + "\n\n" + p.text;
        bufStart = overlapStart;
        lastEnd = p.end;
      } else {
        buf = buf + add;
        if (bufStart === 0 && buf) bufStart = p.start;
        lastEnd = p.end;
      }
    }
    if (buf)
      windows.push({
        text: buf,
        charStart: bufStart,
        charEnd: lastEnd,
        approxTokens: estimateTokens(buf),
      });
    return windows;
  }
  const windows: Window[] = [];
  let pos = 0;
  while (pos < s.length) {
    const end = Math.min(s.length, pos + targetChars);
    const text = s.slice(pos, end);
    windows.push({
      text,
      charStart: pos,
      charEnd: end,
      approxTokens: estimateTokens(text),
    });
    if (end >= s.length) break;
    pos = Math.max(0, end - overlapChars);
  }
  return windows;
}

export function splitParagraphs(
  s: string
): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  if (!s) return out;
  const re = /\n{2,}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = last;
    const end = m.index;
    if (end > start) out.push({ text: s.slice(start, end), start, end });
    last = m.index + m[0].length;
  }
  if (last < s.length)
    out.push({ text: s.slice(last), start: last, end: s.length });
  return out;
}

export function splitSentences(
  s: string
): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  if (!s) return out;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "." || ch === "!" || ch === "?") {
      const prev = i > 0 ? s[i - 1] : "";
      const next = i + 1 < s.length ? s[i + 1] : "";
      if (/\d/.test(prev) && /\d/.test(next)) continue;
      let j = i + 1;
      while (j < s.length && /["')```\}»”’]/.test(s[j])) j++;
      if (j < s.length && !/\s|\n/.test(s[j])) continue;
      const end = j;
      const text = s.slice(start, end).trim();
      if (text) out.push({ text, start, end });
      start = end;
    }
  }
  if (start < s.length) {
    const tail = s.slice(start).trim();
    if (tail) out.push({ text: tail, start, end: s.length });
  }
  return out;
}

export function sanitizeText(
  s: string,
  opts?: {
    normalize?: "NFC" | "NFD" | "NFKC" | "NFKD" | false;
    removeControl?: boolean;
    collapseWhitespace?: boolean;
    preserveNewlines?: boolean;
    decodeEntities?: boolean;
    stripMarkdownSyntax?: boolean;
  }
): string {
  if (!s) return "";
  const {
    normalize = "NFKC",
    removeControl = true,
    collapseWhitespace = false,
    preserveNewlines = true,
    decodeEntities = true,
    stripMarkdownSyntax = false,
  } = opts ?? {};
  let out = s;
  if (normalize) {
    try {
      out = out.normalize(normalize);
    } catch {}
  }
  if (removeControl) {
    out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  }
  if (decodeEntities) {
    out = decodeHtmlEntities(out);
  }
  if (stripMarkdownSyntax) {
    out = stripMarkdown(out);
  }
  if (collapseWhitespace) {
    if (preserveNewlines) {
      out = out
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]+\n/g, "\n");
    } else {
      out = out.replace(/\s+/g, " ").trim();
    }
  }
  return out;
}

function removeFencedBlocks(src: string, fence: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const a = src.indexOf(fence, i);
    if (a === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, a);
    const b = src.indexOf(fence, a + fence.length);
    if (b === -1) {
      out += src.slice(a + fence.length);
      break;
    }
    const inner = src.slice(a + fence.length, b).trim();
    out += inner;
    i = b + fence.length;
  }
  return out;
}

function removeDelimitedBlocks(
  src: string,
  open: string,
  close: string
): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const a = src.indexOf(open, i);
    if (a === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, a);
    const b = src.indexOf(close, a + open.length);
    if (b === -1) {
      out += src.slice(a + open.length);
      break;
    }
    const inner = src.slice(a + open.length, b).trim();
    out += inner;
    i = b + close.length;
  }
  return out;
}

function removeInlineDollarMath(src: string): string {
  const lines = src.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const s = lines[li];
    let out = "";
    let i = 0;
    while (i < s.length) {
      if (s[i] === "$") {
        const prev = i > 0 ? s[i - 1] : "";
        if (prev === "\\") {
          out += "$";
          i += 1;
          continue;
        }
        let j = i + 1;
        let found = -1;
        while (j < s.length) {
          if (s[j] === "$" && s[j - 1] !== "\\") {
            found = j;
            break;
          }
          j++;
        }
        if (found !== -1) {
          const inner = s.slice(i + 1, found).trim();
          out += inner;
          i = found + 1;
          continue;
        }
      }
      out += s[i];
      i += 1;
    }
    lines[li] = out;
  }
  return lines.join("\n");
}

export function stripMarkdown(md: string): string {
  if (!md) return "";

  let text = md;

  // Remove code blocks and inline code
  text = removeFencedBlocks(text, "```");
  text = text.replace(/`([^`]+)`/g, "$1");

  // Remove math blocks with KATEX markers
  text = text.replace(
    /!```math\n([^```]*)```KATEX_INLINE_OPEN[^)]+KATEX_INLINE_CLOSE/g,
    "$1"
  );
  text = text.replace(
    /```math\n([^```]+)```KATEX_INLINE_OPEN[^)]+KATEX_INLINE_CLOSE/g,
    "$1"
  );

  // Remove emphasis markers
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2"); // Bold
  text = text.replace(/(\*|_)(.*?)\1/g, "$2"); // Italic

  // Process line-by-line elements
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Remove headers
    line = line.replace(/^\s{0,3}#{1,6}\s+/, "");

    // Remove blockquotes
    line = line.replace(/^\s{0,3}>\s?/, "");

    // Remove list markers
    line = line.replace(/^\s{0,3}[-*+]\s+/, ""); // Unordered lists
    line = line.replace(/^\s{0,3}\d+\.\s+/, ""); // Ordered lists

    // Clean table formatting
    if (/^\s*\|/.test(line)) {
      line = line.replace(/^\s*\|/, "");
    }
    if (/\|\s*$/.test(line)) {
      line = line.replace(/\|\s*$/, "");
    }
    line = line.replace(/\s*\|\s*/g, "  ");

    // Remove horizontal rules
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      line = "";
    }

    lines[i] = line;
  }
  text = lines.join("\n");

  // Remove math delimiters
  text = removeDelimitedBlocks(text, "$$", "$$");
  text = removeDelimitedBlocks(text, "```math\n", "```");
  text = removeDelimitedBlocks(text, "KATEX_INLINE_OPEN", "KATEX_INLINE_CLOSE");
  text = removeInlineDollarMath(text);

  // Escape special characters after KATEX markers
  text = text.replace(
    /KATEX_INLINE_OPEN([\\`*_{}```math\n```()#+\-.!])/g,
    "$1"
  );

  // Normalize whitespace
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

export function findQuoteOffsets(
  text: string,
  quote: string,
  opts?: {
    ignoreCase?: boolean;
    ignoreWhitespace?: boolean;
    normalizeQuotes?: boolean;
    normalizeDashes?: boolean;
    maxSteps?: number;
  }
): { start: number; end: number } | null {
  if (!text || !quote) return null;
  const idx = indexOfSafe(text, quote, opts?.ignoreCase);
  if (idx !== -1) return { start: idx, end: idx + quote.length };
  return tolerantFind(text, quote, {
    ignoreCase: opts?.ignoreCase ?? true,
    ignoreWhitespace: opts?.ignoreWhitespace ?? true,
    normalizeQuotes: opts?.normalizeQuotes ?? true,
    normalizeDashes: opts?.normalizeDashes ?? true,
    maxSteps: opts?.maxSteps ?? 2_000_000,
  });
}

function indexOfSafe(
  hay: string,
  needle: string,
  ignoreCase?: boolean
): number {
  if (!ignoreCase) return hay.indexOf(needle);
  return hay.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
}

function tolerantFind(
  hay: string,
  needle: string,
  opts: {
    ignoreCase: boolean;
    ignoreWhitespace: boolean;
    normalizeQuotes: boolean;
    normalizeDashes: boolean;
    maxSteps: number;
  }
): { start: number; end: number } | null {
  const normChar = (c: string): string => {
    let ch = c;
    if (opts.ignoreCase) ch = ch.toLowerCase();
    if (opts.normalizeQuotes) {
      if ("“”„»«".includes(ch)) ch = '"';
      if ("‘’‚‹›".includes(ch)) ch = "'";
    }
    if (opts.normalizeDashes && "—–‐‑‒".includes(ch)) ch = "-";
    if (opts.ignoreWhitespace && /\s/.test(ch)) ch = " ";
    return ch;
  };
  const normNeedleArr: string[] = [];
  let lastWasSpace = false;
  for (const c of needle) {
    const n = normChar(c);
    if (n === " ") {
      if (!lastWasSpace) normNeedleArr.push(" ");
      lastWasSpace = true;
    } else {
      normNeedleArr.push(n);
      lastWasSpace = false;
    }
  }
  const normNeedle = normNeedleArr.join("");
  if (!normNeedle) return null;
  const n0 = normNeedle[0];
  const maxSteps = opts.maxSteps;
  let steps = 0;
  for (let i = 0; i < hay.length; i++) {
    const hc = normChar(hay[i]);
    if (hc !== n0) continue;
    let hi = i;
    let nj = 0;
    let start = -1;
    while (hi < hay.length && nj < normNeedle.length) {
      if (++steps > maxSteps) return null;
      let hch = normChar(hay[hi]);
      const nch = normNeedle[nj];
      if (opts.ignoreWhitespace && hch === " ") {
        let hj = hi + 1;
        while (hj < hay.length && /\s/.test(hay[hj])) {
          if (++steps > maxSteps) return null;
          hj++;
        }
        hch = " ";
      }
      if (hch === nch) {
        if (start === -1) start = hi;
        hi++;
        nj++;
      } else {
        start = -1;
        break;
      }
    }
    if (nj === normNeedle.length) {
      let end = hi;
      if (opts.ignoreWhitespace && normNeedle.endsWith(" ")) {
        while (end < hay.length && /\s/.test(hay[end])) end++;
      }
      return { start: start === -1 ? i : start, end };
    }
  }
  return null;
}

export function makeSnippet(
  text: string,
  start: number,
  end: number,
  opts?: { context?: number; ellipsis?: string }
): string {
  const ctx = Math.max(0, opts?.context ?? 120);
  const ell = opts?.ellipsis ?? "…";
  const s = Math.max(0, start - ctx);
  const e = Math.min(text.length, end + ctx);
  let prefix = text.slice(s, start);
  let mid = text.slice(start, end);
  let suffix = text.slice(end, e);
  prefix = prefix.replace(/\s+/g, " ").trimStart();
  mid = mid.replace(/\s+/g, " ");
  suffix = suffix.replace(/\s+/g, " ").trimEnd();
  const leftEll = s > 0 ? ell + " " : "";
  const rightEll = e < text.length ? " " + ell : "";
  return `${leftEll}${prefix}${mid}${suffix}${rightEll}`.trim();
}

export function countTokenStats(s: string): TokenStats {
  let codePoints = 0;
  let ascii = 0;
  let nonAscii = 0;
  let whitespace = 0;
  let punctuation = 0;
  for (const ch of s) {
    codePoints++;
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x7f) ascii++;
    else nonAscii++;
    if (/\s/.test(ch)) whitespace++;
    if (/[.,!?;:()[```{}"“”'‘’—–\-…]/.test(ch)) punctuation++;
  }
  const words = countWords(s);
  return {
    chars: s.length,
    codePoints,
    ascii,
    nonAscii,
    whitespace,
    punctuation,
    words,
  };
}

function countWords(s: string): number {
  if (!s) return 0;
  const parts = s.trim().split(/\s+/);
  return parts.filter(Boolean).length;
}

function decodeHtmlEntities(s: string): string {
  const map: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&#39;": "'",
    "&apos;": "'",
    "&quot;": '"',
    "&nbsp;": " ",
    "&ndash;": "–",
    "&mdash;": "—",
    "&hellip;": "…",
  };
  return s.replace(/&[a-zA-Z#0-9]+;?/g, (m) => map[m] ?? m);
}
