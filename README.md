# MRV CodeHub — Student Experience

React + Vite + Tailwind frontend with an Express + SQLite (`node:sqlite`) backend.

## Run

Requires Node.js 22.13+ (uses the built-in `node:sqlite` module).

```bash
npm install
npm run dev:all      # Vite on :5173 (proxies /api) + API on :3001
npm test             # backend integration tests
npm run deploy       # build single-file frontend and serve it + API on :3001
```

The SQLite database is created at `server/data/codehub.db` on first start (override with `DB_FILE` / `DATA_DIR`).
First start seeds an admin (`ADMIN_EMAIL` / `ADMIN_PASSWORD`, default `admin@mrv.edu` / `Admin@123`),
two students (`student1@mrv.edu`, `student2@mrv.edu`, password `Student@123`) and one contest. Change these for production.
Set `AUTH_SECRET` in production (otherwise a random secret is generated in the data dir) and `CORS_ORIGIN` if the
frontend is served from another origin.

## Fullscreen contest mode & anti-cheating

- Students must enter fullscreen before `POST /api/student/contests/:id/start` (server rejects without `fullscreen: true`).
- While a contest runs the client blocks and reports copy / paste / cut (keyboard shortcuts and clipboard events),
  fullscreen exit, leaving the page and (optionally) tab switches.
- `POST /api/student/sessions/:id/violations` applies the configured policy in a DB transaction: saves the answer snapshot,
  records the violation (student, contest, type, server timestamp, reason, IP, user agent), and either warns or
  terminates the session (`status = 'terminated'`, "Terminated for Policy Violation").
- Duplicate protection: unique `(session_id, client_event_id)` plus a 2-second same-type window.
- Terminated / submitted / expired sessions are locked: answer saves, submits and restarts are rejected server-side.
- Admin dashboard (polls every 3s): overview stats, violation incidents, sessions with status filter,
  per-session incident report with saved answers and student history, and violation policy editor
  (`terminate` immediately, or `warn` N times then terminate; enable/disable per type).
