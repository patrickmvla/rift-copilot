/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useMemo } from "react";
import {
  useResearchStore,
  useResearchStage,
} from "@/features/research/client/store";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";

/* -------------------------------- Helpers --------------------------------- */

function clsx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

const STAGES = [
  "plan",
  "search",
  "read",
  "rank",
  "answer",
  "verify",
  "done",
] as const;
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

  // FIX: select fields individually to avoid creating a new object each render
  // (prevents React's "getSnapshot should be cached" warning)
  const startedAt = useResearchStore((s) => s.startedAt);
  const endedAt = useResearchStore((s) => s.endedAt);
  const progress = useResearchStore((s) => s.progress);

  const value = useMemo(() => stagePercent(stage), [stage]);
  const elapsed = useMemo(() => {
    if (!startedAt) return 0;
    const end = endedAt ?? Date.now();
    return end - startedAt;
  }, [startedAt, endedAt]);

  const statusBadge =
    stage === "error"
      ? { variant: "destructive" as const, text: STAGE_LABEL[stage] }
      : stage === "done"
      ? { variant: "outline" as const, text: STAGE_LABEL[stage] }
      : { variant: "secondary" as const, text: STAGE_LABEL[stage] };

  return (
    <section
      className={clsx("rounded-md border bg-background", props.className)}
    >
      <div
        className={clsx(
          "flex items-center gap-3 px-3",
          props.compact ? "py-2" : "py-3"
        )}
      >
        <Badge variant={statusBadge.variant} className="uppercase">
          {statusBadge.text}
        </Badge>
        <div className="flex-1">
          <Progress value={value} className="h-2" />
        </div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {formatElapsed(elapsed)}
        </div>
      </div>

      {/* Stepper */}
      <div className={clsx("px-3 pb-2")}>
        <div className="flex items-center justify-between">
          {STAGES.map((s, i) => {
            const idx = stageIndex(stage);
            const completed = i < idx || stage === "done";
            const current = i === idx && stage !== "done";
            return (
              <div
                key={s}
                className="flex min-w-0 flex-1 items-center last:flex-none"
              >
                <div className="flex items-center gap-2">
                  <div
                    className={clsx(
                      "h-2 w-2 rounded-full",
                      completed
                        ? "bg-primary"
                        : current
                        ? "bg-primary/70"
                        : "bg-muted-foreground/30"
                    )}
                    title={STAGE_LABEL[s as Stage]}
                  />
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
              <div className="text-xs text-muted-foreground">
                No progress yet.
              </div>
            ) : (
              <ul className="space-y-1">
                {progress.map((p, i) => (
                  <li
                    key={`${p.stage}-${p.ts}-${i}`}
                    className="flex items-center gap-2 text-xs"
                  >
                    <span className="text-muted-foreground">
                      {formatElapsed(
                        (p.ts ?? Date.now()) - (startedAt ?? p.ts)
                      )}
                    </span>
                    <span className="text-muted-foreground">•</span>
                    <span className="font-medium">
                      {STAGE_LABEL[p.stage as Stage] || p.stage}
                    </span>
                    {p.message ? (
                      <>
                        <span className="text-muted-foreground">—</span>
                        <span className="truncate">{p.message}</span>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
