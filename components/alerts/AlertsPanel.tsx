"use client";

import { ColResize, useColumnWidths } from "@/components/ui/ResizableColumns";
import {
  alertNotificationsGranted,
  desktopNotificationsSupported,
  setDesktopAlertsEnabled,
} from "@/lib/alerts/fire";
import { formatPrice } from "@/lib/maws/feed";
import { formatTicker } from "@/lib/maws/universe";
import { useActivePane, useAppStore } from "@/lib/store";
import { useQuote } from "@/lib/use-quotes";
import { Bell, BellPlus, BellRing, Trash2, Volume2, VolumeX } from "lucide-react";
import { useEffect, useState } from "react";

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const iconButton =
  "flex h-6 w-6 items-center justify-center rounded hover:bg-(--app-hover)";

export function AlertsPanel() {
  const pane = useActivePane();
  const quote = useQuote(pane.symbol);
  const alerts = useAppStore((s) => s.alerts);
  const hits = useAppStore((s) => s.alertHits);
  const addAlert = useAppStore((s) => s.addAlert);
  const toggleAlert = useAppStore((s) => s.toggleAlert);
  const removeAlert = useAppStore((s) => s.removeAlert);
  const alertDesktop = useAppStore((s) => s.chartSettings.alertDesktop === true);
  const alertSound = useAppStore((s) => s.chartSettings.alertSound !== false);
  const patchChartSettings = useAppStore((s) => s.patchChartSettings);
  const [price, setPrice] = useState("");
  const [side, setSide] = useState<"above" | "below">("above");
  // Read after mount: the browser APIs behind these do not exist during SSR.
  const [perm, setPerm] = useState({ supported: false, granted: false });
  const { template, onResize } = useColumnWidths("alerts", [28, 100, 92, 84, 28]);

  useEffect(() => {
    setPerm({ supported: desktopNotificationsSupported(), granted: alertNotificationsGranted() });
  }, [alertDesktop]);

  const fired = (target: number, s: "above" | "below") => {
    if (!quote) return false;
    return s === "above" ? quote.last >= target : quote.last <= target;
  };

  const toggleDesktop = () => {
    void setDesktopAlertsEnabled(!alertDesktop).then(() =>
      setPerm({ supported: desktopNotificationsSupported(), granted: alertNotificationsGranted() }),
    );
  };

  // Newest first, so the first entry per alert is its latest firing.
  const lastHit = new Map<string, (typeof hits)[number]>();
  for (const hit of hits) if (!lastHit.has(hit.alertId)) lastHit.set(hit.alertId, hit);

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ color: "var(--maws-text)" }}>
      <div
        className="flex h-8 items-center gap-1 border-b px-2 text-[13px] font-semibold"
        style={{ borderColor: "var(--maws-border)" }}
      >
        <span className="flex-1">Alerts</span>
        <button
          type="button"
          className={iconButton}
          title={alertDesktop ? "Desktop alerts on" : "Desktop alerts off — click to turn on"}
          aria-pressed={alertDesktop}
          style={{ color: alertDesktop ? "var(--app-accent)" : "var(--app-muted)" }}
          onClick={toggleDesktop}
        >
          {alertDesktop ? <BellRing size={13} /> : <Bell size={13} />}
        </button>
        <button
          type="button"
          className={iconButton}
          title={alertSound ? "Alert sound on" : "Alert sound off"}
          aria-pressed={alertSound}
          style={{ color: alertSound ? "var(--app-accent)" : "var(--app-muted)" }}
          onClick={() => patchChartSettings({ alertSound: !alertSound })}
        >
          {alertSound ? <Volume2 size={13} /> : <VolumeX size={13} />}
        </button>
      </div>
      <div className="border-b px-2 py-2" style={{ borderColor: "var(--maws-border)" }}>
        <div className="mb-1 text-[11px]" style={{ color: "var(--maws-muted)" }}>
          {formatTicker(pane.symbol)} last {quote ? formatPrice(pane.symbol, quote.last) : "—"}
        </div>
        <div className="flex gap-1">
          <select
            value={side}
            onChange={(e) => setSide(e.target.value as "above" | "below")}
            className="h-7 border px-1 text-[12px]"
            style={{
              borderColor: "var(--maws-border)",
              background: "var(--maws-bg)",
              color: "var(--maws-text)",
            }}
          >
            <option value="above">Crossing up</option>
            <option value="below">Crossing down</option>
          </select>
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="Price"
            className="h-7 w-full border px-2 text-[12px] outline-none"
            style={{
              borderColor: "var(--maws-border)",
              background: "var(--maws-bg)",
              color: "var(--maws-text)",
            }}
          />
          <button
            type="button"
            className="flex h-7 items-center gap-1 bg-(--app-accent) px-2 text-[11px] text-white"
            onClick={() => {
              const value = Number(price) || quote?.last;
              if (!value) return;
              addAlert({ symbol: pane.symbol, price: value, side, enabled: true });
              setPrice("");
            }}
          >
            <BellPlus size={12} />
            Add
          </button>
        </div>
        {perm.supported && !perm.granted && (
          <button
            type="button"
            className="mt-1 text-[11px] text-(--app-accent) hover:underline"
            onClick={toggleDesktop}
          >
            {alertDesktop
              ? "Notifications are blocked — allow them for this site in the browser"
              : "Turn on desktop alerts"}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div
          className="sticky top-0 z-10 grid border-b px-2 py-1 text-[11px] uppercase"
          style={{
            gridTemplateColumns: template,
            minWidth: "max-content",
            borderColor: "var(--maws-border)",
            background: "var(--maws-panel)",
            color: "var(--maws-muted)",
          }}
        >
          <span className="relative pr-1">
            On
            <ColResize onMouseDown={onResize(0, 22)} />
          </span>
          <span className="relative truncate pr-1">
            Symbol
            <ColResize onMouseDown={onResize(1, 56)} />
          </span>
          <span className="relative truncate pr-1">
            Condition
            <ColResize onMouseDown={onResize(2, 56)} />
          </span>
          <span className="relative truncate pr-1">
            Status
            <ColResize onMouseDown={onResize(3, 44)} />
          </span>
          <span className="relative truncate">
            {" "}
            <ColResize onMouseDown={onResize(4, 22)} />
          </span>
        </div>
        {alerts.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-(--app-muted)">
            No alerts. Add a price level for the active symbol.
          </div>
        )}
        {alerts.map((alert) => {
          const hit = lastHit.get(alert.id);
          const live = alert.enabled && fired(alert.price, alert.side);
          return (
            <div
              key={alert.id}
              className="grid items-center border-b border-(--app-border) px-2 py-2"
              style={{ gridTemplateColumns: template, minWidth: "max-content" }}
            >
              <input
                type="checkbox"
                checked={alert.enabled}
                onChange={() => toggleAlert(alert.id)}
              />
              <span className="truncate pr-1 text-[12px] text-(--app-text)">{formatTicker(alert.symbol)}</span>
              <span className="truncate pr-1 text-[12px] text-(--app-text)">
                {alert.side === "above" ? "≥" : "≤"} {formatPrice(alert.symbol, alert.price)}
              </span>
              <span
                className="truncate pr-1 text-[11px]"
                style={{ color: hit || live ? "var(--app-up)" : "var(--app-muted)" }}
                title={hit ? `${formatPrice(alert.symbol, hit.last)} at ${clock(hit.at)}` : undefined}
              >
                {hit ? `Hit ${clock(hit.at)}` : live ? "Triggered" : "Waiting"}
              </span>
              <button
                type="button"
                className="text-(--app-muted) hover:text-(--app-down)"
                onClick={() => removeAlert(alert.id)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
