import { useState, type FormEvent } from "react";
import { ShieldCheck } from "lucide-react";
import { api, tokenStore } from "@/lib/api";
import type { User } from "@/lib/types";

export default function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ token: string; user: User }>("/auth/login", { method: "POST", body: { email, password } });
      tokenStore.set(res.token);
      onLogin(res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="flex items-center gap-2 text-lg font-semibold text-indigo-700">
          <ShieldCheck className="h-6 w-6" /> MRV CodeHub
        </div>
        <p className="text-sm text-slate-500">Sign in to continue</p>
        <label className="block text-sm">
          <span className="text-slate-700">Email</span>
          <input name="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none" />
        </label>
        <label className="block text-sm">
          <span className="text-slate-700">Password</span>
          <input name="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none" />
        </label>
        {error && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <button disabled={busy} className="w-full rounded-md bg-indigo-600 py-2 font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
