/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import {
  ResearchRequestSchema,
  type ResearchRequest,
  type Depth,
} from "@/features/research/types";
import {
  startResearchWithStore,
  type StreamHandle,
} from "@/features/research/client/api";
import {
  useResearchStore,
  useResearchStage,
} from "@/features/research/client/store";

// shadcn/ui
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

// icons
import {
  Loader2,
  Play,
  Square,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";

// Extend the request schema with form-only fields
const FormSchema = ResearchRequestSchema.extend({
  allowedDomainsCsv: z.string().optional(),
  disallowedDomainsCsv: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});

// IMPORTANT: use z.input so the form type matches Zod input (depth can be undefined due to default)
type FormValues = z.input<typeof FormSchema>;

const EXAMPLES = [
  'What are the latest FDA updates on GLP-1 safety (2023–2025)?',
  "Summarize credible evidence on PFAS exposure health risks since 2020",
  "Compare RAG reranking methods and cite the best open-source evals",
];

export function ResearchForm() {
  const stage = useResearchStage();
  const store = useResearchStore();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const handleRef = useRef<StreamHandle | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      question: "",
      depth: "normal", // provide a default to keep UI controlled
      region: "",
      allowedDomainsCsv: "",
      disallowedDomainsCsv: "",
      fromDate: "",
      toDate: "",
    },
    mode: "onSubmit",
  });

  const questionVal = form.watch("question");
  const depthVal = form.watch("depth");

  const canStop = useMemo(
    () =>
      ["plan", "search", "read", "rank", "answer", "verify"].includes(stage),
    [stage]
  );

  useEffect(() => {
    // Cleanup on unmount: abort any in-flight stream
    return () => {
      try {
        handleRef.current?.abort?.("unmount");
      } catch {
        /* ignore */
      }
    };
  }, []);

  // Submit helper so we can trigger from Enter
  const trySubmit = () => {
    if (!canStop && questionVal && questionVal.trim().length >= 8) {
      form.handleSubmit(onSubmit)();
    }
  };

  const onSubmit = async (values: FormValues) => {
    const allowedDomains = splitCsv(values.allowedDomainsCsv);
    const disallowedDomains = splitCsv(values.disallowedDomainsCsv);
    const timeRange = toTimeRange(values.fromDate, values.toDate);

    const payload: ResearchRequest = {
      question: values.question.trim(),
      depth: (values.depth ?? "normal") as Depth,
      region: values.region?.trim() || undefined,
      allowedDomains: allowedDomains.length ? allowedDomains : undefined,
      disallowedDomains: disallowedDomains.length
        ? disallowedDomains
        : undefined,
      timeRange: timeRange ?? undefined,
    };

    try {
      const handle = startResearchWithStore(payload);
      handleRef.current = handle;
      await handle.done;
    } catch (e: any) {
      store.setError(e?.message ?? "Streaming failed");
    }
  };

  const stop = () => {
    try {
      handleRef.current?.abort("User cancelled");
    } catch {
      /* ignore */
    }
    store.cancel("Cancelled");
  };

  const hardReset = () => {
    try {
      handleRef.current?.abort("Reset");
    } catch {
      /* ignore */
    }
    store.reset();
    form.reset();
    textAreaRef.current?.focus();
  };

  const applyExample = (q: string) => {
    form.setValue("question", q, { shouldDirty: true, shouldTouch: true });
    textAreaRef.current?.focus();
  };

  return (
    <div className="space-y-4">
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="grid grid-cols-12 gap-4"
        >
          {/* Question */}
          <div className="col-span-12">
            <FormField
              control={form.control}
              name="question"
              render={({ field }) => {
                // Avoid duplicate `ref`: extract and merge
                const { ref: fieldRef, ...rest } = field;
                return (
                  <FormItem>
                    <div className="flex items-center justify-between">
                      <FormLabel>Research question</FormLabel>
                      <p className="text-xs text-muted-foreground">
                        Press Enter to run • Shift+Enter for a new line
                      </p>
                    </div>
                    <FormControl>
                      <Textarea
                        {...rest}
                        ref={(el) => {
                          fieldRef(el);
                          textAreaRef.current = el;
                        }}
                        placeholder='e.g., "What are the latest FDA updates on GLP-1 safety (2023–2025)?"'
                        className="min-h-[110px] resize-y"
                        onKeyDown={(e) => {
                          const isComposing = (e.nativeEvent as any)?.isComposing;
                          if (e.key === "Enter" && !e.shiftKey && !isComposing) {
                            e.preventDefault();
                            trySubmit();
                          }
                        }}
                      />
                    </FormControl>
                    <FormDescription>
                      Be specific to get better, more grounded results.
                    </FormDescription>

                    {/* Quick examples */}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {EXAMPLES.map((ex) => (
                        <Button
                          key={ex}
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="h-6 rounded-full px-2 text-[11px]"
                          onClick={() => applyExample(ex)}
                        >
                          <Sparkles className="mr-1 h-3 w-3" />
                          {ex}
                        </Button>
                      ))}
                    </div>

                    <FormMessage />
                  </FormItem>
                );
              }}
            />
          </div>

          {/* Depth */}
          <div className="col-span-12 md:col-span-3">
            <FormField
              control={form.control}
              name="depth"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Depth</FormLabel>
                  <Select
                    value={field.value ?? "normal"}
                    onValueChange={field.onChange}
                    disabled={canStop}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select depth" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="quick">Quick</SelectItem>
                      <SelectItem value="normal">Normal</SelectItem>
                      <SelectItem value="deep">Deep</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Quick for speed; Deep to explore more sources.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {/* Region */}
          <div className="col-span-12 md:col-span-3">
            <FormField
              control={form.control}
              name="region"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Region (optional)</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., US, EU" {...field} />
                  </FormControl>
                  <FormDescription>Use if the topic is region-sensitive.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {/* Advanced toggle */}
          <div className="col-span-12">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="px-2"
              onClick={() => setShowAdvanced((s) => !s)}
            >
              <SlidersHorizontal className="mr-2 h-4 w-4" />
              {showAdvanced ? "Hide advanced options" : "Show advanced options"}
            </Button>
          </div>

          {/* Advanced options */}
          {showAdvanced && (
            <>
              <div className="col-span-12">
                <Separator />
              </div>

              <div className="col-span-12 md:col-span-6">
                <FormField
                  control={form.control}
                  name="allowedDomainsCsv"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Allow domains</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="example.com, docs.example.org"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Comma-separated list to prefer/include.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="col-span-12 md:col-span-6">
                <FormField
                  control={form.control}
                  name="disallowedDomainsCsv"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Deny domains</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="twitter.com, reddit.com"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Comma-separated list to exclude.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="col-span-12 md:col-span-3">
                <FormField
                  control={form.control}
                  name="fromDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>From date</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormDescription>ISO date lower bound (optional).</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="col-span-12 md:col-span-3">
                <FormField
                  control={form.control}
                  name="toDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>To date</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormDescription>ISO date upper bound (optional).</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="col-span-12">
                <Separator />
              </div>
            </>
          )}

          {/* Actions */}
          <div className="col-span-12 flex items-center gap-2 pt-1">
            <Button
              type="submit"
              disabled={!questionVal || questionVal.trim().length < 8 || canStop}
            >
              {canStop ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Running…
                </>
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" />
                  Start research
                </>
              )}
            </Button>

            <Button
              type="button"
              variant="secondary"
              onClick={stop}
              disabled={!canStop}
              title={canStop ? "Stop current run" : "Nothing to stop"}
            >
              <Square className="mr-2 h-4 w-4" />
              Stop
            </Button>

            <Button
              type="button"
              variant="ghost"
              onClick={hardReset}
              title="Clear current answer and state"
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Reset
            </Button>

            <span className="ml-auto text-xs text-muted-foreground">
              Depth: <strong>{depthVal ?? "normal"}</strong> • Stage:{" "}
              <strong className="uppercase">{stage}</strong>
              {store.startedAt
                ? ` • Elapsed: ${Math.round(store.durationMs() / 1000)}s`
                : null}
            </span>
          </div>
        </form>
      </Form>
    </div>
  );
}

/* --------------------------------- Utils ---------------------------------- */

function splitCsv(s?: string): string[] {
  if (!s) return [];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function toTimeRange(from?: string, to?: string) {
  const f = from && from.trim().length ? from.trim() : undefined;
  const t = to && to.trim().length ? to.trim() : undefined;
  if (!f && !t) return undefined;
  return { from: f, to: t };
}