import type { ReactNode } from "react";

export const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "—");
export const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString() : "—");

export function Stat({ icon, label, value, sub }: { icon: ReactNode; label: string; value: number | string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2 text-sm text-slate-500">{icon}{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export function Table({ headers, rows, empty, testId }: { headers: string[]; rows: ReactNode[]; empty: string; testId?: string }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full text-left text-sm" data-testid={testId}>
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>{headers.map((h, i) => <th key={i} className="px-3 py-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>{rows.length ? rows : <tr><td colSpan={headers.length} className="px-3 py-6 text-center text-slate-500">{empty}</td></tr>}</tbody>
      </table>
    </div>
  );
}

export const td = "px-3 py-2";
