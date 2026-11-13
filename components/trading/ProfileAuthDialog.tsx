"use client";

import { CircleAlert, Eye, EyeOff, LoaderCircle, LockKeyhole } from "lucide-react";
import { useState, type FormEvent } from "react";

import { profileLabel } from "@/lib/live/bridge";
import type { LiveProfileId } from "@/lib/live/types";

/**
 * Operator sign-in for a trading profile, shared by the profile chooser and the
 * topbar menu so both entry points look and behave the same.
 *
 * Testnet and Live are visually distinct (blue versus amber) because attaching
 * Live can move real money; the password field and primary action stay in the
 * same place in both so the flow never shifts under the operator.
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
  const live = profileId === "binance-production";
  const label = profileLabel(profileId);
  const accent = live ? "#f0b90b" : "#2962ff";
  const accentSoft = live ? "rgba(240,185,11,0.12)" : "rgba(41,98,255,0.14)";
  const accentBorder = live ? "rgba(240,185,11,0.45)" : "rgba(41,98,255,0.45)";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-[2px]"
      onMouseDown={onCancel}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-auth-title"
        aria-describedby="profile-auth-description"
        onSubmit={onSubmit}
        className="w-[420px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[12px] border border-(--app-border) bg-[#131313] shadow-[0_28px_90px_rgba(0,0,0,0.8)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div
          className="flex items-start gap-3 border-b border-(--app-border) px-5 py-4"
          style={{ background: `linear-gradient(180deg, ${accentSoft}, transparent)` }}
        >
          <span
            className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border"
            style={{ borderColor: accentBorder, background: accentSoft, color: accent }}
          >
            <LockKeyhole size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span id="profile-auth-title" className="text-[15px] font-semibold text-(--app-text)">
                Connect to {label}
              </span>
              <span
                className="rounded-[3px] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em]"
                style={{ color: accent, background: accentSoft, border: `1px solid ${accentBorder}` }}
              >
                {live ? "Live" : "Testnet"}
              </span>
            </div>
            <p id="profile-auth-description" className="mt-1 text-[12px] leading-4 text-(--app-muted)">
              {live
                ? "Sign in with the server operator password. Attaching Live uses real credentials."
                : "Sign in with the server operator password to attach this profile."}
            </p>
          </div>
        </div>

        <div className="px-5 py-4">
          <label
            htmlFor="profile-operator-password"
            className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.06em] text-(--app-muted)"
          >
            Operator password
          </label>
          <div className="relative">
            <input
              id="profile-operator-password"
              type={revealed ? "text" : "password"}
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              placeholder="••••••••••••"
              className="h-10 w-full rounded-[6px] border border-(--app-border) bg-[#0d0d0d] pl-3 pr-10 text-[13px] text-(--app-text) outline-none transition-colors placeholder:text-(--app-faint) focus:border-[#2962ff]"
              style={error ? { borderColor: "rgba(242,54,69,0.6)" } : undefined}
            />
            <button
              type="button"
              aria-label={revealed ? "Hide password" : "Show password"}
              aria-pressed={revealed}
              onClick={() => setRevealed((value) => !value)}
              className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-[4px] text-(--app-muted) transition-colors hover:bg-(--app-hover) hover:text-(--app-text)"
            >
              {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>

          {error ? (
            <div
              role="alert"
              className="mt-3 flex items-start gap-2 rounded-[6px] border border-[#f23645]/35 bg-[#1a0b0d] px-3 py-2 text-[12px] text-[#f23645]"
            >
              <CircleAlert size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : (
            <p className="mt-2.5 text-[11px] text-(--app-muted)">
              The password stays on the server; it is verified against its hash.
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-(--app-border) bg-[#111111] px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 rounded-[5px] px-3 text-[12px] text-(--app-muted) transition-colors hover:bg-(--app-hover) hover:text-(--app-text)"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || password.length === 0}
            className="flex h-8 items-center gap-1.5 rounded-[5px] px-3.5 text-[12px] font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: accent, color: live ? "#0b0b0b" : "#ffffff" }}
          >
            {busy ? <LoaderCircle size={13} className="animate-spin" /> : null}
            {busy ? "Connecting…" : `Connect ${label}`}
          </button>
        </div>
      </form>
    </div>
  );
}
