import type { ExamStatus } from "@/lib/types";

const STYLES: Record<ExamStatus, [string, string]> = {
  not_started: ["bg-slate-100 text-slate-600", "Not Started"],
  in_progress: ["bg-blue-50 text-blue-700", "In Progress"],
  submitted: ["bg-emerald-50 text-emerald-700", "Submitted"],
  expired: ["bg-teal-50 text-teal-700", "Completed (Time Expired)"],
  terminated: ["bg-red-100 text-red-700", "Terminated for Policy Violation"],
};

export default function StatusBadge({ status }: { status: ExamStatus }) {
  const [cls, label] = STYLES[status];
  return <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}
