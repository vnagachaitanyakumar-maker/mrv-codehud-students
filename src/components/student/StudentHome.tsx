import { useCallback, useEffect, useState } from "react";
import { Clock, ListChecks } from "lucide-react";
import { api } from "@/lib/api";
import type { ContestSummary } from "@/lib/types";
import ContestRoom from "./ContestRoom";
import StatusBadge from "@/components/StatusBadge";

export default function StudentHome() {
  const [contests, setContests] = useState<ContestSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openContest, setOpenContest] = useState<ContestSummary | null>(null);

  const load = useCallback(() => {
    api<{ contests: ContestSummary[] }>("/student/contests")
      .then((r) => setContests(r.contests))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  if (openContest) {
    return <ContestRoom contest={openContest} onExit={() => { setOpenContest(null); load(); }} />;
  }

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">Contests</h1>
      {error && <p className="mb-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        {contests.map((c) => (
          <div key={c.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <h2 className="font-semibold">{c.title}</h2>
              {c.session && <StatusBadge status={c.session.status} />}
            </div>
            <p className="mt-1 text-sm text-slate-600">{c.description}</p>
            <div className="mt-3 flex gap-4 text-xs text-slate-500">
              <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" />{c.durationMinutes} min</span>
              <span className="flex items-center gap-1"><ListChecks className="h-3.5 w-3.5" />{c.questionCount} questions</span>
            </div>
            {c.session?.status === "terminated" && (
              <p className="mt-3 rounded bg-red-50 px-3 py-2 text-xs text-red-700">{c.session.terminationReason}</p>
            )}
            {c.session && (c.session.status === "submitted" || c.session.status === "expired") && (
              <p className="mt-3 text-sm text-slate-700">Score: {c.session.score} / {c.session.maxScore}</p>
            )}
            <button onClick={() => setOpenContest(c)}
              className="mt-4 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
              {!c.session ? "Open contest" : c.session.status === "in_progress" ? "Resume contest" : "View result"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
