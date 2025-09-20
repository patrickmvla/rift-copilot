"use client";

import { useEffect, useMemo, useRef, useState, MouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  useResearchStore,
  useResearchStage,
} from "@/features/research/client/store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

/* -------------------------------- Helpers --------------------------------- */

function stageBadgeVariant(
  stage: string
): "default" | "secondary" | "destructive" | "outline" {
  switch (stage) {
    case "plan":
    case "search":
    case "read":
    case "rank":
      return "secondary";
    case "answer":
    case "verify":
      return "default";
    case "done":
      return "outline";
    case "error":
      return "destructive";
    default:
      return "secondary";
  }
}

/**
 * Linkify bare numeric citations: [1] -> [1](#cite-1)
 * - Skips image syntax: ![alt]
 * - Skips existing links: [text](...)
 */
function linkifyCitations(md: string): string {
  if (!md) return "";
  let out = "";
  for (let i = 0; i < md.length; i++) {
    const ch = md[i];

    // Skip image alt syntax: '![...'
    if (ch === "!" && md[i + 1] === "[") {
      out += ch;
      continue;
    }

    // Detect [digits] not immediately followed by '(' (which would be a link)
    if (ch === "[") {
      let j = i + 1;
      let digits = "";
      while (
        j < md.length &&
        md[j] >= "0" &&
        md[j] <= "9" &&
        digits.length < 3
      ) {
        digits += md[j];
        j++;
      }
      if (digits.length > 0 && j < md.length && md[j] === "]") {
        const after = md[j + 1] || "";
        if (after !== "(") {
          out += `[${digits}](#cite-${digits})`;
          i = j; // jump past the closing ]
          continue;
        }
      }
    }

    out += ch;
  }
  return out;
}

function EmptyState({ stage }: { stage: string }) {
  const hints: Record<string, string> = {
    idle: "Ask a question to start a research run.",
    plan: "Planning sub-queries…",
    search: "Searching the web…",
    read: "Reading sources…",
    rank: "Ranking snippets…",
    answer: "Drafting answer…",
    verify: "Verifying claims…",
    done: "No content.",
    error: "An error occurred.",
  };
  return (
    <div className="text-sm text-muted-foreground">
      {hints[stage] ?? "Waiting for output…"}
      <div className="mt-3 space-y-2">
        <div className="h-4 w-5/6 animate-pulse rounded bg-muted" />
        <div className="h-4 w-4/6 animate-pulse rounded bg-muted" />
        <div className="h-4 w-3/6 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}

/* ------------------------------- Component -------------------------------- */

export function ChatStream() {
  const stage = useResearchStage();

  // FIX: Select each slice separately to avoid creating a new object each render
  // (prevents "getServerSnapshot should be cached" in React 19/Next 15)
  const sources = useResearchStore((s) => s.sources);
  const answerMarkdown = useResearchStore((s) => s.answerMarkdown);
  const tokensAppended = useResearchStore((s) => s.tokensAppended);

  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  // Convert [n] to [n](#cite-n) for clickable citations
  const linkedMarkdown = useMemo(
    () => linkifyCitations(answerMarkdown),
    [answerMarkdown]
  );

  useEffect(() => {
    if (!autoScroll) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [tokensAppended, autoScroll]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(answerMarkdown || "");
    } catch {
      // ignore
    }
  };

  const onDownload = () => {
    const blob = new Blob([answerMarkdown || ""], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "research-answer.md";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCitationClick = (
    e: MouseEvent<HTMLAnchorElement>,
    href?: string
  ) => {
    if (!href || !href.startsWith("#cite-")) return;
    e.preventDefault();
    const n = Number(href.replace("#cite-", ""));
    if (!Number.isFinite(n)) return;
    const sref = sources.find((s) => s.index === n);
    if (sref) {
      useResearchStore.getState().selectSource(sref.id);
    }
  };

  return (
    <section className="rounded-md border bg-background">
      <div className="flex items-center gap-2 px-3 py-2">
        <Badge variant={stageBadgeVariant(stage)} className="uppercase">
          {stage}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {tokensAppended > 0
            ? `${tokensAppended} chars streamed`
            : "Awaiting output"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setAutoScroll((s) => !s)}
          >
            {autoScroll ? "Auto-scroll: On" : "Auto-scroll: Off"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCopy}
            disabled={!answerMarkdown}
          >
            Copy
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDownload}
            disabled={!answerMarkdown}
          >
            Download .md
          </Button>
        </div>
      </div>
      <Separator />
      <div
        ref={containerRef}
        className={[
          "prose prose-sm md:prose-base dark:prose-invert max-w-none px-4 py-4",
          "h-[52vh] md:h-[60vh] overflow-y-auto",
        ].join(" ")}
      >
        {answerMarkdown ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a({ href, children, ...props }) {
                const isCitation =
                  typeof href === "string" && href.startsWith("#cite-");
                return (
                  <a
                    href={href}
                    {...props}
                    onClick={(e) => handleCitationClick(e, href)}
                    className={
                      isCitation
                        ? "text-primary no-underline hover:underline cursor-pointer"
                        : "underline"
                    }
                  >
                    {children}
                  </a>
                );
              },
              pre({ children }) {
                return (
                  <pre className="overflow-x-auto rounded-md border bg-muted p-3 text-xs">
                    {children}
                  </pre>
                );
              },
              code({ children }) {
                return (
                  <code className="rounded bg-muted px-1 py-0.5">
                    {children}
                  </code>
                );
              },
            }}
          >
            {linkedMarkdown}
          </ReactMarkdown>
        ) : (
          <EmptyState stage={stage} />
        )}
      </div>
    </section>
  );
}
