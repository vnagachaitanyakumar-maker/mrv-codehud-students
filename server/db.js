import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashPassword } from "./auth.js";

export const VIOLATION_TYPES = {
  copy: "Copy (Ctrl+C)",
  paste: "Paste (Ctrl+V)",
  cut: "Cut (Ctrl+X)",
  fullscreen_exit: "Exited fullscreen",
  tab_switch: "Switched tab / window",
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student','admin')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS contests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('mcq','text')),
  options TEXT,
  correct_answer TEXT,
  points INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS contest_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id INTEGER NOT NULL REFERENCES contests(id),
  student_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('in_progress','submitted','expired','terminated')),
  started_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  ended_at INTEGER,
  termination_reason TEXT,
  score INTEGER,
  max_score INTEGER,
  UNIQUE (contest_id, student_id)
);
CREATE TABLE IF NOT EXISTS answers (
  session_id INTEGER NOT NULL REFERENCES contest_sessions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  answer TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, question_id)
);
CREATE TABLE IF NOT EXISTS violations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES contest_sessions(id),
  student_id INTEGER NOT NULL REFERENCES users(id),
  contest_id INTEGER NOT NULL REFERENCES contests(id),
  type TEXT NOT NULL,
  client_event_id TEXT NOT NULL,
  client_timestamp INTEGER,
  recorded_at INTEGER NOT NULL,
  action_taken TEXT NOT NULL CHECK (action_taken IN ('warned','terminated')),
  reason TEXT NOT NULL,
  user_agent TEXT,
  ip TEXT,
  UNIQUE (session_id, client_event_id)
);
CREATE INDEX IF NOT EXISTS idx_violations_recorded ON violations(recorded_at);
CREATE INDEX IF NOT EXISTS idx_violations_session ON violations(session_id, type, recorded_at);
CREATE TABLE IF NOT EXISTS violation_policies (
  type TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  action TEXT NOT NULL CHECK (action IN ('terminate','warn')),
  max_warnings INTEGER NOT NULL DEFAULT 0 CHECK (max_warnings >= 0 AND max_warnings <= 20),
  updated_at INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);
`;

export function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  seed(db);
  return db;
}

export function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function seed(db) {
  const now = Date.now();
  const insertPolicy = db.prepare(
    "INSERT OR IGNORE INTO violation_policies (type, enabled, action, max_warnings, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const type of Object.keys(VIOLATION_TYPES)) {
    insertPolicy.run(type, type === "tab_switch" ? 0 : 1, "terminate", 0, now);
  }

  const { count } = db.prepare("SELECT COUNT(*) AS count FROM users").get();
  if (count > 0) return;

  tx(db, () => {
    const insertUser = db.prepare(
      "INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    insertUser.run(
      "Platform Admin",
      process.env.ADMIN_EMAIL || "admin@mrv.edu",
      hashPassword(process.env.ADMIN_PASSWORD || "Admin@123"),
      "admin",
      now,
    );
    insertUser.run("Aarav Reddy", "student1@mrv.edu", hashPassword("Student@123"), "student", now);
    insertUser.run("Diya Sharma", "student2@mrv.edu", hashPassword("Student@123"), "student", now);

    const contest = db
      .prepare("INSERT INTO contests (title, description, duration_minutes, created_at) VALUES (?, ?, ?, ?)")
      .run(
        "DSA Weekly Contest #1",
        "Arrays, complexity analysis and searching. Fullscreen proctored contest.",
        30,
        now,
      );
    const contestId = contest.lastInsertRowid;
    const insertQ = db.prepare(
      "INSERT INTO questions (contest_id, position, prompt, type, options, correct_answer, points) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertQ.run(contestId, 1, "What is the time complexity of binary search on a sorted array of n elements?", "mcq",
      JSON.stringify(["O(n)", "O(log n)", "O(n log n)", "O(1)"]), "O(log n)", 2);
    insertQ.run(contestId, 2, "Which data structure follows the LIFO principle?", "mcq",
      JSON.stringify(["Queue", "Stack", "Heap", "Linked List"]), "Stack", 2);
    insertQ.run(contestId, 3, "What is the worst-case time complexity of quicksort?", "mcq",
      JSON.stringify(["O(n log n)", "O(n)", "O(n^2)", "O(log n)"]), "O(n^2)", 2);
    insertQ.run(contestId, 4, "Name the algorithmic technique that solves problems by combining solutions to overlapping subproblems.", "text",
      null, "dynamic programming", 4);
  });
}
