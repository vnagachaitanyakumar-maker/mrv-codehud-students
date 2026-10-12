import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createApp } from "../app.js";

let server;
let base;
let db;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codehub-test-"));

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

before(async () => {
  ({ app: server, db } = createApp({ dataDir, dbFile: path.join(dataDir, "test.db") }));
  await new Promise((resolve) => {
    server = server.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("auth & roles", () => {
  test("rejects bad credentials and unauthenticated access", async () => {
    assert.equal((await call("POST", "/api/auth/login", { body: { email: "admin@mrv.edu", password: "nope" } })).status, 401);
    assert.equal((await call("GET", "/api/admin/overview")).status, 401);
    assert.equal((await call("GET", "/api/admin/overview", { token: "forged.token" })).status, 401);
  });
  test("students cannot access admin APIs and admins cannot act as students", async () => {
    const s = await login("student1@mrv.edu", "Student@123");
    const a = await login("admin@mrv.edu", "Admin@123");
    assert.equal((await call("GET", "/api/admin/violations", { token: s })).status, 403);
    assert.equal((await call("PUT", "/api/admin/policies/copy", { token: s, body: { enabled: false, action: "warn", maxWarnings: 1 } })).status, 403);
    assert.equal((await call("POST", "/api/student/contests/1/start", { token: a, body: { fullscreen: true } })).status, 403);
  });
});

describe("contest termination flow", () => {
  let token;
  let sessionId;
  let questions;

  test("start requires fullscreen confirmation", async () => {
    token = await login("student1@mrv.edu", "Student@123");
    const r = await call("POST", "/api/student/contests/1/start", { token, body: {} });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /fullscreen/i);
  });

  test("starts session, never leaks correct answers, saves answers", async () => {
    const r = await call("POST", "/api/student/contests/1/start", { token, body: { fullscreen: true } });
    assert.equal(r.status, 201);
    assert.equal(r.body.session.status, "in_progress");
    questions = r.body.questions;
    assert.ok(questions.every((q) => !("correct_answer" in q) && !("correctAnswer" in q)));
    sessionId = r.body.session.id;
    const save = await call("PUT", `/api/student/sessions/${sessionId}/answers`, {
      token, body: { answers: [{ questionId: questions[0].id, answer: "O(log n)" }] },
    });
    assert.equal(save.status, 200);
  });

  test("rejects answers for questions outside the contest", async () => {
    const r = await call("PUT", `/api/student/sessions/${sessionId}/answers`, { token, body: { answers: [{ questionId: 9999, answer: "x" }] } });
    assert.equal(r.status, 400);
  });

  test("other students cannot touch this session", async () => {
    const other = await login("student2@mrv.edu", "Student@123");
    assert.equal((await call("GET", `/api/student/sessions/${sessionId}`, { token: other })).status, 404);
    assert.equal((await call("POST", `/api/student/sessions/${sessionId}/violations`, { token: other, body: { type: "copy", clientEventId: eid() } })).status, 404);
  });

  test("rejects unknown violation types", async () => {
    const r = await call("POST", `/api/student/sessions/${sessionId}/violations`, { token, body: { type: "hack", clientEventId: eid() } });
    assert.equal(r.status, 400);
  });

  test("paste terminates immediately, saves snapshot answers, records violation", async () => {
    const id = eid();
    const r = await call("POST", `/api/student/sessions/${sessionId}/violations`, {
      token,
      body: { type: "paste", clientEventId: id, occurredAt: Date.now(), answers: [{ questionId: questions[1].id, answer: "Stack" }] },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.action, "terminated");
    assert.equal(r.body.session.status, "terminated");
    assert.equal(r.body.session.statusLabel, "Terminated for Policy Violation");
    assert.match(r.body.session.terminationReason, /Terminated for Policy Violation: Paste/);
    assert.equal(r.body.session.score, 4);

    const dup = await call("POST", `/api/student/sessions/${sessionId}/violations`, { token, body: { type: "paste", clientEventId: id } });
    assert.equal(dup.status, 200);
    assert.equal(dup.body.duplicate, true);

    const rows = db.prepare("SELECT * FROM violations WHERE session_id = ?").all(sessionId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].student_id, 2);
    assert.equal(rows[0].contest_id, 1);
    assert.equal(rows[0].type, "paste");
    assert.ok(rows[0].recorded_at > 0);
    assert.match(rows[0].reason, /Terminated for Policy Violation/);
  });

  test("terminated session is locked and cannot be resumed", async () => {
    const save = await call("PUT", `/api/student/sessions/${sessionId}/answers`, { token, body: { answers: [{ questionId: questions[0].id, answer: "O(n)" }] } });
    assert.equal(save.status, 403);
    const submit = await call("POST", `/api/student/sessions/${sessionId}/submit`, { token, body: { answers: [] } });
    assert.equal(submit.status, 403);
    const resume = await call("POST", "/api/student/contests/1/start", { token, body: { fullscreen: true } });
    assert.equal(resume.status, 403);
    assert.equal(resume.body.session.status, "terminated");
    const stored = db.prepare("SELECT answer FROM answers WHERE session_id = ? AND question_id = ?").get(sessionId, questions[0].id);
    assert.equal(stored.answer, "O(log n)");
  });

  test("admin sees violation, terminated session and incident detail", async () => {
    const a = await login("admin@mrv.edu", "Admin@123");
    const ov = await call("GET", "/api/admin/overview", { token: a });
    assert.equal(ov.body.terminatedSessions, 1);
    assert.equal(ov.body.totalViolations, 1);
    const v = await call("GET", "/api/admin/violations?afterId=0", { token: a });
    assert.equal(v.body.violations[0].studentName, "Aarav Reddy");
    assert.equal(v.body.violations[0].type, "paste");
    const none = await call("GET", `/api/admin/violations?afterId=${ov.body.latestViolationId}`, { token: a });
    assert.equal(none.body.violations.length, 0);
    const s = await call("GET", "/api/admin/sessions?status=terminated", { token: a });
    assert.equal(s.body.sessions.length, 1);
    const d = await call("GET", `/api/admin/sessions/${sessionId}`, { token: a });
    assert.equal(d.body.violations.length, 1);
    assert.equal(d.body.answers.find((x) => x.questionId === questions[1].id).answer, "Stack");
  });
});

describe("configurable warn policy and duplicate protection", () => {
  test("warn policy allows N warnings then terminates; burst duplicates are ignored", async () => {
    const a = await login("admin@mrv.edu", "Admin@123");
    const bad = await call("PUT", "/api/admin/policies/copy", { token: a, body: { enabled: true, action: "warn", maxWarnings: 99 } });
    assert.equal(bad.status, 400);
    const ok = await call("PUT", "/api/admin/policies/copy", { token: a, body: { enabled: true, action: "warn", maxWarnings: 1 } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.policy.maxWarnings, 1);
    await call("PUT", "/api/admin/policies/fullscreen_exit", { token: a, body: { enabled: false, action: "terminate", maxWarnings: 0 } });

    const token = await login("student2@mrv.edu", "Student@123");
    const start = await call("POST", "/api/student/contests/1/start", { token, body: { fullscreen: true } });
    const sid = start.body.session.id;
    const url = `/api/student/sessions/${sid}/violations`;

    const ignored = await call("POST", url, { token, body: { type: "fullscreen_exit", clientEventId: eid() } });
    assert.equal(ignored.body.action, "ignored");

    const burst = await Promise.all([1, 2, 3].map(() => call("POST", url, { token, body: { type: "copy", clientEventId: eid() } })));
    assert.equal(burst.filter((r) => r.body.recorded).length, 1);
    assert.equal(burst.find((r) => r.body.recorded).body.action, "warned");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM violations WHERE session_id = ?").get(sid).n, 1);

    await new Promise((r) => setTimeout(r, 2100));
    const second = await call("POST", url, { token, body: { type: "copy", clientEventId: eid() } });
    assert.equal(second.body.action, "terminated");
    assert.match(second.body.session.terminationReason, /after the allowed 1 warning/);
  });
});
