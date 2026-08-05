import { createContext, useContext, useEffect, useState } from "react";

export type User = {
  id: number;
  name: string;
  email: string;
  role: "admin" | "user";
  systemRole?: "system_admin" | "user";
  householdRole?: "household_admin" | "adult" | "child" | "viewer";
  disabled?: boolean;
  createdAt: string;
};
type AuthContextValue = { user: User | null; loading: boolean; login: (email: string, password: string) => Promise<void>; logout: () => Promise<void> };
const AuthContext = createContext<AuthContextValue | null>(null);
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, credentials: "same-origin", headers: { "Content-Type": "application/json", ...options.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    api<{ user: User }>("/api/auth/me").then(result => setUser(result.user)).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);
  async function login(email: string, password: string) {
    const result = await api<{ user: User }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    setUser(result.user);
  }
  async function logout() {
    try { await api("/api/auth/logout", { method: "POST" }); } finally { setUser(null); }
  }
  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
