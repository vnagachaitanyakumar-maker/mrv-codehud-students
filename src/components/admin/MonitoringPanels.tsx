import { useEffect, useState } from "react";
import { Bell, CheckCircle2, PlayCircle, Ban, Clock, X } from "lucide-react";
import { api } from "@/lib/api";
import type { ActivityItem, AdminSession, LiveData, StudentDetail, StudentSummary } from "@/lib/types";
import StatusBadge from "@/components/StatusBadge";
import { formatDuration } from "@/components/ResultSummary";
import { fmt, fmtTime, Table, td } from "./ui";

const pct = (v: number | null | undefined) => (v == null ? "—" : `${v}%`);
const marks = (s: AdminSession) => (s.score == null ? "—" : `${s.score}/${s.maxScore}`);

export function LiveExams({ data, onOpen }: { data: LiveData | null; onOpen: (sessionId: number) => void }) {
  const [contestId, setContestId] = useState<number | null>(null);
  const roster = data?.roster.find((c) => c.contestId === contestId) ?? data?.roster[0];
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="font-semibold">Students currently taking exams ({data?.live.length ?? 0})</h2>
        <Table testId="live-table" headers={["Student", "Student ID", "Exam", "Start time", "Status", "Answered", "Time remaining", "Last activity", "Violations", ""]}
          empty="No students are taking an exam right now." rows={(data?.live ?? []).map((s) => (
            <tr key={s.id} className="border-t border-slate-100">
              <td className={td}><div className="font-medium">{s.studentName}</div><div className="text-xs text-slate-500">{s.studentEmail}</div></td>
              <td className={td}>{s.studentId}</td>
              <td className={td}>{s.contestTitle}</td>
              <td className={`${td} whitespace-nowrap`}>{fmt(s.startedAt)}</td>
              <td className={td}><StatusBadge status={s.status} /></td>
              <td className={td}>{s.answeredCount}/{s.totalQuestions}</td>
              <td className={`${td} font-mono`}>{formatDuration(s.timeRemainingSeconds)}</td>
              <td className={`${td} whitespace-nowrap text-xs`}>{fmtTime(s.lastActivityAt)}</td>
              <td className={td}>{s.violationCount}</td>
              <td className={td}><button onClick={() => onOpen(s.id)} className="text-xs text-indigo-600 hover:underline">Details</button></td>
            </tr>
          ))} />
      </section>
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Exam roster</h2>
          <select value={roster?.contestId ?? ""} onChange={(e) => setContestId(Number(e.target.value))} className="rounded-md border border-slate-300 px-2 py-1 text-sm">
            {data?.roster.map((c) => <option key={c.contestId} value={c.contestId}>{c.contestTitle}</option>)}
          </select>
        </div>
        <Table testId="roster-table" headers={["Student", "Student ID", "Status", "Started", "Submitted", "Marks", "%", ""]} empty="No students."
          rows={(roster?.students ?? []).map((r) => (
            <tr key={r.studentId} className="border-t border-slate-100">
              <td className={td}><div className="font-medium">{r.studentName}</div><div className="text-xs text-slate-500">{r.studentEmail}</div></td>
              <td className={td}>{r.studentId}</td>
              <td className={td}><StatusBadge status={r.status} /></td>
              <td className={`${td} whitespace-nowrap`}>{fmt(r.session?.startedAt)}</td>
              <td className={`${td} whitespace-nowrap`}>{fmt(r.session?.endedAt)}</td>
              <td className={td}>{r.session ? marks(r.session) : "—"}</td>
              <td className={td}>{pct(r.session?.percentage)}</td>
              <td className={td}>{r.session && <button onClick={() => onOpen(r.session!.id)} className="text-xs text-indigo-600 hover:underline">Details</button>}</td>
            </tr>
          ))} />
      </section>
    </div>
  );
}

export function ResultsPanel({ results, onOpen }: { results: AdminSession[]; onOpen: (sessionId: number) => void }) {
  return (
    <Table testId="results-table" headers={["Student", "Exam", "Status", "Submitted", "Marks", "Total", "%", "Correct", "Incorrect", "Unanswered", "Duration", "Violations", ""]}
      empty="No completed attempts yet." rows={results.map((s) => (
        <tr key={s.id} className="border-t border-slate-100">
          <td className={td}><div className="font-medium">{s.studentName}</div><div className="text-xs text-slate-500">ID {s.studentId}</div></td>
          <td className={td}>{s.contestTitle}</td>
          <td className={td}><StatusBadge status={s.status} /></td>
          <td className={`${td} whitespace-nowrap`}>{fmt(s.endedAt)}</td>
          <td className={`${td} font-semibold`}>{s.score ?? "—"}</td>
          <td className={td}>{s.maxScore ?? "—"}</td>
          <td className={td}>{pct(s.percentage)}</td>
          <td className={`${td} text-emerald-700`}>{s.correctCount ?? "—"}</td>
          <td className={`${td} text-red-700`}>{s.incorrectCount ?? "—"}</td>
          <td className={td}>{s.unansweredCount ?? "—"}</td>
          <td className={td}>{formatDuration(s.durationSeconds)}</td>
          <td className={td}>{s.violationCount}</td>
          <td className={td}><button onClick={() => onOpen(s.id)} className="text-xs text-indigo-600 hover:underline">Details</button></td>
        </tr>
      ))} />
  );
}

export function StudentsPanel({ refreshKey, onOpen }: { refreshKey: number; onOpen: (sessionId: number) => void }) {
  const [students, setStudents] = useState<StudentSummary[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ students: StudentSummary[] }>("/admin/students").then((r) => { setStudents(r.students); setError(null); }).catch((e) => setError(e.message));
  }, [refreshKey]);
  return (
    <div className="space-y-3">
      {error && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <Table testId="students-table" headers={["Student", "Student ID", "Attempts", "Active", "Terminated", "Average %", "Violations", "Last activity", ""]}
        empty="No students." rows={students.map((s) => (
          <tr key={s.id} className="border-t border-slate-100">
            <td className={td}><div className="font-medium">{s.name}</div><div className="text-xs text-slate-500">{s.email}</div></td>
            <td className={td}>{s.id}</td>
            <td className={td}>{s.attempts}</td>
            <td className={td}>{s.active}</td>
            <td className={td}>{s.terminated}</td>
            <td className={td}>{pct(s.averagePercentage)}</td>
            <td className={td}>{s.violations}</td>
            <td className={`${td} whitespace-nowrap text-xs`}>{fmt(s.lastActivityAt)}</td>
            <td className={td}><button onClick={() => setSelected(s.id)} className="text-xs text-indigo-600 hover:underline">View history</button></td>
          </tr>
        ))} />
      {selected !== null && <StudentHistory id={selected} refreshKey={refreshKey} onClose={() => setSelected(null)} onOpen={onOpen} />}
    </div>
  );
}

function StudentHistory({ id, refreshKey, onClose, onOpen }: { id: number; refreshKey: number; onClose: () => void; onOpen: (sessionId: number) => void }) {
  const [d, setD] = useState<StudentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<StudentDetail>(`/admin/students/${id}`).then(setD).catch((e) => setError(e.message));
  }, [id, refreshKey]);
  const finished = d?.attempts.filter((a) => a.percentage != null && a.status !== "terminated") ?? [];
  const avg = finished.length ? Math.round((finished.reduce((t, a) => t + (a.percentage ?? 0), 0) / finished.length) * 10) / 10 : null;
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-6" onClick={onClose}>
      <div className="w-full max-w-5xl rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()} data-testid="student-history-modal">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{d ? `${d.student.name} · ID ${d.student.id}` : "Student"} — exam history</h2>
          <button onClick={onClose}><X className="h-5 w-5" /></button>
        </div>
        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
        {d && (
          <div className="mt-4 space-y-5 text-sm">
            <p className="text-slate-600">{d.student.email} · {d.attempts.length} attempt(s) · average {pct(avg)} · {d.violations.length} violation(s)</p>
            <section>
              <h3 className="mb-2 font-semibold">Attempts &amp; results</h3>
              <Table headers={["Exam", "Status", "Started", "Ended", "Marks", "%", "Correct", "Incorrect", "Duration", ""]} empty="No attempts."
                rows={d.attempts.map((a) => (
                  <tr key={a.id} className="border-t border-slate-100">
                    <td className={td}>{a.contestTitle}</td>
                    <td className={td}><StatusBadge status={a.status} /></td>
                    <td className={`${td} whitespace-nowrap`}>{fmt(a.startedAt)}</td>
                    <td className={`${td} whitespace-nowrap`}>{fmt(a.endedAt)}</td>
                    <td className={td}>{marks(a)}</td>
                    <td className={td}>{pct(a.percentage)}</td>
                    <td className={td}>{a.correctCount ?? "—"}</td>
                    <td className={td}>{a.incorrectCount ?? "—"}</td>
                    <td className={td}>{formatDuration(a.durationSeconds)}</td>
                    <td className={td}><button onClick={() => onOpen(a.id)} className="text-xs text-indigo-600 hover:underline">Details</button></td>
                  </tr>
                ))} />
            </section>
            <section>
              <h3 className="mb-2 font-semibold">Violations</h3>
              {d.violations.length === 0 ? <p className="text-slate-500">None</p> : (
                <ul className="space-y-1">{d.violations.map((v) => (
                  <li key={v.id} className="rounded border border-slate-200 px-3 py-2">
                    <span className="font-medium">{v.typeLabel}</span> · {v.contestTitle} · {v.actionTaken} · {fmt(v.timestamp)}
                    <div className="text-xs text-slate-500">{v.reason}</div>
                  </li>
                ))}</ul>
              )}
            </section>
            <section>
              <h3 className="mb-2 font-semibold">Activity timeline</h3>
              <ActivityList items={d.activity} compact />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

const EVENT_STYLE: Record<string, string> = {
  started: "bg-blue-100 text-blue-700",
  resumed: "bg-blue-50 text-blue-600",
  answer_saved: "bg-slate-100 text-slate-600",
  violation_warned: "bg-amber-100 text-amber-800",
  submitted: "bg-emerald-100 text-emerald-700",
  expired: "bg-teal-100 text-teal-700",
  terminated: "bg-red-100 text-red-700",
};

function describe(a: ActivityItem) {
  const d = a.details as Record<string, string | number | null> | null;
  if (!d) return "";
  if (a.event === "answer_saved") return `${d.answeredCount} question(s) answered`;
  if (a.event === "started") return `${d.durationMinutes} min exam`;
  if (a.event === "violation_warned" || a.event === "terminated") return String(d.reason ?? "");
  if (a.event === "submitted" || a.event === "expired") return `Score ${d.score}/${d.maxScore} · ${d.correct} correct, ${d.incorrect} incorrect`;
  return "";
}

export function ActivityList({ items, compact }: { items: ActivityItem[]; compact?: boolean }) {
  if (!items.length) return <p className="text-sm text-slate-500">No activity yet.</p>;
  return (
    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white text-sm" data-testid="activity-feed">
      {items.map((a) => (
        <li key={a.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
          <span className="w-40 shrink-0 text-xs text-slate-500">{fmt(a.timestamp)}</span>
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${EVENT_STYLE[a.event] ?? ""}`}>{a.eventLabel}</span>
          {!compact && <span className="font-medium">{a.studentName}</span>}
          <span className="text-slate-600">{a.contestTitle}</span>
          <span className="text-xs text-slate-500">{describe(a)}</span>
        </li>
      ))}
    </ul>
  );
}

export const NOTIFY_EVENTS = new Set(["started", "submitted", "expired", "terminated"]);

const NOTE_ICON: Record<string, React.ReactNode> = {
  started: <PlayCircle className="h-4 w-4 text-blue-600" />,
  submitted: <CheckCircle2 className="h-4 w-4 text-emerald-600" />,
  expired: <Clock className="h-4 w-4 text-teal-600" />,
  terminated: <Ban className="h-4 w-4 text-red-600" />,
};

function noteText(a: ActivityItem) {
  if (a.event === "started") return `${a.studentName} started ${a.contestTitle}`;
  if (a.event === "submitted") return `${a.studentName} submitted ${a.contestTitle}`;
  if (a.event === "expired") return `${a.studentName}'s time expired on ${a.contestTitle}`;
  return `${a.studentName}'s session on ${a.contestTitle} was terminated`;
}

export function Toasts({ toasts, onDismiss }: { toasts: ActivityItem[]; onDismiss: (id: number) => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2" data-testid="toasts">
      {toasts.map((t) => (
        <div key={t.id} role="status" className={`flex items-start gap-2 rounded-lg border bg-white p-3 text-sm shadow-lg ${t.event === "terminated" ? "border-red-300" : "border-slate-200"}`}>
          {NOTE_ICON[t.event]}
          <div className="flex-1">
            <div className="font-medium">{noteText(t)}</div>
            {t.event === "terminated" && <div className="text-xs text-red-700">{describe(t)}</div>}
            <div className="text-xs text-slate-500">{fmtTime(t.timestamp)}</div>
          </div>
          <button onClick={() => onDismiss(t.id)}><X className="h-4 w-4 text-slate-400" /></button>
        </div>
      ))}
    </div>
  );
}

export function NotificationBell({ items, unread, onOpen }: { items: ActivityItem[]; unread: number; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => { setOpen((o) => !o); onOpen(); }} className="relative rounded p-1 hover:bg-slate-200" title="Notifications" data-testid="notification-bell">
        <Bell className="h-4 w-4" />
        {unread > 0 && <span className="absolute -right-1 -top-1 rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">{unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-96 rounded-xl border border-slate-200 bg-white shadow-xl">
          <div className="border-b border-slate-100 px-3 py-2 text-sm font-semibold">Notifications</div>
          <ul className="max-h-96 overflow-y-auto text-sm">
            {items.length === 0 && <li className="px-3 py-4 text-center text-slate-500">No notifications yet.</li>}
            {items.map((a) => (
              <li key={a.id} className="flex items-start gap-2 border-b border-slate-50 px-3 py-2">
                {NOTE_ICON[a.event]}
                <div><div>{noteText(a)}</div><div className="text-xs text-slate-500">{fmt(a.timestamp)}</div></div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
