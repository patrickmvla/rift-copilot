"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetClose,
} from "@/components/ui/sheet";
import { Menu, Github, ArrowRight } from "lucide-react";

/* -------------------------------- Helpers --------------------------------- */
function clsx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function formatStars(n?: number | null) {
  if (n == null) return null;
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(n / 1000)}k`;
}

function LogoMark() {
  return (
    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-sm font-bold text-primary">
      E
    </div>
  );
}

type NavItem = { href: string; label: string };

const NAV: NavItem[] = [
  { href: "/research", label: "Research" },
  { href: "/how-it-works", label: "How it works" },
];

/* -------------------------------- Component -------------------------------- */

export type MainHeaderProps = {
  className?: string;
  githubUrl?: string; // e.g., "https://github.com/owner/repo"
  repoSlug?: string; // e.g., "owner/repo" to fetch stars
  ctaLabel?: string;
  ctaHref?: string;
};

export function MainHeader({
  className,
  githubUrl = "https://github.com",
  repoSlug,
  ctaLabel = "Start researching",
  ctaHref = "/research",
}: MainHeaderProps) {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Fetch GitHub stars (optional)
  useEffect(() => {
    let ignore = false;
    async function loadStars() {
      if (!repoSlug) return;
      try {
        const res = await fetch(`https://api.github.com/repos/${repoSlug}`);
        if (!res.ok) return;
        const json = await res.json();
        if (!ignore) setStars(json?.stargazers_count ?? null);
      } catch {
        // ignore
      }
    }
    loadStars();
    return () => {
      ignore = true;
    };
  }, [repoSlug]);

  const starsText = useMemo(() => formatStars(stars), [stars]);

  return (
    <header
      className={clsx(
        "sticky top-0 z-40 w-full border-b bg-background/70 backdrop-blur supports-[backdrop-filter]:bg-background/60",
        scrolled ? "shadow-sm" : "",
        className
      )}
      role="banner"
    >
      <div className="container mx-auto flex h-14 items-center justify-between px-4 md:px-6">
        {/* Left: Brand + desktop nav */}
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2" aria-label="Go to home">
            <LogoMark />
            <span className="hidden text-sm font-semibold sm:inline">
              Evidence-First
            </span>
          </Link>

          <nav className="ml-2 hidden items-center gap-4 md:flex" aria-label="Main">
            {NAV.map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={clsx(
                    "text-sm transition-colors hover:text-foreground",
                    active ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Right: actions (desktop) */}
        <div className="hidden items-center gap-2 md:flex">
          <Button asChild variant="ghost" size="sm">
            <Link
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open GitHub repository"
              className="inline-flex items-center gap-2"
            >
              <Github className="h-4 w-4" />
              GitHub
              {starsText && (
                <Badge variant="secondary" className="ml-1">
                  ★ {starsText}
                </Badge>
              )}
            </Link>
          </Button>

          <Button asChild size="sm" className="group">
            <Link href={ctaHref}>
              {ctaLabel}
              <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Button>
        </div>

        {/* Mobile: sheet menu */}
        <div className="md:hidden">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open menu">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[300px]">
              <div className="mt-1 flex items-center gap-2">
                <LogoMark />
                <div className="text-sm font-semibold">Evidence-First</div>
              </div>

              <div className="mt-6 flex flex-col gap-1" role="menu" aria-label="Mobile navigation">
                {NAV.map((item) => {
                  const active =
                    item.href === "/"
                      ? pathname === "/"
                      : pathname.startsWith(item.href);
                  return (
                    <SheetClose asChild key={item.href}>
                      <Link
                        href={item.href}
                        className={clsx(
                          "rounded px-2 py-2 text-sm",
                          active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent"
                        )}
                      >
                        {item.label}
                      </Link>
                    </SheetClose>
                  );
                })}
              </div>

              <div className="mt-6 flex items-center gap-2">
                <Button asChild variant="ghost" className="flex-1">
                  <Link href={githubUrl} target="_blank" rel="noopener noreferrer">
                    <Github className="mr-2 h-4 w-4" />
                    GitHub
                    {starsText && <Badge variant="secondary" className="ml-2">★ {starsText}</Badge>}
                  </Link>
                </Button>
                <SheetClose asChild>
                  <Button asChild className="flex-1">
                    <Link href={ctaHref}>
                      {ctaLabel}
                    </Link>
                  </Button>
                </SheetClose>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}