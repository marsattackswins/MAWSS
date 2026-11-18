"use client";

import { CircleHelp, X } from "lucide-react";
import { dialogFrame, useDialogDismiss } from "@/components/ui/dialog-frame";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  MouseEvent,
  ReactNode,
  Ref,
} from "react";

/** Shared settings chrome — use for every settings dialog now and later. */
export const settingsUi = {
  overlay: "fixed inset-0 z-[80] flex items-center justify-center bg-transparent",
  // Every surface measurement comes from the one shared pop-up frame, so a
  // settings dialog and the broker dialog cannot drift apart again.
  panel: `${dialogFrame.panel} w-full`,
  header: `${dialogFrame.header} items-center`,
  title: dialogFrame.title,
  closeBtn: dialogFrame.closeBtn,
  tabs: "flex shrink-0 gap-4 border-b border-[var(--app-border)] px-5",
  tab: (on: boolean) =>
    `h-9 border-b-2 text-[13px] capitalize ${
      on
        ? "border-[var(--app-text)] text-[var(--app-text)]"
        : "border-transparent text-[var(--app-muted)] hover:text-[var(--app-text)]"
    }`,
  body: dialogFrame.body,
  footer: dialogFrame.footer,
  sectionTitle:
    "mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-[0.08em] text-[var(--app-muted)]",
  label: "text-[12px] text-[var(--app-muted)]",
  text: "text-[13px] text-[var(--app-text)]",
  muted: "text-[12px] text-[var(--app-muted)]",
  input:
    "h-8 rounded-[4px] border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-[13px] text-[var(--app-text)] outline-none focus:border-[var(--app-muted)] disabled:opacity-45",
  inputSm:
    "h-8 w-[88px] rounded-[4px] border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-[13px] text-[var(--app-text)] outline-none focus:border-[var(--app-muted)] disabled:opacity-45",
  select:
    "h-8 appearance-none rounded-[4px] border border-[var(--app-border)] bg-[var(--app-bg)] px-2 pr-7 text-[13px] text-[var(--app-text)] outline-none focus:border-[var(--app-muted)] disabled:opacity-45",
  navItem: (on: boolean) =>
    `mx-2 flex w-[calc(100%-16px)] items-center gap-2 rounded-[4px] px-2 py-2 text-left text-[13px] ${
      on
        ? "bg-[var(--app-hover)] text-[var(--app-text)]"
        : "text-[var(--app-text)] hover:bg-[var(--app-border)]"
    }`,
} as const;

export function SettingsOverlay({
  onClose,
  children,
  className = "",
}: {
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  // Chart palettes stay see-through (you adjust them while watching the chart),
  // but they still own Escape and give focus back to their trigger.
  useDialogDismiss(true, onClose);
  return (
    <div
      role="dialog"
      aria-modal="true"
      className={`${settingsUi.overlay} ${className}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

export function SettingsPanel({
  width = 440,
  children,
  className = "",
  onMouseDown,
  style,
  panelRef,
}: {
  width?: number | string;
  children: ReactNode;
  className?: string;
  onMouseDown?: (e: MouseEvent) => void;
  style?: CSSProperties;
  panelRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={panelRef}
      className={`${settingsUi.panel} ${className}`}
      style={{
        width: typeof width === "number" ? `${width}px` : width,
        maxWidth: "calc(100vw - 24px)",
        ...style,
      }}
      onMouseDown={onMouseDown ?? ((e) => e.stopPropagation())}
    >
      {children}
    </div>
  );
}

export function SettingsHeader({
  title,
  onClose,
  trailing,
  onMouseDown,
}: {
  title: ReactNode;
  onClose: () => void;
  trailing?: ReactNode;
  /** Drag handle — same pattern as the global settings title bar. */
  onMouseDown?: (e: MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className={`${settingsUi.header}${onMouseDown ? " cursor-move select-none" : ""}`}
      onMouseDown={onMouseDown}
    >
      <div className={`flex min-w-0 items-center gap-2 ${settingsUi.title}`}>{title}</div>
      <div className="flex items-center gap-1">
        {trailing}
        <button type="button" className={settingsUi.closeBtn} onClick={onClose} title="Close">
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

export function SettingsTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly T[] | T[];
  value: T;
  onChange: (tab: T) => void;
}) {
  return (
    <div className={settingsUi.tabs}>
      {tabs.map((t) => (
        <button
          key={t}
          type="button"
          className={settingsUi.tab(value === t)}
          onClick={() => onChange(t)}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

export function SettingsBody({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`${settingsUi.body} ${className}`}>{children}</div>;
}

export function SettingsFooter({
  left,
  children,
}: {
  left?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={settingsUi.footer}>
      <div className="min-w-0">{left}</div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

export function SettingsBtn({
  variant = "secondary",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
}) {
  const base =
    "h-9 rounded-[4px] px-4 text-[13px] font-semibold transition-colors disabled:opacity-45";
  const styles =
    variant === "primary"
      ? "bg-white text-black hover:bg-[#e0e3eb]"
      : variant === "ghost"
        ? "border border-[var(--app-faint)] text-[var(--app-text)] hover:border-[var(--app-muted)] hover:bg-[var(--app-hover)]"
        : "border border-[var(--app-faint)] text-[var(--app-text)] hover:border-[var(--app-muted)] hover:bg-[var(--app-hover)]";
  return <button type="button" className={`${base} ${styles} ${className}`} {...rest} />;
}

export function SettingsSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="mb-5">
      <div className={settingsUi.sectionTitle}>
        {title}
        {hint ? <CircleHelp size={12} className="text-[var(--app-faint)]" /> : null}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

/** Label above control (forms like Account settings). */
export function SettingsFieldStack({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block min-w-0">
      <span className={`mb-2 flex items-center gap-1 ${settingsUi.label}`}>
        {label}
        {hint ? <CircleHelp size={12} className="text-[var(--app-faint)]" /> : null}
      </span>
      {children}
    </label>
  );
}

/** Label left, control right (compact rows). */
export function SettingsFieldRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex items-center justify-between gap-3 py-1 ${settingsUi.text}`}>
      <span className="shrink-0">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export function SettingsCheck({
  label,
  hint,
  checked,
  onChange,
  disabled,
  extra,
  indent,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  extra?: ReactNode;
  indent?: boolean;
}) {
  return (
    <div
      className={`flex items-start gap-2 py-1 ${indent ? "pl-5" : ""} ${
        disabled ? "opacity-45" : ""
      }`}
    >
      <input
        type="checkbox"
        className="mt-1 accent-white"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="min-w-0 flex-1">
        <div className={`flex items-center gap-2 ${settingsUi.text}`}>
          <span>{label}</span>
          {extra}
        </div>
        {hint ? <div className={`mt-1 ${settingsUi.muted}`}>{hint}</div> : null}
      </div>
    </div>
  );
}

export { SettingsColorSwatch } from "@/components/settings/ColorPicker";

export function SettingsSelectWrap({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      {children}
      <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-[var(--app-muted)]">
        ▾
      </span>
    </div>
  );
}
