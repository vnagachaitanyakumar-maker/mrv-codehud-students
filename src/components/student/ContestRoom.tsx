import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Ban, CheckCircle2, Clock, Maximize, ShieldAlert } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { ContestSummary, Session, SessionPayload, ViolationResult, ViolationType } from "@/lib/types";
import { useContestGuard } from "./useContestGuard";

type Phase = "gate" | "active" | "ended";

function eventId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function formatRemaining(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function ContestRoom({ contest, onExit }: { contest: ContestSummary; onExit: () => void }) {
  const [phase, setPhase] = useState<Phase>(
    contest.session && contest.session.status !== "in_progress" ? "ended" : "gate",
  );
  const [payload, setPayload] = useState<SessionPayload | null>(null);
  const [session, setSession] = useState<Session | null>(contest.session);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(!!document.fullscreenElement);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const armedRef = useRef(false);
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const dirtyRef = useRef(new Set<number>());
  const clockOffsetRef = useRef(0);
  const warningsUsedRef = useRef(0);

  const answerList = () =>
    Object.entries(answersRef.current).map(([questionId, answer]) => ({ questionId: Number(questionId), answer }));

  const finish = useCallback((s: Session) => {
    armedRef.current = false;
    setSession(s);
    setPhase("ended");
    setLocked(true);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }, []);

  const load = useCallback((p: SessionPayload) => {
    setPayload(p);
    setSession(p.session);
    setAnswers(Object.fromEntries(p.answers.map((a) => [a.questionId, a.answer])));
    clockOffsetRef.current = Date.parse(p.serverNow) - Date.now();
    warningsUsedRef.current = p.violations.filter((v) => v.actionTaken === "warned").length;
    if (p.session.status === "in_progress") {
      armedRef.current = true;
      setLocked(false);
      setPhase("active");
    } else {
      finish(p.session);
    }
  }, [finish]);

  async function start() {
    setError(null);
    setBusy(true);
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    } catch {
      setBusy(false);
      setError("Fullscreen mode is required to start this contest. Please allow fullscreen and try again.");
      return;
    }
    try {
      const p = await api<SessionPayload>(`/student/contests/${contest.id}/start`, {
        method: "POST",
        body: { fullscreen: !!document.fullscreenElement },
      });
      load(p);
    } catch (e) {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      const err = e as ApiError;
      if (err.data?.session) finish(err.data.session as Session);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const reportViolation = useCallback(async (type: ViolationType, opts?: { unloading?: boolean }) => {
    if (!armedRef.current || !payload || !session) return;
    const policy = payload.policies.find((p) => p.type === type);
    if (!policy?.enabled) return;

    const willTerminate = policy.action === "terminate" || warningsUsedRef.current + 1 > policy.maxWarnings;
    if (willTerminate) {
      armedRef.current = false;
      setLocked(true);
    }
    const body = { type, clientEventId: eventId(), occurredAt: Date.now(), answers: answerList() };
    const path = `/student/sessions/${session.id}/violations`;

    if (opts?.unloading) {
      api(path, { method: "POST", body, keepalive: true }).catch(() => {});
      return;
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await api<ViolationResult>(path, { method: "POST", body });
        if (result.session.status !== "in_progress") {
          finish(result.session);
        } else if (result.action === "warned") {
          warningsUsedRef.current = result.warningsUsed ?? warningsUsedRef.current + 1;
          setWarning(result.reason ?? "Violation recorded.");
          if (willTerminate) { armedRef.current = true; setLocked(false); }
        } else if (willTerminate) {
          armedRef.current = true;
          setLocked(false);
        }
        return;
      } catch (e) {
        if (e instanceof ApiError && e.status < 500) {
          setError(e.message);
          return;
        }
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    setError("Could not reach the server to record a policy event. Your contest is locked until the connection is restored.");
  }, [payload, session, finish]);

  useContestGuard(phase === "active", reportViolation);

  const refreshSession = useCallback(async () => {
    if (!session) return;
    const p = await api<SessionPayload>(`/student/sessions/${session.id}`);
    if (p.session.status !== "in_progress") finish(p.session);
  }, [session, finish]);

  // Debounced autosave of changed answers.
  useEffect(() => {
    if (phase !== "active" || !session || dirtyRef.current.size === 0) return;
    const t = setTimeout(async () => {
      const ids = [...dirtyRef.current];
      dirtyRef.current.clear();
      try {
        const res = await api<{ savedAt: string }>(`/student/sessions/${session.id}/answers`, {
          method: "PUT",
          body: { answers: ids.map((id) => ({ questionId: id, answer: answersRef.current[id] ?? "" })) },
        });
        setSavedAt(res.savedAt);
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) await refreshSession();
        else ids.forEach((id) => dirtyRef.current.add(id));
      }
    }, 700);
    return () => clearTimeout(t);
  }, [answers, phase, session, refreshSession]);

  const submit = useCallback(async (auto = false) => {
    if (!session || (!auto && !window.confirm("Submit your answers? You cannot change them afterwards."))) return;
    armedRef.current = false;
    setLocked(true);
    try {
      const res = await api<{ session: Session }>(`/student/sessions/${session.id}/submit`, {
        method: "POST",
        body: { answers: answerList() },
      });
      finish(res.session);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) await refreshSession();
      else {
        setError((e as Error).message);
        armedRef.current = true;
        setLocked(false);
      }
    }
  }, [session, finish, refreshSession]);

  // Countdown timer, synced to server clock.
  const endsAt = session ? Date.parse(session.endsAt) : 0;
  const remaining = endsAt - (now + clockOffsetRef.current);
  useEffect(() => {
    if (phase !== "active") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);
  useEffect(() => {
    if (phase === "active" && remaining <= 0 && !locked) submit(true);
  }, [phase, remaining, locked, submit]);

  async function reenterFullscreen() {
    try {
      await document.documentElement.requestFullscreen();
      setError(null);
    } catch {
      setError("Fullscreen could not be enabled. Please allow fullscreen to continue the contest.");
    }
  }

  const inputsDisabled = locked || !isFullscreen;

  function setAnswer(questionId: number, value: string) {
    if (inputsDisabled || phase !== "active") return;
    dirtyRef.current.add(questionId);
    setAnswers((a) => ({ ...a, [questionId]: value }));
  }

  if (phase === "ended" && session) {
    if (session.status === "terminated") {
      return (
        <div className="mx-auto max-w-2xl rounded-xl border-2 border-red-300 bg-white p-8 text-center shadow-sm" data-testid="termination-screen">
          <Ban className="mx-auto h-14 w-14 text-red-600" />
          <h1 className="mt-4 text-2xl font-bold text-red-700">Contest Terminated</h1>
          <p className="mt-1 font-semibold text-red-600">Terminated for Policy Violation</p>
          <p className="mt-4 rounded bg-red-50 px-4 py-3 text-sm text-red-800">{session.terminationReason}</p>
          <dl className="mt-4 grid grid-cols-2 gap-2 text-left text-sm text-slate-600">
            <dt>Contest</dt><dd className="font-medium text-slate-900">{contest.title}</dd>
            <dt>Terminated at</dt><dd className="font-medium text-slate-900">{session.endedAt && new Date(session.endedAt).toLocaleString()}</dd>
          </dl>
          <p className="mt-4 text-sm text-slate-600">
            The timer has been stopped and the answers you entered before the violation have been saved.
            This session is locked: answers cannot be modified and the contest cannot be resumed. Contact your
            administrator if you believe this was a mistake.
          </p>
          <button onClick={onExit} className="mt-6 inline-flex items-center gap-1 rounded-md bg-slate-800 px-4 py-2 text-sm text-white">
            <ArrowLeft className="h-4 w-4" /> Back to contests
          </button>
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" />
        <h1 className="mt-4 text-xl font-semibold">{session.statusLabel}</h1>
        <p className="mt-2 text-slate-600">Score: <span className="font-semibold">{session.score} / {session.maxScore}</span></p>
        <button onClick={onExit} className="mt-6 inline-flex items-center gap-1 rounded-md bg-slate-800 px-4 py-2 text-sm text-white">
          <ArrowLeft className="h-4 w-4" /> Back to contests
        </button>
      </div>
    );
  }

  if (phase === "gate") {
    return (
      <div className="mx-auto max-w-2xl rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <button onClick={onExit} className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <h1 className="text-xl font-semibold">{contest.title}</h1>
        <p className="mt-1 text-sm text-slate-600">{contest.description}</p>
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="mb-2 flex items-center gap-2 font-semibold"><ShieldAlert className="h-4 w-4" /> Proctored contest rules</div>
          <ul className="list-disc space-y-1 pl-5">
            <li>The contest runs in fullscreen mode. Exiting fullscreen is a policy violation.</li>
            <li>Copy (Ctrl+C), paste (Ctrl+V) and cut (Ctrl+X) are prohibited.</li>
            <li>Violations are logged and may immediately terminate your session according to the active policy.</li>
            <li>A terminated session cannot be resumed and its answers are locked.</li>
          </ul>
        </div>
        {error && <p className="mt-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <button onClick={start} disabled={busy}
          className="mt-6 inline-flex items-center gap-2 rounded-md bg-indigo-600 px-5 py-2.5 font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
          <Maximize className="h-4 w-4" />
          {contest.session?.status === "in_progress" ? "Enter fullscreen & resume" : "Enter fullscreen & start contest"}
        </button>
      </div>
    );
  }

  if (!payload || !session) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-50 select-none" data-testid="contest-room">
      {!isFullscreen && !locked && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/80 p-6" data-testid="fullscreen-required">
          <div className="max-w-md rounded-xl bg-white p-6 text-center shadow-xl">
            <Maximize className="mx-auto h-10 w-10 text-indigo-600" />
            <h2 className="mt-3 text-lg font-semibold">Fullscreen required</h2>
            <p className="mt-2 text-sm text-slate-600">
              You left fullscreen mode. This has been recorded. Your answers are locked until you return to fullscreen.
            </p>
            <button onClick={reenterFullscreen}
              className="mt-4 inline-flex items-center gap-2 rounded-md bg-indigo-600 px-5 py-2.5 font-medium text-white hover:bg-indigo-700">
              <Maximize className="h-4 w-4" /> Re-enter fullscreen
            </button>
          </div>
        </div>
      )}
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-3">
          <div>
            <div className="font-semibold">{payload.contest.title}</div>
            <div className="text-xs text-slate-500">{savedAt ? `All changes saved · ${new Date(savedAt).toLocaleTimeString()}` : "Answers autosave as you type"}</div>
          </div>
          <div className={`flex items-center gap-2 rounded-md px-3 py-1.5 font-mono text-lg ${remaining < 60000 ? "bg-red-50 text-red-700" : "bg-slate-100"}`} data-testid="timer">
            <Clock className="h-4 w-4" /> {formatRemaining(remaining)}
          </div>
        </div>
      </div>
      <div className="mx-auto max-w-4xl space-y-4 px-6 py-6">
        {warning && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4" /> <span>{warning}</span>
          </div>
        )}
        {error && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {payload.questions.map((q) => (
          <div key={q.id} className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex justify-between text-sm text-slate-500">
              <span>Question {q.position}</span><span>{q.points} pts</span>
            </div>
            <p className="mt-1 font-medium">{q.prompt}</p>
            {q.type === "mcq" ? (
              <div className="mt-3 space-y-2">
                {q.options!.map((opt) => (
                  <label key={opt} className="flex cursor-pointer items-center gap-2 text-sm">
                    <input type="radio" name={`q${q.id}`} value={opt} disabled={inputsDisabled}
                      checked={answers[q.id] === opt} onChange={() => setAnswer(q.id, opt)} />
                    {opt}
                  </label>
                ))}
              </div>
            ) : (
              <textarea value={answers[q.id] ?? ""} disabled={inputsDisabled} onChange={(e) => setAnswer(q.id, e.target.value)}
                data-testid={`answer-${q.id}`} rows={3}
                className="mt-3 w-full rounded-md border border-slate-300 p-2 text-sm select-text focus:border-indigo-500 focus:outline-none disabled:bg-slate-100" />
            )}
          </div>
        ))}
        <button onClick={() => submit(false)} disabled={inputsDisabled}
          className="rounded-md bg-emerald-600 px-5 py-2.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-60">
          Submit contest
        </button>
      </div>
    </div>
  );
}
