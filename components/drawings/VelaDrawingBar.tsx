"use client";

/**
 * VelaDrawingBar.tsx — Vela's native drawing toolbar, docked HORIZONTALLY in the
 * MAWS top bar.
 *
 * One bar drives the ACTIVE pane's chart (the same seam VelaWorkspace uses for
 * its shared left rail): every arm/magnet/measure/eraser press routes through
 * `chart.drawings.*` of the active pane, and Vela's `drawing:*` events echo
 * back through the store (DrawingOverlay), so MAWS's own toolbar buttons, the
 * in-chart flyouts and this bar all share one state.
 *
 * The MAWS extras — undo/redo (relocated here from the top bar) — are built as
 * PLAIN DOM inside the same bar root (not React children), so every button of the
 * row is one uniform set of drag-reorderable siblings that rebuilds and
 * Fast-Refresh remounts can't desync. The order persists. Visibility toggles and
 * drawing removal live in the chart's right-click menu instead of this row.
 */

import { useAppStore } from "@/lib/store";
import { getChart } from "@/lib/chart-registry";
import { syncPaneDrawingsFromVela } from "@/lib/vela-drawings";
import { velaThemeNameFromAppSettings } from "@/lib/app-theme";
import type { DrawingTypeKey, VelaTheme } from "@/lib/charting";
import { useEffect, useRef } from "react";
import {
  DrawingToolbar as VelaDrawingToolbar,
  buildToolbar,
  defaultToolbar,
  resolveTheme,
  type ToolbarDefinition,
  type ToolbarGroupConfig,
} from "@/lib/charting";
// Registers the longposition/shortposition aliases the quick row buttons arm.
import "@/lib/vela-drawing-aliases";

/** Quick-access tools, one dedicated button each — the old flat MAWS top-bar set.
 *  Single-tool groups render as plain (chevron-less) buttons. */
const QUICK_TOOLS: ToolbarGroupConfig[] = [
  { id: "trendline", label: "Trend Line", tools: ["trendline"] },
  { id: "polyline", label: "Path", tools: ["polyline"] },
  { id: "curve", label: "Curve", tools: ["curve"] },
  { id: "hray", label: "Horizontal Ray", tools: ["hray"] },
  { id: "parallelchannel", label: "Parallel Channel", tools: ["parallelchannel"] },
  { id: "box", label: "Rectangle", tools: ["box"] },
  { id: "ellipse", label: "Circle", tools: ["ellipse"] },
  { id: "arrowmarkup", label: "Arrow Up", tools: ["arrowmarkup"] },
  { id: "arrowmarkdown", label: "Arrow Down", tools: ["arrowmarkdown"] },
];

/** Catalog tools kept OFF their stock group: `flagmark` never surfaces (the user
 *  doesn't want it on any toolbar); `iconstamp` (the Icon tool) is dropped from
 *  the bar entirely; `position` is re-homed to its own standalone button right
 *  of the quick tools below. `datepricerange` is removed from the top bar
 *  (available via the "more" aggregator flyout). `trendline` is in QUICK_TOOLS
 *  as a dedicated button — suppress its duplicate in the Lines catalog group so
 *  the representative button shows the next tool (Horizontal Line) instead. */
const HIDDEN_CATALOG_TYPES: ReadonlySet<string> = new Set(["flagmark", "iconstamp", "position", "datepricerange", "trendline", "hline"]);

/** Tools that are promoted to top-level plain buttons even though they belong to
 *  a catalog group — these bypass their group's flyout. */
const PROMOTED_TOOLS: ReadonlySet<string> = new Set(["magnifier"]);

/**
 * The MAWS top bar toolbar:
 *
 * Layout (left → right):
 *   [undo] [redo]
 *   [crosshair] [measure] [magnet]            ← Vela mode buttons (built by Vela)
 *   [trendline] [hray] [parallelchannel]      ← quick plain buttons
 *   [box] [ellipse] [arrowmarkup] [arrowmarkdown]
 *   [position]                                ← promoted standalone
 *   [magnifier]                               ← promoted standalone from measurements
 *   [lines] [fibonacci] [patterns]            ← catalog representative buttons (no flyout)
 *   [shapes] [text]
 *   [more ⋮]                                  ← MAWS-owned button + custom flyout
 *   [hide-drawings] [hide-indicators] [clear]
 *
 * Every catalog group is collapsed to a single representative tool (no chevron/dropdown).
 * All their overflow content is in the MAWS-owned "more" flyout whose button opens it
 * without selecting any tool — a tool is only armed when the user clicks inside.
 */
interface MoreSection {
  label: string;
  tools: ToolbarDefinition["groups"][number]["tools"];
}

function mawsTopBarToolbar(): { definition: ToolbarDefinition; moreSections: MoreSection[] } {
  const quick = buildToolbar({ groups: QUICK_TOOLS }).definition.groups;

  // Resolve the full catalog so we have ToolDefinition objects (icon, label, type).
  const catalog = defaultToolbar();

  // Strip globally hidden types from every group.
  for (const g of catalog.groups) {
    g.tools = g.tools.filter((t) => !HIDDEN_CATALOG_TYPES.has(t.type));
    if (g.sections) {
      g.sections = g.sections
        .map((s) => ({ ...s, tools: s.tools.filter((t) => !HIDDEN_CATALOG_TYPES.has(t.type)) }))
        .filter((s) => s.tools.length > 0);
    }
  }

  // Standalone promoted tools (magnifier) — each becomes a 1-tool plain button.
  const promotedButtons: typeof catalog.groups = [];
  for (const g of catalog.groups) {
    const promoted = g.tools.filter((t) => PROMOTED_TOOLS.has(t.type));
    if (promoted.length > 0) {
      promotedButtons.push({ id: `promoted:${promoted[0]!.type}`, label: promoted[0]!.label, tools: [promoted[0]!] });
      g.tools = g.tools.filter((t) => !PROMOTED_TOOLS.has(t.type));
      if (g.sections) {
        g.sections = g.sections
          .map((s) => ({ ...s, tools: s.tools.filter((t) => !PROMOTED_TOOLS.has(t.type)) }))
          .filter((s) => s.tools.length > 0);
      }
    }
  }

  // Standalone position button — single-tool, no flyout.
  const [positionGroup] = buildToolbar({
    groups: [{ id: "position", label: "Long/Short Position", tools: ["position"] }],
  }).definition.groups;

  // Catalog groups that still have tools after filtering.
  const remaining = catalog.groups.filter((g) => g.tools.length > 0);

  /** Catalog groups that should NOT get a representative top-bar button.
   *  Their tools are still accessible through the "more" flyout. */
  const NO_REP_GROUPS = new Set(["lines-channels-pitchforks", "patterns-waves-harmonics", "measurements"]);

  // Each catalog group → 1-tool representative button (no flyout),
  // unless the group is suppressed from the top bar entirely.
  const representativeButtons = remaining
    .filter((g) => !NO_REP_GROUPS.has(g.id))
    .map((g) => ({
      id: `rep:${g.id}`,
      label: g.label,
      tools: [g.tools[0]!],
    }));

  // Collect all catalog sections for the MAWS-owned "more" flyout.
  // "more" is NOT part of the ToolbarDefinition — Vela never builds it.
  const definition: ToolbarDefinition = {
    groups: [
      ...quick,
      ...(positionGroup ? [positionGroup] : []),
      ...promotedButtons,
      ...representativeButtons,
      // "more" intentionally absent — it is a MAWS button, not a Vela group.
    ],
  };

  const fullCatalog = defaultToolbar();
  const barTools = definition.groups.flatMap((group) => group.tools);
  const menuToolTypes = new Set([
    ...remaining.flatMap((group) =>
      (group.sections ?? [{ label: group.label, tools: group.tools }])
        .flatMap((section) => section.tools.map((tool) => tool.type)),
    ),
    ...barTools.map((tool) => tool.type),
  ]);
  const moreSections: MoreSection[] = fullCatalog.groups
    .flatMap((group) => group.sections ?? [{ label: group.label, tools: group.tools }])
    .map((section) => ({
      label: section.label,
      tools: section.tools.filter((tool) => menuToolTypes.has(tool.type)),
    }))
    .filter((section) => section.tools.length > 0);

  return { definition, moreSections };
}

/** Persisted drag order of the bar's buttons (keys, left → right). Kept in its own
 *  localStorage key — the zustand workspace payload is shape-frozen by
 *  tests/persistence-compat.test.ts, so a new preference must not join it. Keys:
 *  bare group ids (what the earlier tool-cells-only files saved), `mode:*` for the
 *  bar's own mode buttons, `app:*` for the MAWS buttons (undo/redo/hide/CLR). */
const BAR_ORDER_KEY = "maws.drawingBar.order.v1";
const FAVORITES_KEY = "maws.drawingBar.favorites.v1";

function initializeFavorites(
  chart: NonNullable<ReturnType<typeof activeChart>>,
  defaultTools: readonly DrawingTypeKey[],
  knownTools: ReadonlySet<string>,
): DrawingTypeKey[] {
  let savedFavorites: DrawingTypeKey[] | null = null;
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        console.error("[maws] Saved drawing-tool favorites are invalid.");
      } else {
        savedFavorites = parsed.filter(
          (type): type is DrawingTypeKey => typeof type === "string" && knownTools.has(type),
        );
      }
    }
  } catch (error) {
    console.error("[maws] Could not read drawing-tool favorite preferences.", error);
  }

  const favorites = savedFavorites ?? [...new Set([...defaultTools, ...chart.drawings.favorites()])];
  chart.drawings.setFavorites(favorites);
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  } catch (error) {
    console.error("[maws] Could not save drawing-tool favorite preferences.", error);
  }
  return chart.drawings.favorites();
}

function loadBarOrder(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(BAR_ORDER_KEY) ?? "null");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Lucide glyphs (24-grid, 2px stroke, round joins) as plain SVG strings — the
 *  MAWS extra buttons are vanilla DOM, so they can't use the React icon set.
 *  All icons are fixed at 16×16 to match the `font-size:16px` set on the bar
 *  root (which makes Vela's own `1em` SVGs render at the same size). */
function svgIcon(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}
const UNDO_ICON = svgIcon(
  '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
);
const REDO_ICON = svgIcon(
  '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/>',
);
// "More tools" aggregator — six dots in a 3×2 grid (universal "more" glyph).
const MORE_ICON = svgIcon(
  '<circle cx="5"  cy="9"  r="1.5" fill="currentColor" stroke="none"/>'
  + '<circle cx="12" cy="9"  r="1.5" fill="currentColor" stroke="none"/>'
  + '<circle cx="19" cy="9"  r="1.5" fill="currentColor" stroke="none"/>'
  + '<circle cx="5"  cy="15" r="1.5" fill="currentColor" stroke="none"/>'
  + '<circle cx="12" cy="15" r="1.5" fill="currentColor" stroke="none"/>'
  + '<circle cx="19" cy="15" r="1.5" fill="currentColor" stroke="none"/>',
);
/** The active pane's chart, looked up at CALL time (the bar outlives pane
 *  switches — a stale closure would aim clicks at the wrong chart). */
function activeChart() {
  return getChart(useAppStore.getState().activePaneId)?.vela ?? null;
}

/** One MAWS extra button: a plain `.toolbar-btn` (app-muted grey, app-text on
 *  hover — the same ink the rest of the top bar speaks) that lives INSIDE the
 *  bar root and carries its drag identity on the element itself. */
function makeBarButton(key: string, label: string, html: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "toolbar-btn";
  b.dataset.dragKey = key;
  b.dataset.own = "app";
  // No `title`: a native OS bubble would clash with the chart's themed tip.
  // `data-app-tip` is read by AppTooltipLayer, which draws that same bubble.
  b.dataset.appTip = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = html;
  b.addEventListener("click", onClick);
  return b;
}

// Favorite marker — the wishlist diamond of the ticker search (symbol-picker's
// `diamond`/`diamond-filled`), redrawn on this file's 24-grid icon style.
const DIAMOND_ICON = svgIcon('<path d="M12 3 21 12l-9 9L3 12Z"/>');
const DIAMOND_FILLED_ICON = svgIcon('<path d="M12 3 21 12l-9 9L3 12Z" fill="currentColor"/>');
type DrawingToolDefinition = ToolbarDefinition["groups"][number]["tools"][number];

interface FavoriteUi {
  setFavorites: (types: readonly DrawingTypeKey[]) => void;
  setActiveTool: (type: DrawingTypeKey | null) => void;
  destroy: () => void;
}

/** Render favorited tools as standalone toolbar buttons unless they already have one. */
function mountFavoriteButtons(
  root: HTMLElement,
  tools: readonly DrawingToolDefinition[],
  directTypes: ReadonlySet<DrawingTypeKey>,
): FavoriteUi {
  const byType = new Map(tools.map((tool) => [tool.type, tool]));
  const buttons = new Map<DrawingTypeKey, HTMLButtonElement>();
  let activeTool: DrawingTypeKey | null = null;

  const setFavorites = (types: readonly DrawingTypeKey[]): void => {
    const favorites = [...new Set(types)];
    const favoriteSet = new Set(favorites);
    for (const [type, button] of buttons) {
      if (!favoriteSet.has(type) || directTypes.has(type)) {
        button.remove();
        buttons.delete(type);
      }
    }
    for (const type of favorites) {
      if (directTypes.has(type)) continue;
      const tool = byType.get(type);
      if (!tool) continue;
      let button = buttons.get(type);
      if (!button) {
        button = makeBarButton(`favorite:${type}`, tool.label, tool.icon, () => {
          activeChart()?.drawings.setTool(type);
        });
        button.draggable = true;
        buttons.set(type, button);
      }
      button.dataset.on = activeTool === type ? "1" : "";
      const moreButton = root.querySelector<HTMLElement>('[data-drag-key="app:more"]');
      root.insertBefore(button, moreButton);
    }
  };

  return {
    setFavorites,
    setActiveTool: (type) => {
      activeTool = type;
      for (const [favoriteType, button] of buttons) {
        button.dataset.on = type === favoriteType ? "1" : "";
      }
    },
    destroy: () => {
      for (const button of buttons.values()) button.remove();
      buttons.clear();
    },
  };
}

interface MoreButtonUi {
  setFavorites: (types: readonly DrawingTypeKey[]) => void;
  destroy: () => void;
}

function paintFavoriteButton(button: HTMLButtonElement, favorite: boolean): void {
  const label = favorite ? "Remove from favorites" : "Add to favorites";
  button.dataset.appTip = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(favorite));
  button.style.color = favorite ? "var(--app-accent)" : "var(--app-muted)";
  button.innerHTML = favorite ? DIAMOND_FILLED_ICON : DIAMOND_ICON;
}

/**
 * Build and mount the "more tools" button — a fully MAWS-owned button that opens
 * a custom flyout panel containing all catalog tools grouped by section.
 * Clicking the button ONLY toggles the panel; a tool is armed only when the user
 * clicks a row inside the panel.
 */
function mountMoreButton(root: HTMLElement, host: HTMLElement, sections: MoreSection[]): MoreButtonUi {
  if (sections.length === 0) return { setFavorites: () => {}, destroy: () => {} };

  let panel: HTMLDivElement | null = null;
  let favorites = new Set<DrawingTypeKey>();
  const favoriteButtons = new Map<DrawingTypeKey, HTMLButtonElement[]>();
  const setFavorites = (types: readonly DrawingTypeKey[]): void => {
    favorites = new Set(types);
    for (const [type, buttons] of favoriteButtons) {
      for (const button of buttons) paintFavoriteButton(button, favorites.has(type));
    }
  };

  // Built first so the close/outside/panel closures below can all reference it;
  // they only run from its own events, well after this initialization.
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "toolbar-btn";
  btn.dataset.dragKey = "app:more";
  btn.dataset.own = "app";
  btn.dataset.appTip = "More tools";
  btn.setAttribute("aria-label", "More tools");
  btn.innerHTML = MORE_ICON;

  const closePanel = (): void => {
    panel?.remove();
    panel = null;
    favoriteButtons.clear();
    btn.dataset.on = "";
    document.removeEventListener("pointerdown", onOutside);
  };

  const onOutside = (e: PointerEvent): void => {
    const t = e.target as Node;
    if (panel && !panel.contains(t) && !btn.contains(t)) closePanel();
  };

  const openPanel = (): void => {
    const p = document.createElement("div");
    p.className = "maws-more-panel";
    const btnR = btn.getBoundingClientRect();
    const hostR = host.getBoundingClientRect();
    p.style.cssText = [
      "position:absolute",
      `left:${btnR.left - hostR.left}px`,
      `top:${btnR.bottom - hostR.top + 4}px`,
      "z-index:50",
      "display:flex",
      "flex-direction:column",
      "gap:0",
      "padding:4px 0",
      "min-width:200px",
      "max-height:min(70vh,520px)",
      "overflow-y:auto",
      "overflow-x:hidden",
      "border-radius:8px",
      "border:1px solid var(--app-border)",
      "background:var(--app-menu)",
      "box-shadow:0 8px 28px rgba(0,0,0,0.65)",
      "color:var(--app-text)",
    ].join(";");

    for (let si = 0; si < sections.length; si++) {
      const sec = sections[si]!;

      // Section header label.
      const header = document.createElement("div");
      header.textContent = sec.label;
      header.style.cssText = [
        "padding:6px 12px 2px",
        "font-size:10px",
        "font-weight:600",
        "letter-spacing:0.06em",
        "text-transform:uppercase",
        "color:var(--app-muted)",
        "pointer-events:none",
        "user-select:none",
      ].join(";");
      p.appendChild(header);

      // Tool rows.
      for (const tool of sec.tools) {
        const row = document.createElement("div");
        row.style.cssText = [
          "display:flex",
          "align-items:center",
          "gap:8px",
          "padding:2px 6px 2px 12px",
          "width:100%",
          "text-align:left",
          "white-space:nowrap",
          "font-size:13px",
          "color:var(--app-text)",
        ].join(";");
        row.addEventListener("mouseover", () => { row.style.background = "var(--app-hover)"; });
        row.addEventListener("mouseout",  () => { row.style.background = "transparent"; });

        const select = document.createElement("button");
        select.type = "button";
        select.setAttribute("aria-label", tool.label);
        select.style.cssText = "display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:6px 0;text-align:left;white-space:nowrap;font-size:13px;color:var(--app-text);background:transparent;border:0;cursor:pointer;";

        const iconWrap = document.createElement("span");
        iconWrap.style.cssText = "width:16px;height:16px;display:flex;align-items:center;justify-content:center;flex:none;opacity:0.6;";
        iconWrap.innerHTML = tool.icon;
        select.appendChild(iconWrap);

        const lbl = document.createElement("span");
        lbl.textContent = tool.label;
        lbl.style.flex = "1";
        select.appendChild(lbl);
        row.appendChild(select);

        const fav = document.createElement("button");
        fav.type = "button";
        fav.style.cssText = "display:flex;align-items:center;justify-content:center;width:26px;height:26px;flex:none;border:0;border-radius:4px;background:transparent;cursor:pointer;color:var(--app-muted);";
        paintFavoriteButton(fav, favorites.has(tool.type));
        const rows = favoriteButtons.get(tool.type) ?? [];
        rows.push(fav);
        favoriteButtons.set(tool.type, rows);
        fav.addEventListener("pointerdown", (e) => e.stopPropagation());
        fav.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          activeChart()?.drawings.setFavorite(tool.type, !favorites.has(tool.type));
        });
        row.appendChild(fav);

        select.addEventListener("click", (e) => {
          e.stopPropagation();
          activeChart()?.drawings.setTool(tool.type);
          closePanel();
        });
        p.appendChild(row);
      }

      // Horizontal divider between sections, not after the last.
      if (si < sections.length - 1) {
        const div = document.createElement("div");
        div.style.cssText = "height:1px;background:var(--app-border);margin:4px 0;";
        p.appendChild(div);
      }
    }

    host.appendChild(p);
    panel = p;
    btn.dataset.on = "1";
    requestAnimationFrame(() => document.addEventListener("pointerdown", onOutside));
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel) { closePanel(); } else { openPanel(); }
  });

  root.appendChild(btn);

  return {
    setFavorites,
    destroy: () => {
      closePanel();
      btn.remove();
    },
  };
}

/** Mount the MAWS extras into the bar root: undo/redo lead the row (left of the
 *  crosshair, where they sit relative to the bar). The hide toggles and the
 *  drawing removal belong to the chart's right-click menu, not to this row. */
function mountAppButtons(root: HTMLElement): void {
  /** Undo/redo replace the drawings document INSIDE the controller, which emits no
   *  drawing events — the store is settled right after, or an undone drawing stays
   *  in the slice and is re-created on the next mount. */
  const step = (dir: "undo" | "redo") => {
    const paneId = useAppStore.getState().activePaneId;
    const chart = getChart(paneId)?.vela;
    if (!chart) return;
    if (dir === "undo") chart.drawings.undo();
    else chart.drawings.redo();
    syncPaneDrawingsFromVela(paneId);
  };
  const undo = makeBarButton("app:undo", "Undo drawing", UNDO_ICON, () => step("undo"));
  const redo = makeBarButton("app:redo", "Redo drawing", REDO_ICON, () => step("redo"));

  const anchor = root.firstChild; // the crosshair (cursor) button
  root.insertBefore(undo, anchor);
  root.insertBefore(redo, anchor);
  // Nothing to unsubscribe: these buttons die with the bar root.
}

/** Hand the bar's tooltips to the shell.
 *
 * Vela's toolbar attaches its own chrome tip to every cell/button
 * (`attachChromeTooltip`), and that tip is painted in the CHART's font —
 * `sans-serif` — while the shell's `AppTooltipLayer` uses the app font. On the
 * same row that read as a second, foreign-looking bubble (the one the user
 * called "native"), so the bar opts out of Vela's tips entirely: a capture
 * `pointerenter` listener swallows the event Vela arms its tips from (it never
 * reaches the cell's own listener), and every `aria-label` in the row is
 * mirrored onto `data-app-tip`, which is the shell layer's label source.
 *
 * The `MutationObserver` keeps that up to date — `setDefinition`, a favorites
 * repaint or a theme rebuild all replace the cells, and their labels with them. */
function attachAppTips(root: HTMLElement): () => void {
  const stopVelaTips = (event: Event): void => event.stopPropagation();
  const tag = (): void => {
    for (const el of root.querySelectorAll<HTMLElement>("[aria-label]")) {
      if (el.dataset.appTip) continue; // the MAWS extras carry their own label
      const label = el.getAttribute("aria-label")?.trim();
      if (label) el.dataset.appTip = label;
    }
  };
  root.addEventListener("pointerenter", stopVelaTips, true);
  tag();
  const observer = new MutationObserver(tag);
  observer.observe(root, { childList: true, subtree: true });
  return () => {
    root.removeEventListener("pointerenter", stopVelaTips, true);
    observer.disconnect();
  };
}

/** Keys that stay in the row at every width: the app's own controls and modes,
 *  plus the aggregator the overflow drains into. Everything else — the quick
 *  tools, the promoted tools and the catalog representatives — is expendable. */
const PINNED_BAR_KEYS: ReadonlySet<string> = new Set([
  "app:undo",
  "app:redo",
  "app:more",
  "mode:cursor",
  "mode:measure",
  "mode:magnet",
  "position",
]);
/** The bar root's own column gap (`orientHorizontal` sets 2px), and the slack
 *  that keeps a kept cell from sitting flush against the row's edge. */
const BAR_GAP_PX = 2;
const FIT_SLACK_PX = 4;

/**
 * Collapse the row into the "More tools" flyout when the top bar's slot for it
 * shrinks (narrow window, big trade block, maximised pane).
 *
 * The row is fixed-width chrome in a wrapping header, so before this it kept a
 * hard 600px floor and pushed whole blocks onto extra header lines. Now the
 * slot may shrink, and this effect trims the row to what fits: pinned controls
 * stay, and reading left → right the last cells that no longer fit are hidden —
 * their tools are already listed in the "more" flyout (its sections are built
 * from the full catalog), so nothing becomes unreachable. The more button gains
 * a marker dot and says how many tools it is holding.
 *
 * Measured and applied inside one frame: the row is un-hidden, every cell is
 * read, and the losers are hidden again before the browser paints, so a resize
 * never flickers. `ResizeObserver` covers the slot; the `MutationObserver`
 * covers rebuilds (theme, favorites, drag-reorder) that replace the cells.
 */
function fitBarToSlot(root: HTMLElement): () => void {
  const host = root.parentElement; // .vela-dtb-host
  const slot = host?.parentElement; // the top bar's flex slot
  if (!host || !slot) return () => {};
  let frame = 0;

  const apply = (): void => {
    frame = 0;
    const cells = [...root.children].filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.dataset.dragKey !== undefined,
    );
    if (cells.length === 0) return;
    for (const el of cells) el.removeAttribute("data-fit-hidden");
    const measured = cells.map((el) => ({
      el,
      width: el.offsetWidth,
      pinned: PINNED_BAR_KEYS.has(el.dataset.dragKey!),
    }));
    // The pinned controls sit at the END of the row (the magnet/tool modes and
    // "more"), so their width is reserved before the expendable cells are
    // handed what is left — otherwise the row overflows by exactly their size.
    const pinnedWidth = measured
      .filter((cell) => cell.pinned)
      .reduce((sum, cell) => sum + cell.width + BAR_GAP_PX, 0);
    const roomForTools = slot.clientWidth - FIT_SLACK_PX - pinnedWidth;

    const keep = new Set<HTMLElement>();
    let used = 0;
    for (const cell of measured) {
      if (cell.pinned) {
        keep.add(cell.el);
        continue;
      }
      const next = used + cell.width + BAR_GAP_PX;
      if (next > roomForTools) continue;
      used = next;
      keep.add(cell.el);
    }

    // Hide through an attribute, not inline `display`: the stylesheet above
    // forces `display:inline-flex !important` on every cell/button, which would
    // beat an inline declaration.
    let hidden = 0;
    for (const el of cells) {
      const hide = !keep.has(el);
      if (hide) hidden++;
      if (el.hasAttribute("data-fit-hidden") !== hide) {
        if (hide) el.setAttribute("data-fit-hidden", "1");
        else el.removeAttribute("data-fit-hidden");
      }
    }

    const more = root.querySelector<HTMLElement>('[data-drag-key="app:more"]');
    if (more) {
      const label = hidden > 0 ? `More tools — ${hidden} hidden` : "More tools";
      if (more.dataset.appTip !== label) {
        more.dataset.appTip = label;
        more.setAttribute("aria-label", label);
      }
      more.dataset.overflow = hidden > 0 ? "1" : "";
    }
  };

  let timer = 0;
  const run = (): void => {
    if (frame) cancelAnimationFrame(frame);
    if (timer) window.clearTimeout(timer);
    frame = 0;
    timer = 0;
    apply();
  };
  const schedule = (): void => {
    if (frame || timer) return;
    frame = requestAnimationFrame(run);
    // A hidden tab never delivers rAF (the bar mounts in a background tab, or
    // the window is minimised): measure from a task as well, so the row is
    // already trimmed the first time it is shown.
    timer = window.setTimeout(run, 120);
  };
  const ro = new ResizeObserver(schedule);
  ro.observe(slot);
  const mo = new MutationObserver(schedule);
  mo.observe(root, { childList: true });
  schedule();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    if (timer) window.clearTimeout(timer);
    ro.disconnect();
    mo.disconnect();
  };
}

/** Tag the bar's own (visible) buttons with their drag keys and return them:
 *  group cells speak their bare group id — the same ids the earlier tool-cells-only
 *  saved files used — and the mode buttons (cursor/measure/magnet) get `mode:*`.
 *  Hidden chrome (eraser/stay/collapse) is skipped by visibility, not by name.
 *  The MAWS extras carry their `app:*` keys from creation. */
function tagBarChildren(root: HTMLElement, def: ToolbarDefinition): void {
  const groupCells = [...root.children].filter(
    (el): el is HTMLElement =>
      el instanceof HTMLElement &&
      el.classList.contains("vela-dtb-cell") &&
      !el.querySelector('[aria-label="Magnet snap"]'),
  );
  const gid = new Map(groupCells.map((cell, i) => [cell, def.groups[i]?.id] as const));
  const modeKey = (el: Element): string | null => {
    const label =
      el.getAttribute("aria-label") ??
      el.querySelector("[aria-label]")?.getAttribute("aria-label");
    if (label === "Cursor") return "mode:cursor";
    if (label === "Measure") return "mode:measure";
    if (label === "Magnet snap") return "mode:magnet";
    return null;
  };
  for (const el of [...root.children]) {
    if (!(el instanceof HTMLElement) || el.dataset.dragKey) continue;
    if (el.getClientRects().length === 0) continue; // hidden chrome — not draggable
    const key = gid.get(el) ?? modeKey(el);
    if (!key) continue;
    el.dataset.dragKey = key;
    el.dataset.own = "vela";
  }
}

/** Re-apply the saved order by MOVING the already-tagged buttons (no rebuild): the
 *  saved keys refill the slots those buttons occupy by default, so keys the file
 *  predates — or brand-new tools — keep their built-in positions. */
function realizeSavedOrder(root: HTMLElement): void {
  const saved = loadBarOrder();
  if (saved.length === 0) return;
  const marked = [...root.children].filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.dataset.dragKey !== undefined,
  );
  const byKey = new Map(marked.map((el) => [el.dataset.dragKey!, el]));
  const seen = new Set<string>();
  const present: string[] = [];
  for (const key of saved) {
    if (seen.has(key) || !byKey.has(key)) continue;
    seen.add(key);
    present.push(key);
  }
  if (present.length === 0) return;
  const slots: number[] = [];
  marked.forEach((el, i) => {
    if (seen.has(el.dataset.dragKey!)) slots.push(i);
  });
  const desired = [...marked];
  present.forEach((key, i) => {
    const el = byKey.get(key);
    if (el) desired[slots[i]!] = el;
  });
  // Already in place (e.g. a saved file equal to the default) — touch nothing.
  if (desired.every((el, i) => el === marked[i])) return;
  for (const el of desired) root.appendChild(el);
}

/** Drag-to-reorder for EVERY button in the row (HTML5 DnD): the live DOM is the
 *  source of truth during the drag; on release the new key order is persisted and
 *  mirrored onto the toolbar definition (so a rebuild keeps it). Everything is a
 *  direct child of the bar root, so reordering is plain sibling shuffling. */
function enableReorder(root: HTMLElement, def: ToolbarDefinition): () => void {
  tagBarChildren(root, def);
  const marked = [...root.children].filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.dataset.dragKey !== undefined,
  );
  if (marked.length === 0) return () => {};
  for (const el of marked) el.draggable = true;
  realizeSavedOrder(root);

  let dragged: HTMLElement | null = null;
  const markedFrom = (e: DragEvent): HTMLElement | null =>
    e.target instanceof Element ? e.target.closest<HTMLElement>("[data-drag-key]") : null;

  const onStart = (e: DragEvent): void => {
    const el = markedFrom(e);
    if (!el?.dataset.dragKey) return;
    dragged = el;
    el.classList.add("vela-dtb-dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", el.dataset.dragKey);
    }
  };

  const onOver = (e: DragEvent): void => {
    const target = markedFrom(e);
    if (!dragged || !target) return;
    e.preventDefault(); // mark droppable
    if (target === dragged) return;
    const r = target.getBoundingClientRect();
    if (e.clientX <= r.left + r.width / 2) {
      if (target.previousSibling !== dragged) root.insertBefore(dragged, target);
    } else if (target.nextSibling !== dragged) {
      root.insertBefore(dragged, target.nextSibling);
    }
  };

  const onDrop = (e: DragEvent): void => {
    e.preventDefault(); // accept the drop anywhere droppable; commit on dragend
  };

  const onEnd = (): void => {
    const el = dragged;
    dragged = null;
    if (!el) return;
    el.classList.remove("vela-dtb-dragging");
    const order = [...root.children]
      .filter(
        (c): c is HTMLElement => c instanceof HTMLElement && c.dataset.dragKey !== undefined,
      )
      .map((c) => c.dataset.dragKey!);
    try {
      localStorage.setItem(BAR_ORDER_KEY, JSON.stringify(order));
    } catch {
      /* storage unavailable — the session order still applies */
    }
    // A rebuild regenerates the cells from the definition — mirror the order onto it.
    const pos = new Map(order.map((id, i) => [id, i] as const));
    const last = Number.MAX_SAFE_INTEGER;
    def.groups.sort((a, b) => (pos.get(a.id) ?? last) - (pos.get(b.id) ?? last));
  };

  root.addEventListener("dragstart", onStart);
  root.addEventListener("dragover", onOver);
  root.addEventListener("drop", onDrop);
  root.addEventListener("dragend", onEnd);

  return () => {
    root.removeEventListener("dragstart", onStart);
    root.removeEventListener("dragover", onOver);
    root.removeEventListener("drop", onDrop);
    root.removeEventListener("dragend", onEnd);
  };
}

/** Flip Vela's vertical (left-dock) toolbar CSS into a horizontal top-bar bar.
 *  Everything Vela's own stylesheet sizes per-cell stays intact; only the row
 *  direction, surface chrome and the flyout anchoring change. NO scrolling:
 *  every group cell and mode button must fit the row at once. */
function orientHorizontal(root: HTMLElement, host: HTMLElement): () => void {
  root.style.flexDirection = "row";
  root.style.alignItems = "center";
  root.style.width = "auto";
  root.style.height = "40px";
  root.style.padding = "0 1px";
  root.style.overflowX = "visible";
  root.style.overflowY = "visible";
  root.style.background = "transparent";
  root.style.borderRight = "none";
  root.style.borderTop = "none";
  root.style.gap = "2px";
  root.style.flexWrap = "nowrap";
  // Normalise all `1em` SVGs (Vela's own icons) to exactly 16 px — the same
  // explicit px we use for the MAWS extra button SVGs.
  root.style.fontSize = "16px";

  const cssId = "maws-vela-dtb-topbar-css";
  if (!document.getElementById(cssId)) {
    const st = document.createElement("style");
    st.id = cssId;
    st.textContent = `
.vela-dtb-host{position:relative;flex:none;}
.vela-dtb-host .vela-dtb{overflow:visible !important;align-items:center !important;}
/* Every button/cell: uniform 28 px tall, centred content, no extra padding.
   26 px wide so the pinned controls (undo, redo, cursor, measure, magnet,
   position, more) still fit the top bar's narrowest slot. */
.vela-dtb-host .vela-dtb-btn,
.vela-dtb-host .vela-dtb-cell{
  width:auto !important;
  height:28px !important;
  min-width:26px !important;
  padding:0 !important;
  display:inline-flex !important;
  align-items:center !important;
  justify-content:center !important;
}
/* The icon slot: fixed 16×16 so every glyph sits in the same box. */
.vela-dtb-host .vela-dtb-icon{
  width:16px !important;
  height:16px !important;
  display:flex !important;
  align-items:center !important;
  justify-content:center !important;
  flex-shrink:0 !important;
}
/* The chevron arrow on the "more" group button: nudge snug against the icon. */
.vela-dtb-host .vela-dtb-arrow{right:-2px !important;}
/* Hide ALL Vela-injected divider elements (width:24px;height:1px) inside the bar.
   In the horizontal layout these render as a vertical stripe crossing the row. */
.vela-dtb-host .vela-dtb>div[style*="height:1px"],
.vela-dtb-host .vela-dtb>div[style*="height: 1px"],
.vela-dtb-host .vela-dtb>div[style*="width:24px"],
.vela-dtb-host .vela-dtb>div[style*="width: 24px"]{display:none !important;}
/* Collapse toggle is meaningless in the top bar row — hide it. */
.vela-dtb-host .vela-dtb-collapse{display:none !important;}
/* Eraser + stay-in-drawing-mode were dropped from the MAWS top bar by request. */
.vela-dtb-host .vela-dtb-btn[aria-label="Eraser (click/drag to delete)"]{display:none !important;}
.vela-dtb-host .vela-dtb-btn[aria-label="Stay in drawing mode"]{display:none !important;}
/* Tool-cell ink. */
.vela-dtb-host .vela-dtb{color:var(--app-muted) !important;}
.vela-dtb-host .vela-dtb-btn:hover,.vela-dtb-host .vela-dtb-icon:hover,.vela-dtb-host .vela-dtb-arrow:hover{color:#fff !important;}
.vela-dtb-host .vela-dtb-btn[data-active='1'],.vela-dtb-host .vela-dtb-cell[data-active='1'] .vela-dtb-icon{color:#fff !important;}
.vela-dtb-host .vela-dtb-btn:hover .vela-dtb-hit,
.vela-dtb-host .vela-dtb-icon:hover .vela-dtb-hit,
.vela-dtb-host .vela-dtb-arrow:hover .vela-dtb-hit,
.vela-dtb-host .vela-dtb-btn[data-active='1'] .vela-dtb-hit,
.vela-dtb-host .vela-dtb-cell[data-active='1'] .vela-dtb-icon .vela-dtb-hit{background:transparent !important;}
/* MAWS extra buttons. */
.vela-dtb-host .toolbar-btn[data-on='1']{background:transparent !important;color:#fff !important;}
/* Row cells that did not fit (fitBarToSlot) — !important because the cell rules
   above force display:inline-flex. */
.vela-dtb-host .vela-dtb [data-fit-hidden]{display:none !important;}
/* "More tools" holding row cells that did not fit: a corner marker, so a row
   that collapsed is visible without hovering. */
.vela-dtb-host .toolbar-btn[data-overflow='1']{position:relative !important;}
.vela-dtb-host .toolbar-btn[data-overflow='1']::after{
  content:'';position:absolute;right:4px;bottom:4px;width:3px;height:3px;
  border-radius:50%;background:var(--app-accent);
}
/* One-shot buttons flash pure white while pressed. */
.vela-dtb-host .toolbar-btn:active{color:#fff !important;}

/* White / Light theme: keep drawing tool hover/active overlay working with dark ink */
html[data-theme="light"] .vela-dtb-host .vela-dtb-btn:hover,
html[data-theme="light"] .vela-dtb-host .vela-dtb-icon:hover,
html[data-theme="light"] .vela-dtb-host .vela-dtb-arrow:hover{color:var(--app-text) !important;}
html[data-theme="light"] .vela-dtb-host .vela-dtb-btn:hover .vela-dtb-hit,
html[data-theme="light"] .vela-dtb-host .vela-dtb-icon:hover .vela-dtb-hit,
html[data-theme="light"] .vela-dtb-host .vela-dtb-arrow:hover .vela-dtb-hit{background:var(--app-hover) !important;}
html[data-theme="light"] .vela-dtb-host .vela-dtb-btn[data-active='1'],
html[data-theme="light"] .vela-dtb-host .vela-dtb-cell[data-active='1'] .vela-dtb-icon{color:var(--app-text) !important;}
html[data-theme="light"] .vela-dtb-host .vela-dtb-btn[data-active='1'] .vela-dtb-hit,
html[data-theme="light"] .vela-dtb-host .vela-dtb-cell[data-active='1'] .vela-dtb-icon .vela-dtb-hit{background:var(--app-hover) !important;}
html[data-theme="light"] .vela-dtb-host .toolbar-btn[data-on='1']{background:var(--app-hover) !important;color:var(--app-text) !important;}
/* Vela Classic theme: same overlay effect as White */
html[data-theme="classic"] .vela-dtb-host .vela-dtb-btn:hover,
html[data-theme="classic"] .vela-dtb-host .vela-dtb-icon:hover,
html[data-theme="classic"] .vela-dtb-host .vela-dtb-arrow:hover{color:var(--app-text) !important;}
html[data-theme="classic"] .vela-dtb-host .vela-dtb-btn:hover .vela-dtb-hit,
html[data-theme="classic"] .vela-dtb-host .vela-dtb-icon:hover .vela-dtb-hit,
html[data-theme="classic"] .vela-dtb-host .vela-dtb-arrow:hover .vela-dtb-hit{background:var(--app-hover) !important;}
html[data-theme="classic"] .vela-dtb-host .vela-dtb-btn[data-active='1'],
html[data-theme="classic"] .vela-dtb-host .vela-dtb-cell[data-active='1'] .vela-dtb-icon{color:var(--app-text) !important;}
html[data-theme="classic"] .vela-dtb-host .vela-dtb-btn[data-active='1'] .vela-dtb-hit,
html[data-theme="classic"] .vela-dtb-host .vela-dtb-cell[data-active='1'] .vela-dtb-icon .vela-dtb-hit{background:var(--app-hover) !important;}
html[data-theme="classic"] .vela-dtb-host .toolbar-btn[data-on='1']{background:var(--app-hover) !important;color:var(--app-text) !important;}
.vela-dtb-host .toolbar-btn{
  height:28px !important;
  min-width:26px !important;
  display:inline-flex !important;
  align-items:center !important;
  justify-content:center !important;
}
/* Drag-to-reorder. */
.vela-dtb-host [data-drag-key]{cursor:pointer;user-select:none;-webkit-user-select:none;}
.vela-dtb-host [data-drag-key]:active{cursor:grabbing;}
.vela-dtb-host [data-drag-key].vela-dtb-dragging{opacity:.4;}
/* Flyout: Vela positions it via inline styles for the vertical case (opens right).
   We reposition it downward via the MutationObserver below — the class just
   sets the shape. */
.vela-dtb-host .vela-dtb-flyout{
  border-radius:8px !important;
  border:1px solid var(--vela-border) !important;
  max-height:min(70vh,480px) !important;
  min-width:180px !important;
}
`;
    document.head.appendChild(st);
  }

  // Vela computes flyout position via getBoundingClientRect at open time and
  // writes inline left/top. We intercept every new child added to the host that
  // has class `vela-dtb-flyout` and snap it below the bar row instead.
  const snapFlyoutDown = (fly: HTMLElement): void => {
    // Position below the bar root, left-aligned to the cell that opened it.
    const rootR = root.getBoundingClientRect();
    const hostR = host.getBoundingClientRect();
    // Align left edge to wherever Vela's `left` points (it reflects the cell's left).
    // We only override top so horizontal scrolling still aligns to the opening cell.
    fly.style.top = `${rootR.bottom - hostR.top + 4}px`;
    fly.style.borderRadius = "8px";
    fly.style.borderLeft = `1px solid var(--vela-border)`;
    // Remove the square-left-corner seam Vela uses for the docked vertical flyout.
    fly.style.left = fly.style.left; // keep Vela's horizontal alignment
  };

  const mo = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node instanceof HTMLElement && node.classList.contains("vela-dtb-flyout")) {
          // Let Vela finish its own positioning synchronously, then override.
          requestAnimationFrame(() => snapFlyoutDown(node));
        }
      }
    }
  });
  mo.observe(host, { childList: true });

  return () => mo.disconnect();
}

export function VelaDrawingBar() {
  const activePaneId = useAppStore((s) => s.activePaneId);
  const hostRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<VelaDrawingToolbar | null>(null);
  const favoriteUiRef = useRef<FavoriteUi | null>(null);
  const moreUiRef = useRef<MoreButtonUi | null>(null);
  const defaultFavoriteToolsRef = useRef<DrawingTypeKey[]>([]);
  const knownDrawingToolsRef = useRef<ReadonlySet<string>>(new Set());

  // State echo: keep the bar's tints in step with the chart. Vela's renderer
  // shortcuts (Escape, one-shot disarms) and the old per-chart rail changed tool
  // / snap / stay / mode WITHOUT a top-bar click — the bar only repaints through
  // its setters, so mirror the active pane's `drawing:*` events into it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let tries = 0;
    let timer = 0;
    let offs: Array<() => void> = [];
    const attach = () => {
      if (cancelled) return;
      const bar = barRef.current;
      const chart = getChart(activePaneId)?.vela;
      if (!bar || !chart) {
        if (tries++ < 120) timer = window.setTimeout(attach, 250);
        return;
      }
      offs = [
        chart.on("drawing:tool", ({ type }) => {
          bar.setActiveTool(type);
          favoriteUiRef.current?.setActiveTool(type);
        }),
        chart.on("drawing:favorites", ({ favorites }) => {
          const knownFavorites = favorites.filter(
            (type): type is DrawingTypeKey => knownDrawingToolsRef.current.has(type),
          );
          try {
            localStorage.setItem(FAVORITES_KEY, JSON.stringify(knownFavorites));
          } catch (error) {
            console.error("[maws] Could not save drawing-tool favorite preferences.", error);
          }
          bar.setFavorites(knownFavorites);
          favoriteUiRef.current?.setFavorites(knownFavorites);
          moreUiRef.current?.setFavorites(knownFavorites);
        }),
        chart.on("drawing:snap", ({ mode }) => bar.setMagnetMode(mode)),
        chart.on("drawing:stay", ({ on }) => bar.setStayMode(on)),
        chart.on("drawing:mode", ({ mode }) => {
          bar.setMeasureActive(mode === "measure");
          bar.setEraserActive(mode === "eraser");
        }),
        // Magnifier reworked as a pure zoom: when the user finishes dragging the
        // rectangle, zoom the chart to that time range and immediately discard the
        // drawing — no inset, no lower-timeframe fetch, just a viewport snap.
        chart.on("drawing:created", ({ id }) => {
          const drawn = chart.drawings.all().find((d) => d.id === id);
          if (!drawn || drawn.type !== "magnifier") return;
          const anchors = drawn.anchors;
          if (anchors.length < 2) return;
          const from = Math.min(anchors[0]!.time, anchors[1]!.time);
          const to   = Math.max(anchors[0]!.time, anchors[1]!.time);
          if (from >= to) return;
          // Disarm the tool first so the next click doesn't start another drag.
          chart.drawings.setTool(null);
          // Remove the drawing — we only needed its geometry.
          chart.drawings.remove(id);
          // Re-enable autoscale so the price axis fits the zoomed window,
          // then snap the time axis to the selected range.
          chart.renderer.set("autoScale", true);
          chart.setVisibleRange({ from, to });
        }),
      ];
      // Seed from the chart's CURRENT state (the events above only fire on change).
      try {
        const d = chart.drawings;
        const favorites = initializeFavorites(
          chart,
          defaultFavoriteToolsRef.current,
          knownDrawingToolsRef.current,
        );
        bar.setFavorites(favorites);
        favoriteUiRef.current?.setFavorites(favorites);
        moreUiRef.current?.setFavorites(favorites);
        bar.setActiveTool(d.getTool());
        favoriteUiRef.current?.setActiveTool(d.getTool());
        bar.setMagnetMode(d.getSnapMode());
        bar.setStayMode(d.getStayMode());
        const mode = d.getMode();
        bar.setMeasureActive(mode === "measure");
        bar.setEraserActive(mode === "eraser");
      } catch {
        /* chart not fully ready yet */
      }
    };
    attach();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      for (const off of offs) off();
    };
  }, [activePaneId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Follow the app theme (Vela's dialog theme row drives the whole app — the
    // shell chrome colors are the source of truth, so re-resolve from them).
    const theme: VelaTheme = resolveTheme(
      velaThemeNameFromAppSettings(useAppStore.getState().appSettings),
    );
    // Horizontal top bar — `dock: 'static'` keeps it a normal flex child, sizing
    // to content; plain DOM, no chart remount, no settings.
    const bar = new VelaDrawingToolbar(
      host,
      theme,
      (type) => {
        activeChart()?.drawings.setTool(type);
      },
      (mode) => {
        activeChart()?.drawings.setSnapMode(mode);
      },
      () => {
        const d = activeChart()?.drawings;
        if (d) d.setMode(d.getMode() === "measure" ? null : "measure");
      },
      () => {
        const d = activeChart()?.drawings;
        if (d) d.setMode(d.getMode() === "eraser" ? null : "eraser");
      },
      (type, on) => {
        activeChart()?.drawings.setFavorite(type, on);
      },
      (on) => {
        activeChart()?.drawings.setStayMode(on);
      },
      { dock: "static" },
    );
    bar.setVisible(true);
    barRef.current = bar;
    // The bar is created BEFORE any `setDefinition` — push the MAWS quick-row layout now.
    const { definition: def, moreSections } = mawsTopBarToolbar();
    bar.setDefinition?.(def);
    const directTools = def.groups.flatMap((group) => group.tools);
    const directTypes = new Set(directTools.map((tool) => tool.type));
    const allMenuTools = moreSections.flatMap((section) => section.tools);
    defaultFavoriteToolsRef.current = [...directTypes];
    knownDrawingToolsRef.current = new Set(allMenuTools.map((tool) => tool.type));
    const root = (bar as unknown as { root?: HTMLElement }).root;
    let favoriteUi: FavoriteUi | undefined;
    let moreUi: MoreButtonUi | undefined;
    let disposeReorder: (() => void) | undefined;
    let disposeOrient: (() => void) | undefined;
    let disposeTips: (() => void) | undefined;
    let disposeFit: (() => void) | undefined;
    if (root) {
      disposeOrient = orientHorizontal(root, host);
      mountAppButtons(root);
      disposeTips = attachAppTips(root);
      favoriteUi = mountFavoriteButtons(root, allMenuTools, directTypes);
      moreUi = mountMoreButton(root, host, moreSections);
      favoriteUiRef.current = favoriteUi;
      moreUiRef.current = moreUi;
      const favorites = activeChart()?.drawings.favorites() ?? [];
      bar.setFavorites(favorites);
      favoriteUi.setFavorites(favorites);
      moreUi.setFavorites(favorites);
      disposeReorder = enableReorder(root, def);
      disposeFit = fitBarToSlot(root);
    }
    return () => {
      disposeFit?.();
      disposeReorder?.();
      favoriteUi?.destroy();
      moreUi?.destroy();
      favoriteUiRef.current = null;
      moreUiRef.current = null;
      disposeTips?.();
      disposeOrient?.();
      barRef.current = null;
      try {
        bar.destroy();
      } catch {
        /* already torn down */
      }
      if (host) host.replaceChildren();
    };
  }, []);

  return (
    // The bar may be narrower than its content: `fitBarToSlot` hides the cells
    // that do not fit (their tools stay in the "more" flyout).
    <div className="relative z-[2] flex min-w-0 flex-1 items-center">
      <div ref={hostRef} className="vela-dtb-host flex" data-vela-drawing-bar />
    </div>
  );
}
