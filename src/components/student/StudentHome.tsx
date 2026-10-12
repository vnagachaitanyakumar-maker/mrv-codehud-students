import { useCallback, useEffect, useState } from "react";
import { Clock, History, ListChecks } from "lucide-react";
import { api } from "@/lib/api";
import type { ContestSummary, HistoryAttempt } from "@/lib/types";
import ContestRoom from "./ContestRoom";
import StatusBadge from "@/components/StatusBadge";
import ResultSummary, { formatDuration } from "@/components/ResultSummary";

export default function StudentHome() {
  const [contests, setContests] = useState<ContestSummary[]>([]);
  const [history, setHistory] = useState<HistoryAttempt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openContest, setOpenContest] = useState<ContestSummary | null>(null);

  const load = useCallback(() => {
    Promise.all([
      api<{ contests: ContestSummary[] }>("/student/contests"),
      api<{ attempts: HistoryAttempt[] }>("/student/history"),
    ])
      .then(([c, h]) => {
        setContests(c.contests);
        setHistory(h.attempts);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  if (openContest) {
    return <ContestRoom contest={openContest} onExit={() => { setOpenContest(null); load(); }} />;
  }

  return (
    <div className="space-y-8">
      <section>
        <h1 className="mb-4 text-xl font-semibold">Exams</h1>
        {error && <p className="mb-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="grid gap-4 md:grid-cols-2">
          {contests.map((c) => (
            <div key={c.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm" data-testid={`contest-${c.id}`}>
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-semibold">{c.title}</h2>
                <StatusBadge status={c.session?.status ?? "not_started"} />
              </div>
              <p className="mt-1 text-sm text-slate-600">{c.description}</p>
              <div className="mt-3 flex gap-4 text-xs text-slate-500">
                <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" />{c.durationMinutes} min</span>
                <span className="flex items-center gap-1"><ListChecks className="h-3.5 w-3.5" />{c.questionCount} questions</span>
              </div>
              {c.session?.status === "terminated" && (
                <p className="mt-3 rounded bg-red-50 px-3 py-2 text-xs text-red-700">{c.session.terminationReason}</p>
              )}
              {c.session && c.session.status !== "in_progress" && <div className="mt-3"><ResultSummary session={c.session} /></div>}
              <button onClick={() => setOpenContest(c)}
                className="mt-4 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
                {!c.session ? "Open exam" : c.session.status === "in_progress" ? "Resume exam" : "View result"}
              </button>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold"><History className="h-5 w-5" /> My exam history</h2>
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm" data-testid="student-history">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>{["Exam", "Status", "Started", "Submitted", "Marks", "%", "Correct", "Incorrect", "Duration"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-500">No attempts yet.</td></tr>
              ) : history.map((a) => (
                <tr key={a.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-medium">{a.contestTitle}</td>
                  <td className="px-3 py-2"><StatusBadge status={a.status} /></td>
                  <td className="px-3 py-2 whitespace-nowrap">{new Date(a.startedAt).toLocaleString()}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{a.endedAt ? new Date(a.endedAt).toLocaleString() : "—"}</td>
                  <td className="px-3 py-2">{a.score == null ? "—" : `${a.score}/${a.maxScore}`}</td>
                  <td className="px-3 py-2">{a.percentage == null ? "—" : `${a.percentage}%`}</td>
                  <td className="px-3 py-2">{a.correctCount ?? "—"}</td>
                  <td className="px-3 py-2">{a.incorrectCount ?? "—"}</td>
                  <td className="px-3 py-2">{formatDuration(a.durationSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
