import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertOctagon, Ban, GraduationCap, Percent, RefreshCw, Users, X } from "lucide-react";
import { api } from "@/lib/api";
import type { ActivityItem, AdminSession, LiveData, Overview, Policy, SessionStatus, Violation } from "@/lib/types";
import StatusBadge from "@/components/StatusBadge";
import ResultSummary, { formatDuration } from "@/components/ResultSummary";
import { fmt, Stat, Table } from "./ui";
import { ActivityList, LiveExams, NOTIFY_EVENTS, NotificationBell, ResultsPanel, StudentsPanel, Toasts } from "./MonitoringPanels";

const POLL_MS = 3000;
const TOAST_MS = 8000;
type Tab = "live" | "results" | "students" | "activity" | "incidents" | "sessions" | "policies";
const TAB_LABELS: Record<Tab, string> = {
  live: "Live monitoring",
  results: "Results",
  students: "Students & history",
  activity: "Activity log",
  incidents: "Violation incidents",
  sessions: "All sessions",
  policies: "Violation policies",
};


export default function AdminDashboard({ canEditPolicies }: { canEditPolicies: boolean }) {
  const [tab, setTab] = useState<Tab>("live");
  const [live, setLive] = useState<LiveData | null>(null);
  const [results, setResults] = useState<AdminSession[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [notifications, setNotifications] = useState<ActivityItem[]>([]);
  const [toasts, setToasts] = useState<ActivityItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [pollCount, setPollCount] = useState(0);
  const latestActivityRef = useRef<number | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [statusFilter, setStatusFilter] = useState<SessionStatus | "">("");
  const [typeFilter, setTypeFilter] = useState("");
  const [freshIds, setFreshIds] = useState<Set<number>>(new Set());
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const latestIdRef = useRef<number | null>(null);

  const poll = useCallback(async () => {
    try {
      const vQuery = new URLSearchParams({ limit: "200" });
      if (typeFilter) vQuery.set("type", typeFilter);
      const sQuery = statusFilter ? `?status=${statusFilter}` : "";
      const [ov, v, s, lv, rs, act] = await Promise.all([
        api<Overview>("/admin/overview"),
        api<{ violations: Violation[] }>(`/admin/violations?${vQuery}`),
        api<{ sessions: AdminSession[] }>(`/admin/sessions${sQuery}`),
        api<LiveData>("/admin/live"),
        api<{ results: AdminSession[] }>("/admin/results"),
        api<{ activity: ActivityItem[] }>("/admin/activity?limit=200"),
      ]);
      const prevActivity = latestActivityRef.current;
      if (prevActivity !== null) {
        const news = act.activity.filter((a) => a.id > prevActivity && NOTIFY_EVENTS.has(a.event)).reverse();
        if (news.length) {
          setNotifications((n) => [...news.slice().reverse(), ...n].slice(0, 100));
          setUnread((u) => u + news.length);
          setToasts((t) => [...t, ...news].slice(-5));
          news.forEach((a) => setTimeout(() => setToasts((t) => t.filter((x) => x.id !== a.id)), TOAST_MS));
        }
      }
      latestActivityRef.current = Math.max(prevActivity ?? 0, ov.latestActivityId, act.activity[0]?.id ?? 0);
      setLive(lv);
      setResults(rs.results);
      setActivity(act.activity);
      setPollCount((c) => c + 1);
      if (latestIdRef.current !== null) {
        const fresh = v.violations.filter((x) => x.id > latestIdRef.current!).map((x) => x.id);
        if (fresh.length) setFreshIds(new Set(fresh));
      }
      latestIdRef.current = ov.latestViolationId;
      setOverview(ov);
      setViolations(v.violations);
      setSessions(s.sessions);
      setLastUpdated(new Date());
      setPollError(null);
    } catch (e) {
      setPollError((e as Error).message);
    }
  }, [statusFilter, typeFilter]);

  useEffect(() => {
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [poll]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Exam Monitoring Dashboard</h1>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className={`h-2 w-2 rounded-full ${pollError ? "bg-red-500" : "animate-pulse bg-emerald-500"}`} />
          {pollError ? `Update failed: ${pollError}` : `Live · polling every ${POLL_MS / 1000}s`}
          {lastUpdated && <span>· updated {lastUpdated.toLocaleTimeString()}</span>}
          <button onClick={poll} className="rounded p-1 hover:bg-slate-200" title="Refresh now"><RefreshCw className="h-3.5 w-3.5" /></button>
          <NotificationBell items={notifications} unread={unread} onOpen={() => setUnread(0)} />
        </div>
      </div>

      {overview && (
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6" data-testid="overview">
          <Stat icon={<AlertOctagon className="h-5 w-5 text-amber-600" />} label="Total violations" value={overview.totalViolations} sub={`${overview.violationsLast24h} in last 24h`} />
          <Stat icon={<Ban className="h-5 w-5 text-red-600" />} label="Terminated sessions" value={overview.terminatedSessions} />
          <Stat icon={<Activity className="h-5 w-5 text-blue-600" />} label="Active sessions" value={overview.activeSessions} />
          <Stat icon={<Users className="h-5 w-5 text-emerald-600" />} label="Completed sessions" value={overview.completedSessions} />
          <Stat icon={<GraduationCap className="h-5 w-5 text-indigo-600" />} label="Students" value={overview.totalStudents} />
          <Stat icon={<Percent className="h-5 w-5 text-slate-600" />} label="Average score" value={overview.averagePercentage == null ? "—" : `${overview.averagePercentage}%`} />
        </div>
      )}

      <div className="flex gap-1 border-b border-slate-200">
        {(Object.keys(TAB_LABELS) as Tab[]).filter((t) => t !== "policies" || canEditPolicies).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium capitalize ${tab === t ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === "live" && <LiveExams data={live} onOpen={setDetailId} />}
      {tab === "results" && <ResultsPanel results={results} onOpen={setDetailId} />}
      {tab === "students" && <StudentsPanel refreshKey={pollCount} onOpen={setDetailId} />}
      {tab === "activity" && <ActivityList items={activity} />}

      {tab === "incidents" && (
        <div className="space-y-3">
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1 text-sm">
            <option value="">All violation types</option>
            <option value="copy">Copy</option>
            <option value="paste">Paste</option>
            <option value="cut">Cut</option>
            <option value="fullscreen_exit">Fullscreen exit</option>
            <option value="tab_switch">Tab switch</option>
          </select>
          <Table headers={["Time", "Student", "Contest", "Violation", "Action", "Reason", ""]} empty="No violations recorded yet." rows={violations.map((v) => (
            <tr key={v.id} className={`border-t border-slate-100 ${freshIds.has(v.id) ? "bg-amber-50" : ""}`}>
              <td className="px-3 py-2 whitespace-nowrap">{fmt(v.timestamp)}</td>
              <td className="px-3 py-2"><div className="font-medium">{v.studentName}</div><div className="text-xs text-slate-500">ID {v.studentId} · {v.studentEmail}</div></td>
              <td className="px-3 py-2">{v.contestTitle} <span className="text-xs text-slate-500">(#{v.contestId})</span></td>
              <td className="px-3 py-2">{v.typeLabel}</td>
              <td className="px-3 py-2"><span className={`rounded px-2 py-0.5 text-xs font-medium ${v.actionTaken === "terminated" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"}`}>{v.actionTaken}</span></td>
              <td className="px-3 py-2 text-xs text-slate-600">{v.reason}</td>
              <td className="px-3 py-2"><button onClick={() => setDetailId(v.sessionId)} className="text-xs text-indigo-600 hover:underline">Details</button></td>
            </tr>
          ))} />
        </div>
      )}

      {tab === "sessions" && (
        <div className="space-y-3">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as SessionStatus | "")} className="rounded-md border border-slate-300 px-2 py-1 text-sm">
            <option value="">All sessions</option>
            <option value="terminated">Terminated for Policy Violation</option>
            <option value="in_progress">In progress</option>
            <option value="submitted">Submitted</option>
            <option value="expired">Time expired</option>
          </select>
          <Table headers={["Student", "Contest", "Status", "Started", "Ended", "Violations", "Score", ""]} empty="No sessions." rows={sessions.map((s) => (
            <tr key={s.id} className="border-t border-slate-100">
              <td className="px-3 py-2"><div className="font-medium">{s.studentName}</div><div className="text-xs text-slate-500">ID {s.studentId}</div></td>
              <td className="px-3 py-2">{s.contestTitle}</td>
              <td className="px-3 py-2"><StatusBadge status={s.status} /></td>
              <td className="px-3 py-2 whitespace-nowrap">{fmt(s.startedAt)}</td>
              <td className="px-3 py-2 whitespace-nowrap">{fmt(s.endedAt)}</td>
              <td className="px-3 py-2">{s.violationCount}</td>
              <td className="px-3 py-2">{s.score == null ? "—" : `${s.score}/${s.maxScore}`}</td>
              <td className="px-3 py-2"><button onClick={() => setDetailId(s.id)} className="text-xs text-indigo-600 hover:underline">Details</button></td>
            </tr>
          ))} />
        </div>
      )}

      {tab === "policies" && canEditPolicies && <PolicyEditor />}
      {detailId !== null && <SessionDetail id={detailId} refreshKey={pollCount} onClose={() => setDetailId(null)} />}
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}

function PolicyEditor() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<{ policies: Policy[] }>("/admin/policies").then((r) => setPolicies(r.policies)).catch((e) => setMessage({ ok: false, text: e.message }));
  }, []);

  const update = (type: string, patch: Partial<Policy>) =>
    setPolicies((ps) => ps.map((p) => (p.type === type ? { ...p, ...patch } : p)));

  async function save(p: Policy) {
    try {
      const res = await api<{ policy: Policy }>(`/admin/policies/${p.type}`, {
        method: "PUT",
        body: { enabled: p.enabled, action: p.action, maxWarnings: p.maxWarnings },
      });
      update(p.type, res.policy);
      setMessage({ ok: true, text: `Saved policy for "${res.policy.label}" at ${new Date(res.policy.updatedAt).toLocaleTimeString()}.` });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        <strong>Terminate</strong> ends the session on the first occurrence. <strong>Warn</strong> allows the given number of
        warnings (shared across all violation types in a session) and terminates on the next violation.
      </p>
      {message && <p className={`rounded px-3 py-2 text-sm ${message.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{message.text}</p>}
      <Table headers={["Violation", "Enabled", "Action", "Allowed warnings", "Last updated", ""]} empty="No policies." rows={policies.map((p) => (
        <tr key={p.type} className="border-t border-slate-100" data-testid={`policy-${p.type}`}>
          <td className="px-3 py-2 font-medium">{p.label}</td>
          <td className="px-3 py-2"><input type="checkbox" checked={p.enabled} onChange={(e) => update(p.type, { enabled: e.target.checked })} /></td>
          <td className="px-3 py-2">
            <select value={p.action} onChange={(e) => update(p.type, { action: e.target.value as Policy["action"] })} className="rounded border border-slate-300 px-2 py-1">
              <option value="terminate">Terminate immediately</option>
              <option value="warn">Warn, then terminate</option>
            </select>
          </td>
          <td className="px-3 py-2">
            <input type="number" min={0} max={20} disabled={p.action === "terminate"} value={p.maxWarnings}
              onChange={(e) => update(p.type, { maxWarnings: Number(e.target.value) })} className="w-20 rounded border border-slate-300 px-2 py-1 disabled:bg-slate-100" />
          </td>
          <td className="px-3 py-2 text-xs text-slate-500">{fmt(p.updatedAt)}</td>
          <td className="px-3 py-2"><button onClick={() => save(p)} className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700">Save</button></td>
        </tr>
      ))} />
    </div>
  );
}

interface Detail {
  session: AdminSession;
  answers: { questionId: number; position: number; prompt: string; answer: string | null; correctAnswer: string | null; points: number; updatedAt: string | null }[];
  violations: Violation[];
  studentHistory: Violation[];
  activity: ActivityItem[];
}

function SessionDetail({ id, refreshKey, onClose }: { id: number; refreshKey: number; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Detail>(`/admin/sessions/${id}`).then(setDetail).catch((e) => setError(e.message));
  }, [id, refreshKey]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6" onClick={onClose}>
      <div className="w-full max-w-3xl rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Exam attempt #{id}</h2>
          <button onClick={onClose}><X className="h-5 w-5" /></button>
        </div>
        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
        {detail && (
          <div className="mt-4 space-y-5 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <div>Student: <strong>{detail.session.studentName}</strong> (ID {detail.session.studentId})</div>
              <div>Contest: <strong>{detail.session.contestTitle}</strong> (ID {detail.session.contestId})</div>
              <div>Status: <StatusBadge status={detail.session.status} /></div>
              <div>Score: {detail.session.score == null ? "—" : `${detail.session.score}/${detail.session.maxScore}`}</div>
              <div>Started: {fmt(detail.session.startedAt)}</div>
              <div>Ended: {fmt(detail.session.endedAt)}</div>
              <div>Answered: {detail.session.answeredCount}/{detail.session.totalQuestions}</div>
              <div>Time remaining: {formatDuration(detail.session.timeRemainingSeconds)}</div>
            </div>
            <ResultSummary session={detail.session} />
            {detail.session.terminationReason && <p className="rounded bg-red-50 px-3 py-2 text-red-800">{detail.session.terminationReason}</p>}
            <section>
              <h3 className="mb-2 font-semibold">Violations in this session</h3>
              {detail.violations.length === 0 ? <p className="text-slate-500">None</p> : (
                <ul className="space-y-1">{detail.violations.map((v) => (
                  <li key={v.id} className="rounded border border-slate-200 px-3 py-2">
                    <span className="font-medium">{v.typeLabel}</span> · {v.actionTaken} · {fmt(v.timestamp)}
                    <div className="text-xs text-slate-500">{v.reason} · IP {v.ip ?? "?"}</div>
                  </li>
                ))}</ul>
              )}
            </section>
            <section>
              <h3 className="mb-2 font-semibold">{detail.session.status === "in_progress" ? "Saved answers (live)" : "Saved answers (locked)"}</h3>
              <ul className="space-y-1">{detail.answers.map((a) => (
                <li key={a.questionId} className="rounded border border-slate-200 px-3 py-2">
                  <div className="text-slate-500">Q{a.position}. {a.prompt}</div>
                  <div>Answer: <strong>{a.answer ?? "— (not answered)"}</strong> <span className="text-xs text-slate-500">correct: {a.correctAnswer}</span></div>
                </li>
              ))}</ul>
            </section>
            <section>
              <h3 className="mb-2 font-semibold">Activity timeline</h3>
              <ActivityList items={detail.activity} compact />
            </section>
            <section>
              <h3 className="mb-2 font-semibold">Student incident history ({detail.studentHistory.length})</h3>
              <ul className="space-y-1">{detail.studentHistory.map((v) => (
                <li key={v.id} className="text-xs text-slate-600">{fmt(v.timestamp)} · {v.contestTitle} · {v.typeLabel} · {v.actionTaken}</li>
              ))}</ul>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
