import type { Metadata } from "next";

import { ResearchForm } from "@/components/ResearchForm";
import { ProgressBar } from "@/components/ProgressBar";
import { ChatStream } from "@/components/ChatStream";
import { EvidencePanel } from "@/components/EvidencePanel";

import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";

// Resizable layout (client component from shadcn/ui)
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";

export const metadata: Metadata = {
  title: "Evidence-First Research",
  description: "Deep research with verifiable evidence and citations.",
};

export default function ResearchPage() {
  return (
    <main className="container mx-auto px-4 py-6 md:px-6 md:py-8">
      {/* Skip links for keyboard users */}
      <div className="sr-only">
        <a href="#answer" className="focus:not-sr-only focus:absolute focus:top-4 focus:left-4 rounded bg-primary px-3 py-1 text-sm text-primary-foreground">
          Skip to answer
        </a>
        <a href="#evidence" className="ml-2 focus:not-sr-only focus:absolute focus:top-4 focus:left-40 rounded bg-primary px-3 py-1 text-sm text-primary-foreground">
          Skip to evidence
        </a>
      </div>

      {/* Page header */}
      <header className="mb-4 md:mb-6" aria-labelledby="research-title">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-xs">Research</Badge>
          <h1 id="research-title" className="text-2xl font-semibold tracking-tight md:text-3xl">
            Evidence-First Research
          </h1>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Deep research with verifiable evidence and citations.
        </p>
      </header>

      {/* Layout: resizable on desktop, still works on mobile */}
      <ResizablePanelGroup direction="horizontal" className="gap-6 lg:gap-8">
        {/* Left: Input + Progress + Answer */}
        <ResizablePanel defaultSize={58} minSize={40}>
          <section className="space-y-4" aria-label="Query and answer">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Ask a question</CardTitle>
                <CardDescription>Use natural language. Shift+Enter for a new line.</CardDescription>
              </CardHeader>
              <CardContent>
                <ResearchForm />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Progress</CardTitle>
                <CardDescription>Live planning, search, reading, and verification.</CardDescription>
              </CardHeader>
              <CardContent>
                <ProgressBar showTimeline />
              </CardContent>
            </Card>

            <Card id="answer" className="overflow-hidden">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Answer</CardTitle>
                <CardDescription>Streaming response with inline citations.</CardDescription>
              </CardHeader>
              <Separator />
              <CardContent className="pt-4">
                {/* ChatStream handles its own scroll + autoscroll */}
                <ChatStream />
              </CardContent>
            </Card>
          </section>
        </ResizablePanel>

        <ResizableHandle withHandle className="mx-1" />

        {/* Right: Evidence */}
        <ResizablePanel defaultSize={42} minSize={30}>
          <aside id="evidence" aria-label="Evidence" className="h-full">
            {/* Sticky effect provided by parent scroll; EvidencePanel manages its own internal scroll */}
            <Card className="h-full">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Evidence</CardTitle>
                <CardDescription>Sources, quotes, and offsets for verification.</CardDescription>
              </CardHeader>
              <Separator />
              <CardContent className="p-0">
                <div className="p-4">
                  <EvidencePanel />
                </div>
              </CardContent>
            </Card>
          </aside>
        </ResizablePanel>
      </ResizablePanelGroup>
    </main>
  );
}