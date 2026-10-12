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
  role TEXT NOT NULL CHECK (role IN ('student','teacher','admin')),
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
  correct_count INTEGER,
  incorrect_count INTEGER,
  unanswered_count INTEGER,
  time_remaining_ms INTEGER,
  answered_count INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER,
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
CREATE TABLE IF NOT EXISTS exam_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES contest_sessions(id),
  student_id INTEGER NOT NULL REFERENCES users(id),
  contest_id INTEGER NOT NULL REFERENCES contests(id),
  event TEXT NOT NULL CHECK (event IN ('started','resumed','answer_saved','violation_warned','submitted','expired','terminated')),
  details TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_session ON exam_activity(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_student ON exam_activity(student_id, created_at);
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
  migrate(db);
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

const SESSION_COLUMNS = {
  correct_count: "INTEGER",
  incorrect_count: "INTEGER",
  unanswered_count: "INTEGER",
  time_remaining_ms: "INTEGER",
  answered_count: "INTEGER NOT NULL DEFAULT 0",
  last_activity_at: "INTEGER",
};

// Upgrades databases created by earlier versions of the app in place.
function migrate(db) {
  const tableSql = (name) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)?.sql;
  const usersSql = tableSql("users");
  if (usersSql && !usersSql.includes("'teacher'")) {
    db.exec("PRAGMA foreign_keys = OFF");
    tx(db, () => {
      db.exec(`CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('student','teacher','admin')),
        created_at INTEGER NOT NULL
      );
      INSERT INTO users_new SELECT id, name, email, password_hash, role, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;`);
    });
    db.exec("PRAGMA foreign_keys = ON");
  }
  if (tableSql("contest_sessions")) {
    const existing = new Set(db.prepare("PRAGMA table_info(contest_sessions)").all().map((c) => c.name));
    for (const [col, type] of Object.entries(SESSION_COLUMNS)) {
      if (!existing.has(col)) db.exec(`ALTER TABLE contest_sessions ADD COLUMN ${col} ${type}`);
    }
  }
}

const DEMO_USERS = [
  ["Platform Admin", process.env.ADMIN_EMAIL || "admin@mrv.edu", process.env.ADMIN_PASSWORD || "Admin@123", "admin"],
  ["Aarav Reddy", "student1@mrv.edu", "Student@123", "student"],
  ["Diya Sharma", "student2@mrv.edu", "Student@123", "student"],
  ["Prof. Kavya Rao", "teacher@mrv.edu", "Teacher@123", "teacher"],
  ["Rohan Verma", "student3@mrv.edu", "Student@123", "student"],
];

const DEMO_CONTESTS = [
  {
    title: "DSA Weekly Contest #1",
    description: "Arrays, complexity analysis and searching. Fullscreen proctored contest.",
    duration: 30,
    questions: [
      ["What is the time complexity of binary search on a sorted array of n elements?", "mcq", ["O(n)", "O(log n)", "O(n log n)", "O(1)"], "O(log n)", 2],
      ["Which data structure follows the LIFO principle?", "mcq", ["Queue", "Stack", "Heap", "Linked List"], "Stack", 2],
      ["What is the worst-case time complexity of quicksort?", "mcq", ["O(n log n)", "O(n)", "O(n^2)", "O(log n)"], "O(n^2)", 2],
      ["Name the algorithmic technique that solves problems by combining solutions to overlapping subproblems.", "text", null, "dynamic programming", 4],
    ],
  },
  {
    title: "Python Fundamentals Quiz",
    description: "Core Python syntax and data types. Fullscreen proctored exam.",
    duration: 15,
    questions: [
      ["Which keyword defines a function in Python?", "mcq", ["func", "def", "function", "lambda"], "def", 2],
      ["What is the output type of len('hello')?", "mcq", ["str", "int", "float", "list"], "int", 2],
      ["Which collection type is immutable?", "mcq", ["list", "dict", "set", "tuple"], "tuple", 2],
      ["What built-in function returns the largest item in an iterable?", "text", null, "max", 2],
      ["Which operator is used for floor division?", "mcq", ["/", "//", "%", "**"], "//", 2],
    ],
  },
];

// Seeds demo accounts, exams and default policies; rows that already exist are left untouched.
function seed(db) {
  const now = Date.now();
  tx(db, () => {
    const insertPolicy = db.prepare(
      "INSERT OR IGNORE INTO violation_policies (type, enabled, action, max_warnings, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const type of Object.keys(VIOLATION_TYPES)) {
      insertPolicy.run(type, type === "tab_switch" ? 0 : 1, "terminate", 0, now);
    }

    const insertUser = db.prepare(
      "INSERT OR IGNORE INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    const userExists = db.prepare("SELECT 1 FROM users WHERE email = ?");
    for (const [name, email, password, role] of DEMO_USERS) {
      if (!userExists.get(email)) insertUser.run(name, email, hashPassword(password), role, now);
    }

    const contestExists = db.prepare("SELECT 1 FROM contests WHERE title = ?");
    const insertContest = db.prepare("INSERT INTO contests (title, description, duration_minutes, created_at) VALUES (?, ?, ?, ?)");
    const insertQ = db.prepare(
      "INSERT INTO questions (contest_id, position, prompt, type, options, correct_answer, points) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const c of DEMO_CONTESTS) {
      if (contestExists.get(c.title)) continue;
      const contestId = insertContest.run(c.title, c.description, c.duration, now).lastInsertRowid;
      c.questions.forEach(([prompt, type, options, answer, points], i) =>
        insertQ.run(contestId, i + 1, prompt, type, options ? JSON.stringify(options) : null, answer, points),
      );
    }
  });
}
