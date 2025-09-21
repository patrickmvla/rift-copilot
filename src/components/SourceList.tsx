"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useResearchStore } from "@/features/research/client/store";
import type { SourceRef } from "@/features/research/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  Search as SearchIcon,
  X,
  ExternalLink,
  Copy as CopyIcon,
  ArrowUpDown,
  Globe,
  FileText,
  Hash,
} from "lucide-react";
import Image from "next/image";

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

function faviconFor(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${host}&sz=64`;
  } catch {
    return null;
  }
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
  const host = domainOf(source.url);
  const favicon = faviconFor(source.url);

  return (
    <div ref={innerRef} className="w-full">
      <button
        type="button"
        onClick={() => onSelect(source.id)}
        title={source.title || host}
        className={clsx(
          "w-full rounded border p-2 text-left hover:bg-accent focus:outline-none focus-visible:ring-2",
          selected ? "border-primary ring-2 ring-primary/40" : "border-border"
        )}
        onDoubleClick={(e) => {
          e.preventDefault();
          window.open(source.url, "_blank", "noopener,noreferrer");
        }}
        role="option"
        aria-selected={selected}
      >
        <div className="flex items-center gap-2">
          <Badge
            variant={selected ? "default" : "secondary"}
            className="min-w-6 justify-center"
          >
            {source.index ?? "?"}
          </Badge>

          <div className="h-4 w-4 overflow-hidden rounded-sm bg-muted">
            {favicon ? (
              <Image
                src={favicon}
                alt=""
                width={16}
                height={16}
                className="h-4 w-4"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <span className="inline-block h-4 w-4 text-[10px] leading-4 text-muted-foreground">
                {host[0]?.toUpperCase() ?? "•"}
              </span>
            )}
          </div>

          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {source.title || host}
            </div>
            <div className="truncate text-xs text-muted-foreground">{host}</div>
          </div>

          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              title="Open in new tab"
              onClick={(e) => {
                e.stopPropagation();
                window.open(source.url, "_blank", "noopener,noreferrer");
              }}
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              title="Copy URL"
              onClick={async (e) => {
                e.stopPropagation();
                try {
                  await navigator.clipboard.writeText(source.url);
                } catch {
                  /* ignore */
                }
              }}
            >
              <CopyIcon className="h-4 w-4" />
            </Button>
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

type SortKey = "index" | "domain" | "title";
type SortDir = "asc" | "desc";

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
  const [sortKey, setSortKey] = useState<SortKey>("index");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const listRefMap = useRef(new Map<string, HTMLDivElement | null>());

  // Derived
  const sorted = useMemo(() => {
    const arr = sources.slice();
    const cmp = (a: SourceRef, b: SourceRef) => {
      let v = 0;
      if (sortKey === "index") {
        const ai = a.index ?? Number.MAX_SAFE_INTEGER;
        const bi = b.index ?? Number.MAX_SAFE_INTEGER;
        v = ai - bi;
        if (v === 0) {
          // tie-breaker: domain, then title
          const ad = domainOf(a.url).localeCompare(domainOf(b.url));
          v = ad !== 0 ? ad : (a.title ?? "").localeCompare(b.title ?? "");
        }
      } else if (sortKey === "domain") {
        v =
          domainOf(a.url).localeCompare(domainOf(b.url)) ||
          (a.title ?? "").localeCompare(b.title ?? "");
      } else {
        // title
        v =
          (a.title ?? "").localeCompare(b.title ?? "") ||
          domainOf(a.url).localeCompare(domainOf(b.url));
      }
      return sortDir === "asc" ? v : -v;
    };
    return arr.sort(cmp);
  }, [sources, sortKey, sortDir]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((s) => {
      const t = (s.title ?? "").toLowerCase();
      const d = domainOf(s.url).toLowerCase();
      return t.includes(q) || d.includes(q);
    });
  }, [sorted, filter]);

  // Counts
  const totalCount = sources.length;
  const visibleCount = filtered.length;

  // Scroll selected into view
  useEffect(() => {
    if (!selectedId) return;
    const el = listRefMap.current.get(selectedId);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedId, filtered.length]);

  // Handlers
  const clearSelection = () => select(null);
  const clearFilter = () => setFilter("");
  const toggleDir = () => setSortDir((d) => (d === "asc" ? "desc" : "asc"));

  return (
    <section
      className={clsx("rounded-md border bg-background", props.className)}
      aria-label="Sources"
      tabIndex={-1}
    >
      {(props.showToolbar ?? true) && (
        <>
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium">Sources</div>
              <Badge variant="secondary" title="Visible / Total">
                {visibleCount}/{totalCount}
              </Badge>
            </div>

            <Separator
              orientation="vertical"
              className="mx-2 hidden h-5 md:block"
            />

            {/* Search */}
            <div className="relative min-w-[200px] flex-1">
              <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.currentTarget.value)}
                placeholder={props.placeholder ?? "Filter by title or domain"}
                className="h-8 pl-8 pr-8"
              />
              {filter && (
                <button
                  type="button"
                  aria-label="Clear filter"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={clearFilter}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* Sort */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Sort</span>
              <Select
                value={sortKey}
                onValueChange={(v) => setSortKey(v as SortKey)}
              >
                <SelectTrigger className="h-8 w-[140px]">
                  <SelectValue placeholder="Sort by" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="index">
                    <span className="inline-flex items-center gap-2">
                      <Hash className="h-4 w-4" /> Index
                    </span>
                  </SelectItem>
                  <SelectItem value="domain">
                    <span className="inline-flex items-center gap-2">
                      <Globe className="h-4 w-4" /> Domain
                    </span>
                  </SelectItem>
                  <SelectItem value="title">
                    <span className="inline-flex items-center gap-2">
                      <FileText className="h-4 w-4" /> Title
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="sm"
                className="h-8"
                onClick={toggleDir}
                title={sortDir === "asc" ? "Ascending" : "Descending"}
              >
                <ArrowUpDown className="h-4 w-4" />
              </Button>
            </div>

            {/* Actions for selection */}
            <div className="ml-auto flex items-center gap-2">
              {selectedId && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Open selected"
                    onClick={() => {
                      const s = sources.find((x) => x.id === selectedId);
                      if (s)
                        window.open(s.url, "_blank", "noopener,noreferrer");
                    }}
                  >
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Copy selected URL"
                    onClick={async () => {
                      const s = sources.find((x) => x.id === selectedId);
                      if (!s) return;
                      try {
                        await navigator.clipboard.writeText(s.url);
                      } catch {
                        /* ignore */
                      }
                    }}
                  >
                    <CopyIcon className="mr-2 h-4 w-4" />
                    Copy URL
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearSelection}
                    title="Clear selection"
                  >
                    Unselect
                  </Button>
                </>
              )}
            </div>
          </div>
          <Separator />
        </>
      )}

      <div
        className={clsx(
          "flex flex-col gap-2 overflow-y-auto p-3",
          props.maxHeightClass ?? "max-h-[60vh]"
        )}
        role="listbox"
        aria-label="Source list"
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
