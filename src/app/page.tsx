import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = {
  title: 'Evidence-First Research Copilot',
  description: 'Deep research with verifiable citations, powered by Groq + Jina + Turso.',
};

export default function HomePage() {
  return (
    <main className="container mx-auto px-4 py-12 md:py-16">
      {/* Hero */}
      <section className="mx-auto max-w-3xl text-center">
        <h1 className="text-3xl font-bold tracking-tight md:text-5xl">
          Evidence-First Research Copilot
        </h1>
        <p className="mt-4 text-muted-foreground md:text-lg">
          Ask complex questions and get precise answers with inline citations and verifiable quotes.
          Built on Groq for low-latency LLMs, Jina for deep search, and Turso for storage.
        </p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <Button asChild size="lg">
            <Link href="/research">Start researching</Link>
          </Button>
          <Button asChild variant="secondary" size="lg">
            <Link href="/research#how-it-works">How it works</Link>
          </Button>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto mt-12 grid max-w-5xl grid-cols-1 gap-4 md:mt-16 md:grid-cols-3">
        <div className="rounded-lg border bg-card p-5">
          <h3 className="text-sm font-semibold">Verifiable answers</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Answers include numbered citations [1], [2] linked to sources, with quotes and offsets.
          </p>
        </div>
        <div className="rounded-lg border bg-card p-5">
          <h3 className="text-sm font-semibold">Deep retrieval</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Jina Deepsearch + readable extraction; local FTS with rerank-ready hooks.
          </p>
        </div>
        <div className="rounded-lg border bg-card p-5">
          <h3 className="text-sm font-semibold">Typed & fast</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Next.js App Router, Drizzle + Turso, Zod validation, shadcn/ui, AI SDK v5 with Groq.
          </p>
        </div>
      </section>

      {/* Steps */}
      <section id="how-it-works" className="mx-auto mt-12 max-w-5xl md:mt-16">
        <h2 className="text-xl font-semibold">How it works</h2>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded-lg border bg-card p-5">
            <div className="text-sm font-semibold">1) Plan & Search</div>
            <p className="mt-2 text-sm text-muted-foreground">
              The copilot plans subqueries and performs web deepsearch with domain/time filters.
            </p>
          </div>
          <div className="rounded-lg border bg-card p-5">
            <div className="text-sm font-semibold">2) Read & Rank</div>
            <p className="mt-2 text-sm text-muted-foreground">
              Content is cleaned, chunked, and ranked with FTS5 (and optional rerank).
            </p>
          </div>
          <div className="rounded-lg border bg-card p-5">
            <div className="text-sm font-semibold">3) Answer & Verify</div>
            <p className="mt-2 text-sm text-muted-foreground">
              Answers stream with citations; claims are extracted and bound to quotes with offsets.
            </p>
          </div>
        </div>
        <div className="mt-6">
          <Button asChild>
            <Link href="/research">Try it now</Link>
          </Button>
        </div>
      </section>
    </main>
  );
}