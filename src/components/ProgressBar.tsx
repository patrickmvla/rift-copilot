/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  useResearchStore,
  useResearchStage,
} from "@/features/research/client/store";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import {
  ListChecks,
  Search as SearchIcon,
  BookOpenText,
  ArrowUpDown,
  MessageSquareText,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  Loader2,
} from "lucide-react";

/* -------------------------------- Helpers --------------------------------- */

function clsx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

const STAGES = ["plan", "search", "read", "rank", "answer", "verify", "done"] as const;
type Stage = (typeof STAGES)[number] | "idle" | "error";

const STAGE_LABEL: Record<Stage, string> = {
  idle: "Idle",
  plan: "Plan",
  search: "Search",
  read: "Read",
  rank: "Rank",
  answer: "Answer",
  verify: "Verify",
  done: "Done",
  error: "Error",
};

const STAGE_ICON: Record<Stage, any> = {
  idle: ListChecks,
  plan: ListChecks,
  search: SearchIcon,
  read: BookOpenText,
  rank: ArrowUpDown,
  answer: MessageSquareText,
  verify: ShieldCheck,
  done: CheckCircle2,
  error: AlertTriangle,
};

function stageIndex(stage: Stage): number {
  if (stage === "idle") return 0;
  if (stage === "error") return STAGES.length - 1;
  const idx = STAGES.indexOf(stage as any);
  return idx >= 0 ? idx : 0;
}

function stagePercent(stage: Stage): number {
  if (stage === "idle") return 0;
  const idx = stageIndex(stage);
  const maxIdx = STAGES.length - 1;
  const pct = Math.round((idx / maxIdx) * 100);
  return Math.max(0, Math.min(100, pct));
}

function formatElapsed(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "0:00";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return `${m}:${ss}`;
}

/* -------------------------------- Component -------------------------------- */

export type ProgressBarProps = {
  className?: string;
  compact?: boolean; // smaller header
  showTimeline?: boolean; // render the per-step log below
};

export function ProgressBar(props: ProgressBarProps) {
  const stage = useResearchStage() as Stage;

  // Select fields individually to avoid re-creating objects on each render
  const startedAt = useResearchStore((s) => s.startedAt);
  const endedAt = useResearchStore((s) => s.endedAt);
  const progress = useResearchStore((s) => s.progress);

  const value = useMemo(() => stagePercent(stage), [stage]);
  const elapsed = useMemo(() => {
    if (!startedAt) return 0;
    const end = endedAt ?? Date.now();
    return end - startedAt;
  }, [startedAt, endedAt]);

  const status =
    stage === "error"
      ? { variant: "destructive" as const, text: "Error", icon: STAGE_ICON.error }
      : stage === "done"
      ? { variant: "outline" as const, text: "Done", icon: STAGE_ICON.done }
      : {
          variant: "secondary" as const,
          text: STAGE_LABEL[stage] || "Running",
          icon: STAGE_ICON[stage] || Loader2,
        };

  // Auto-scroll timeline to newest item
  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!props.showTimeline) return;
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [props.showTimeline, progress.length]);

  return (
    <section
      className={clsx("rounded-md border bg-background", props.className)}
      role="status"
      aria-live="polite"
      aria-label={`Research status: ${STAGE_LABEL[stage]}`}
    >
      {/* Header row */}
      <div className={clsx("flex items-center gap-3 px-3", props.compact ? "py-2" : "py-3")}>
        <Badge
          variant={status.variant}
          className={clsx(
            "flex items-center gap-1.5 uppercase",
            status.variant === "destructive" ? "text-white" : ""
          )}
          title={STAGE_LABEL[stage]}
        >
          {stage === "done" ? (
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
          ) : stage === "error" ? (
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <Loader2
              className={clsx("h-3.5 w-3.5", stage === "idle" ? "" : "animate-spin")}
              aria-hidden
            />
          )}
          {status.text}
        </Badge>

        <div className="flex-1">
          <Progress value={value} className="h-2" />
        </div>

        <div className="text-right">
          <div className="text-xs text-muted-foreground tabular-nums">{formatElapsed(elapsed)}</div>
          {!props.compact && (
            <div className="text-[10px] text-muted-foreground tabular-nums">{value}%</div>
          )}
        </div>
      </div>

      {/* Stepper */}
      <div className="px-3 pb-2">
        <div className="flex items-center justify-between">
          {STAGES.map((s, i) => {
            const idx = stageIndex(stage);
            const completed = i < idx || stage === "done";
            const current = i === idx && stage !== "done";
            const Icon = STAGE_ICON[s];
            return (
              <div key={s} className="flex min-w-0 flex-1 items-center last:flex-none">
                <div className="flex items-center gap-2">
                  <div
                    className={clsx(
                      "flex h-6 w-6 items-center justify-center rounded-full border text-[10px]",
                      completed
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : current
                        ? "border-primary/50 bg-primary/15 text-primary animate-pulse"
                        : "border-muted-foreground/30 bg-muted-foreground/10 text-muted-foreground"
                    )}
                    title={STAGE_LABEL[s as Stage]}
                    aria-current={current ? "step" : undefined}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden />
                  </div>
                  <span
                    className={clsx(
                      "truncate text-xs",
                      completed
                        ? "text-foreground"
                        : current
                        ? "text-foreground"
                        : "text-muted-foreground"
                    )}
                  >
                    {STAGE_LABEL[s as Stage]}
                  </span>
                </div>
                {i < STAGES.length - 1 && (
                  <div className="mx-2 h-[1px] flex-1 bg-muted-foreground/20" />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Timeline (optional) */}
      {props.showTimeline && (
        <>
          <Separator />
          <div className="px-3 py-2">
            {progress.length === 0 ? (
              <div className="text-xs text-muted-foreground">No progress yet.</div>
            ) : (
              <div ref={logRef} className="max-h-48 overflow-auto">
                <ul className="space-y-1">
                  {progress.map((p, i) => {
                    const st = (p.stage as Stage) || "idle";
                    const Icon = STAGE_ICON[st] || ListChecks;
                    const label = STAGE_LABEL[st] || p.stage;
                    return (
                      <li
                        key={`${p.stage}-${p.ts}-${i}`}
                        className="flex items-center gap-2 text-xs"
                      >
                        <span className="text-muted-foreground tabular-nums">
                          {formatElapsed((p.ts ?? Date.now()) - (startedAt ?? p.ts))}
                        </span>
                        <span className="text-muted-foreground">•</span>
                        <span
                          className={clsx(
                            "inline-flex items-center gap-1.5 font-medium",
                            st === "error"
                              ? "text-destructive"
                              : st === "done"
                              ? "text-foreground"
                              : "text-foreground"
                          )}
                        >
                          <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                          {label}
                        </span>
                        {p.message ? (
                          <>
                            <span className="text-muted-foreground">—</span>
                            <span className="truncate">{p.message}</span>
                          </>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}