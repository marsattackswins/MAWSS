"use client";

import { useEffect, useState } from "react";

import { liveApi } from "@/lib/live/api";
import { useLiveStore } from "@/lib/live/store";
import type { FreezeDto } from "@/lib/live/types";

function when(at: number): string {
  try {
    return new Date(at).toLocaleString();
  } catch {
    return String(at);
  }
}

/**
 * Active submission freezes in the health area.
 *
 * It reports what each freeze still needs and offers one explicit operator
 * unfreeze. The button stays disabled, with the blocking reason shown, while
 * any freeze's own clear condition is unmet: nothing is ever cleared
 * automatically, and clicking never enables execution or the kill switch.
 */
export function FreezeBanner() {
  const frozen = useLiveStore((s) => s.health?.submissionsFrozen ?? false);
  const profileId = useLiveStore((s) => s.profileId);
  const generation = useLiveStore((s) => s.generation);
  const [freezes, setFreezes] = useState<FreezeDto[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profileId) {
      setFreezes([]);
      setDialogOpen(false);
      return;
    }
    let cancelled = false;
    liveApi
      .freezes()
      .then((result) => {
        if (!cancelled) setFreezes(result.freezes);
      })
      .catch(() => {
        // The banner is advisory: a failed read leaves the previous list.
      });
    return () => {
      cancelled = true;
    };
  }, [frozen, profileId, generation]);

  // Server truth (the freeze rows) decides visibility, so the banner cannot
  // hide behind a stale health flag. It refreshes when health changes.
  if (freezes.length === 0) return null;

  const blockers = freezes.filter((freeze) => freeze.blockingReason !== null);
  const disabled = blockers.length > 0;
  const firstBlocker = blockers[0]?.blockingReason ?? null;

  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await liveApi.clearFreeze();
      setFreezes(result.freezes);
      setDialogOpen(false);
      if (result.cleared.length === 0) {
        const stillBlocked = result.freezes.find((freeze) => freeze.blockingReason);
        setError(stillBlocked?.blockingReason ?? "No freeze met its clear condition");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unfreeze failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        data-testid="freeze-banner"
        role="status"
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--app-down)] bg-(--app-down)/10 px-3 py-1 text-[12px] text-[var(--app-down)]"
      >
        <span className="font-semibold">Submissions frozen</span>
        <ul className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1" data-testid="freeze-list">
          {freezes.map((freeze) => (
            <li key={freeze.code} className="min-w-0" data-testid={`freeze-${freeze.code}`}>
              <span className="font-mono font-semibold">{freeze.code}</span>{" "}
              <span className="text-(--app-text)">{freeze.reason || "no reason recorded"}</span>{" "}
              <span className="text-(--app-muted)">since {when(freeze.since)}</span>{" "}
              <span className="text-(--app-muted)">
                {freeze.blockingReason ?? "clear condition met"}
              </span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          data-testid="freeze-clear"
          disabled={disabled}
          title={disabled ? `Cannot clear yet: ${firstBlocker}` : "Clear the freezes whose conditions are met"}
          onClick={() => {
            setError(null);
            setDialogOpen(true);
          }}
          className="h-[24px] shrink-0 rounded-[4px] border border-[var(--app-down)] px-2 font-semibold disabled:cursor-not-allowed disabled:opacity-50"
        >
          Clear freeze
        </button>
        {disabled && firstBlocker ? (
          <span data-testid="freeze-clear-blocked" className="w-full text-(--app-muted)">
            Clear disabled: {firstBlocker}
          </span>
        ) : null}
      </div>

      {dialogOpen ? (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/50" data-testid="freeze-dialog">
          <div role="dialog" aria-modal="true" aria-labelledby="freeze-dialog-title" className="w-[440px] rounded-[6px] border border-(--app-border) bg-(--app-elevated) p-4 text-[13px] text-(--app-text) shadow-[var(--app-shadow-menu)]">
            <h2 id="freeze-dialog-title" className="mb-2 text-[14px] font-semibold">
              Clear submission freezes?
            </h2>
            <p className="mb-2 text-(--app-muted)">
              Only freezes whose own condition is already met will clear. Execution stays disabled and
              the kill switch is not touched.
            </p>
            <ul className="mb-3 list-disc space-y-1 pl-5" data-testid="freeze-dialog-reasons">
              {freezes.map((freeze) => (
                <li key={freeze.code}>
                  <span className="font-mono font-semibold">{freeze.code}</span>: {freeze.reason || "no reason recorded"}
                </li>
              ))}
            </ul>
            {error ? (
              <p role="alert" className="mb-2 text-[var(--app-down)]" data-testid="freeze-error">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button type="button" className="h-[28px] rounded-[4px] px-3 hover:bg-(--app-hover)" onClick={() => setDialogOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                data-testid="freeze-confirm"
                disabled={busy}
                className="h-[28px] rounded-[4px] border border-[var(--app-down)] px-3 font-semibold disabled:opacity-50"
                onClick={() => void clear()}
              >
                Clear freeze
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
