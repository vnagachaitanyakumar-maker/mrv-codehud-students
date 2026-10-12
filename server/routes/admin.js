import { Router } from "express";
import { requireRole } from "../auth.js";
import { VIOLATION_TYPES } from "../db.js";
import {
  expireDueSessions,
  getPolicies,
  HttpError,
  serializeActivity,
  serializeSession,
  serializeViolation,
  updatePolicy,
} from "../contestService.js";

const ACTIVITY_SELECT = `
  SELECT a.*, u.name AS student_name, u.email AS student_email, c.title AS contest_title
  FROM exam_activity a JOIN users u ON u.id = a.student_id JOIN contests c ON c.id = a.contest_id`;

const VIOLATION_SELECT = `
  SELECT v.*, u.name AS student_name, u.email AS student_email, c.title AS contest_title
  FROM violations v JOIN users u ON u.id = v.student_id JOIN contests c ON c.id = v.contest_id`;

const SESSION_SELECT = `
  SELECT s.*, u.name AS student_name, u.email AS student_email, c.title AS contest_title,
         c.duration_minutes,
         (SELECT COUNT(*) FROM violations v WHERE v.session_id = s.id) AS violation_count,
         (SELECT COUNT(*) FROM questions q WHERE q.contest_id = s.contest_id) AS total_questions
  FROM contest_sessions s JOIN users u ON u.id = s.student_id JOIN contests c ON c.id = s.contest_id`;

const toInt = (v) => (v == null || v === "" ? null : Number.isInteger(Number(v)) ? Number(v) : NaN);

function serializeAdminSession(row) {
  return {
    ...serializeSession(row),
    studentName: row.student_name,
    studentEmail: row.student_email,
    contestTitle: row.contest_title,
    violationCount: row.violation_count,
    totalQuestions: row.total_questions,
    durationMinutes: row.duration_minutes,
  };
}

export function adminRouter(db) {
  const r = Router();
  r.use(requireRole("admin", "teacher"));
  r.use((_req, _res, next) => {
    expireDueSessions(db);
    next();
  });

  r.get("/overview", (_req, res) => {
    const count = (sql, ...args) => db.prepare(sql).get(...args).n;
    const since = Date.now() - 24 * 60 * 60 * 1000;
    res.json({
      totalViolations: count("SELECT COUNT(*) AS n FROM violations"),
      violationsLast24h: count("SELECT COUNT(*) AS n FROM violations WHERE recorded_at >= ?", since),
      terminatedSessions: count("SELECT COUNT(*) AS n FROM contest_sessions WHERE status = 'terminated'"),
      activeSessions: count("SELECT COUNT(*) AS n FROM contest_sessions WHERE status = 'in_progress' AND ends_at > ?", Date.now()),
      completedSessions: count("SELECT COUNT(*) AS n FROM contest_sessions WHERE status IN ('submitted','expired')"),
      byType: db.prepare("SELECT type, COUNT(*) AS count FROM violations GROUP BY type").all()
        .map((r) => ({ type: r.type, label: VIOLATION_TYPES[r.type] || r.type, count: r.count })),
      latestViolationId: db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM violations").get().n,
      latestActivityId: db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM exam_activity").get().n,
      totalStudents: count("SELECT COUNT(*) AS n FROM users WHERE role = 'student'"),
      averagePercentage: db
        .prepare("SELECT ROUND(AVG(score * 100.0 / max_score), 1) AS n FROM contest_sessions WHERE status IN ('submitted','expired') AND max_score > 0")
        .get().n,
      serverTime: new Date().toISOString(),
    });
  });

  r.get("/violations", (req, res) => {
    const afterId = toInt(req.query.afterId);
    const studentId = toInt(req.query.studentId);
    const contestId = toInt(req.query.contestId);
    const limit = Math.min(Math.max(toInt(req.query.limit) || 100, 1), 500);
    const type = req.query.type || null;
    if ([afterId, studentId, contestId].some(Number.isNaN)) throw new HttpError(400, "Invalid numeric filter");
    if (type && !VIOLATION_TYPES[type]) throw new HttpError(400, "Unknown violation type");
    const where = [];
    const args = [];
    if (afterId != null) { where.push("v.id > ?"); args.push(afterId); }
    if (studentId != null) { where.push("v.student_id = ?"); args.push(studentId); }
    if (contestId != null) { where.push("v.contest_id = ?"); args.push(contestId); }
    if (type) { where.push("v.type = ?"); args.push(type); }
    const sql = `${VIOLATION_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY v.id DESC LIMIT ?`;
    res.json({ violations: db.prepare(sql).all(...args, limit).map(serializeViolation) });
  });

  r.get("/sessions", (req, res) => {
    const status = req.query.status || null;
    if (status && !["in_progress", "submitted", "expired", "terminated"].includes(status)) {
      throw new HttpError(400, "Invalid status filter");
    }
    const sql = `${SESSION_SELECT} ${status ? "WHERE s.status = ?" : ""} ORDER BY COALESCE(s.ended_at, s.started_at) DESC LIMIT 500`;
    const rows = status ? db.prepare(sql).all(status) : db.prepare(sql).all();
    res.json({ sessions: rows.map(serializeAdminSession) });
  });

  r.get("/sessions/:id", (req, res) => {
    const id = toInt(req.params.id);
    const row = Number.isInteger(id) ? db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) : null;
    if (!row) throw new HttpError(404, "Session not found");
    const answers = db
      .prepare(
        `SELECT q.id AS questionId, q.position, q.prompt, q.type, q.correct_answer AS correctAnswer, q.points,
                a.answer, a.updated_at AS updatedAt
         FROM questions q LEFT JOIN answers a ON a.question_id = q.id AND a.session_id = ?
         WHERE q.contest_id = ? ORDER BY q.position`,
      )
      .all(row.id, row.contest_id)
      .map((a) => ({ ...a, updatedAt: a.updatedAt ? new Date(a.updatedAt).toISOString() : null }));
    const violations = db.prepare(`${VIOLATION_SELECT} WHERE v.session_id = ? ORDER BY v.id`).all(row.id).map(serializeViolation);
    const history = db
      .prepare(`${VIOLATION_SELECT} WHERE v.student_id = ? ORDER BY v.id DESC LIMIT 100`)
      .all(row.student_id)
      .map(serializeViolation);
    const activity = db.prepare(`${ACTIVITY_SELECT} WHERE a.session_id = ? ORDER BY a.id`).all(row.id).map(serializeActivity);
    res.json({ session: serializeAdminSession(row), answers, violations, studentHistory: history, activity });
  });

  r.get("/live", (_req, res) => {
    const live = db
      .prepare(`${SESSION_SELECT} WHERE s.status = 'in_progress' ORDER BY s.started_at DESC`)
      .all()
      .map(serializeAdminSession);
    const contests = db.prepare("SELECT id, title, duration_minutes FROM contests ORDER BY id").all();
    const students = db.prepare("SELECT id, name, email FROM users WHERE role = 'student' ORDER BY name").all();
    const sessions = new Map(
      db.prepare(`${SESSION_SELECT}`).all().map((row) => [`${row.contest_id}:${row.student_id}`, serializeAdminSession(row)]),
    );
    const roster = contests.map((c) => ({
      contestId: c.id,
      contestTitle: c.title,
      durationMinutes: c.duration_minutes,
      students: students.map((st) => {
        const session = sessions.get(`${c.id}:${st.id}`) || null;
        return {
          studentId: st.id,
          studentName: st.name,
          studentEmail: st.email,
          status: session ? session.status : "not_started",
          statusLabel: session ? session.statusLabel : "Not Started",
          session,
        };
      }),
    }));
    res.json({ live, roster, serverTime: new Date().toISOString() });
  });

  r.get("/results", (req, res) => {
    const contestId = toInt(req.query.contestId);
    if (Number.isNaN(contestId)) throw new HttpError(400, "Invalid contestId");
    const sql = `${SESSION_SELECT} WHERE s.status <> 'in_progress' ${contestId != null ? "AND s.contest_id = ?" : ""}
                 ORDER BY s.ended_at DESC LIMIT 500`;
    const rows = contestId != null ? db.prepare(sql).all(contestId) : db.prepare(sql).all();
    res.json({ results: rows.map(serializeAdminSession) });
  });

  r.get("/activity", (req, res) => {
    const afterId = toInt(req.query.afterId);
    const studentId = toInt(req.query.studentId);
    const sessionId = toInt(req.query.sessionId);
    if ([afterId, studentId, sessionId].some(Number.isNaN)) throw new HttpError(400, "Invalid numeric filter");
    const limit = Math.min(Math.max(toInt(req.query.limit) || 100, 1), 500);
    const where = [];
    const args = [];
    if (afterId != null) { where.push("a.id > ?"); args.push(afterId); }
    if (studentId != null) { where.push("a.student_id = ?"); args.push(studentId); }
    if (sessionId != null) { where.push("a.session_id = ?"); args.push(sessionId); }
    const sql = `${ACTIVITY_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.id DESC LIMIT ?`;
    res.json({ activity: db.prepare(sql).all(...args, limit).map(serializeActivity) });
  });

  r.get("/students", (_req, res) => {
    const rows = db
      .prepare(
        `SELECT u.id, u.name, u.email,
                COUNT(s.id) AS attempts,
                SUM(CASE WHEN s.status = 'in_progress' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN s.status = 'terminated' THEN 1 ELSE 0 END) AS terminated,
                ROUND(AVG(CASE WHEN s.status IN ('submitted','expired') AND s.max_score > 0 THEN s.score * 100.0 / s.max_score END), 1) AS avg_pct,
                (SELECT COUNT(*) FROM violations v WHERE v.student_id = u.id) AS violations,
                MAX(COALESCE(s.last_activity_at, s.started_at)) AS last_activity
         FROM users u LEFT JOIN contest_sessions s ON s.student_id = u.id
         WHERE u.role = 'student' GROUP BY u.id ORDER BY u.name`,
      )
      .all();
    res.json({
      students: rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        attempts: r.attempts,
        active: r.active || 0,
        terminated: r.terminated || 0,
        averagePercentage: r.avg_pct,
        violations: r.violations,
        lastActivityAt: r.last_activity ? new Date(r.last_activity).toISOString() : null,
      })),
    });
  });

  r.get("/students/:id", (req, res) => {
    const id = toInt(req.params.id);
    const student = Number.isInteger(id)
      ? db.prepare("SELECT id, name, email FROM users WHERE id = ? AND role = 'student'").get(id)
      : null;
    if (!student) throw new HttpError(404, "Student not found");
    const attempts = db.prepare(`${SESSION_SELECT} WHERE s.student_id = ? ORDER BY s.started_at DESC`).all(id).map(serializeAdminSession);
    const violations = db.prepare(`${VIOLATION_SELECT} WHERE v.student_id = ? ORDER BY v.id DESC LIMIT 200`).all(id).map(serializeViolation);
    const activity = db.prepare(`${ACTIVITY_SELECT} WHERE a.student_id = ? ORDER BY a.id DESC LIMIT 200`).all(id).map(serializeActivity);
    res.json({ student, attempts, violations, activity });
  });

  r.get("/policies", (_req, res) => res.json({ policies: getPolicies(db) }));

  r.put("/policies/:type", requireRole("admin"), (req, res) => {
    res.json({ policy: updatePolicy(db, req.params.type, req.body, req.user.id) });
  });

  return r;
}
