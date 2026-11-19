"use client";

import { useAppStore } from "@/lib/store";
import { MAWS_JOURNAL_URL } from "@/lib/maws/journal";
import { eventMatchesShortcut } from "@/lib/shortcuts";
import { velaThemeNameFromAppSettings } from "@/lib/app-theme";
import { useCallback, useEffect, useRef, useState } from "react";

// ── Journal ↔ chart theme bridge ───────────────────────────────────────────
// The chart offers four dark Vela palettes (Muted, Classic, Gruvbox, True
// Black). The journal maps a binary `journal-theme-v1` (light|dark) onto a `.dark` class
// and, for each dark Vela palette, picks a full skin via a `data-journal-theme`
// attribute on <html> — the vendored stylesheet defines the muted, classic and
// gruvbox skins, and the host injects a true-black one. Every journal token
// (color surfaces, focus ring, brand accent, P&L colors, chart series) is per
// palette, and canvas painters re-resolve tokens when that attribute flips.
// Vela Light (not a dark skin) removes the attribute so the journal falls
// back to its own light palette.

type ChartThemeName = "black" | "dark" | "classic" | "gruvbox" | "light";

/** The true-black skin. The vendored journal ships muted/classic/gruvbox skins
 *  in its own stylesheet, so the host injects this one into the same-origin
 *  frame instead of asking for a rebuild of the sidecar. Tokens mirror
 *  BLACK_THEME and the shell's app palette: OLED #000 on every surface. */
const BLACK_SKIN_ID = "maws-journal-black-skin";
const BLACK_SKIN_CSS = `
:root[data-journal-theme="black"] {
  color-scheme: dark;
  --background: #000000;
  --foreground: #d1d4dc;
  --card: #000000;
  --card-foreground: #d1d4dc;
  --popover: #000000;
  --popover-foreground: #d1d4dc;
  --primary: #d1d4dc;
  --primary-foreground: #000000;
  --secondary: #1a1a1a;
  --secondary-foreground: #d1d4dc;
  --muted: #000000;
  --muted-foreground: #787b86;
  --accent: #1a1a1a;
  --accent-foreground: #d1d4dc;
  --destructive: #f23645;
  --destructive-foreground: #ffffff;
  --border: #222222;
  --input: #222222;
  --ring: #2962ff;
  --brand: #2962ff;
  --viz-surface: #000000;
  --ink-muted: #787b86;
  --gridline: #141414;
  --baseline: #222222;
  --profit: #089981;
  --profit-fill: #089981;
  --loss: #f23645;
  --neutral-mid: #1a1a1a;
  --series-1: #2962ff;
  --series-2: #ff9800;
  --series-3: #26a69a;
  --series-4: #ef5350;
  --series-5: #ab47bc;
  --series-6: #66bb6a;
  --series-7: #ffee58;
  --series-8: #26c6da;
}
`;

/** Idempotent: the frame keeps this style across in-app navigation, and a full
 *  reload re-injects it on the next theme sync. */
function ensureBlackSkin(win: Window) {
  const doc = win.document;
  if (doc.getElementById(BLACK_SKIN_ID)) return;
  const style = doc.createElement("style");
  style.id = BLACK_SKIN_ID;
  style.textContent = BLACK_SKIN_CSS;
  doc.head.appendChild(style);
}

/** The chart theme's name → journal skin key. The chart's muted palette is
 *  named `dark` in ThemeName space, but its journal skin is keyed `muted`.
 *  Classic, gruvbox and black map to their own full skins; light has no skin
 *  and returns undefined so the journal uses its own palette. */
function journalSkinFor(name: ChartThemeName): string | undefined {
  if (name === "light") return undefined;
  if (name === "dark") return "muted";
  return name; // "black" | "classic" | "gruvbox"
}

/**
 * Push the chart's theme into the journal document: the binary class flips
 * its Tailwind `dark:` variants, and the data attribute selects one of the
 * full Vela skins defined in the journal's globals.css.
 */
function applyJournalTheme(win: Window, name: ChartThemeName) {
  const root = win.document.documentElement;
  root.classList.toggle("dark", name !== "light");
  const skin = journalSkinFor(name);
  if (skin === undefined) delete root.dataset.journalTheme;
  else {
    root.dataset.journalTheme = skin;
    if (skin === "black") ensureBlackSkin(win);
  }
}

/**
 * Full-screen host for the vendored LuxAlgo Trade Journal, proxied same-origin at
 * /journal by the MAWS server (rewrites → port 3400, basePath "/journal"). The
 * iframe mounts lazily on first open and survives close-by-hide so the journal
 * keeps its in-app state between visits. No chrome of its own — the journal's
 * filter bar carries the "Back to chart" button that closes this overlay.
 */
export function JournalOverlay() {
  const open = useAppStore((s) => s.journalOverlayOpen);
  const setJournalOverlayOpen = useAppStore((s) => s.setJournalOverlayOpen);

  // Mount once on first open, then keep the iframe alive across closes.
  const [mounted, setMounted] = useState(false);
  const mountedRef = useRef(false);
  useEffect(() => {
    if (open && !mountedRef.current) {
      mountedRef.current = true;
      setMounted(true);
    }
  }, [open]);

  // "Back to chart" inside the journal (and any same-origin frame control)
  // closes the overlay by posting this message to the parent window.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { source?: string; type?: string } | null;
      if (data?.source === "maws-journal" && data?.type === "close") {
        setJournalOverlayOpen(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [setJournalOverlayOpen]);

  // ── Theme sync: the journal follows the chart's theme ────────────────────
  // Map the persisted chrome colors back to the Vela theme name, then apply
  // the matching journal look (Vela Light → journal's own light; Vela Muted /
  // Vela Classic / Vela Gruvbox → journal dark with that palette's tones).
  const chartTheme = useAppStore((s): ChartThemeName => {
    const name = velaThemeNameFromAppSettings(s.appSettings);
    // velaThemeNameFromAppSettings returns black | light | classic | gruvbox
    // | dark, all of which are valid ChartThemeName values.
    return name === "light" || name === "classic" || name === "gruvbox" || name === "black" ? name : "dark";
  });
  const themeRef = useRef(chartTheme);
  themeRef.current = chartTheme;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeReady, setIframeReady] = useState(false);

  // Belt and braces for the iframe-load race: the probe covers an iframe that
  // was already complete when mounted (hot reload, restore), the sync effect
  // re-runs whenever the overlay opens (persisted-open reload), and onLoad
  // covers the normal first-load ordering.
  useEffect(() => {
    if (!mounted) return;
    const doc = iframeRef.current?.contentWindow?.document;
    if (doc && doc.readyState === "complete") setIframeReady(true);
  }, [mounted, open]);

  const syncJournalTheme = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try {
      win.localStorage.setItem("journal-theme-v1", themeRef.current === "light" ? "light" : "dark");
      applyJournalTheme(win, themeRef.current);
    } catch {
      // Same-origin by construction; a failure here only means the journal
      // document isn't reachable yet — the next sync retries.
    }
  }, []);

  // Propagate theme changes and re-sync when the overlay (re)opens.
  useEffect(() => {
    if (!iframeReady) return;
    syncJournalTheme();
  }, [chartTheme, iframeReady, open, syncJournalTheme]);

  // A journal reload (its own navigations, root layout refresh) wipes the
  // attribute — a cheap self-heal keeps the palette pinned to the chart's.
  useEffect(() => {
    if (!mounted) return;
    const id = window.setInterval(() => {
      const win = iframeRef.current?.contentWindow;
      const root = win?.document.documentElement;
      if (!root) return;
      const expected = journalSkinFor(themeRef.current);
      if (root.dataset.journalTheme !== expected) syncJournalTheme();
    }, 750);
    return () => window.clearInterval(id);
  }, [mounted, syncJournalTheme]);

  // While the journal frame holds focus, the parent window never sees
  // keydowns — listen inside the (same-origin) frame so the toggleJournal
  // shortcut closes the overlay from within too.
  useEffect(() => {
    if (!mounted || !open || !iframeReady) return;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    const onKey = (e: KeyboardEvent) => {
      const s = useAppStore.getState();
      if (!eventMatchesShortcut(e, s.shortcuts.toggleJournal)) return;
      e.preventDefault();
      s.setJournalOverlayOpen(false);
    };
    win.addEventListener("keydown", onKey);
    return () => win.removeEventListener("keydown", onKey);
  }, [mounted, open, iframeReady]);

  if (!mounted) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Trade Journal"
      className="fixed inset-0 z-[100] flex-col bg-[var(--app-bg)]"
      // Hide by display rather than unmounting: the iframe keeps its scroll
      // state, form fields and in-journal history between visits.
      style={{ display: open ? "flex" : "none" }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          setJournalOverlayOpen(false);
        }
      }}
    >
      <iframe
        ref={iframeRef}
        src={MAWS_JOURNAL_URL}
        title="LuxAlgo Trade Journal"
        className="min-h-0 flex-1 border-0 bg-[var(--app-bg)]"
        onLoad={() => {
          setIframeReady(true);
          syncJournalTheme();
        }}
      />
    </div>
  );
}
