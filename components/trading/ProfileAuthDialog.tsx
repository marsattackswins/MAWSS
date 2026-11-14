"use client";

import {
  ArrowRight,
  CircleAlert,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  PlugZap,
  ShieldCheck,
  Waves,
} from "lucide-react";
import { useState, type FormEvent, type KeyboardEvent } from "react";

import { profileLabel } from "@/lib/live/bridge";
import type { LiveProfileId } from "@/lib/live/types";

const PROFILE_FACTS: Record<
  LiveProfileId,
  { environment: string; endpoint: string; funds: string; blurb: string }
> = {
  "binance-testnet": {
    environment: "Demo",
    endpoint: "demo-fapi",
    funds: "Simulated",
    blurb: "Binance Futures Demo Trading. Orders never touch real funds.",
  },
  "binance-production": {
    environment: "Production",
    endpoint: "fapi",
    funds: "Real funds",
    blurb: "Binance Futures Live. Attaching can place real orders with real funds.",
  },
};

const STEPS = [
  { icon: ShieldCheck, title: "Verify operator", body: "Checked server-side against the operator hash." },
  { icon: PlugZap, title: "Attach profile", body: "Scoped to this session; restart stays Disconnected." },
  { icon: Waves, title: "Keep the chart live", body: "Public market data keeps flowing either way." },
] as const;

function BinanceMark({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={color} aria-hidden="true">
      <path d="M7.0679 12L5.03779 14.0301L3.00256 12L5.03268 9.96989L7.0679 12ZM12.0026 7.06534L15.485 10.5477L17.5151 8.51761L12.0026 3L6.48495 8.51761L8.51506 10.5477L12.0026 7.06534ZM18.9673 9.96989L16.9372 12L18.9673 14.0301L20.9975 12L18.9673 9.96989ZM12.0026 16.9347L8.52018 13.4523L6.49006 15.4824L12.0026 21L17.5151 15.4824L15.485 13.4523L12.0026 16.9347ZM12.0026 14.0301L14.0327 12L12.0026 9.96989L9.96734 12L12.0026 14.0301Z" />
    </svg>
  );
}

/**
 * Operator sign-in for a trading profile, shared by the profile chooser and the
 * topbar menu.
 *
 * One card, one decision: which environment you are attaching, why the password
 * is needed, what attaching will and will not do, and a single primary action.
 * Testnet and Live are colour-coded (blue / amber) because Live moves real money.
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
  const facts = PROFILE_FACTS[profileId];
  const accent = live ? "#f0b90b" : "#2962ff";
  const accentRgb = live ? "240,185,11" : "41,98,255";
  const onDarkAccent = live ? "#120d00" : "#ffffff";

  const trackCaps = (event: KeyboardEvent<HTMLInputElement>) => {
    if (typeof event.getModifierState !== "function") return;
    setCapsLock(event.getModifierState("CapsLock"));
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 px-4 backdrop-blur-[3px]">
      {/* Backdrop click closes; the card stops the event. */}
      <div className="absolute inset-0" aria-hidden="true" onMouseDown={onCancel} />
      <div
        className="relative w-[520px] max-w-full rounded-[15px] p-px shadow-[0_40px_120px_-20px_rgba(0,0,0,0.95)]"
        style={{
          background: `linear-gradient(150deg, rgba(${accentRgb},0.55), rgba(${accentRgb},0.10) 26%, #2a2a2a 55%, #1c1c1c 100%)`,
          // Drives the password field's focus ring so it matches the environment.
          ["--auth-accent" as string]: accent,
        }}
      >
        <form
          role="dialog"
          aria-modal="true"
          aria-labelledby="profile-auth-title"
          aria-describedby="profile-auth-description"
          onSubmit={onSubmit}
          className="overflow-hidden rounded-[14px] bg-[#101010]"
        >
          {/* Top meta strip: who this dialog belongs to and which environment. */}
          <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-2.5">
            <div className="flex items-center gap-2">
              <BinanceMark color={accent} />
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-(--app-muted)">
                MAWS
              </span>
              <span className="h-3 w-px bg-white/10" aria-hidden="true" />
              <span className="text-[10px] uppercase tracking-[0.14em] text-(--app-faint)">
                Profile access
              </span>
            </div>
            <span
              className="flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em]"
              style={{ color: accent, background: `rgba(${accentRgb},0.10)`, border: `1px solid rgba(${accentRgb},0.35)` }}
            >
              <span className="size-1 rounded-full" style={{ background: accent }} />
              {live ? "Live" : "Testnet"}
            </span>
          </div>

          {/* Hero */}
          <div className="flex items-start gap-3.5 px-5 pt-4 pb-3">
            <span
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px]"
              style={{
                background: `radial-gradient(circle at 30% 20%, rgba(${accentRgb},0.28), rgba(${accentRgb},0.05))`,
                border: `1px solid rgba(${accentRgb},0.35)`,
                color: accent,
                boxShadow: `0 0 24px -8px rgba(${accentRgb},0.6)`,
              }}
            >
              <LockKeyhole size={18} />
            </span>
            <div className="min-w-0">
              <h2 id="profile-auth-title" className="text-[17px] font-semibold leading-5 text-(--app-text)">
                Connect to {label}
              </h2>
              <p id="profile-auth-description" className="mt-1 text-[12px] leading-[18px] text-(--app-muted)">
                {facts.blurb}
              </p>
            </div>
          </div>

          {/* Profile facts */}
          <div className="mx-5 grid grid-cols-3 overflow-hidden rounded-[8px] border border-white/[0.07] bg-[#0b0b0b]">
            {[
              { label: "Environment", value: facts.environment },
              { label: "Endpoint", value: facts.endpoint },
              { label: "Funds", value: facts.funds },
            ].map((fact, index) => (
              <div
                key={fact.label}
                className={`px-3 py-2 ${index > 0 ? "border-l border-white/[0.06]" : ""}`}
              >
                <div className="text-[9px] font-medium uppercase tracking-[0.12em] text-(--app-faint)">
                  {fact.label}
                </div>
                <div
                  className="mt-0.5 truncate text-[12px] font-medium text-(--app-text)"
                  style={fact.label === "Funds" && live ? { color: accent } : undefined}
                  title={fact.value}
                >
                  {fact.value}
                </div>
              </div>
            ))}
          </div>

          {/* What attaching does */}
          <ul className="mx-5 mt-3.5 space-y-1.5">
            {STEPS.map((step) => (
              <li key={step.title} className="flex items-start gap-2.5 text-[11px] leading-4">
                <span
                  className="mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border border-white/[0.07] bg-white/[0.03]"
                  aria-hidden="true"
                >
                  <step.icon size={10} className="text-(--app-muted)" />
                </span>
                <span className="min-w-0 text-(--app-muted)">
                  <span className="font-medium text-(--app-text)">{step.title}.</span> {step.body}
                </span>
              </li>
            ))}
          </ul>

          {/* Credential */}
          <div className="mt-4 border-t border-white/[0.06] bg-[#0c0c0c] px-5 pt-3.5 pb-4">
            <div className="mb-1.5 flex items-baseline justify-between">
              <label
                htmlFor="profile-operator-password"
                className="text-[10px] font-semibold uppercase tracking-[0.12em] text-(--app-muted)"
              >
                Operator password
              </label>
              {capsLock ? (
                <span className="flex items-center gap-1 text-[10px] font-medium text-[#f0b90b]">
                  <CircleAlert size={10} /> Caps Lock is on
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[10px] text-(--app-faint)">
                  <KeyRound size={10} /> Required
                </span>
              )}
            </div>
            <div className="relative">
              <LockKeyhole
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-(--app-faint)"
                aria-hidden="true"
              />
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
                className="profile-auth-field h-11 w-full rounded-[7px] border border-white/10 bg-[#0d0d0d] pl-9 pr-11 text-[13px] tracking-[0.02em] text-(--app-text) outline-none transition-colors placeholder:text-(--app-faint) hover:border-white/20"
                style={error ? { borderColor: "rgba(242,54,69,0.65)" } : undefined}
              />
              <button
                type="button"
                aria-label={revealed ? "Hide password" : "Show password"}
                aria-pressed={revealed}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setRevealed((value) => !value)}
                className="absolute right-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-[5px] text-(--app-muted) transition-colors hover:bg-white/[0.06] hover:text-(--app-text)"
              >
                {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>

            {error ? (
              <div
                role="alert"
                className="mt-2.5 flex items-start gap-2 rounded-[6px] border border-[#f23645]/30 bg-[#f23645]/[0.08] px-2.5 py-2 text-[11px] leading-4 text-[#ff6b78]"
              >
                <CircleAlert size={12} className="mt-[1px] shrink-0" />
                <span>{error}</span>
              </div>
            ) : (
              <p className="mt-2 text-[10px] leading-4 text-(--app-faint)">
                Verified server-side against its hash. The password is never stored in the browser.
              </p>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-5 py-3">
            <span className="hidden items-center gap-1 text-[10px] text-(--app-faint) sm:flex">
              Press
              <kbd className="rounded-[3px] border border-white/10 bg-white/[0.05] px-1 py-px font-mono text-[9px] text-(--app-muted)">
                Esc
              </kbd>
              to cancel
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={onCancel}
                className="h-8 rounded-[6px] px-3 text-[12px] font-medium text-(--app-muted) transition-colors hover:bg-white/[0.06] hover:text-(--app-text)"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || password.length === 0}
                className="group flex h-8 items-center gap-1.5 rounded-[6px] px-3.5 text-[12px] font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  background: accent,
                  color: onDarkAccent,
                  boxShadow: busy ? "none" : `0 6px 18px -8px rgba(${accentRgb},0.85)`,
                }}
              >
                {busy ? <LoaderCircle size={13} className="animate-spin" /> : null}
                {busy ? "Connecting…" : `Connect ${label}`}
                {busy ? null : <ArrowRight size={13} className="transition-transform group-hover:translate-x-0.5" />}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
