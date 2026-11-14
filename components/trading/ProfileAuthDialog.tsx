"use client";

import { ArrowRight, CircleAlert, Eye, EyeOff, LoaderCircle, LockKeyhole } from "lucide-react";
import { useState, type FormEvent, type KeyboardEvent } from "react";

import { profileLabel } from "@/lib/live/bridge";
import type { LiveProfileId } from "@/lib/live/types";

const PROFILE_META: Record<LiveProfileId, { host: string; detail: string }> = {
  "binance-testnet": { host: "Binance Futures Demo", detail: "demo-fapi" },
  "binance-production": { host: "Binance Futures Live", detail: "fapi" },
};

function BinanceMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7.0679 12L5.03779 14.0301L3.00256 12L5.03268 9.96989L7.0679 12ZM12.0026 7.06534L15.485 10.5477L17.5151 8.51761L12.0026 3L6.48495 8.51761L8.51506 10.5477L12.0026 7.06534ZM18.9673 9.96989L16.9372 12L18.9673 14.0301L20.9975 12L18.9673 9.96989ZM12.0026 16.9347L8.52018 13.4523L6.49006 15.4824L12.0026 21L17.5151 15.4824L15.485 13.4523L12.0026 16.9347ZM12.0026 14.0301L14.0327 12L12.0026 9.96989L9.96734 12L12.0026 14.0301Z" />
    </svg>
  );
}

/**
 * Operator sign-in for a trading profile, shared by the profile chooser and the
 * topbar menu.
 *
 * Kept intentionally short — which market you attach to, the one-line risk, the
 * password, two actions — while still showing the exchange mark and endpoint so
 * the card reads as a Binance attachment. Every colour is an `--app-*` theme
 * token (the accent tints the mark, primary button and focus ring), so the card
 * follows light, dark and custom accents; no fixed gradient edge.
 */
export function ProfileAuthDialog({
  profileId,
  password,
  error,
  busy,
  onPasswordChange,
  onCancel,
  onSubmit,
}: {
  profileId: LiveProfileId;
  password: string;
  error: string | null;
  busy: boolean;
  onPasswordChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const live = profileId === "binance-production";
  const label = profileLabel(profileId);
  const meta = PROFILE_META[profileId];

  const trackCaps = (event: KeyboardEvent<HTMLInputElement>) => {
    if (typeof event.getModifierState !== "function") return;
    setCapsLock(event.getModifierState("CapsLock"));
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 px-4 backdrop-blur-[2px]">
      {/* Backdrop click closes; the card stops the event. */}
      <div className="absolute inset-0" aria-hidden="true" onMouseDown={onCancel} />
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-auth-title"
        aria-describedby="profile-auth-description"
        onSubmit={onSubmit}
        className="relative w-[420px] max-w-full rounded-[12px] border border-(--app-border) bg-(--app-elevated) shadow-[0_24px_60px_-24px_rgba(0,0,0,0.55)]"
        style={{ ["--auth-accent" as string]: "var(--app-accent)" }}
      >
        {/* Meta strip: which product this dialog belongs to and which environment. */}
        <div className="flex items-center justify-between gap-3 border-b border-(--app-border) px-5 py-2.5">
          <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em]">
            <span className="text-(--app-muted)">MAWS</span>
            <span className="text-(--app-faint)">/</span>
            <span className="font-medium tracking-[0.12em] text-(--app-faint)">Profile access</span>
          </span>
          <span className="flex items-center gap-1.5 rounded-full border border-(--app-border) px-2 py-0.5">
            <span
              className="size-1.5 rounded-full"
              style={{ background: live ? "var(--app-down)" : "var(--app-up)" }}
            />
            <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-(--app-muted)">
              {live ? "Live" : "Testnet"}
            </span>
          </span>
        </div>

        {/* Hero: exchange mark, which profile, and the one risk line that matters. */}
        <div className="flex items-start gap-3 px-5 pt-4">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[9px] border"
            style={{
              color: "var(--app-accent)",
              borderColor: "color-mix(in srgb, var(--app-accent) 28%, transparent)",
              background: "color-mix(in srgb, var(--app-accent) 12%, transparent)",
            }}
          >
            <BinanceMark />
          </span>
          <div className="min-w-0 pt-0.5">
            <h2 id="profile-auth-title" className="text-[15px] font-semibold leading-5 text-(--app-text)">
              Connect to {label}
            </h2>
            <p id="profile-auth-description" className="mt-0.5 text-[12px] leading-[17px] text-(--app-muted)">
              {live
                ? "Attaching can place real orders with real funds."
                : "Demo trading: orders never touch real funds."}
            </p>
          </div>
        </div>

        {/* One compact line instead of a facts grid: host and endpoint. */}
        <div className="mt-3 flex items-center gap-2 px-5 text-[11px] text-(--app-faint)">
          <span className="text-(--app-muted)">{meta.host}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono text-[10px]">{meta.detail}</span>
          <span aria-hidden="true">·</span>
          <span>{live ? "Real funds" : "Simulated funds"}</span>
        </div>

        <div className="mt-3.5 border-t border-(--app-border) px-5 pt-3.5">
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <label
              htmlFor="profile-operator-password"
              className="flex items-center gap-1.5 text-[11px] font-medium text-(--app-muted)"
            >
              <LockKeyhole size={11} aria-hidden="true" />
              Operator password
            </label>
            {capsLock ? (
              <span
                className="flex items-center gap-1 text-[10px] font-medium"
                style={{ color: "var(--app-down)" }}
              >
                <CircleAlert size={10} /> Caps Lock is on
              </span>
            ) : null}
          </div>
          <div className="relative">
            <input
              id="profile-operator-password"
              type={revealed ? "text" : "password"}
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              onKeyUp={trackCaps}
              onKeyDown={trackCaps}
              placeholder="Enter operator password"
              aria-invalid={error ? true : undefined}
              className="profile-auth-field h-10 w-full rounded-[6px] border border-(--app-border) bg-(--app-bg) px-3 pr-10 text-[13px] text-(--app-text) outline-none transition-colors placeholder:text-(--app-faint) hover:border-(--app-muted)"
              style={
                error
                  ? { borderColor: "color-mix(in srgb, var(--app-down) 65%, transparent)" }
                  : undefined
              }
            />
            <button
              type="button"
              aria-label={revealed ? "Hide password" : "Show password"}
              aria-pressed={revealed}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setRevealed((value) => !value)}
              className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-[5px] text-(--app-muted) transition-colors hover:bg-(--app-hover) hover:text-(--app-text)"
            >
              {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>

          {error ? (
            <div
              role="alert"
              className="mt-2 flex items-start gap-2 rounded-[6px] border px-2.5 py-1.5 text-[11px] leading-4"
              style={{
                borderColor: "color-mix(in srgb, var(--app-down) 40%, transparent)",
                background: "color-mix(in srgb, var(--app-down) 10%, transparent)",
                color: "var(--app-down)",
              }}
            >
              <CircleAlert size={12} className="mt-[1px] shrink-0" />
              <span>{error}</span>
            </div>
          ) : (
            <p className="mt-2 text-[10px] leading-4 text-(--app-faint)">
              Verified server-side against the operator hash, never stored in the browser.
            </p>
          )}
        </div>

        <div className="mt-3.5 flex items-center justify-end gap-2 border-t border-(--app-border) px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 rounded-[6px] px-3 text-[12px] font-medium text-(--app-muted) transition-colors hover:bg-(--app-hover) hover:text-(--app-text)"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || password.length === 0}
            className="group flex h-8 items-center gap-1.5 rounded-[6px] px-3.5 text-[12px] font-semibold text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100"
            style={{ background: "var(--app-accent)" }}
          >
            {busy ? <LoaderCircle size={13} className="animate-spin" /> : null}
            {busy ? "Connecting…" : "Connect"}
            {busy ? null : <ArrowRight size={13} className="transition-transform group-hover:translate-x-0.5" />}
          </button>
        </div>
      </form>
    </div>
  );
}
