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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  Search as SearchIcon,
  Filter,
  X,
  Copy as CopyIcon,
  Download as DownloadIcon,
  AlertTriangle,
} from "lucide-react";

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

function escapeCSV(s: string) {
  const needsQuotes = /[",\n]/.test(s);
  const escaped = s.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
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
        <div className="mt-1 flex flex-wrap items-center gap-2">
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
          {claim.contradicted && <Badge variant="destructive">Contradicted</Badge>}
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
  // Select slices individually to avoid re-creating objects on each render
  const sources = useResearchStore((s) => s.sources);
  const storeClaims = useResearchStore((s) => s.claims);
  const storeSelectedIndex = useResearchStore((s) => s.ui.selectedClaimIndex);
  const storeShowConfidence = useResearchStore((s) => s.ui.showConfidence);
  const selectedSourceId = useResearchStore((s) => s.ui.selectedSourceId);
  const selectClaimInStore = useResearchStore((s) => s.selectClaim);
  const selectSource = useResearchStore((s) => s.selectSource);

  const indexMap = useMemo(() => buildIndexMap(sources), [sources]);

  // Data source
  const claimsRaw: VerifiedClaim[] = useMemo(() => {
    if (Array.isArray(props.claims)) return props.claims as VerifiedClaim[];
    if (props.claims && "claims" in (props.claims as VerifyClaimsResponse)) {
      return (props.claims as VerifyClaimsResponse).claims ?? [];
    }
    return (storeClaims?.claims ?? []) as VerifiedClaim[];
  }, [props.claims, storeClaims]);

  // Selection
  const uncontrolled = !props.claims;
  const selectedIdx = uncontrolled ? storeSelectedIndex : props.selectedIndex ?? null;
  const select = (idx: number | null) =>
    uncontrolled ? selectClaimInStore(idx) : props.onSelect?.(idx);

  // Local UI state
  const [filter, setFilter] = useState("");
  const [onlySelectedSource, setOnlySelectedSource] = useState(false);
  const [expandedAll, setExpandedAll] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [supportMin, setSupportMin] = useState<string>("0");
  const [contradictedOnly, setContradictedOnly] = useState(false);

  const showConfidence = storeShowConfidence;

  // Unique types for filter
  const types = useMemo(() => {
    const set = new Set<string>();
    for (const c of claimsRaw) if (c.claimType) set.add(c.claimType);
    return Array.from(set);
  }, [claimsRaw]);

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

    if (typeFilter !== "all") {
      arr = arr.filter((c) => (c.claimType || "").toLowerCase() === typeFilter.toLowerCase());
    }

    const min = Number(supportMin) || 0;
    if (min > 0) {
      arr = arr.filter((c) => (c.supportScore ?? 0) >= min);
    }

    if (contradictedOnly) {
      arr = arr.filter((c) => !!c.contradicted);
    }

    if (onlySelectedSource && selectedSourceId) {
      arr = arr.filter((c) => (c.evidence ?? []).some((e) => e.sourceId === selectedSourceId));
    }

    // Sort: contradicted first, then by support desc
    arr = [...arr].sort((a, b) => {
      if (a.contradicted !== b.contradicted) return a.contradicted ? -1 : 1;
      return (b.supportScore ?? 0) - (a.supportScore ?? 0);
    });

    return arr;
  }, [claimsRaw, filter, typeFilter, supportMin, contradictedOnly, onlySelectedSource, selectedSourceId]);

  const totalClaims = claimsRaw.length;
  const contradictedCount = useMemo(
    () => claimsRaw.filter((c) => c.contradicted).length,
    [claimsRaw]
  );

  // Scroll selected into view
  const refs = useRef(new Map<number, HTMLDivElement | null>());
  useEffect(() => {
    if (selectedIdx == null) return;
    const el = refs.current.get(selectedIdx);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedIdx, filteredClaims.length]);

  // Export helpers
  const copyAll = async () => {
    try {
      const lines = filteredClaims.map((c, ) => {
        const s = fmtPct(c.supportScore ?? 0);
        const tag = c.claimType ? ` [${c.claimType}]` : "";
        const contra = c.contradicted ? " (CONTRADICTED)" : "";
        return `- ${c.text}${tag} — ${s}${contra}`;
      });
      await navigator.clipboard.writeText(lines.join("\n"));
    } catch {
      /* ignore */
    }
  };

  const downloadCSV = () => {
    const rows = [
      ["index", "text", "support", "contradicted", "type", "uncertainty"].map(escapeCSV).join(","),
      ...filteredClaims.map((c, i) =>
        [
          i + 1,
          escapeCSV(c.text),
          (c.supportScore ?? 0).toFixed(3),
          c.contradicted ? "true" : "false",
          escapeCSV(c.claimType || ""),
          escapeCSV(c.uncertaintyReason || ""),
        ].join(",")
      ),
    ].join("\n");

    const blob = new Blob([rows], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "claims.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadMD = () => {
    const lines = [
      "# Claims",
      "",
      ...filteredClaims.map((c, i) => {
        const s = fmtPct(c.supportScore ?? 0);
        const tag = c.claimType ? ` (${c.claimType})` : "";
        const contra = c.contradicted ? " — CONTRADICTED" : "";
        return `${i + 1}. ${c.text}${tag} — ${s}${contra}`;
      }),
    ].join("\n");
    const blob = new Blob([lines], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "claims.md";
    a.click();
    URL.revokeObjectURL(url);
  };

  const focusSource = (sid: string) => selectSource(sid);

  // Render
  return (
    <section className={clsx("rounded-md border bg-background", props.className)} aria-label="Verified claims">
      {(props.showToolbar ?? true) && (
        <>
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <div className="text-sm font-medium">Claims</div>
              <Badge variant="secondary">{filteredClaims.length}/{totalClaims}</Badge>
              <Badge variant={contradictedCount > 0 ? "destructive" : "secondary"} title="Contradicted count">
                {contradictedCount} contradicted
              </Badge>
            </div>

            <Separator orientation="vertical" className="mx-2 hidden md:block h-5" />

            {/* Search */}
            <div className="relative flex-1 min-w-[200px]">
              <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.currentTarget.value)}
                placeholder={props.placeholder ?? "Filter by text/type/uncertainty"}
                className="h-8 pl-8"
              />
              {filter && (
                <button
                  type="button"
                  aria-label="Clear filter"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setFilter("")}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* Type */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Type</span>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="h-8 w-[140px]">
                  <SelectValue placeholder="All types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  {types.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Support min */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Support</span>
              <Select value={supportMin} onValueChange={setSupportMin}>
                <SelectTrigger className="h-8 w-[120px]">
                  <SelectValue placeholder="Any" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Any</SelectItem>
                  <SelectItem value="0.5">50%+</SelectItem>
                  <SelectItem value="0.75">75%+</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Toggles */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Only selected source</span>
              <Switch
                checked={onlySelectedSource}
                onCheckedChange={setOnlySelectedSource}
                disabled={!selectedSourceId}
              />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Expand all</span>
              <Switch checked={expandedAll} onCheckedChange={setExpandedAll} />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Contradicted only</span>
              <Switch checked={contradictedOnly} onCheckedChange={setContradictedOnly} />
            </div>

            {/* Actions */}
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={copyAll} disabled={filteredClaims.length === 0} title="Copy visible claims">
                <CopyIcon className="mr-2 h-4 w-4" />
                Copy
              </Button>
              <Button variant="ghost" size="sm" onClick={downloadCSV} disabled={filteredClaims.length === 0} title="Download CSV">
                <DownloadIcon className="mr-2 h-4 w-4" />
                CSV
              </Button>
              <Button variant="ghost" size="sm" onClick={downloadMD} disabled={filteredClaims.length === 0} title="Download Markdown">
                <DownloadIcon className="mr-2 h-4 w-4" />
                .md
              </Button>
              {selectedIdx != null && (
                <Button variant="ghost" size="sm" onClick={() => select(null)}>
                  Unselect
                </Button>
              )}
            </div>
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
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="h-4 w-4" />
            No claims match your filters.
          </div>
        ) : (
          filteredClaims.map((c, i) => {
            // Use original index in store order for stable selection
            const originalIndex = claimsRaw.indexOf(c);
            const isSelected = selectedIdx === originalIndex;
            const showEvidence = expandedAll || isSelected;

            const evs = (c.evidence ?? []).filter((e) =>
              onlySelectedSource && selectedSourceId ? e.sourceId === selectedSourceId : true
            );

            return (
              <div
                key={`${c.text}-${i}`}
                ref={(el) => {
                  refs.current.set(originalIndex, el);
                }}
                className={clsx(
                  "rounded border p-3 transition-colors",
                  isSelected ? "border-primary ring-2 ring-primary/40" : "border-border"
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
                        key={`${originalIndex}-${j}-${e.sourceId}-${e.chunkId ?? "x"}`}
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