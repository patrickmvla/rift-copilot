'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useResearchStore } from '@/features/research/client/store';
import type { VerifyClaimsResponse, SourceRef, VerifiedClaim } from '@/features/research/types';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';

/* -------------------------------- Helpers --------------------------------- */

function clsx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(' ');
}

function supportColor(score: number): string {
  if (score >= 0.75) return 'bg-green-500';
  if (score >= 0.5) return 'bg-yellow-500';
  return 'bg-red-500';
}

function fmtPct(x: number): string {
  const v = Math.max(0, Math.min(1, x));
  return `${Math.round(v * 100)}%`;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/* ------------------------------- Subparts ---------------------------------- */

function SupportBar({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(score * 100)));
  return (
    <div className="h-2 w-full rounded bg-muted">
      <div
        className={clsx('h-2 rounded', supportColor(score))}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function SourceItem({
  source,
  selected,
  onSelect,
}: {
  source: SourceRef;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(source.id)}
      className={clsx(
        'w-full rounded border p-2 text-left hover:bg-accent',
        selected ? 'border-primary ring-2 ring-primary/40' : 'border-border'
      )}
    >
      <div className="flex items-center gap-2">
        <Badge variant={selected ? 'default' : 'secondary'} className="min-w-6 justify-center">
          {source.index ?? '?'}
        </Badge>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {source.title || domainOf(source.url)}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {domainOf(source.url)}
          </div>
        </div>
        <div className="ml-auto">
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary underline"
            onClick={(e) => e.stopPropagation()}
          >
            Open
          </a>
        </div>
      </div>
    </button>
  );
}

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
          {sourceNum ?? '?'}
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

export function EvidencePanel() {
  // FIX: select each slice individually to avoid creating a new object per render
  const sources = useResearchStore((s) => s.sources);
  const claimsResp = useResearchStore((s) => s.claims) as VerifyClaimsResponse | null;
  const ui = useResearchStore((s) => s.ui);
  const selectSource = useResearchStore((s) => s.selectSource);
  const selectClaim = useResearchStore((s) => s.selectClaim);
  const setShowConfidence = useResearchStore((s) => s.setShowConfidence);

  const [onlySelectedSource, setOnlySelectedSource] = useState(false);

  // Index mapping for [n] labels in evidence quotes
  const indexMap = useMemo(() => {
    const m = new Map<string, number>();
    sources.forEach((s, i) => m.set(s.id, s.index ?? i + 1));
    return m;
  }, [sources]);

  // Keep a ref to selected source element for scrolling
  const selectedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (selectedRef.current) {
      selectedRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [ui.selectedSourceId]);

  // Sort claims by support desc, contradictions first
  const claimList = useMemo(() => {
    const c = claimsResp?.claims ?? [];
    return [...c].sort((a, b) => {
      if (a.contradicted !== b.contradicted) return a.contradicted ? -1 : 1;
      return (b.supportScore ?? 0) - (a.supportScore ?? 0);
    });
  }, [claimsResp]);

  return (
    <section className="rounded-md border bg-background">
      <div className="flex items-center gap-3 px-3 py-2">
        <div className="text-sm font-medium">Evidence</div>
        <Separator orientation="vertical" className="h-5" />
        <div className="text-xs text-muted-foreground">
          {sources.length} sources • {claimsResp?.claims?.length ?? 0} claims
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Confidence</span>
            <Switch
              checked={ui.showConfidence}
              onCheckedChange={(v) => setShowConfidence(v)}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Only selected source</span>
            <Switch
              checked={onlySelectedSource}
              onCheckedChange={(v) => setOnlySelectedSource(v)}
            />
          </div>
          {ui.selectedSourceId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => selectSource(null)}
              title="Clear selection"
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      <Separator />

      <div className="grid grid-cols-12 gap-3 p-3">
        {/* Sources list */}
        <div className="col-span-12 lg:col-span-5 flex flex-col gap-2 overflow-y-auto max-h-[28vh] lg:max-h-[60vh] pr-1">
          {sources.length === 0 ? (
            <div className="text-sm text-muted-foreground">No sources yet.</div>
          ) : (
            sources
              .slice()
              .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
              .map((s) => (
                <div
                  key={s.id}
                  ref={ui.selectedSourceId === s.id ? selectedRef : null}
                >
                  <SourceItem
                    source={s}
                    selected={ui.selectedSourceId === s.id}
                    onSelect={(id) => selectSource(id)}
                  />
                </div>
              ))
          )}
        </div>

        {/* Claims + evidence */}
        <div className="col-span-12 lg:col-span-7 overflow-y-auto max-h-[40vh] lg:max-h-[60vh] pl-1">
          {claimList.length === 0 ? (
            <div className="text-sm text-muted-foreground">No claims yet.</div>
          ) : (
            <div className="space-y-3">
              {claimList.map((c, i) => {
                const claimIdx = i;
                const evs = (c.evidence ?? []).filter((e) =>
                  onlySelectedSource && ui.selectedSourceId
                    ? e.sourceId === ui.selectedSourceId
                    : true
                );

                return (
                  <div
                    key={`${c.text}-${i}`}
                    className={clsx(
                      'rounded border p-3',
                      ui.selectedClaimIndex === claimIdx ? 'border-primary ring-2 ring-primary/40' : 'border-border'
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <div className="flex-1">
                        <ClaimHeader claim={c} showConfidence={ui.showConfidence} />
                      </div>
                      <div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            selectClaim(
                              ui.selectedClaimIndex === claimIdx ? null : claimIdx
                            )
                          }
                        >
                          {ui.selectedClaimIndex === claimIdx ? 'Unselect' : 'Select'}
                        </Button>
                      </div>
                    </div>

                    {c.uncertaintyReason && (
                      <div className="mt-2 text-xs text-muted-foreground">
                        {c.uncertaintyReason}
                      </div>
                    )}

                    {/* Evidence quotes */}
                    {evs.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {evs.map((e, j) => {
                          const n = indexMap.get(e.sourceId);
                          return (
                            <EvidenceQuote
                              key={`${c.text}-${j}-${e.sourceId}-${e.chunkId ?? 'x'}`}
                              quote={e.quote}
                              sourceNum={n}
                              onFocusSource={() => selectSource(e.sourceId)}
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}