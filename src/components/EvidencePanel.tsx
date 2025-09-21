"use client";

import { useResearchStore } from "@/features/research/client/store";
import type { VerifyClaimsResponse } from "@/features/research/types";

import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";

// Reuse the polished lists from earlier steps
import { ClaimList } from "@/components/ClaimList";
import { SourceList } from "@/components/SourceList";

export function EvidencePanel() {
  // Select slices individually to avoid extra renders
  const sources = useResearchStore((s) => s.sources);
  const claimsResp = useResearchStore((s) => s.claims) as VerifyClaimsResponse | null;
  const showConfidence = useResearchStore((s) => s.ui.showConfidence);
  const setShowConfidence = useResearchStore((s) => s.setShowConfidence);

  const totalSources = sources.length;
  const totalClaims = claimsResp?.claims?.length ?? 0;

  return (
    <section className="rounded-md border bg-background" aria-label="Evidence">
      {/* Header */}
      <div className="flex items-center gap-3 px-3 py-2">
        <div className="text-sm font-medium">Evidence</div>
        <Separator orientation="vertical" className="h-5" />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary">{totalSources} sources</Badge>
          <Badge variant="secondary">{totalClaims} claims</Badge>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Confidence</span>
            <Switch checked={showConfidence} onCheckedChange={setShowConfidence} />
          </div>
          {/* Optional: add a global “Clear all selections” if you want */}
          {/* <Button variant="ghost" size="sm" onClick={() => { useResearchStore.getState().selectSource(null); useResearchStore.getState().selectClaim(null); }}>Clear</Button> */}
        </div>
      </div>

      <Separator />

      {/* Body */}
      <div className="grid grid-cols-12 gap-3 p-3">
        {/* Left: sources */}
        <div className="col-span-12 lg:col-span-5">
          <SourceList
            showToolbar
            placeholder="Filter by title or domain"
            // Keep the independent column scroll like before
            maxHeightClass="max-h-[28vh] lg:max-h-[60vh]"
            className="h-full"
          />
        </div>

        {/* Right: claims + evidence */}
        <div className="col-span-12 lg:col-span-7">
          <ClaimList
            showToolbar
            placeholder="Filter by text/type/uncertainty"
            // Independent scroll, matches previous behavior
            maxHeightClass="max-h-[40vh] lg:max-h-[60vh]"
            className="h-full"
          />
        </div>
      </div>
    </section>
  );
}