"use client";

import { useEffect, useRef, useState } from "react";
import { MawsLogo } from "@/components/brand/MawsLogo";
import { getChart } from "@/lib/chart-registry";
import { MAWS_FULL_NAME } from "@/lib/maws/brand";
import { useAppStore } from "@/lib/store";
import { BookOpen, Keyboard, Settings } from "lucide-react";

/** MAWS product menu: the brand mark at the top bar's left edge opens the
 *  feature menu — journal, keyboard shortcuts, chart settings. */
export function MawsProductMenu() {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const activePaneId = useAppStore((s) => s.activePaneId);
  const setJournalOverlayOpen = useAppStore((s) => s.setJournalOverlayOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (!menuRef.current?.contains(target)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  return (
    <div className="relative z-[2] shrink-0" ref={menuRef}>
      <button
        type="button"
        title={`${MAWS_FULL_NAME} — features`}
        aria-label={`${MAWS_FULL_NAME} — features`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setMenuOpen(false);
        }}
        className="flex h-[28px] w-[28px] items-center justify-center rounded-[4px] text-(--app-muted) hover:bg-(--app-hover) hover:text-(--app-text)"
      >
        <MawsLogo size={18} mono title={MAWS_FULL_NAME} />
      </button>

      {menuOpen && (
        <div className="menu min-w-[210px]" data-dropdown-open>
          <div className="menu-row py-2.5">
            <button
              type="button"
              className="flex w-full items-center gap-2 whitespace-nowrap text-left"
              onClick={() => {
                setMenuOpen(false);
                setJournalOverlayOpen(true);
              }}
            >
              <BookOpen size={14} className="w-[14px] shrink-0 text-(--app-muted)" />
              <span>Trading Journal</span>
            </button>
          </div>

          <div className="menu-row border-t border-(--app-border) py-2.5">
            <button
              type="button"
              className="flex w-full items-center gap-2 whitespace-nowrap text-left"
              onClick={() => {
                setMenuOpen(false);
                setSettingsOpen(true);
              }}
            >
              <Keyboard size={14} className="w-[14px] shrink-0 text-(--app-muted)" />
              <span className="flex-1">Shortcuts</span>
              <span className="text-[11px] text-(--app-muted)">Ctrl+K</span>
            </button>
          </div>

          <div className="menu-row border-t border-(--app-border) py-2.5">
            <button
              type="button"
              className="flex w-full items-center gap-2 whitespace-nowrap text-left"
              onClick={() => {
                setMenuOpen(false);
                (getChart(activePaneId)?.renderer as unknown as {
                  openSettings?: (s?: string) => void;
                }).openSettings?.();
              }}
            >
              <Settings size={14} className="w-[14px] shrink-0 text-(--app-muted)" />
              <span>Settings</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
