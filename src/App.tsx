import { useCallback, useEffect, useState } from "react";
import { LogOut, ShieldCheck } from "lucide-react";
import Login from "@/components/Login";
import StudentHome from "@/components/student/StudentHome";
import AdminDashboard from "@/components/admin/AdminDashboard";
import { api, setUnauthorizedHandler, tokenStore } from "@/lib/api";
import type { User } from "@/lib/types";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!tokenStore.get()) {
      setChecking(false);
      return;
    }
    api<{ user: User }>("/auth/me")
      .then((r) => setUser(r.user))
      .catch(() => tokenStore.clear())
      .finally(() => setChecking(false));
  }, [logout]);

  if (checking) return <div className="flex h-full items-center justify-center text-slate-500">Loading…</div>;
  if (!user) return <Login onLogin={setUser} />;

  return (
    <div className="min-h-full">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2 font-semibold text-indigo-700">
            <ShieldCheck className="h-5 w-5" /> MRV CodeHub
            <span className="ml-2 rounded bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600">
              {user.role === "admin" ? "Admin" : "Student"}
            </span>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-slate-600">{user.name}</span>
            <button onClick={logout} className="flex items-center gap-1 text-slate-500 hover:text-slate-900">
              <LogOut className="h-4 w-4" /> Logout
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        {user.role === "admin" ? <AdminDashboard /> : <StudentHome />}
      </main>
    </div>
  );
}
