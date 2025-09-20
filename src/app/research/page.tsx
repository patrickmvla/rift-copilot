import type { Metadata } from "next";

import { ResearchForm } from "@/components/ResearchForm";
import { ProgressBar } from "@/components/ProgressBar";
import { ChatStream } from "@/components/ChatStream";
import { EvidencePanel } from "@/components/EvidencePanel";

export const metadata: Metadata = {
  title: "Evidence-First Research",
  description: "Deep research with verifiable evidence and citations.",
};

export default function ResearchPage() {
  return (
    <main className="container mx-auto p-4 md:p-6">
      <div className="grid grid-cols-12 gap-6">
        {/* Left: Input + Progress + Answer */}
        <section className="col-span-12 lg:col-span-7 space-y-4">
          <ResearchForm />
          <ProgressBar showTimeline />
          <ChatStream />
        </section>

        {/* Right: Evidence */}
        <aside className="col-span-12 lg:col-span-5">
          <EvidencePanel />
        </aside>
      </div>
    </main>
  );
}
