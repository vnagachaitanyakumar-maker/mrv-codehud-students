import { Router } from "express";
import { requireRole } from "../auth.js";
import {
  getPolicies,
  loadOwnedSession,
  loadSession,
  publicQuestions,
  recordViolation,
  saveAnswers,
  serializeSession,
  serializeViolation,
  startSession,
  submitSession,
} from "../contestService.js";

export function studentRouter(db) {
  const r = Router();
  r.use(requireRole("student"));

  function sessionPayload(row) {
    const contest = db.prepare("SELECT id, title, description, duration_minutes FROM contests WHERE id = ?").get(row.contest_id);
    const answers = db.prepare("SELECT question_id AS questionId, answer FROM answers WHERE session_id = ?").all(row.id);
    const violations = db
      .prepare("SELECT * FROM violations WHERE session_id = ? ORDER BY recorded_at")
      .all(row.id)
      .map(serializeViolation);
    return {
      session: serializeSession(row),
      contest: { id: contest.id, title: contest.title, description: contest.description, durationMinutes: contest.duration_minutes },
      questions: publicQuestions(db, row.contest_id),
      answers,
      violations,
      policies: getPolicies(db),
      serverNow: new Date().toISOString(),
    };
  }

  r.get("/contests", (req, res) => {
    const contests = db
      .prepare(
        `SELECT c.id, c.title, c.description, c.duration_minutes, s.id AS session_id,
                (SELECT COUNT(*) FROM questions q WHERE q.contest_id = c.id) AS question_count
         FROM contests c LEFT JOIN contest_sessions s ON s.contest_id = c.id AND s.student_id = ?
         ORDER BY c.id`,
      )
      .all(req.user.id);
    res.json({
      contests: contests.map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        durationMinutes: c.duration_minutes,
        questionCount: c.question_count,
        session: c.session_id ? serializeSession(loadSession(db, c.session_id)) : null,
      })),
    });
  });

  r.post("/contests/:id/start", (req, res) => {
    const { session, resumed } = startSession(db, req.params.id, req.user, { fullscreen: req.body?.fullscreen });
    res.status(resumed ? 200 : 201).json({ ...sessionPayload(session), resumed });
  });

  r.get("/sessions/:id", (req, res) => {
    res.json(sessionPayload(loadOwnedSession(db, req.params.id, req.user)));
  });

  r.put("/sessions/:id/answers", (req, res) => {
    const session = loadOwnedSession(db, req.params.id, req.user);
    const saved = saveAnswers(db, session, req.body?.answers);
    res.json({ saved, savedAt: new Date().toISOString() });
  });

  r.post("/sessions/:id/submit", (req, res) => {
    const session = loadOwnedSession(db, req.params.id, req.user);
    const updated = submitSession(db, session, req.body?.answers);
    res.json({ session: serializeSession(updated) });
  });

  r.post("/sessions/:id/violations", (req, res) => {
    const session = loadOwnedSession(db, req.params.id, req.user);
    const result = recordViolation(db, session, req.user, req.body, { userAgent: req.get("user-agent"), ip: req.ip });
    res.status(result.recorded ? 201 : 200).json({ ...result, session: serializeSession(result.session) });
  });

  return r;
}
