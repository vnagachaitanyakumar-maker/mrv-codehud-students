export type Role = "student" | "admin";
export type SessionStatus = "in_progress" | "submitted" | "expired" | "terminated";
export type ViolationType = "copy" | "paste" | "cut" | "fullscreen_exit" | "tab_switch";

export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
}

export interface Session {
  id: number;
  contestId: number;
  studentId: number;
  status: SessionStatus;
  statusLabel: string;
  startedAt: string;
  endsAt: string;
  endedAt: string | null;
  terminationReason: string | null;
  score: number | null;
  maxScore: number | null;
}

export interface ContestSummary {
  id: number;
  title: string;
  description: string;
  durationMinutes: number;
  questionCount: number;
  session: Session | null;
}

export interface Question {
  id: number;
  position: number;
  prompt: string;
  type: "mcq" | "text";
  options: string[] | null;
  points: number;
}

export interface Policy {
  type: ViolationType;
  label: string;
  enabled: boolean;
  action: "terminate" | "warn";
  maxWarnings: number;
  updatedAt: string;
}

export interface Violation {
  id: number;
  sessionId: number;
  studentId: number;
  studentName?: string;
  studentEmail?: string;
  contestId: number;
  contestTitle?: string;
  type: ViolationType;
  typeLabel: string;
  actionTaken: "warned" | "terminated";
  reason: string;
  timestamp: string;
  clientTimestamp: string | null;
  userAgent: string | null;
  ip: string | null;
}

export interface SessionPayload {
  session: Session;
  contest: { id: number; title: string; description: string; durationMinutes: number };
  questions: Question[];
  answers: { questionId: number; answer: string }[];
  violations: Violation[];
  policies: Policy[];
  serverNow: string;
  resumed?: boolean;
}

export interface ViolationResult {
  recorded: boolean;
  duplicate: boolean;
  action: "terminated" | "warned" | "ignored" | "none";
  reason?: string;
  warningsUsed?: number;
  maxWarnings?: number;
  session: Session;
}

export interface AdminSession extends Session {
  studentName: string;
  studentEmail: string;
  contestTitle: string;
  violationCount: number;
}

export interface Overview {
  totalViolations: number;
  violationsLast24h: number;
  terminatedSessions: number;
  activeSessions: number;
  completedSessions: number;
  byType: { type: ViolationType; label: string; count: number }[];
  latestViolationId: number;
  serverTime: string;
}
