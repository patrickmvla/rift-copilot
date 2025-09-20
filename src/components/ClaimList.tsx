"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useResearchStore } from "@/features/research/client/store";
import type {
  VerifyClaimsResponse,
  VerifiedClaim,
  SourceRef,
} from "@/features/research/types";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";

/* -------------------------------- Helpers --------------------------------- */

function clsx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function supportColor(score: number): string {
  if (score >= 0.75) return "bg-green-500";
  if (score >= 0.5) return "bg-yellow-500";
  return "bg-red-500";
}

function fmtPct(x: number): string {
  const v = Math.max(0, Math.min(1, x));
  return `${Math.round(v * 100)}%`;
}

function SupportBar({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(score * 100)));
  return (
    <div className="h-2 w-full rounded bg-muted">
      <div
        className={clsx("h-2 rounded", supportColor(score))}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function buildIndexMap(sources: SourceRef[]) {
  const m = new Map<string, number>();
  sources.forEach((s, i) => m.set(s.id, s.index ?? i + 1));
  return m;
}

/* ------------------------------- Subparts ---------------------------------- */

function EvidenceQuote({
  quote,
  sourceNum,
  onFocusSource,
}: {
  quote: string;
  sourceNum: number | undefined;
  onFocusSource: () => void;
}) {
  return (
    <div className="rounded border bg-muted/30 p-2 text-sm">
      <div className="flex items-start gap-2">
        <Badge
          variant="secondary"
          className="min-w-6 cursor-pointer justify-center"
          title="Focus this source"
          onClick={onFocusSource}
        >
          {sourceNum ?? "?"}
        </Badge>
        <div className="flex-1">
          <span className="italic">“{quote}”</span>
        </div>
      </div>
    </div>
  );
}

function ClaimHeader({
  claim,
  showConfidence,
}: {
  claim: VerifiedClaim;
  showConfidence: boolean;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="flex-1">
        <div className="text-sm font-medium">{claim.text}</div>
        <div className="mt-1 flex items-center gap-2">
          {showConfidence && (
            <>
              <div className="w-32">
                <SupportBar score={claim.supportScore ?? 0} />
              </div>
              <span className="text-xs text-muted-foreground">
                {fmtPct(claim.supportScore ?? 0)}
              </span>
            </>
          )}
          {claim.contradicted && (
            <Badge variant="destructive">Contradicted</Badge>
          )}
          {claim.claimType && (
            <Badge variant="secondary" className="capitalize">
              {claim.claimType}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- Component -------------------------------- */

export type ClaimListProps = {
  className?: string;
  // Controlled optional props
  claims?: VerifyClaimsResponse | VerifiedClaim[];
  selectedIndex?: number | null;
  onSelect?: (idx: number | null) => void;
  // UI options
  showToolbar?: boolean;
  maxHeightClass?: string; // e.g., 'max-h-[60vh]'
  placeholder?: string;
};

export function ClaimList(props: ClaimListProps) {
  const store = useResearchStore();

  const uncontrolled = !props.claims;
  const sources = store.sources;
  const indexMap = useMemo(() => buildIndexMap(sources), [sources]);

  // Data source
  const claimsRaw: VerifiedClaim[] = useMemo(() => {
    if (Array.isArray(props.claims)) return props.claims as VerifiedClaim[];
    if (props.claims && "claims" in (props.claims as VerifyClaimsResponse)) {
      return (props.claims as VerifyClaimsResponse).claims ?? [];
    }
    return (store.claims?.claims ?? []) as VerifiedClaim[];
  }, [props.claims, store.claims]);

  // Selection
  const selectedIdx = uncontrolled
    ? store.ui.selectedClaimIndex
    : props.selectedIndex ?? null;
  const select = (idx: number | null) =>
    uncontrolled ? store.selectClaim(idx) : props.onSelect?.(idx);

  // Other store bits
  const showConfidence = store.ui.showConfidence;
  const selectedSourceId = store.ui.selectedSourceId;
  const focusSource = (sid: string) => store.selectSource(sid);

  // Local UI state
  const [filter, setFilter] = useState("");
  const [onlySelectedSource, setOnlySelectedSource] = useState(false);
  const [expandedAll, setExpandedAll] = useState(false);

  // Derived: filtered + sorted claims
  const filteredClaims = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let arr = claimsRaw;

    if (q) {
      arr = arr.filter((c) => {
        const t = c.text.toLowerCase();
        const typ = (c.claimType || "").toLowerCase();
        const unc = (c.uncertaintyReason || "").toLowerCase();
        return t.includes(q) || typ.includes(q) || (unc && unc.includes(q));
      });
    }

    // Sort: contradicted first, then by support desc
    arr = [...arr].sort((a, b) => {
      if (a.contradicted !== b.contradicted) return a.contradicted ? -1 : 1;
      return (b.supportScore ?? 0) - (a.supportScore ?? 0);
    });

    return arr;
  }, [claimsRaw, filter]);

  // Scroll selected into view
  const refs = useRef(new Map<number, HTMLDivElement | null>());
  useEffect(() => {
    if (selectedIdx == null) return;
    const el = refs.current.get(selectedIdx);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedIdx, filteredClaims.length]);

  // Render
  return (
    <section
      className={clsx("rounded-md border bg-background", props.className)}
    >
      {(props.showToolbar ?? true) && (
        <>
          <div className="flex items-center gap-2 px-3 py-2">
            <div className="text-sm font-medium">Claims</div>
            <Separator orientation="vertical" className="mx-2 h-5" />
            <div className="flex-1">
              <Input
                value={filter}
                onChange={(e) => setFilter(e.currentTarget.value)}
                placeholder={
                  props.placeholder ?? "Filter by text/type/uncertainty"
                }
                className="h-8"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Only selected source
              </span>
              <Switch
                checked={onlySelectedSource}
                onCheckedChange={(v) => setOnlySelectedSource(v)}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Expand all</span>
              <Switch
                checked={expandedAll}
                onCheckedChange={(v) => setExpandedAll(v)}
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFilter("")}
              disabled={!filter}
            >
              Clear
            </Button>
            {selectedIdx != null && (
              <Button variant="ghost" size="sm" onClick={() => select(null)}>
                Unselect
              </Button>
            )}
          </div>
          <Separator />
        </>
      )}

      <div
        className={clsx(
          "flex flex-col gap-3 p-3 overflow-y-auto",
          props.maxHeightClass ?? "max-h-[60vh]"
        )}
      >
        {filteredClaims.length === 0 ? (
          <div className="text-sm text-muted-foreground">No claims.</div>
        ) : (
          filteredClaims.map((c, i) => {
            // Use original index in store order: we need stable indices for selection
            const originalIndex = claimsRaw.indexOf(c);
            const isSelected = selectedIdx === originalIndex;
            const showEvidence = expandedAll || isSelected;

            const evs = (c.evidence ?? []).filter((e) =>
              onlySelectedSource && selectedSourceId
                ? e.sourceId === selectedSourceId
                : true
            );

            return (
              <div
                key={`${c.text}-${i}`}
                // FIX: ensure the ref callback returns void, not Map
                ref={(el) => {
                  refs.current.set(originalIndex, el);
                }}
                className={clsx(
                  "rounded border p-3 transition-colors",
                  isSelected
                    ? "border-primary ring-2 ring-primary/40"
                    : "border-border"
                )}
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1">
                    <ClaimHeader claim={c} showConfidence={showConfidence} />
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => select(isSelected ? null : originalIndex)}
                    >
                      {isSelected ? "Unselect" : "Select"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(c.text);
                        } catch {
                          /* ignore */
                        }
                      }}
                    >
                      Copy
                    </Button>
                  </div>
                </div>

                {c.uncertaintyReason && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    {c.uncertaintyReason}
                  </div>
                )}

                {showEvidence && evs.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {evs.map((e, j) => (
                      <EvidenceQuote
                        key={`${originalIndex}-${j}-${e.sourceId}-${
                          e.chunkId ?? "x"
                        }`}
                        quote={e.quote}
                        sourceNum={indexMap.get(e.sourceId)}
                        onFocusSource={() => focusSource(e.sourceId)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
