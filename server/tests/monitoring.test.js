import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { createApp } from "../app.js";

let server;
let base;
let db;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codehub-monitor-"));

async function call(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const login = async (email, password) => (await call("POST", "/api/auth/login", { body: { email, password } })).body.token;
const eid = () => crypto.randomUUID().replaceAll("-", "");

let admin, teacher, s1, s2, s3;
const DSA = 1;

before(async () => {
  ({ app: server, db } = createApp({ dataDir, dbFile: path.join(dataDir, "test.db") }));
  await new Promise((resolve) => {
    server = server.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  [admin, teacher, s1, s2, s3] = await Promise.all([
    login("admin@mrv.edu", "Admin@123"),
    login("teacher@mrv.edu", "Teacher@123"),
    login("student1@mrv.edu", "Student@123"),
    login("student2@mrv.edu", "Student@123"),
    login("student3@mrv.edu", "Student@123"),
  ]);
});
after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("exam monitoring", () => {
  let sess1, sess2, questions;

  test("roles: teacher can read monitoring but not change policies; students are blocked", async () => {
    assert.equal((await call("GET", "/api/admin/live", { token: teacher })).status, 200);
    assert.equal((await call("GET", "/api/admin/students", { token: teacher })).status, 200);
    assert.equal((await call("PUT", "/api/admin/policies/copy", { token: teacher, body: { enabled: true, action: "terminate", maxWarnings: 0 } })).status, 403);
    for (const url of ["/api/admin/live", "/api/admin/results", "/api/admin/activity", "/api/admin/students", "/api/admin/students/3"]) {
      assert.equal((await call("GET", url, { token: s1 })).status, 403, url);
    }
    assert.equal((await call("GET", "/api/student/history", { token: teacher })).status, 403);
  });

  test("roster shows every student as Not Started before any attempt", async () => {
    const r = await call("GET", "/api/admin/live", { token: admin });
    assert.equal(r.body.live.length, 0);
    const dsa = r.body.roster.find((c) => c.contestId === DSA);
    assert.equal(dsa.students.length, 3);
    assert.ok(dsa.students.every((s) => s.status === "not_started" && s.statusLabel === "Not Started"));
  });

  test("two students start; both appear live with activity events", async () => {
    const a = await call("POST", `/api/student/contests/${DSA}/start`, { token: s1, body: { fullscreen: true } });
    const b = await call("POST", `/api/student/contests/${DSA}/start`, { token: s2, body: { fullscreen: true } });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    sess1 = a.body.session.id;
    sess2 = b.body.session.id;
    questions = a.body.questions;

    const live = (await call("GET", "/api/admin/live", { token: admin })).body;
    assert.deepEqual(live.live.map((s) => s.studentName).sort(), ["Aarav Reddy", "Diya Sharma"]);
    const row = live.live.find((s) => s.id === sess1);
    assert.equal(row.contestTitle, "DSA Weekly Contest #1");
    assert.equal(row.statusLabel, "In Progress");
    assert.ok(row.startedAt && row.timeRemainingSeconds > 0 && row.timeRemainingSeconds <= 1800);
    assert.equal(row.totalQuestions, 4);
    const roster = live.roster.find((c) => c.contestId === DSA).students;
    assert.equal(roster.find((s) => s.studentEmail === "student3@mrv.edu").statusLabel, "Not Started");

    const act = (await call("GET", "/api/admin/activity", { token: admin })).body.activity;
    assert.equal(act.filter((x) => x.event === "started").length, 2);
  });

  test("saving answers updates answered count and logs throttled activity", async () => {
    await call("PUT", `/api/student/sessions/${sess1}/answers`, { token: s1, body: { answers: [{ questionId: questions[0].id, answer: "O(log n)" }] } });
    await call("PUT", `/api/student/sessions/${sess1}/answers`, { token: s1, body: { answers: [{ questionId: questions[1].id, answer: "Queue" }] } });
    const row = (await call("GET", "/api/admin/live", { token: admin })).body.live.find((s) => s.id === sess1);
    assert.equal(row.answeredCount, 2);
    const saved = (await call("GET", `/api/admin/activity?sessionId=${sess1}`, { token: admin })).body.activity.filter((a) => a.event === "answer_saved");
    assert.equal(saved.length, 1);
  });

  test("submission is scored on the server with correct/incorrect counts; duplicates rejected", async () => {
    const submit = await call("POST", `/api/student/sessions/${sess1}/submit`, {
      token: s1,
      body: { answers: [{ questionId: questions[2].id, answer: "O(n^2)" }, { questionId: questions[3].id, answer: "  Dynamic Programming " }] },
    });
    assert.equal(submit.status, 200);
    const s = submit.body.session;
    assert.equal(s.status, "submitted");
    assert.equal(s.score, 8);
    assert.equal(s.maxScore, 10);
    assert.equal(s.percentage, 80);
    assert.equal(s.correctCount, 3);
    assert.equal(s.incorrectCount, 1);
    assert.equal(s.unansweredCount, 0);
    assert.ok(s.durationSeconds >= 0 && s.timeRemainingSeconds > 0);

    const again = await call("POST", `/api/student/sessions/${sess1}/submit`, { token: s1, body: { answers: [{ questionId: questions[1].id, answer: "Stack" }] } });
    assert.equal(again.status, 409);
    const tamper = await call("PUT", `/api/student/sessions/${sess1}/answers`, { token: s1, body: { answers: [{ questionId: questions[1].id, answer: "Stack" }] } });
    assert.equal(tamper.status, 409);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM exam_activity WHERE session_id = ? AND event = 'submitted'").get(sess1).n, 1);
    assert.equal(db.prepare("SELECT score FROM contest_sessions WHERE id = ?").get(sess1).score, 8);
  });

  test("termination by violation appears in results and activity with reason", async () => {
    const v = await call("POST", `/api/student/sessions/${sess2}/violations`, {
      token: s2, body: { type: "copy", clientEventId: eid(), occurredAt: Date.now(), answers: [{ questionId: questions[0].id, answer: "O(log n)" }] },
    });
    assert.equal(v.body.action, "terminated");
    const results = (await call("GET", "/api/admin/results", { token: teacher })).body.results;
    const t = results.find((r) => r.id === sess2);
    assert.equal(t.statusLabel, "Terminated for Policy Violation");
    assert.equal(t.correctCount, 1);
    assert.equal(t.unansweredCount, 3);
    const act = (await call("GET", `/api/admin/activity?sessionId=${sess2}`, { token: admin })).body.activity;
    const term = act.find((a) => a.event === "terminated");
    assert.equal(term.details.violationType, "copy");
    assert.match(term.details.reason, /Terminated for Policy Violation/);
    assert.equal((await call("GET", "/api/admin/live", { token: admin })).body.live.length, 0);
  });

  test("student history is private; admin student history aggregates attempts", async () => {
    const mine = (await call("GET", "/api/student/history", { token: s1 })).body.attempts;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].percentage, 80);
    assert.equal(mine[0].contestTitle, "DSA Weekly Contest #1");
    assert.equal((await call("GET", "/api/student/history", { token: s3 })).body.attempts.length, 0);
    assert.equal((await call("GET", `/api/student/sessions/${sess1}`, { token: s2 })).status, 404);

    const students = (await call("GET", "/api/admin/students", { token: admin })).body.students;
    const aarav = students.find((s) => s.email === "student1@mrv.edu");
    assert.equal(aarav.attempts, 1);
    assert.equal(aarav.averagePercentage, 80);
    const diya = students.find((s) => s.email === "student2@mrv.edu");
    assert.equal(diya.terminated, 1);
    assert.equal(diya.violations, 1);

    const detail = (await call("GET", `/api/admin/students/${diya.id}`, { token: admin })).body;
    assert.equal(detail.attempts.length, 1);
    assert.equal(detail.violations[0].type, "copy");
    assert.ok(detail.activity.some((a) => a.event === "started"));
  });

  test("expired sessions are auto-completed with server-side scoring", async () => {
    const r = await call("POST", "/api/student/contests/2/start", { token: s3, body: { fullscreen: true } });
    const id = r.body.session.id;
    await call("PUT", `/api/student/sessions/${id}/answers`, { token: s3, body: { answers: [{ questionId: r.body.questions[0].id, answer: "def" }] } });
    db.prepare("UPDATE contest_sessions SET ends_at = ? WHERE id = ?").run(Date.now() - 1000, id);
    const live = (await call("GET", "/api/admin/live", { token: admin })).body;
    assert.ok(!live.live.some((s) => s.id === id));
    const row = (await call("GET", "/api/admin/results", { token: admin })).body.results.find((x) => x.id === id);
    assert.equal(row.status, "expired");
    assert.equal(row.statusLabel, "Completed (Time Expired)");
    assert.equal(row.score, 2);
    assert.equal(row.correctCount, 1);
    assert.equal(row.timeRemainingSeconds, 0);
  });

  test("overview and activity cursor support polling", async () => {
    const o = (await call("GET", "/api/admin/overview", { token: admin })).body;
    assert.ok(o.latestActivityId > 0);
    assert.equal(o.totalStudents, 3);
    const none = (await call("GET", `/api/admin/activity?afterId=${o.latestActivityId}`, { token: admin })).body.activity;
    assert.equal(none.length, 0);
    assert.equal((await call("GET", "/api/admin/activity?afterId=abc", { token: admin })).status, 400);
  });
});

describe("migration", () => {
  test("upgrades a database created before teacher role and result columns existed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codehub-migrate-"));
    const file = path.join(dir, "old.db");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('student','admin')), created_at INTEGER NOT NULL);
      CREATE TABLE contests (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, duration_minutes INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE contest_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, contest_id INTEGER NOT NULL REFERENCES contests(id),
        student_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL, started_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
        ended_at INTEGER, termination_reason TEXT, score INTEGER, max_score INTEGER, UNIQUE (contest_id, student_id));
      INSERT INTO users VALUES (1, 'Old Student', 'old@mrv.edu', 'x', 'student', 0);
      INSERT INTO contests VALUES (1, 'Old Contest', '', 10, 0);
      INSERT INTO contest_sessions (contest_id, student_id, status, started_at, ends_at, ended_at, score, max_score)
        VALUES (1, 1, 'submitted', 0, 600000, 300000, 4, 10);`);
    old.close();
    const { db: upgraded } = createApp({ dataDir: dir, dbFile: file });
    assert.ok(upgraded.prepare("SELECT 1 FROM users WHERE role = 'teacher'").get());
    const cols = upgraded.prepare("PRAGMA table_info(contest_sessions)").all().map((c) => c.name);
    assert.ok(["correct_count", "answered_count", "time_remaining_ms", "last_activity_at"].every((c) => cols.includes(c)));
    assert.equal(upgraded.prepare("SELECT student_id FROM contest_sessions").get().student_id, 1);
    assert.equal(upgraded.prepare("PRAGMA foreign_key_check").all().length, 0);
    const legacy = upgraded.prepare("SELECT unanswered_count, time_remaining_ms FROM contest_sessions").get();
    assert.equal(legacy.unanswered_count, 0);
    assert.equal(legacy.time_remaining_ms, 300000);
    upgraded.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
