"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useResearchStore } from "@/features/research/client/store";
import type { SourceRef } from "@/features/research/types";

/* -------------------------------- Helpers --------------------------------- */

function clsx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function byIndex(a: SourceRef, b: SourceRef) {
  const ai = a.index ?? 0;
  const bi = b.index ?? 0;
  if (ai && bi) return ai - bi;
  // fallback to domain/title if index missing
  const ad = domainOf(a.url).localeCompare(domainOf(b.url));
  if (ad !== 0) return ad;
  return (a.title ?? "").localeCompare(b.title ?? "");
}

/* ------------------------------- Subcomponents ----------------------------- */

function SourceRow({
  source,
  selected,
  onSelect,
  innerRef,
}: {
  source: SourceRef;
  selected: boolean;
  onSelect: (id: string) => void;
  innerRef?: (el: HTMLDivElement | null) => void;
}) {
  return (
    <div ref={innerRef} className="w-full">
      <button
        type="button"
        onClick={() => onSelect(source.id)}
        title={source.title || domainOf(source.url)}
        className={clsx(
          "w-full rounded border p-2 text-left hover:bg-accent focus:outline-none",
          selected ? "border-primary ring-2 ring-primary/40" : "border-border"
        )}
        onDoubleClick={(e) => {
          e.preventDefault();
          window.open(source.url, "_blank", "noopener,noreferrer");
        }}
      >
        <div className="flex items-center gap-2">
          <Badge
            variant={selected ? "default" : "secondary"}
            className="min-w-6 justify-center"
          >
            {source.index ?? "?"}
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
    </div>
  );
}

/* -------------------------------- Component -------------------------------- */

export type SourceListProps = {
  className?: string;
  // Controlled mode (optional)
  sources?: SourceRef[];
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  // UI options
  placeholder?: string;
  maxHeightClass?: string; // e.g., 'max-h-[60vh]'
  showToolbar?: boolean;
};

export function SourceList(props: SourceListProps) {
  const store = useResearchStore();
  const uncontrolled = !props.sources;

  // Data/selection
  const sources = (props.sources ?? store.sources) as SourceRef[];
  const selectedId = uncontrolled
    ? store.ui.selectedSourceId
    : props.selectedId ?? null;
  const select = (id: string | null) =>
    uncontrolled ? store.selectSource(id) : props.onSelect?.(id);

  // UI state
  const [filter, setFilter] = useState("");
  const listRefMap = useRef(new Map<string, HTMLDivElement | null>());

  // Derived
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const arr = sources.slice().sort(byIndex);
    if (!q) return arr;
    return arr.filter((s) => {
      const t = (s.title ?? "").toLowerCase();
      const d = domainOf(s.url).toLowerCase();
      return t.includes(q) || d.includes(q);
    });
  }, [sources, filter]);

  // Scroll selected into view
  useEffect(() => {
    if (!selectedId) return;
    const el = listRefMap.current.get(selectedId);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedId, filtered.length]);

  // Handlers
  const clearSelection = () => select(null);
  const clearFilter = () => setFilter("");

  return (
    <section
      className={clsx("rounded-md border bg-background", props.className)}
    >
      {(props.showToolbar ?? true) && (
        <>
          <div className="flex items-center gap-2 px-3 py-2">
            <div className="text-sm font-medium">Sources</div>
            <Separator orientation="vertical" className="mx-2 h-5" />
            <div className="flex-1">
              <Input
                value={filter}
                onChange={(e) => setFilter(e.currentTarget.value)}
                placeholder={props.placeholder ?? "Filter by title or domain"}
                className="h-8"
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilter}
              disabled={!filter}
              title="Clear filter"
            >
              Clear
            </Button>
            {selectedId && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearSelection}
                title="Clear selection"
              >
                Unselect
              </Button>
            )}
          </div>
          <Separator />
        </>
      )}

      <div
        className={clsx(
          "flex flex-col gap-2 p-3 overflow-y-auto",
          props.maxHeightClass ?? "max-h-[60vh]"
        )}
      >
        {filtered.length === 0 ? (
          <div className="text-sm text-muted-foreground">No sources.</div>
        ) : (
          filtered.map((s) => (
            <SourceRow
              key={s.id}
              source={s}
              selected={s.id === selectedId}
              onSelect={(id) => select(id)}
              innerRef={(el) => listRefMap.current.set(s.id, el)}
            />
          ))
        )}
      </div>
    </section>
  );
}
