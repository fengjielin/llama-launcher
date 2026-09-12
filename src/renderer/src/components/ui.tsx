import type { ReactNode } from "react";

export type Tone = "slate" | "sky" | "emerald" | "amber" | "rose" | "violet";

const BADGE_TONE: Record<Tone, string> = {
  slate: "bg-slate-500/10 text-slate-300 ring-slate-500/30",
  sky: "bg-sky-500/10 text-sky-300 ring-sky-500/30",
  emerald: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30",
  amber: "bg-amber-500/10 text-amber-300 ring-amber-500/30",
  rose: "bg-rose-500/10 text-rose-300 ring-rose-500/30",
  violet: "bg-violet-500/10 text-violet-300 ring-violet-500/30",
};

export function Badge({ tone = "slate", title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-[1px] text-[11px] leading-4 ring-1 ring-inset ${BADGE_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

type ButtonVariant = "default" | "primary" | "danger" | "ghost";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  default: "bg-[#1b2230] text-slate-200 ring-1 ring-inset ring-[#2a3444] hover:bg-[#232c3d]",
  primary: "bg-sky-600 text-white hover:bg-sky-500",
  danger: "bg-rose-600 text-white hover:bg-rose-500",
  ghost: "bg-transparent text-slate-400 hover:bg-[#1b2230] hover:text-slate-200",
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
        checked ? "bg-sky-600" : "bg-[#2a3444]"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? "left-[18px]" : "left-0.5"}`}
      />
    </button>
  );
}

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
      className={`min-w-0 flex-1 rounded-md border border-[#2a3444] bg-[#0d1117] px-2 py-1 text-xs text-slate-200 outline-none transition-colors placeholder:text-slate-600 focus:border-sky-600 disabled:cursor-not-allowed disabled:opacity-50 ${
        mono ? "mono" : ""
      } ${className}`}
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
      className="w-28 min-w-0 rounded-md border border-[#2a3444] bg-[#0d1117] px-2 py-1 text-xs text-slate-200 outline-none focus:border-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
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
      className={`min-w-0 rounded-md border border-[#2a3444] bg-[#0d1117] px-2 py-1 text-xs text-slate-200 outline-none focus:border-sky-600 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
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
    <section className={`rounded-lg border border-[#1e2530] bg-[#11151d] ${className}`}>
      <header className="flex items-center justify-between gap-2 border-b border-[#1e2530] px-3 py-2">
        <h2 className="text-xs font-semibold tracking-wide text-slate-300">{title}</h2>
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
