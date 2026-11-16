type Tone = "ok" | "warn" | "error" | "neutral";

const styles: Record<Tone, string> = {
  ok: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  warn: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  error: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  neutral: "bg-slate-500/15 text-slate-300 ring-slate-500/30"
};

export function StatusBadge({ label, tone = "neutral" }: { label: string; tone?: Tone }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${styles[tone]}`}>
      {label}
    </span>
  );
}

export function toneForState(state: string): Tone {
  if (state === "ok" || state === "ready") return "ok";
  if (state === "degraded" || state === "unknown") return "warn";
  if (state === "error" || state === "not_ready") return "error";
  return "neutral";
}
