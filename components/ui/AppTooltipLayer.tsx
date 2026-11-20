"use client";

import { useEffect } from "react";

/**
 * The shell's one tooltip for plain `title` attributes.
 *
 * The chart's drawing toolbar and chrome already drew Vela's themed tip
 * (lib/charting/renderers/shared/chrome-tooltip.ts), while every other control
 * leaned on the browser's native bubble — OS font, OS delay, unthemeable. So the
 * same screen showed two different tooltips. This layer listens for hovers on
 * `[title]`, hides the native bubble for that hover and draws the Vela one, so a
 * control keeps its `title` prop and simply looks like the chart's.
 *
 * Deliberately the same behaviour as chrome-tooltip.ts: 700 ms hover delay,
 * mouse-only (a tap has no hover to follow, so a touch-armed tip would stick),
 * closes on press, scroll, resize, blur and Escape.
 */
const OPEN_DELAY_MS = 700;
const GAP_PX = 8;
const EDGE_PAD = 4;
const STASH = "data-app-tooltip";
/** Label source for controls that must never show a native bubble. */
const TIP_ATTR = "data-app-tip";

export function AppTooltipLayer() {
  useEffect(() => {
    // No `hover: none` bail: a touchscreen laptop reports coarse pointers too, and
    // bailing there would leave the OS bubble on a machine driven by a mouse. The
    // per-event `pointerType` check below is the real touch guard.
    let timer: number | null = null;
    let tip: HTMLDivElement | null = null;
    let anchor: Element | null = null;
    /** Restores an SVG icon's <title> after a hover muted it (see `open`). */
    let unmute: (() => void) | null = null;

    /** Put the title back so React's prop and the DOM stay in agreement. */
    const releaseAnchor = (): void => {
      if (anchor) {
        const stashed = anchor.getAttribute(STASH);
        if (stashed !== null) {
          if (!anchor.hasAttribute("title")) anchor.setAttribute("title", stashed);
          anchor.removeAttribute(STASH);
        }
      }
      anchor = null;
      unmute?.();
      unmute = null;
    };

    const close = (): void => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      tip?.remove();
      tip = null;
      releaseAnchor();
    };

    /**
     * Adjacent to the control, 8 px off its edge — right first (a rail of icons
     * reads like the drawing toolbar's own tips), then left, then above/below.
     * `pointerX` keeps a tip on a long row next to the icon actually hovered
     * instead of centred somewhere in the middle of the row.
     */
    const place = (el: Element, box: HTMLDivElement, pointerX: number): void => {
      const a = el.getBoundingClientRect();
      const w = box.offsetWidth;
      const h = box.offsetHeight;
      const maxX = window.innerWidth - w - EDGE_PAD;
      const maxY = window.innerHeight - h - EDGE_PAD;
      const clampX = (x: number): number => Math.max(EDGE_PAD, Math.min(x, maxX));
      const clampY = (y: number): number => Math.max(EDGE_PAD, Math.min(y, maxY));
      const midY = a.top + a.height / 2 - h / 2;
      const beside = Math.min(Math.max(pointerX, a.left), a.right);
      const midX = beside - w / 2;

      let x: number;
      let y: number;
      if (a.right + GAP_PX + w <= maxX) {
        x = a.right + GAP_PX;
        y = midY;
      } else if (a.left - GAP_PX - w >= EDGE_PAD) {
        x = a.left - GAP_PX - w;
        y = midY;
      } else if (a.top - GAP_PX - h >= EDGE_PAD) {
        x = midX;
        y = a.top - GAP_PX - h;
      } else {
        x = midX;
        y = a.bottom + GAP_PX;
      }

      box.style.left = `${Math.round(clampX(x))}px`;
      box.style.top = `${Math.round(clampY(y))}px`;
    };

    const show = (el: Element, text: string, pointerX: number): void => {
      if (anchor !== el) return;
      const box = document.createElement("div");
      box.className = "app-tooltip";
      box.setAttribute("role", "tooltip");
      box.textContent = text;
      // Parked off-screen for one measurement, then placed — never seen in a corner.
      box.style.left = "-9999px";
      document.body.appendChild(box);
      tip = box;
      place(el, box, pointerX);
    };

    /**
     * Arm the tip for one element. `mute` hides whatever native tooltip the
     * element would otherwise show — the `title` attribute for buttons, the
     * `<title>` child for inline SVG icons (the MAWS logo). `restore` is for
     * mutations that `releaseAnchor` cannot undo on its own.
     */
    const open = (
      el: Element,
      text: string,
      pointerX: number,
      mute: () => void,
      restore: (() => void) | null = null,
    ): void => {
      close();
      anchor = el;
      unmute = restore;
      mute();
      timer = window.setTimeout(() => {
        timer = null;
        show(el, text, pointerX);
      }, OPEN_DELAY_MS);
    };

    /** `data-app-tip` first: the drawing bar opts out of `title` entirely so a
     *  native bubble can never appear there, even before this layer arms. */
    const openFor = (el: Element, pointerX: number): void => {
      const text = el.getAttribute(TIP_ATTR) ?? el.getAttribute("title");
      if (!text) return;
      open(el, text, pointerX, () => {
        const title = el.getAttribute("title");
        if (title === null) return; // data-app-tip only: nothing native to hide
        el.setAttribute(STASH, title);
        el.removeAttribute("title");
      });
    };

    /** SVG icons carry their label in a `<title>` child, which browsers turn into
     *  a native bubble. Blank it for the hover and write it back on close. */
    const openWithSvgTitle = (svg: Element, pointerX: number): boolean => {
      const node = svg.querySelector("title");
      const text = node?.textContent?.trim();
      if (!node || !text) return false;
      const original = node.textContent;
      open(
        svg,
        text,
        pointerX,
        () => {
          node.textContent = "";
        },
        () => {
          node.textContent = original;
        },
      );
      return true;
    };

    const onOver = (event: PointerEvent): void => {
      if (event.pointerType !== "mouse") return;
      const target = event.target as Node | null;
      if (anchor && target && anchor.contains(target)) return; // same control, still open
      const el = (target as Element | null)?.closest?.(`[title], [${TIP_ATTR}]`) as Element | null;
      if (el) {
        openFor(el, event.clientX);
        return;
      }
      const svg = (target as Element | null)?.closest?.("svg") ?? null;
      if (!svg || !openWithSvgTitle(svg, event.clientX)) {
        close(); // moved onto a control with no tip: drop the last one
      }
    };

    const onOut = (event: PointerEvent): void => {
      if (!anchor) return;
      const to = event.relatedTarget as Node | null;
      if (to && anchor.contains(to)) return; // still inside the control
      close();
    };

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };

    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("scroll", close, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);

    return () => {
      close();
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, []);

  return null;
}
