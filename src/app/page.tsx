import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowRight, CheckCircle2, Search, Zap, Github, Sparkles } from "lucide-react";

export const metadata: Metadata = {
  title: "Evidence-First Research Copilot",
  description: "Deep research with verifiable citations, powered by Groq + Jina + Turso.",
};

const EXAMPLES = [
  'What are the latest FDA updates on GLP-1 safety (2023–2025)?',
  "Summarize credible evidence on PFAS exposure health risks since 2020",
  "Compare RAG reranking methods and cite the best open-source evals",
];

export default function HomePage() {
  return (
    <main className="relative container mx-auto px-4 py-12 md:py-16">
      {/* Soft background glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-primary/10 dark:bg-primary/15 [mask-image:radial-gradient(60%_50%_at_50%_0%,black,transparent)]"
      />

      {/* Hero */}
      <section className="mx-auto max-w-3xl text-center" aria-labelledby="hero-title">
        <div className="mb-3 flex flex-wrap items-center justify-center gap-2">
          <Badge variant="outline" className="text-xs">Open-source • Evidence-first</Badge>
        </div>

        <h1 id="hero-title" className="text-4xl font-bold tracking-tight md:text-6xl">
          <span className="bg-gradient-to-b from-foreground to-foreground/60 bg-clip-text text-transparent">
            Evidence-First Research Copilot
          </span>
        </h1>

        <p className="mt-4 text-muted-foreground md:text-lg">
          Ask complex questions and get precise answers with inline citations and verifiable quotes.
          Built on Groq for low-latency LLMs, Jina for deep search, and Turso for storage.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg" className="group">
            <Link href="/research" aria-label="Start researching">
              <span>Start researching</span>
              <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Button>

          <Button asChild variant="secondary" size="lg">
            <Link href="/how-it-works">How it works</Link>
          </Button>

          <Button asChild variant="ghost" size="lg">
            <Link href="https://github.com" target="_blank" rel="noopener noreferrer" aria-label="View on GitHub">
              <Github className="mr-2 h-4 w-4" />
              GitHub
            </Link>
          </Button>
        </div>

        {/* Quick example queries (optional deep-links to /research) */}
        <div className="mx-auto mt-4 flex max-w-3xl flex-wrap justify-center gap-2">
          {EXAMPLES.map((q) => (
            <Button
              key={q}
              asChild
              variant="secondary"
              size="sm"
              className="h-7 rounded-full px-3 text-xs"
              title={q}
            >
              {/* If your ResearchForm reads ?q= from URL, this will prefill. Otherwise it’s just a shortcut link. */}
              <Link href={`/research?q=${encodeURIComponent(q)}`}>
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                {q}
              </Link>
            </Button>
          ))}
        </div>
      </section>

      {/* Optional product preview image (place /public/preview.png) */}
      <section className="mx-auto mt-10 max-w-5xl md:mt-14">
        <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
          <div className="relative aspect-[16/9] w-full">
            <Image
              src="/preview.png"
              alt="Screenshot of the Evidence-First Research UI"
              fill
              priority
              sizes="(max-width: 768px) 100vw, 1000px"
              className="object-cover"
            />
          </div>
        </div>
      </section>

      {/* Features */}
      <section
        className="mx-auto mt-12 grid max-w-5xl grid-cols-1 gap-4 md:mt-16 md:grid-cols-3"
        aria-labelledby="features-title"
      >
        <h2 id="features-title" className="sr-only">Features</h2>

        <Card className="transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm">
          <CardHeader className="flex-row items-start gap-3">
            <div className="rounded-md bg-primary/10 p-2 text-primary">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-sm">Verifiable answers</CardTitle>
              <CardDescription className="mt-1 text-sm">
                Answers include numbered citations [1], [2] linked to sources, with quotes and offsets.
              </CardDescription>
            </div>
          </CardHeader>
        </Card>

        <Card className="transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm">
          <CardHeader className="flex-row items-start gap-3">
            <div className="rounded-md bg-primary/10 p-2 text-primary">
              <Search className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-sm">Deep retrieval</CardTitle>
              <CardDescription className="mt-1 text-sm">
                Jina Deepsearch + readable extraction; local FTS with rerank-ready hooks.
              </CardDescription>
            </div>
          </CardHeader>
        </Card>

        <Card className="transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm">
          <CardHeader className="flex-row items-start gap-3">
            <div className="rounded-md bg-primary/10 p-2 text-primary">
              <Zap className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-sm">Typed & fast</CardTitle>
              <CardDescription className="mt-1 text-sm">
                Next.js App Router, Drizzle + Turso, Zod validation, shadcn/ui, AI SDK v5 with Groq.
              </CardDescription>
            </div>
          </CardHeader>
        </Card>
      </section>

      {/* Steps */}
      <section id="how-it-works" className="mx-auto mt-12 max-w-5xl md:mt-16" aria-labelledby="how-title">
        <h2 id="how-title" className="text-xl font-semibold">How it works</h2>

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
          <Card className="h-full">
            <CardHeader className="p-5">
              <div className="mb-2 flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                  1
                </div>
                <div className="text-sm font-semibold">Plan & Search</div>
              </div>
              <CardDescription className="text-sm">
                The copilot plans subqueries and performs web deepsearch with domain/time filters.
              </CardDescription>
            </CardHeader>
          </Card>

          <Card className="h-full">
            <CardHeader className="p-5">
              <div className="mb-2 flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                  2
                </div>
                <div className="text-sm font-semibold">Read & Rank</div>
              </div>
              <CardDescription className="text-sm">
                Content is cleaned, chunked, and ranked with FTS5 (and optional rerank).
              </CardDescription>
            </CardHeader>
          </Card>

          <Card className="h-full">
            <CardHeader className="p-5">
              <div className="mb-2 flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                  3
                </div>
                <div className="text-sm font-semibold">Answer & Verify</div>
              </div>
              <CardDescription className="text-sm">
                Answers stream with citations; claims are extracted and bound to quotes with offsets.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>

        <div className="mt-6">
          <Button asChild className="group">
            <Link href="/research">
              Try it now
              <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Button>
        </div>
      </section>
    </main>
  );
}