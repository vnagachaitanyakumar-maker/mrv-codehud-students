import type { Session } from "@/lib/types";

export function formatDuration(seconds: number | null | undefined) {
  if (seconds == null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}h ${m}m ${s}s` : `${m}m ${s.toString().padStart(2, "0")}s`;
}

export default function ResultSummary({ session }: { session: Session }) {
  if (session.status === "in_progress") return null;
  const items: [string, string][] = [
    ["Marks", session.score == null ? "—" : `${session.score} / ${session.maxScore}`],
    ["Percentage", session.percentage == null ? "—" : `${session.percentage}%`],
    ["Correct", String(session.correctCount ?? "—")],
    ["Incorrect", String(session.incorrectCount ?? "—")],
    ["Unanswered", String(session.unansweredCount ?? "—")],
    ["Duration", formatDuration(session.durationSeconds)],
  ];
  return (
    <dl className="grid grid-cols-3 gap-2 text-left text-sm" data-testid="result-summary">
      {items.map(([k, v]) => (
        <div key={k} className="rounded-lg bg-slate-50 px-3 py-2">
          <dt className="text-xs text-slate-500">{k}</dt>
          <dd className="font-semibold text-slate-900">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
