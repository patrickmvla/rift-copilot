import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  ListChecks,
  Search as SearchIcon,
  BookOpenText,
  SquareStack,
  ArrowUpDown,
  MessageSquareText,
  ShieldCheck,
  Link as LinkIcon,
} from "lucide-react";

export const metadata: Metadata = {
  title: "How it works • Evidence-First Research",
  description: "Understand the planning → search → read → rank → answer → verify pipeline.",
};

const TOC = [
  { id: "pipeline", label: "Pipeline details" },
  { id: "models", label: "Key data models" },
  { id: "api", label: "API quickstart" },
  { id: "env", label: "Environment & flags" },
  { id: "faq", label: "FAQ" },
];

type IconType = React.ComponentType<React.SVGProps<SVGSVGElement>>;

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <div className="group relative flex items-center gap-2">
      <h2 id={id} className="text-xl font-semibold">
        {children}
      </h2>
      <a
        href={`#${id}`}
        aria-label={`Link to ${children as string}`}
        className="opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground"
      >
        <LinkIcon className="h-4 w-4" />
      </a>
    </div>
  );
}

function StepCard({
  title,
  body,
  badge,
  icon: Icon,
}: {
  title: string;
  body: string;
  badge: string;
  icon: IconType;
}) {
  return (
    <Card className="relative transition-all hover:-translate-y-0.5">
      <CardHeader className="pb-2">
        <div className="absolute -top-3 left-4 rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
          {badge}
        </div>
        <div className="flex items-center gap-2">
          <div className="rounded-md bg-primary/10 p-2 text-primary">
            <Icon className="h-5 w-5" />
          </div>
          <CardTitle className="text-sm">{title}</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <CardDescription className="text-sm">{body}</CardDescription>
      </CardContent>
    </Card>
  );
}

function StepBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function QA({ q, a }: { q: string; a: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{q}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{a}</p>
      </CardContent>
    </Card>
  );
}

export default function HowItWorksPage() {
  return (
    <main className="container mx-auto px-4 py-10 md:py-14">
      {/* Hero */}
      <header className="mx-auto max-w-3xl text-center">
        <div className="mb-3 flex justify-center">
          <Badge variant="outline" className="text-xs">
            Documentation
          </Badge>
        </div>
        <h1 className="text-3xl font-bold tracking-tight md:text-5xl">How it works</h1>
        <p className="mt-4 text-muted-foreground md:text-lg">
          A verifiable research pipeline: plan → search → read → rank → answer → verify.
        </p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <Button asChild>
            <Link href="/research">Try it now</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/">Back to home</Link>
          </Button>
        </div>
      </header>

      {/* Steps overview + TOC */}
      <div className="mx-auto mt-10 grid max-w-6xl grid-cols-12 gap-6 md:mt-14">
        <div className="col-span-12 lg:col-span-9">
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
            <StepCard
              title="Plan"
              body="We prompt a small, fast LLM to extract intent and generate sub-queries with optional domain/time constraints."
              badge="1"
              icon={ListChecks}
            />
            <StepCard
              title="Search"
              body="We call Jina Deepsearch (/v1/search) with domain/time filters. Optional chat fallback can be enabled. Results are deduped and filtered."
              badge="2"
              icon={SearchIcon}
            />
            <StepCard
              title="Read"
              body="Each URL is read via Jina Reader (r.jina.ai with Authorization) or raw HTML. Text is sanitized, normalized, and stored."
              badge="3"
              icon={BookOpenText}
            />
            <StepCard
              title="Chunk"
              body="We split text into windows (~1k tokens with overlap), and store chunks in Turso (libSQL)."
              badge="4"
              icon={SquareStack}
            />
            <StepCard
              title="Rank"
              body="FTS5 (bm25) over chunks selects top snippets; we diversify per source. Optional cross-encoder rerank (Jina) can be enabled."
              badge="5"
              icon={ArrowUpDown}
            />
            <StepCard
              title="Answer + Verify"
              body="We stream an answer with inline citations [n], then extract claims and bind quotes with exact char offsets for verification."
              badge="6"
              icon={ShieldCheck}
            />
          </div>
        </div>

        {/* Sticky TOC on desktop */}
        <aside className="col-span-12 lg:col-span-3">
          <Card className="lg:sticky lg:top-6">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">On this page</CardTitle>
            </CardHeader>
            <CardContent>
              <nav className="space-y-2 text-sm">
                {TOC.map((t) => (
                  <div key={t.id}>
                    <Link href={`#${t.id}`} className="text-muted-foreground hover:text-foreground">
                      {t.label}
                    </Link>
                  </div>
                ))}
              </nav>
            </CardContent>
          </Card>
        </aside>
      </div>

      {/* Pipeline details */}
      <section id="pipeline" className="mx-auto mt-12 max-w-5xl md:mt-16" aria-labelledby="pipeline-heading">
        <SectionHeading id="pipeline-heading">Pipeline details</SectionHeading>
        <div className="mt-4 grid grid-cols-1 gap-5 text-sm leading-6 md:grid-cols-2">
          <StepBlock
            title="Planning"
            items={[
              "LLM: Groq (plan model), deterministic (temperature 0).",
              "Outputs subqueries, optional constraints (timeRange, region, allow/deny domains).",
            ]}
          />
          <StepBlock
            title="Search"
            items={[
              "Primary: POST https://api.jina.ai/v1/search with Authorization: Bearer $JINA_API_KEY.",
              "We use top_k, allow/deny, time_range, and region. 400/401/404 are treated as non-retryable.",
              "Optional: Deepsearch Chat fallback (https://deepsearch.jina.ai/v1/chat/completions) — can be disabled.",
            ]}
          />
          <StepBlock
            title="Read & sanitize"
            items={[
              "Jina Reader: GET https://r.jina.ai/https://example.com (with Authorization).",
              "Raw fetch fallback when Reader fails; HTML → text via simple stripping and normalization.",
              "Text normalized (NFKC), control chars removed, optional markdown strip (for markdown sources).",
            ]}
          />
          <StepBlock
            title="Chunk + storage"
            items={[
              "Chunk windows ~1000 tokens, 15% overlap, paragraph-aware.",
              "DB: Turso (libSQL) via Drizzle; tables: sources, source_content, chunks, threads, messages, claims, claim_evidence.",
              "FTS5 virtual table chunks_fts is created if missing; triggers maintain sync on insert/update/delete.",
            ]}
          />
          <StepBlock
            title="Rank snippets"
            items={[
              "FTS5 bm25 ranking per subquery, merged by best score.",
              "Diversification by source (cap per source) to avoid overfitting one page.",
              "Optional rerank via Jina cross-encoder (ENABLE_RERANK=true).",
            ]}
          />
          <StepBlock
            title="Answer"
            items={[
              "LLM: Groq (answer model), streaming tokens to UI.",
              "Answer includes inline citations like [1], [2], clickable to focus sources.",
            ]}
          />
          <StepBlock
            title="Verify"
            items={[
              "LLM: Groq (verify model) produces JSON claims with evidence.",
              "We bind evidence quotes back to chunk text, computing charStart/charEnd via tolerant matching.",
              "Optionally run NLI contradiction checks (feature flagable).",
            ]}
          />
        </div>
      </section>

      {/* Key data models */}
      <section id="models" className="mx-auto mt-12 max-w-5xl md:mt-16" aria-labelledby="models-heading">
        <SectionHeading id="models-heading">Key data models</SectionHeading>
        <ul className="mt-4 grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
          {[
            ["sources", "url, domain, title, crawledAt, lang, httpStatus, status"],
            ["source_content", "sourceId → text, html"],
            ["chunks", "sourceId → windows with charStart/charEnd, tokens"],
            ["threads & messages", "conversation log of user/assistant"],
            ["claims & claim_evidence", "verified claims, evidence quotes, offsets, source linkage"],
          ].map(([name, desc]) => (
            <li key={name} className="rounded-md border bg-card p-3">
              <div className="font-medium">{name}</div>
              <div className="text-muted-foreground">{desc}</div>
            </li>
          ))}
        </ul>
      </section>

      {/* API quickstart */}
      <section id="api" className="mx-auto mt-12 max-w-5xl md:mt-16" aria-labelledby="api-heading">
        <SectionHeading id="api-heading">API quickstart</SectionHeading>
        <div className="mt-4 space-y-4">
          <div className="rounded-md border bg-card p-4">
            <div className="text-sm font-medium">POST /api/research</div>
            <pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs">
{`curl -s -X POST http://localhost:3000/api/research \\
  -H "Content-Type: application/json" \\
  -d '{
    "question": "What are the key points of the latest Jina AI blog post?",
    "depth": "normal",
    "timeRange": null,
    "allowedDomains": null,
    "disallowedDomains": null
  }'`}
            </pre>
          </div>
          <div className="rounded-md border bg-card p-4">
            <div className="text-sm font-medium">POST /api/verify</div>
            <pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs">
{`curl -s -X POST http://localhost:3000/api/verify \\
  -H "Content-Type: application/json" \\
  -d '{
    "answerMarkdown": "Answer with [1]...", 
    "snippets": [{"sourceId":"src_123","text":"..."}],
    "maxClaims": 12
  }'`}
            </pre>
          </div>
          <div className="rounded-md border bg-card p-4">
            <div className="text-sm font-medium">GET /api/source/[id]</div>
            <pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs">
{`curl -s "http://localhost:3000/api/source/src_123?include=content,chunks&snippetChars=400"`}
            </pre>
          </div>
        </div>
      </section>

      {/* Environment & feature flags */}
      <section id="env" className="mx-auto mt-12 max-w-5xl md:mt-16" aria-labelledby="env-heading">
        <SectionHeading id="env-heading">Environment & feature flags</SectionHeading>
        <div className="mt-4 overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted">
              <tr className="text-xs uppercase text-muted-foreground">
                <th className="px-3 py-2">Key</th>
                <th className="px-3 py-2">Purpose</th>
                <th className="px-3 py-2">Default</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["GROQ_API_KEY", "Groq LLM calls (plan/answer/verify)", "—"],
                ["JINA_API_KEY", "Jina Deepsearch, Reader, (optional rerank)", "—"],
                ["TURSO_DATABASE_URL", "libSQL/Turso database URL", "file:./.data/dev.db (dev)"],
                ["TURSO_AUTH_TOKEN", "libSQL auth token (remote)", "—"],
                ["REQUEST_TIMEOUT_MS", "Global HTTP timeout knob", "30000"],
                ["MAX_SOURCES_INLINE", "Read/ingest inline cap", "12"],
                ["ENABLE_RERANK", "Enable Jina reranker (rank stage)", "false"],
                ["JINA_USE_CHAT", "Use Deepsearch Chat directly", "0"],
                ["JINA_DISABLE_CHAT_FALLBACK", "Skip chat fallback on search 4xx", "1"],
                ["JINA_PREWARM", "Prewarm s.jina.ai for query", "0"],
                ["PRETTY_LOGS", "pino-pretty local logs", "0"],
              ].map(([k, p, d]) => (
                <tr key={k} className="border-t">
                  <td className="px-3 py-2 font-mono">{k}</td>
                  <td className="px-3 py-2 text-muted-foreground">{p}</td>
                  <td className="px-3 py-2 text-muted-foreground">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="mx-auto mt-12 max-w-5xl md:mt-16" aria-labelledby="faq-heading">
        <SectionHeading id="faq-heading">FAQ</SectionHeading>
        <div className="mt-4 grid grid-cols-1 gap-4 text-sm text-muted-foreground">
          <QA
            q="Why do some searches return no results?"
            a="Your Jina API key/plan may not include Deepsearch. We treat 400/401/404 as non-retryable and skip chat fallback by default to keep things fast. Enable chat or use alternative providers if needed."
          />
          <QA
            q="How are citations [n] generated?"
            a="Sources used in the answer are indexed 1..N in the sidebar; the answer inserts [n] in-line, and clicking navigates to the matched source and quotes."
          />
          <QA
            q="How is evidence verified?"
            a="The verification step yields claims with evidence quotes; we compute char offsets by tolerant matching (ignoring whitespace, quotes, and dashes) against the stored chunk text."
          />
          <QA
            q="How do I reset or rebuild FTS?"
            a="We create chunks_fts and triggers if missing. You can also ship a migration to create FTS5 virtual table and triggers up-front."
          />
        </div>
      </section>

      <footer className="mx-auto mt-14 max-w-6xl border-t pt-6 text-center text-xs text-muted-foreground">
        Built with Next.js App Router, Drizzle + Turso, Jina, and Groq.
      </footer>
    </main>
  );
}