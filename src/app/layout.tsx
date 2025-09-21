import "@/styles/globals.css";
import type { Metadata } from "next";
import { MainHeader } from "@/components/MainHeader";
import { Providers } from "../providers/providers";

export const metadata: Metadata = {
  title: "Evidence-First Research",
  description: "Deep research with verifiable citations and evidence.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased">
        {/* Skip to content */}
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 rounded bg-primary px-3 py-1 text-sm text-primary-foreground"
        >
          Skip to content
        </a>

        <Providers>
          <MainHeader
            // githubUrl="https://github.com/owner/repo"
            // repoSlug="owner/repo"
          />
          {/* Anchor target for skip link; pages can still use their own <main> */}
          <div id="content" />
          {children}
        </Providers>
      </body>
    </html>
  );
}