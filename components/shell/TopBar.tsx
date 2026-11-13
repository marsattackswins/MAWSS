"use client";

import { ToolbarBtn } from "@/components/ui/ToolbarBtn";
import { getChart, getWorkspace } from "@/lib/chart-registry";
import type { ThemeName } from "@/lib/charting";
import { CHART_STYLES } from "@/lib/chart-style";
import { VelaDrawingBar } from "@/components/drawings/VelaDrawingBar";
import { MawsProductMenu } from "@/components/shell/MawsProductMenu";
import { formatPrice, mawsFeed } from "@/lib/maws/feed";
import { formatTicker } from "@/lib/maws/universe";
import { useActivePane, useAppStore } from "@/lib/store";
import { useLiveStore } from "@/lib/live/store";
import { liveApi, LiveApiError, LiveAuthError, setCsrf } from "@/lib/live/api";
import { ProfileAuthDialog } from "@/components/trading/ProfileAuthDialog";
import { profileErrorMessage, profileLabel, switchLiveProfile } from "@/lib/live/bridge";
import type { LiveProfileId } from "@/lib/live/types";
import { TIMEFRAMES } from "@/lib/timeframes";
import { newClientOrderId, submitOrderFromUi } from "@/lib/trading/ui-orders";
import {
  formatMarginLabel,
  bumpTopbarMargin,
  quantizeQtyToStep,
  qtyStepFor,
  resolveOrderQty,
  resolveSymbolTrading,
  topbarSeedMargin,
} from "@/lib/trading/symbol-settings";
import { useQuote } from "@/lib/use-quotes";
import {
  applyVelaThemeEverywhere,
  velaThemeNameFromAppSettings,
} from "@/lib/app-theme";
import { applyThemeToCharts } from "@/lib/vela-chart-settings";
import type { Timeframe } from "@/types";
import { VelaTemplateMenu } from "@/components/shell/VelaTemplateMenu";
import { VelaLayoutButton } from "@/components/shell/VelaLayoutButton";
import { FeedStatusIndicator } from "@/components/shell/FeedStatusIndicator";
import {
  Camera,
  ChevronDown,
  ChevronsLeft,
  Diamond,
  Maximize,
  Moon,
  Rewind,
  Settings,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

const BAR_TFS: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "4h", "1D", "1W", "1M"];
const MORE_TFS: Timeframe[] = ["3m", "2h"];
const TOPBAR_ICON_ORDER_KEY = "maws.topbarIconOrder.v2";
const TOPBAR_ICON_IDS = [
  "screenshot",
  "fullscreen",
  "theme",
  "tradestate",
  "journal",
  "template",
] as const;
type TopbarIconId = (typeof TOPBAR_ICON_IDS)[number];

function isTopbarIconId(value: unknown): value is TopbarIconId {
  return typeof value === "string" && TOPBAR_ICON_IDS.some((id) => id === value);
}

function loadTopbarIconOrder(): TopbarIconId[] {
  try {
    const raw = localStorage.getItem(TOPBAR_ICON_ORDER_KEY);
    const saved: unknown = raw ? JSON.parse(raw) : null;
    const order = Array.isArray(saved) ? saved.filter(isTopbarIconId) : [];
    const merged = [
      ...new Set(order),
      ...TOPBAR_ICON_IDS.filter((id) => !order.includes(id)),
    ];
    if (!order.includes("fullscreen")) {
      merged.splice(merged.indexOf("fullscreen"), 1);
      merged.splice(merged.indexOf("screenshot") + 1, 0, "fullscreen");
    }
    return merged;
  } catch {
    return [...TOPBAR_ICON_IDS];
  }
}


function BinanceIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="#f0b90b" className="shrink-0" aria-hidden="true">
      <path d="M7.0679 12L5.03779 14.0301L3.00256 12L5.03268 9.96989L7.0679 12ZM12.0026 7.06534L15.485 10.5477L17.5151 8.51761L12.0026 3L6.48495 8.51761L8.51506 10.5477L12.0026 7.06534ZM18.9673 9.96989L16.9372 12L18.9673 14.0301L20.9975 12L18.9673 9.96989ZM12.0026 16.9347L8.52018 13.4523L6.49006 15.4824L12.0026 21L17.5151 15.4824L15.485 13.4523L12.0026 16.9347ZM12.0026 14.0301L14.0327 12L12.0026 9.96989L9.96734 12L12.0026 14.0301Z" />
    </svg>
  );
}

function CandleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M5 3v10M11 2v12" stroke="currentColor" strokeWidth="1.2" />
      <rect x="3.2" y="5" width="3.6" height="6" fill="currentColor" />
      <rect x="9.2" y="4" width="3.6" height="7" fill="currentColor" />
    </svg>
  );
}

function ChartStyleIcon({
  id,
  className = "",
}: {
  id: (typeof CHART_STYLES)[number]["id"];
  className?: string;
}) {
  const common = `shrink-0 ${className}`;
  switch (id) {
    case "solid":
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" className={common} fill="none">
          <path d="M5 2.5v13M13 1.5v15" stroke="currentColor" strokeWidth="1.2" />
          <rect x="3.2" y="5" width="3.6" height="7" fill="currentColor" />
          <rect x="11.2" y="4" width="3.6" height="8" fill="currentColor" />
        </svg>
      );
    case "hollow":
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" className={common} fill="none">
          <path d="M5 2.5v13M13 1.5v15" stroke="currentColor" strokeWidth="1.2" />
          <rect x="3.2" y="5" width="3.6" height="7" stroke="currentColor" strokeWidth="1.3" />
          <rect x="11.2" y="4" width="3.6" height="8" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      );
    case "heikinashi":
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" className={common} fill="none">
          <path d="M4.5 3v12M9 2v14M13.5 4v10" stroke="currentColor" strokeWidth="1.1" />
          <rect x="2.8" y="6" width="3.4" height="5.5" fill="currentColor" />
          <rect x="7.3" y="5" width="3.4" height="7" fill="currentColor" opacity="0.55" />
          <rect x="11.8" y="7" width="3.4" height="4.5" fill="currentColor" />
        </svg>
      );
    case "bars":
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" className={common} fill="none">
          <path
            d="M4 3.5v11M2.5 7H4M4 12h1.5M9 2.5v13M7.5 6H9M9 11h1.5M14 3v12M12.5 8H14M14 11.5h1.5"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="square"
          />
        </svg>
      );
    case "line":
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" className={common} fill="none">
          <path
            d="M2 12.5 6 7.5 9.5 10.5 16 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      );
    case "area":
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" className={common} fill="none">
          <path
            d="M2 13.5 6 8 9.5 11 16 4.5V15H2v-1.5Z"
            fill="currentColor"
            opacity="0.28"
          />
          <path
            d="M2 13.5 6 8 9.5 11 16 4.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      );
    case "baseline":
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" className={common} fill="none">
          <path d="M2 9.5h14" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2" opacity="0.7" />
          <path
            d="M2 12 5.5 7.5 9 10.5 16 5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <path d="M2 12 5.5 7.5 9 10.5 16 5V15H2v-3Z" fill="currentColor" opacity="0.22" />
        </svg>
      );
    default:
      return <CandleIcon />;
  }
}

function IndicatorsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path d="M2 12h3V5H2v7zm4.5 0h3V3h-3v9zM11 12h3V6h-3v6z" fill="currentColor" />
    </svg>
  );
}

/** Stepped topbar sizing: min 10 USDT margin, 10 USDT steps; qty is derived
 *  from margin × leverage at the order price. */
function marginToQty(symbol: string, margin: number, price: number): number {
  if (!(price > 0)) return 0;
  const t = resolveSymbolTrading(symbol);
  const lev = Math.max(1, t.leverage);
  return quantizeQtyToStep((margin * lev) / price, qtyStepFor(symbol));
}

/** Isolated so quote ticks don't re-render the whole top bar. */
function BuySellStrip({
  symbol,
  onSell,
  onBuy,
  onContextMenu,
}: {
  symbol: string;
  onSell: (price: number, qty: number) => void;
  onBuy: (price: number, qty: number) => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const quote = useQuote(symbol);
  const connectedBroker = useAppStore((s) => s.connectedBroker);
  const setBrokerDialogOpen = useAppStore((s) => s.setBrokerDialogOpen);
  const livePhase = useLiveStore((s) => s.phase);
  const liveProfileId = useLiveStore((s) => s.profileId);
  const liveReady = useLiveStore((s) => s.ready);
  const searchOpen = useAppStore((s) => s.searchOpen);
  const indicatorMenuOpen = useAppStore((s) => s.indicatorMenuOpen);
  const contextMenu = useAppStore((s) => s.contextMenu);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (searchOpen || indicatorMenuOpen || contextMenu) {
      setDropdownOpen(false);
    }
  }, [searchOpen, indicatorMenuOpen, contextMenu]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (!menuRef.current?.contains(target)) setDropdownOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDropdownOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [dropdownOpen]);

  const [authTarget, setAuthTarget] = useState<LiveProfileId | null>(null);
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [productionConfirmation, setProductionConfirmation] = useState(false);
  const [productionChecked, setProductionChecked] = useState(false);

  const startSwitch = async (profileId: LiveProfileId, confirmProduction = false) => {
    try {
      const result = await switchLiveProfile(profileId, confirmProduction);
      if (result === "error") {
        const current = useLiveStore.getState();
        useLiveStore.getState().notify("error", current.managerError ?? profileErrorMessage(current.reasonCode));
      }
    } catch (error: unknown) {
      useLiveStore.getState().notify(
        "error",
        error instanceof LiveApiError ? profileErrorMessage(error.code) : "Server profile status is unavailable."
      );
    }
  };

  const authenticateForProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authTarget || authBusy || authPassword.length === 0) return;
    const target = authTarget;
    setAuthBusy(true);
    setAuthError(null);
    try {
      const session = await liveApi.login(authPassword);
      setCsrf(session.csrf);
      const response = await liveApi.profiles();
      const profile = response.profiles.find((item) => item.profileId === target);
      if (!profile?.configured) {
        setAuthError("That Binance profile is not configured on the server.");
        return;
      }
      setAuthTarget(null);
      setAuthPassword("");
      if (target === "binance-production") {
        setProductionChecked(false);
        setProductionConfirmation(true);
      } else {
        void startSwitch(target);
      }
    } catch (error: unknown) {
      if (error instanceof LiveAuthError) {
        setAuthError("Invalid operator password.");
      } else {
        setAuthError("Operator authentication is unavailable. Try again.");
      }
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSelectProfile = async (profileId: LiveProfileId) => {
    setDropdownOpen(false);
    try {
      const session = await liveApi.session();
      if (session.authenticated) {
        setCsrf(session.csrf ?? null);
        if (profileId === "binance-production") {
          setProductionChecked(false);
          setProductionConfirmation(true);
        } else {
          void startSwitch(profileId);
        }
        return;
      }
    } catch {
      // Fall through to authentication prompt
    }
    setAuthTarget(profileId);
    setAuthPassword("");
    setAuthError(null);
  };
  const timeframe = useAppStore((s) => {
    const pane = s.panes.find((p) => p.id === s.activePaneId);
    return pane?.timeframe ?? "1D";
  });
  const [feedLive, setFeedLive] = useState(
    () => mawsFeed.getKlineStatus(symbol, timeframe) === "live",
  );
  useEffect(() => {
    const id = setInterval(() => {
      setFeedLive(mawsFeed.getKlineStatus(symbol, timeframe) === "live");
    }, 1_000);
    return () => clearInterval(id);
  }, [symbol, timeframe]);

  const bid = quote ? quote.last * 0.9999 : 0;
  const ask = quote ? quote.last * 1.0001 : 0;
  // Topbar sizing is margin-based: min 10 USDT, ±10 steps. Seeded once per
  // symbol from the trading defaults; a hand-set margin is never stomped by
  // quote ticks. Qty is derived at click time from margin × leverage / price.
  const [margin, setMargin] = useState<number | null>(null);
  const [marginSymbol, setMarginSymbol] = useState(symbol);
  const [marginDraft, setMarginDraft] = useState<string | null>(null);
  if (symbol !== marginSymbol) {
    setMarginSymbol(symbol);
    setMargin(null);
    setMarginDraft(null);
  }
  const marginValue = margin ?? topbarSeedMargin(symbol);
  const bumpMargin = (dir: 1 | -1) =>
    setMargin(bumpTopbarMargin(symbol, marginValue, dir));
  const units = marginToQty(symbol, marginValue, bid || ask);
  const profileBlocked = livePhase === "switching" || livePhase === "degraded" || livePhase === "failed" || livePhase === "detached" || (connectedBroker === "binance" && liveProfileId !== null && (!liveReady || livePhase !== "ready"));
  // When not connected to any broker, treat as a halted state so the buttons
  // are visibly disabled and the title explains why.
  const disconnected = connectedBroker !== "binance";
  const disabled = !quote || !feedLive || profileBlocked || disconnected;
  const feedTitle = disconnected ? "Connect a trading profile to trade" : profileBlocked ? "Trading halted: profile switch in progress" : !feedLive ? "Trading halted: market data not live" : undefined;
  return (
    <div
      className="ml-1 flex shrink-0 items-center gap-1"
      onContextMenu={(e) => {
        if (!quote) return;
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e.clientX, e.clientY);
      }}
    >
      {disconnected ? (
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setDropdownOpen((v) => !v)}
            className={`toolbar-btn gap-1 px-2.5 text-[12px] ${dropdownOpen ? "is-active" : ""}`}
            title="Connect a trading profile to trade"
            aria-haspopup="menu"
            aria-expanded={dropdownOpen}
            data-testid="topbar-disconnected"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-[#6b7280]" />
            Disconnected
            <ChevronDown size={11} className="text-(--app-muted)" />
          </button>

          {dropdownOpen && (
            <div
              className="menu right-0 w-[240px]"
              data-dropdown-open
              role="menu"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="menu-section-title">Trading Profiles</div>
              <button
                type="button"
                className="menu-row flex w-full items-center gap-2.5 px-3 py-2 text-left"
                onClick={() => void handleSelectProfile("binance-testnet")}
              >
                <BinanceIcon />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[12px] font-medium text-(--app-text)">Testnet</span>
                  <span className="truncate text-[11px] text-(--app-muted)">USDT-M Futures (Testnet)</span>
                </div>
                <span className="shrink-0 rounded bg-[#22c55e]/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[#22c55e]">
                  Test
                </span>
              </button>

              <button
                type="button"
                className="menu-row flex w-full items-center gap-2.5 px-3 py-2 text-left"
                onClick={() => void handleSelectProfile("binance-production")}
              >
                <BinanceIcon />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[12px] font-medium text-(--app-text)">Live</span>
                  <span className="truncate text-[11px] text-(--app-muted)">USDT-M Futures (Live)</span>
                </div>
                <span className="shrink-0 rounded bg-[#f0b90b]/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[#f0b90b]">
                  Live
                </span>
              </button>

            </div>
          )}
        </div>
      ) : (
        <>
      {/* Connected status dot */}
      <span
        className="flex shrink-0 items-center gap-1 px-1 text-[11px] text-(--app-muted)"
        title={liveProfileId === "binance-production" ? "Connected to Binance Live" : "Connected to Binance Testnet"}
      >
        <span
          className={`size-1.5 shrink-0 rounded-full ${liveProfileId === "binance-production" ? "bg-[#f0b90b]" : "bg-[#22c55e]"}`}
        />
      </span>
      <button
        type="button"
        disabled={disabled}
        title={feedTitle}
        aria-label="Sell at bid"
        className="trade-block trade-block-sell flex h-[32px] shrink-0 items-center gap-1.5 px-2.5 text-[12px] tabular-nums disabled:opacity-40"
        onClick={() => {
          if (!quote) return;
          const qty = marginToQty(symbol, marginValue, bid);
          if (qty > 0) onSell(bid, qty);
        }}
      >
        <span className="size-1.5 shrink-0 rounded-full bg-[#f23645]" />
        <span className="shrink-0 text-[#f23645]">Sell</span>
        <span className="min-w-0 truncate text-(--app-text)">
          {quote ? formatPrice(symbol, bid) : "—"}
        </span>
      </button>
      <div
        className="trade-hover flex h-[32px] shrink-0 items-center gap-0 px-0 rounded-[10px]"
        title={`Margin × leverage → order size (min 10)`}
      >
        <button
          type="button"
          aria-label="Decrease margin"
          disabled={disabled || marginValue <= 10}
          className="flex h-6 w-[14px] items-center justify-center text-[12px] text-(--app-muted) hover:bg-(--app-hover) disabled:opacity-40"
          onClick={() => bumpMargin(-1)}
        >
          −
        </button>
        <input
          aria-label="Order margin"
          className="w-8 border-b border-(--app-border) bg-transparent pb-0.5 text-center text-[12px] font-medium tabular-nums text-(--app-text) outline-none focus:border-(--app-muted)"
          value={marginDraft ?? marginValue}
          onChange={(e) => {
            setMarginDraft(e.target.value);
            const next = Number(e.target.value);
            if (Number.isFinite(next) && next >= 10) {
              setMargin(Math.round(next / 10) * 10 || 10);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setMarginDraft(null);
              (e.target as HTMLInputElement).blur();
            }
          }}
          onBlur={() => setMarginDraft(null)}
        />
        <button
          type="button"
          aria-label="Increase margin"
          disabled={disabled}
          className="flex h-6 w-[14px] items-center justify-center text-[12px] text-(--app-muted) hover:bg-(--app-hover) disabled:opacity-40"
          onClick={() => bumpMargin(1)}
        >
          +
        </button>
      </div>
      <button
        type="button"
        disabled={disabled}
        title={feedTitle}
        aria-label="Buy at ask"
        className="trade-block trade-block-buy flex h-[32px] shrink-0 items-center gap-1.5 px-2.5 text-[12px] tabular-nums disabled:opacity-40"
        onClick={() => {
          if (!quote) return;
          const qty = marginToQty(symbol, marginValue, ask);
          if (qty > 0) onBuy(ask, qty);
        }}
      >
        <span className="min-w-0 truncate text-(--app-text)">
          {quote ? formatPrice(symbol, ask) : "—"}
        </span>
        <span className="shrink-0 text-[#2ebd85]">Buy</span>
        <span className="size-1.5 shrink-0 rounded-full bg-[#2ebd85]" />
      </button>
        </>
      )}
      {authTarget ? (
        <ProfileAuthDialog
          profileId={authTarget}
          password={authPassword}
          error={authError}
          busy={authBusy}
          onPasswordChange={setAuthPassword}
          onCancel={() => {
            setAuthTarget(null);
            setAuthPassword("");
            setAuthError(null);
          }}
          onSubmit={authenticateForProfile}
        />
      ) : null}

      {productionConfirmation ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
          onMouseDown={() => {
            setProductionConfirmation(false);
            setProductionChecked(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="production-confirm-title"
            className="w-[430px] max-w-[calc(100vw-32px)] rounded-[8px] border border-[#f0b90b]/50 bg-[#17130a] p-5 shadow-[0_16px_60px_rgba(0,0,0,0.7)]"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div id="production-confirm-title" className="text-[16px] font-semibold text-[#f0b90b]">
              You are connecting to Binance Live.
            </div>
            <p className="mt-3 text-[13px] leading-5 text-(--app-text)">This uses the server’s production credentials.</p>
            <p className="text-[13px] leading-5 text-(--app-text)">Existing orders and positions will not be cancelled or closed.</p>
            <p className="text-[13px] leading-5 text-(--app-text)">Switching may be blocked if exposure exists.</p>
            <label className="mt-4 flex cursor-pointer items-start gap-2 text-[12px] text-(--app-text)">
              <input
                type="checkbox"
                checked={productionChecked}
                onChange={(event) => setProductionChecked(event.target.checked)}
                className="mt-0.5 accent-[#f0b90b]"
              />
              <span>I understand and want to continue.</span>
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-[4px] px-3 py-2 text-[12px] text-(--app-muted) hover:bg-[#241f13] hover:text-(--app-text)"
                onClick={() => {
                  setProductionConfirmation(false);
                  setProductionChecked(false);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!productionChecked}
                className="rounded-[4px] bg-[#f0b90b] px-3 py-2 text-[12px] font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => {
                  setProductionConfirmation(false);
                  void startSwitch("binance-production", true);
                }}
              >
                Connect Production
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Switch order, and where the crescent points at each stop: the stops walk the
 *  compass clockwise — NE → SE → SW → NW. */
const THEME_CYCLE = ["dark", "classic", "light", "gruvbox"] as const;
const THEME_LABEL: Record<string, string> = {
  dark: "Vela Muted",
  classic: "Vela Classic",
  light: "White",
  gruvbox: "Gruvbox",
};
/**
 * Cumulative quarter-turns already made this session. Module-level on purpose:
 * the angle must only ever increase, so a CSS clockwise sweep survives every
 * hop including Gruvbox → Muted (270° → 360°), and it must not reset when the
 * bar re-mounts (dev fast-refresh, panel churn).
 */
let themeTurns = 0;
/** The theme the last click (or re-anchor) settled on — tells our own switches
 *  apart from a theme chosen elsewhere, which must re-point the crescent. */
let themeTurnedTo = "";

/**
 * A stylized trade-journal icon: a small notebook with a pencil overlay.
 * Replaces the generic BookOpen glyph with a purpose-built mark.
 */
function JournalIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 15 15"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      {/* Notebook body */}
      <rect x="2" y="1.5" width="9" height="12" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
      {/* Spine binding marks */}
      <path d="M2 4.5h-1M2 7.5h-1M2 10.5h-1" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      {/* Three ruled lines */}
      <path d="M4.5 5h4.5M4.5 7.5h4.5M4.5 10h3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      {/* Pencil nib (bottom-right corner) */}
      <path
        d="M9.8 9.8l1.6-1.6.8.8-1.6 1.6-.8-.8z"
        fill="currentColor"
        stroke="none"
      />
      <path d="M9.8 9.8l-.3 1.1 1.1-.3" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

/**
 * The topbar theme switch's icon.
 *
 * ONE crescent marks the four stops: NORTH-EAST for Vela Muted, SOUTH-EAST for
 * Vela Classic, SOUTH-WEST for White, NORTH-WEST for Gruvbox. The host feeds it
 * a *cumulative* angle that grows by 90° per click, so every switch — and the
 * wrap back to Muted — sweeps clockwise; a per-theme angle would rewind the
 * long way on the last hop.
 */
function ThemeIcon({ rotation }: { rotation: number }) {
  return (
    <Moon
      aria-hidden="true"
      size={15}
      style={{
        transform: `rotate(${rotation}deg)`,
        // One quick quarter turn: most of the arc in the first frames, a short settle.
        transition: "transform 190ms cubic-bezier(0.2, 0.9, 0.2, 1)",
      }}
    />
  );
}

export function TopBar() {
  const pane = useActivePane();
  const setTimeframe = useAppStore((s) => s.setTimeframe);
  const indicatorMenuOpen = useAppStore((s) => s.indicatorMenuOpen);
  const setIndicatorMenuOpen = useAppStore((s) => s.setIndicatorMenuOpen);
  const closeMenus = useAppStore((s) => s.closeMenus);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  // The arrow folds the ENTIRE right side — panel body AND the shortcut rail.
  const rightOpen = useAppStore((s) => s.rightOpen);
  const setRightOpen = useAppStore((s) => s.setRightOpen);
  const setBuySellMenu = useAppStore((s) => s.setBuySellMenu);
  const showBuySell = useAppStore((s) => s.chartSettings.showBuySell);
  // The topbar theme switch reads the resolved app theme (string selector — no
  // re-render on unrelated color tweaks).
  const themeName = useAppStore((s) => velaThemeNameFromAppSettings(s.appSettings));
  // Crescent angle in degrees; only ever grows — see `themeTurns`.
  const [themeAngle, setThemeAngle] = useState(0);
  useEffect(() => {
    const step = Math.max(
      0,
      THEME_CYCLE.indexOf(themeName as (typeof THEME_CYCLE)[number]),
    );
    if (themeTurnedTo === themeName) {
      // Our own click: keep the cumulative angle so the sweep stays clockwise.
      setThemeAngle(90 * themeTurns);
      return;
    }
    // Mounted on a persisted theme, or one picked in the chart-settings dialog:
    // re-anchor the crescent to that theme's resting bearing.
    themeTurnedTo = themeName;
    themeTurns = Math.max(themeTurns, step);
    setThemeAngle(90 * themeTurns);
  }, [themeName]);
  const watchlist = useAppStore((s) => s.watchlist);
  const addToWatchlist = useAppStore((s) => s.addToWatchlist);
  const removeFromWatchlist = useAppStore((s) => s.removeFromWatchlist);
  const patchChartSettings = useAppStore((s) => s.patchChartSettings);
  const candleStyle = useAppStore((s) => s.chartSettings.candleStyle);
  const replay = useAppStore((s) => s.replay);
  const replaySeeking = useAppStore((s) => s.replaySeeking);
  const stopReplay = useAppStore((s) => s.stopReplay);
  const setReplaySeeking = useAppStore((s) => s.setReplaySeeking);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const indicatorSettingsId = useAppStore((s) => s.indicatorSettingsId);
  const drawingSettingsTarget = useAppStore((s) => s.drawingSettingsTarget);
  const brokerDialogOpen = useAppStore((s) => s.brokerDialogOpen);
  const setJournalOverlayOpen = useAppStore((s) => s.setJournalOverlayOpen);
  const tfRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const draggedIconRef = useRef<TopbarIconId | null>(null);
  const [iconOrder, setIconOrder] = useState<TopbarIconId[]>(() => [...TOPBAR_ICON_IDS]);
  const [draggingIcon, setDraggingIcon] = useState<TopbarIconId | null>(null);
  const [tfMore, setTfMore] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const starred = watchlist.includes(pane.symbol);
  const tfLabel = TIMEFRAMES.find((t) => t.id === pane.timeframe)?.label ?? pane.timeframe;

  const closeAllMenus = () => {
    setTfMore(false);
    setStyleOpen(false);
    setIndicatorMenuOpen(false);
    closeMenus();
  };

  const toggleTfMore = () => {
    const next = !tfMore;
    closeAllMenus();
    if (settingsOpen) setSettingsOpen(false);
    if (next) setTfMore(true);
  };

  const toggleStyleOpen = () => {
    const next = !styleOpen;
    closeAllMenus();
    if (settingsOpen) setSettingsOpen(false);
    if (next) setStyleOpen(true);
  };

  const toggleIndicatorMenu = () => {
    const next = !indicatorMenuOpen;
    closeAllMenus();
    if (settingsOpen) setSettingsOpen(false);
    if (next) setIndicatorMenuOpen(true);
  };

  /**
   * VELA's symbol search dialog, hosted by the workspace (the shell used to draw its own
   * popover here). It targets the ACTIVE cell, which the shell keeps aligned with the
   * store, and its rows are the futures-only provider index — same dialog a bare
   * keystroke over the grid opens, so there is one search UI to learn and maintain.
   */
  const openSymbolSearch = () => {
    closeAllMenus();
    if (settingsOpen) setSettingsOpen(false);
    getWorkspace()?.openSymbolSearch();
  };

  const toggleSettings = () => {
    closeAllMenus();
    if (settingsOpen) setSettingsOpen(false);
    // Open Vela's native settings dialog — the ONE settings panel: built-in
    // tabs plus the full MAWS section set (Status line, Scales & labels,
    // Chart chrome, Theme, Trading, Alerts, Events) contributed as host
    // sections on every chart mount.
    (getChart(pane.id)?.renderer as unknown as { openSettings?: (s?: string) => void }).openSettings?.();
  };

  const placeMarket = (side: "buy" | "sell", price: number, qtyOverride?: number) => {
    const trading = resolveSymbolTrading(pane.symbol);
    const qty = qtyOverride ?? resolveOrderQty(pane.symbol, price);
    if (!(qty > 0)) return;
    // One id per user submit action; reused if this action is retried.
    const clientOrderId = newClientOrderId();
    if (trading.confirmOrders && !useAppStore.getState().chartSettings.oneClickTrading) {
      const ok = window.confirm(
        `${side === "buy" ? "Buy" : "Sell"} ${pane.symbol} · margin ${formatMarginLabel(pane.symbol)} @ market?`,
      );
      if (!ok) return;
    }
    submitOrderFromUi({
      symbol: pane.symbol,
      side,
      type: trading.defaultOrderType === "limit" ? "limit" : "market",
      price,
      qty,
      clientOrderId,
    });
  };

  useEffect(() => {
    if (settingsOpen || indicatorSettingsId || drawingSettingsTarget || brokerDialogOpen) {
      setTfMore(false);
      setStyleOpen(false);
      setIndicatorMenuOpen(false);
    }
  }, [
    settingsOpen,
    indicatorSettingsId,
    drawingSettingsTarget,
    brokerDialogOpen,
    setIndicatorMenuOpen,
  ]);

  useEffect(() => {
    setIconOrder(loadTopbarIconOrder());
  }, []);

  const toolbarIcons: Record<TopbarIconId, ReactNode> = {
    screenshot: (
      <ToolbarBtn
        label="Screenshot"
        className="rounded-full"
        onClick={() => {
          closeAllMenus();
          getWorkspace()?.downloadScreenshot?.();
        }}
      >
        <Camera size={15} />
      </ToolbarBtn>
    ),
    fullscreen: (
      <ToolbarBtn
        label="Fullscreen"
        className="rounded-full"
        onClick={() => {
          closeAllMenus();
          if (document.fullscreenElement) void document.exitFullscreen();
          else void document.documentElement.requestFullscreen();
        }}
      >
        <Maximize size={15} />
      </ToolbarBtn>
    ),
    theme: (
      <ToolbarBtn
        label={`Theme · ${THEME_LABEL[themeName] ?? "Vela Muted"}`}
        className="rounded-full"
        onClick={() => {
          closeAllMenus();
          const current = Math.max(0, THEME_CYCLE.indexOf(themeName as (typeof THEME_CYCLE)[number]));
          const step = (current + 1) % THEME_CYCLE.length;
          // Advance the cumulative turn to the next stop, keeping the angle
          // strictly decreasing (never the 3-turn rewind back to 0°).
          themeTurns = Math.max(themeTurns + 1, step);
          themeTurnedTo = THEME_CYCLE[step];
          setThemeAngle(90 * themeTurns);
          const next = THEME_CYCLE[step] as ThemeName;
          const nextSettings = applyVelaThemeEverywhere(next);
          useAppStore
            .getState()
            .setAppSettings({
              ...nextSettings,
              advancedColors: useAppStore.getState().appSettings.advancedColors,
            });
          applyThemeToCharts(next);
        }}
      >
        <ThemeIcon rotation={themeAngle} />
      </ToolbarBtn>
    ),
    tradestate: showBuySell ? (
      <BuySellStrip
        symbol={pane.symbol}
        onSell={(price, qty) => placeMarket("sell", price, qty)}
        onBuy={(price, qty) => placeMarket("buy", price, qty)}
        onContextMenu={(x, y) => {
          closeAllMenus();
          setBuySellMenu({ x, y, symbol: pane.symbol });
        }}
      />
    ) : null,
    journal: (
      <ToolbarBtn
        label="Trade Journal"
        className="gap-1.5 px-2 text-[13px]"
        onClick={() => {
          closeAllMenus();
          if (settingsOpen) setSettingsOpen(false);
          setJournalOverlayOpen(true);
        }}
      >
        <JournalIcon />
        Journal
      </ToolbarBtn>
    ),
    template: (
      <VelaTemplateMenu />
    ),
  };

  const dropIcon = (target: TopbarIconId, clientX: number, targetRect: DOMRect) => {
    const dragged = draggedIconRef.current;
    if (!dragged || dragged === target) return;
    const fromIndex = iconOrder.indexOf(dragged);
    const targetIndex = iconOrder.indexOf(target);
    if (fromIndex < 0 || targetIndex < 0) return;

    const nextOrder = [...iconOrder];
    nextOrder.splice(fromIndex, 1);
    let insertIndex = targetIndex + (clientX >= targetRect.left + targetRect.width / 2 ? 1 : 0);
    if (insertIndex > fromIndex) insertIndex--;
    nextOrder.splice(insertIndex, 0, dragged);
    setIconOrder(nextOrder);
    try {
      localStorage.setItem(TOPBAR_ICON_ORDER_KEY, JSON.stringify(nextOrder));
    } catch {
      /* The current session order still applies when storage is unavailable. */
    }
  };

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;

      if (tfMore && !tfRef.current?.contains(t)) {
        setTfMore(false);
      }
      if (styleOpen && !styleRef.current?.contains(t)) {
        setStyleOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [
    tfMore,
    styleOpen,
    indicatorMenuOpen,
    setIndicatorMenuOpen,
  ]);

  return (
    <header className="relative z-40 flex min-h-[40px] shrink-0 flex-wrap items-center gap-0.5 overflow-visible bg-[var(--app-bg)] px-2 py-1 text-[var(--app-text)]">
      <MawsProductMenu />
      <span className="relative z-[2] top-sep" />

      <button
        type="button"
        data-symbol-search-trigger
        onClick={openSymbolSearch}
        className="relative z-[2] flex h-[28px] w-[140px] shrink-0 items-center justify-between gap-1.5 rounded-full bg-[var(--app-elevated)] px-3 hover:bg-[var(--app-border)]"
      >
        {/* Market-feed health leads the ticker: the dot describes the series named
            right beside it, and this block never carries trading controls. */}
        <FeedStatusIndicator />
        <span className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold">{formatTicker(pane.symbol)}</span>
        <ChevronDown size={12} className="shrink-0 text-(--app-muted)" />
      </button>

      <button
        type="button"
        title={starred ? "Remove from watchlist" : "Add to watchlist"}
        className="relative z-[2] ml-1 flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full text-(--app-muted) hover:bg-(--app-hover) hover:text-(--app-text)"
        onClick={() => {
          closeAllMenus();
          if (starred) removeFromWatchlist(pane.symbol);
          else addToWatchlist(pane.symbol);
        }}
      >
        <Diamond
          size={14}
          color="#ffffff"
          fill={starred ? "#ffffff" : "none"}
          strokeWidth={1.6}
        />
      </button>

      <span className="relative z-[2] top-sep" />

      <div className="relative z-[2] flex shrink-0 items-center">
        {BAR_TFS.map((id) => {
          const tf = TIMEFRAMES.find((t) => t.id === id)!;
          const on = pane.timeframe === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                closeAllMenus();
                setTimeframe(id);
              }}
              className={`h-[26px] rounded-[6px] px-[7px] text-[13px] ${
                on ? "bg-(--app-hover) text-(--app-text)" : "text-(--app-muted) hover:text-(--app-text)"
              }`}
            >
              {tf.label}
            </button>
          );
        })}
        <div className="relative" ref={tfRef}>
          <button
            type="button"
            className="flex h-[26px] w-[20px] items-center justify-center text-(--app-muted) hover:text-(--app-text)"
            onClick={toggleTfMore}
          >
            <ChevronDown size={12} />
          </button>
          {tfMore && (
            <div className="menu" data-dropdown-open>
              {MORE_TFS.map((id) => {
                const tf = TIMEFRAMES.find((t) => t.id === id)!;
                return (
                  <button
                    key={id}
                    type="button"
                    className="menu-row w-full"
                    onClick={() => {
                      setTimeframe(id);
                      setTfMore(false);
                    }}
                  >
                    {tf.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {!BAR_TFS.includes(pane.timeframe) && (
          <span className="ml-1 text-[11px] text-(--app-muted)">{tfLabel}</span>
        )}

        <span className="top-sep" />

        <div className="relative" ref={styleRef}>
          <ToolbarBtn
            label="Chart type"
            active={styleOpen}
            onClick={toggleStyleOpen}
          >
            <ChartStyleIcon id={candleStyle} />
          </ToolbarBtn>
          {styleOpen && (
            <div className="menu min-w-[200px]" data-dropdown-open>
              {CHART_STYLES.map((s) => {
                const on = candleStyle === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    className="menu-row w-full"
                    onClick={() => {
                      if (s.id === "solid" || s.id === "heikinashi") {
                        patchChartSettings({
                          candleStyle: s.id,
                          bodyVisible: true,
                          borderVisible: false,
                          wickVisible: true,
                          bodyUpColor: "#089981",
                          bodyDownColor: "#f23645",
                          borderUpColor: "#089981",
                          borderDownColor: "#f23645",
                          wickUpColor: "#089981",
                          wickDownColor: "#f23645",
                        });
                      } else if (s.id === "hollow") {
                        patchChartSettings({
                          candleStyle: s.id,
                          bodyVisible: true,
                          borderVisible: true,
                          wickVisible: true,
                          bodyUpColor: "#b2b5be",
                          bodyDownColor: "#787b86",
                          borderUpColor: "#b2b5be",
                          borderDownColor: "#787b86",
                          wickUpColor: "#b2b5be",
                          wickDownColor: "#787b86",
                        });
                      } else {
                        patchChartSettings({ candleStyle: s.id });
                      }
                      setStyleOpen(false);
                    }}
                  >
                    <ChartStyleIcon id={s.id} className="text-(--app-muted)" />
                    <span className="flex-1 text-left">{s.label}</span>
                    {on ? <span className="text-[12px] text-(--app-text)">✓</span> : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <span className="top-sep" />

        <VelaLayoutButton />

        <span className="top-sep" />

        <ToolbarBtn
          label="Indicators"
          active={indicatorMenuOpen}
          onClick={toggleIndicatorMenu}
          className="gap-1 px-2 text-[13px] text-(--app-text)"
        >
          <IndicatorsIcon />
          Indicators
          <ChevronDown size={11} className="text-(--app-muted)" />
        </ToolbarBtn>

        <span className="top-sep" />

        <ToolbarBtn
          label="Replay"
          className="gap-1 px-2 text-[13px]"
          active={Boolean(replay) || replaySeeking}
          onClick={() => {
            closeAllMenus();
            if (replay) {
              // Stop active replay — also stop Vela so live data resumes.
              const workspaceReplay = getWorkspace()?.replay;
              if (workspaceReplay?.state.active) workspaceReplay.stop();
              else {
                const chart = getChart(pane.id)?.vela;
                if (chart?.replay.state.active) chart.replay.stop();
              }
              stopReplay();
              return;
            }
            if (replaySeeking) {
              setReplaySeeking(false);
              return;
            }
            // Enter seek mode: the ReplaySeekOverlay takes over from here.
            setReplaySeeking(true);
          }}
        >
          <Rewind size={14} />
          Replay
        </ToolbarBtn>

        <span className="top-sep" />
      </div>

      {/* Vela's native drawing bar (horizontal, top-docked) — one shared bar for the
          active pane, Vela-owned state; the MAWS extras (undo/redo/hide/Clear) ride
          in its row and are all drag-reorderable with the tools. */}
      <div className="relative z-[2] mx-0.5 flex min-w-fit flex-1 items-center">
        <VelaDrawingBar />
      </div>

      <div className="relative z-[2] flex shrink-0 items-center gap-0.5">
        {iconOrder.map((id) => (
          <div
            key={id}
            data-toolbar-icon={id}
            draggable
            className={`flex shrink-0 cursor-grab items-center active:cursor-grabbing ${
              draggingIcon === id ? "opacity-40" : ""
            }`}
            onDragStart={(event) => {
              draggedIconRef.current = id;
              setDraggingIcon(id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", id);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              dropIcon(id, event.clientX, event.currentTarget.getBoundingClientRect());
            }}
            onDragEnd={() => {
              draggedIconRef.current = null;
              setDraggingIcon(null);
            }}
          >
            {toolbarIcons[id]}
          </div>
        ))}
        <button
          type="button"
          className="ml-1 flex h-[28px] w-[30px] shrink-0 items-center justify-center rounded-[4px] text-(--app-muted) hover:bg-(--app-hover) hover:text-(--app-text)"
          title={rightOpen ? "Hide right side" : "Show right side"}
          aria-label={rightOpen ? "Hide right side" : "Show right side"}
          aria-pressed={rightOpen}
          // Hide stows whatever is on screen — full panel or just the docked
          // icon rail; show restores the whole side (setRightOpen does both).
          onClick={() => setRightOpen(!rightOpen)}
        >
          <ChevronsLeft
            size={16}
            className={`transition-transform duration-150 ease-out ${
              rightOpen ? "rotate-180" : "rotate-0"
            }`}
          />
        </button>
      </div>
    </header>
  );
}
