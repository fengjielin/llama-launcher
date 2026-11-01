import type { ReactNode } from "react";

export type Tone = "slate" | "accent" | "emerald" | "amber" | "rose" | "muted";

/** @deprecated 旧名 sky → accent；violet → muted。保留别名避免调用方一次性炸裂。 */
export type LegacyTone = Tone | "sky" | "violet";

function resolveTone(tone: LegacyTone): Tone {
  if (tone === "sky") return "accent";
  if (tone === "violet") return "muted";
  return tone;
}

const BADGE_TONE: Record<Tone, string> = {
  slate: "bg-[color-mix(in_srgb,var(--text-muted)_12%,transparent)] text-[var(--text-secondary)] ring-[color-mix(in_srgb,var(--text-muted)_30%,transparent)]",
  accent: "bg-[var(--accent-soft-bg)] text-[var(--accent)] ring-[var(--accent-soft-border)]",
  emerald: "bg-[color-mix(in_srgb,var(--ok)_12%,transparent)] text-[var(--ok)] ring-[color-mix(in_srgb,var(--ok)_35%,transparent)]",
  amber: "bg-[color-mix(in_srgb,var(--warn)_12%,transparent)] text-[var(--warn)] ring-[color-mix(in_srgb,var(--warn)_35%,transparent)]",
  rose: "bg-[var(--flash-danger-bg)] text-[var(--danger)] ring-[var(--flash-danger-border)]",
  muted: "bg-[color-mix(in_srgb,var(--text-muted)_10%,transparent)] text-[var(--text-muted)] ring-[color-mix(in_srgb,var(--text-muted)_28%,transparent)]",
};

export function Badge({
  tone = "slate",
  title,
  children,
}: {
  tone?: LegacyTone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-[1px] text-[11px] leading-4 ring-1 ring-inset ${BADGE_TONE[resolveTone(tone)]}`}
    >
      {children}
    </span>
  );
}

type ButtonVariant = "default" | "primary" | "danger" | "ghost";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  default:
    "bg-[var(--bg-elevated)] text-[var(--text-primary)] ring-1 ring-inset ring-[var(--border-strong)] hover:bg-[color-mix(in_srgb,var(--bg-elevated)_70%,var(--text-muted))]",
  primary: "bg-[var(--accent-solid)] text-white hover:bg-[var(--accent-solid-hover)]",
  danger: "bg-[color-mix(in_srgb,var(--danger)_75%,#7f1d1d)] text-white hover:bg-[var(--danger)]",
  ghost: "bg-transparent text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]",
};

export function Button({
  children,
  onClick,
  disabled = false,
  variant = "default",
  title,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: ButtonVariant;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${BUTTON_VARIANT[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? "bg-[var(--accent-solid)]" : "bg-[var(--border-strong)]"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? "left-[18px]" : "left-0.5"}`}
      />
    </button>
  );
}

const FIELD =
  "rounded-md border border-[var(--border-strong)] bg-[var(--bg-input)] px-2 py-1 text-xs text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";

export function TextInput({
  value,
  onChange,
  placeholder,
  disabled = false,
  mono = false,
  className = "",
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
  className?: string;
}) {
  return (
    <input
      type="text"
      spellCheck={false}
      disabled={disabled}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className={`min-w-0 flex-1 ${FIELD} ${mono ? "mono" : ""} ${className}`}
    />
  );
}

export function NumberInput({
  value,
  onChange,
  step = 1,
  placeholder,
  disabled = false,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
  step?: number;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="number"
      step={step}
      disabled={disabled}
      value={value === null ? "" : String(value)}
      placeholder={placeholder}
      onChange={(event) => {
        const raw = event.target.value;
        if (raw === "") {
          onChange(null);
          return;
        }
        const parsed = Number(raw);
        onChange(Number.isFinite(parsed) ? parsed : null);
      }}
      className={`w-28 min-w-0 ${FIELD}`}
    />
  );
}

export function Select({
  value,
  onChange,
  options,
  disabled = false,
  className = "",
}: {
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  className?: string;
}) {
  return (
    <select
      disabled={disabled}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={`min-w-0 ${FIELD} ${className}`}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Section({
  title,
  right,
  children,
  className = "",
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-md border border-[var(--border-subtle)] bg-[var(--bg-panel)] ${className}`}>
      <header className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <h2 className="text-xs font-semibold tracking-wide text-[var(--text-secondary)]">{title}</h2>
        {right}
      </header>
      <div className="px-3 py-2.5">{children}</div>
    </section>
  );
}

/** 复制到剪贴板：file:// 下 navigator.clipboard 可能不可用，所以留一条 textarea 兜底 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到下面的兜底方案
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function formatClock(at: number): string {
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
