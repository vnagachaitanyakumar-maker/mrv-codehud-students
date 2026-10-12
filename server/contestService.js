import { VIOLATION_TYPES, tx } from "./db.js";

export const DUPLICATE_WINDOW_MS = 2000;
const MAX_ANSWER_LENGTH = 5000;

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

export function serializeSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    contestId: row.contest_id,
    studentId: row.student_id,
    status: row.status,
    statusLabel: statusLabel(row.status),
    startedAt: iso(row.started_at),
    endsAt: iso(row.ends_at),
    endedAt: iso(row.ended_at),
    terminationReason: row.termination_reason,
    score: row.score,
    maxScore: row.max_score,
  };
}

export function statusLabel(status) {
  return {
    in_progress: "In Progress",
    submitted: "Submitted",
    expired: "Time Expired (Auto-submitted)",
    terminated: "Terminated for Policy Violation",
  }[status];
}

export function getPolicies(db) {
  const rows = db.prepare("SELECT type, enabled, action, max_warnings, updated_at FROM violation_policies ORDER BY type").all();
  return rows
    .filter((r) => VIOLATION_TYPES[r.type])
    .map((r) => ({
      type: r.type,
      label: VIOLATION_TYPES[r.type],
      enabled: !!r.enabled,
      action: r.action,
      maxWarnings: r.max_warnings,
      updatedAt: iso(r.updated_at),
    }));
}

export function updatePolicy(db, type, body, adminId) {
  if (!VIOLATION_TYPES[type]) throw new HttpError(404, "Unknown violation type");
  const { enabled, action, maxWarnings } = body || {};
  if (typeof enabled !== "boolean") throw new HttpError(400, "enabled must be a boolean");
  if (!["terminate", "warn"].includes(action)) throw new HttpError(400, "action must be 'terminate' or 'warn'");
  if (!Number.isInteger(maxWarnings) || maxWarnings < 0 || maxWarnings > 20) {
    throw new HttpError(400, "maxWarnings must be an integer between 0 and 20");
  }
  db.prepare(
    "UPDATE violation_policies SET enabled = ?, action = ?, max_warnings = ?, updated_at = ?, updated_by = ? WHERE type = ?",
  ).run(enabled ? 1 : 0, action, action === "terminate" ? 0 : maxWarnings, Date.now(), adminId, type);
  return getPolicies(db).find((p) => p.type === type);
}

export function publicQuestions(db, contestId) {
  return db
    .prepare("SELECT id, position, prompt, type, options, points FROM questions WHERE contest_id = ? ORDER BY position")
    .all(contestId)
    .map((q) => ({ ...q, options: q.options ? JSON.parse(q.options) : null }));
}

function computeScore(db, session) {
  const questions = db.prepare("SELECT id, type, correct_answer, points FROM questions WHERE contest_id = ?").all(session.contest_id);
  const answers = new Map(
    db.prepare("SELECT question_id, answer FROM answers WHERE session_id = ?").all(session.id).map((a) => [a.question_id, a.answer]),
  );
  let score = 0;
  let max = 0;
  for (const q of questions) {
    max += q.points;
    const given = answers.get(q.id);
    if (given == null || q.correct_answer == null) continue;
    const ok =
      q.type === "mcq"
        ? given === q.correct_answer
        : given.trim().toLowerCase() === q.correct_answer.trim().toLowerCase();
    if (ok) score += q.points;
  }
  return { score, max };
}

function finalizeSession(db, session, status, reason = null) {
  const { score, max } = computeScore(db, session);
  db.prepare(
    "UPDATE contest_sessions SET status = ?, ended_at = ?, termination_reason = ?, score = ?, max_score = ? WHERE id = ? AND status = 'in_progress'",
  ).run(status, Date.now(), reason, score, max, session.id);
}

export function loadSession(db, sessionId) {
  const row = db.prepare("SELECT * FROM contest_sessions WHERE id = ?").get(sessionId);
  if (!row) return null;
  if (row.status === "in_progress" && Date.now() >= row.ends_at) {
    tx(db, () => finalizeSession(db, row, "expired"));
    return db.prepare("SELECT * FROM contest_sessions WHERE id = ?").get(sessionId);
  }
  return row;
}

export function loadOwnedSession(db, sessionId, user) {
  const id = Number(sessionId);
  if (!Number.isInteger(id)) throw new HttpError(400, "Invalid session id");
  const row = loadSession(db, id);
  if (!row || row.student_id !== user.id) throw new HttpError(404, "Session not found");
  return row;
}

function validateAnswers(db, session, answers) {
  if (!Array.isArray(answers)) throw new HttpError(400, "answers must be an array");
  if (answers.length > 200) throw new HttpError(400, "Too many answers");
  const questions = new Map(
    db.prepare("SELECT id, type, options FROM questions WHERE contest_id = ?").all(session.contest_id).map((q) => [q.id, q]),
  );
  return answers.map((a) => {
    const q = questions.get(a?.questionId);
    if (!q) throw new HttpError(400, `Question ${a?.questionId} does not belong to this contest`);
    if (typeof a.answer !== "string" || a.answer.length > MAX_ANSWER_LENGTH) throw new HttpError(400, "Invalid answer value");
    if (q.type === "mcq" && a.answer !== "" && !JSON.parse(q.options).includes(a.answer)) {
      throw new HttpError(400, "Answer is not one of the options");
    }
    return { questionId: q.id, answer: a.answer };
  });
}

function writeAnswers(db, sessionId, answers) {
  const upsert = db.prepare(
    `INSERT INTO answers (session_id, question_id, answer, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, question_id) DO UPDATE SET answer = excluded.answer, updated_at = excluded.updated_at`,
  );
  const now = Date.now();
  for (const a of answers) upsert.run(sessionId, a.questionId, a.answer, now);
}

function assertWritable(session) {
  if (session.status !== "in_progress") {
    throw new HttpError(403, `This session is ${statusLabel(session.status).toLowerCase()}. Answers are locked.`, {
      session: serializeSession(session),
    });
  }
}

export function saveAnswers(db, session, answers) {
  assertWritable(session);
  const clean = validateAnswers(db, session, answers);
  tx(db, () => {
    const fresh = db.prepare("SELECT * FROM contest_sessions WHERE id = ?").get(session.id);
    assertWritable(fresh);
    writeAnswers(db, session.id, clean);
  });
  return clean.length;
}

export function startSession(db, contestId, user, { fullscreen }) {
  const id = Number(contestId);
  const contest = Number.isInteger(id) ? db.prepare("SELECT * FROM contests WHERE id = ?").get(id) : null;
  if (!contest) throw new HttpError(404, "Contest not found");
  if (fullscreen !== true) throw new HttpError(400, "You must enter fullscreen mode before starting the contest.");

  return tx(db, () => {
    const existing = db.prepare("SELECT * FROM contest_sessions WHERE contest_id = ? AND student_id = ?").get(id, user.id);
    if (existing) {
      const current = existing.status === "in_progress" && Date.now() >= existing.ends_at
        ? (finalizeSession(db, existing, "expired"), db.prepare("SELECT * FROM contest_sessions WHERE id = ?").get(existing.id))
        : existing;
      if (current.status === "terminated") {
        throw new HttpError(403, "This contest session was terminated for a policy violation and cannot be resumed.", {
          session: serializeSession(current),
        });
      }
      if (current.status !== "in_progress") {
        throw new HttpError(409, "You have already completed this contest.", { session: serializeSession(current) });
      }
      return { session: current, resumed: true };
    }
    const now = Date.now();
    const result = db
      .prepare("INSERT INTO contest_sessions (contest_id, student_id, status, started_at, ends_at) VALUES (?, ?, 'in_progress', ?, ?)")
      .run(id, user.id, now, now + contest.duration_minutes * 60 * 1000);
    return { session: db.prepare("SELECT * FROM contest_sessions WHERE id = ?").get(result.lastInsertRowid), resumed: false };
  });
}

export function submitSession(db, session, answers) {
  assertWritable(session);
  const clean = answers ? validateAnswers(db, session, answers) : [];
  tx(db, () => {
    const fresh = db.prepare("SELECT * FROM contest_sessions WHERE id = ?").get(session.id);
    assertWritable(fresh);
    writeAnswers(db, session.id, clean);
    finalizeSession(db, fresh, "submitted");
  });
  return db.prepare("SELECT * FROM contest_sessions WHERE id = ?").get(session.id);
}

export function recordViolation(db, session, user, body, meta) {
  const { type, clientEventId, occurredAt, answers } = body || {};
  if (!VIOLATION_TYPES[type]) throw new HttpError(400, "Unknown violation type");
  if (typeof clientEventId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(clientEventId)) {
    throw new HttpError(400, "clientEventId must be 8-64 URL-safe characters");
  }
  const clientTs = Number.isFinite(occurredAt) ? Math.trunc(occurredAt) : null;
  const cleanAnswers = Array.isArray(answers) ? validateAnswers(db, session, answers) : [];

  return tx(db, () => {
    const fresh = db.prepare("SELECT * FROM contest_sessions WHERE id = ?").get(session.id);
    if (fresh.status !== "in_progress") {
      return { recorded: false, duplicate: true, action: fresh.status === "terminated" ? "terminated" : "none", session: fresh };
    }

    const policy = db.prepare("SELECT * FROM violation_policies WHERE type = ?").get(type);
    if (!policy || !policy.enabled) return { recorded: false, duplicate: false, action: "ignored", session: fresh };

    const sameEvent = db
      .prepare("SELECT id FROM violations WHERE session_id = ? AND client_event_id = ?")
      .get(fresh.id, clientEventId);
    const now = Date.now();
    const recentSameType = db
      .prepare("SELECT id FROM violations WHERE session_id = ? AND type = ? AND recorded_at > ?")
      .get(fresh.id, type, now - DUPLICATE_WINDOW_MS);
    if (sameEvent || recentSameType) {
      return { recorded: false, duplicate: true, action: "none", session: fresh };
    }

    if (cleanAnswers.length) writeAnswers(db, fresh.id, cleanAnswers);

    const { warnings } = db
      .prepare("SELECT COUNT(*) AS warnings FROM violations WHERE session_id = ? AND action_taken = 'warned'")
      .get(fresh.id);
    const label = VIOLATION_TYPES[type];
    let action;
    let reason;
    if (policy.action === "terminate") {
      action = "terminated";
      reason = `Terminated for Policy Violation: ${label} detected during the contest.`;
    } else if (warnings + 1 > policy.max_warnings) {
      action = "terminated";
      reason = `Terminated for Policy Violation: ${label} detected after the allowed ${policy.max_warnings} warning(s) were used.`;
    } else {
      action = "warned";
      reason = `Warning ${warnings + 1} of ${policy.max_warnings}: ${label} detected.`;
    }

    const inserted = db
      .prepare(
        `INSERT INTO violations (session_id, student_id, contest_id, type, client_event_id, client_timestamp, recorded_at, action_taken, reason, user_agent, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(fresh.id, user.id, fresh.contest_id, type, clientEventId, clientTs, now, action, reason,
        String(meta.userAgent || "").slice(0, 300), meta.ip || null);

    if (action === "terminated") finalizeSession(db, fresh, "terminated", reason);

    return {
      recorded: true,
      duplicate: false,
      action,
      reason,
      violationId: Number(inserted.lastInsertRowid),
      warningsUsed: action === "warned" ? warnings + 1 : warnings,
      maxWarnings: policy.max_warnings,
      session: db.prepare("SELECT * FROM contest_sessions WHERE id = ?").get(fresh.id),
    };
  });
}

export function serializeViolation(v) {
  return {
    id: v.id,
    sessionId: v.session_id,
    studentId: v.student_id,
    studentName: v.student_name,
    studentEmail: v.student_email,
    contestId: v.contest_id,
    contestTitle: v.contest_title,
    type: v.type,
    typeLabel: VIOLATION_TYPES[v.type] || v.type,
    actionTaken: v.action_taken,
    reason: v.reason,
    timestamp: iso(v.recorded_at),
    clientTimestamp: iso(v.client_timestamp),
    userAgent: v.user_agent,
    ip: v.ip,
  };
}
