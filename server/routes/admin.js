import { Router } from "express";
import { requireRole } from "../auth.js";
import { VIOLATION_TYPES } from "../db.js";
import { getPolicies, HttpError, serializeSession, serializeViolation, updatePolicy } from "../contestService.js";

const VIOLATION_SELECT = `
  SELECT v.*, u.name AS student_name, u.email AS student_email, c.title AS contest_title
  FROM violations v JOIN users u ON u.id = v.student_id JOIN contests c ON c.id = v.contest_id`;

const SESSION_SELECT = `
  SELECT s.*, u.name AS student_name, u.email AS student_email, c.title AS contest_title,
         (SELECT COUNT(*) FROM violations v WHERE v.session_id = s.id) AS violation_count
  FROM contest_sessions s JOIN users u ON u.id = s.student_id JOIN contests c ON c.id = s.contest_id`;

const toInt = (v) => (v == null || v === "" ? null : Number.isInteger(Number(v)) ? Number(v) : NaN);

function serializeAdminSession(row) {
  return {
    ...serializeSession(row),
    studentName: row.student_name,
    studentEmail: row.student_email,
    contestTitle: row.contest_title,
    violationCount: row.violation_count,
  };
}

export function adminRouter(db) {
  const r = Router();
  r.use(requireRole("admin"));

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
    res.json({ session: serializeAdminSession(row), answers, violations, studentHistory: history });
  });

  r.get("/policies", (_req, res) => res.json({ policies: getPolicies(db) }));

  r.put("/policies/:type", (req, res) => {
    res.json({ policy: updatePolicy(db, req.params.type, req.body, req.user.id) });
  });

  return r;
}
