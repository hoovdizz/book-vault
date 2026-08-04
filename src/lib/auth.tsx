import { createContext, useContext, useEffect, useState } from "react";

export type User = { id: number; name: string; email: string; role: "admin" | "user"; createdAt: string };
type AuthContextValue = { user: User | null; loading: boolean; login: (email: string, password: string) => Promise<void>; logout: () => Promise<void> };
const AuthContext = createContext<AuthContextValue | null>(null);
const tokenKey = "bookvault-token";

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem(tokenKey);
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!localStorage.getItem(tokenKey)) return setLoading(false);
    api<{ user: User }>("/api/auth/me").then(result => setUser(result.user)).catch(() => localStorage.removeItem(tokenKey)).finally(() => setLoading(false));
  }, []);
  async function login(email: string, password: string) {
    const result = await api<{ token: string; user: User }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    localStorage.setItem(tokenKey, result.token); setUser(result.user);
  }
  async function logout() {
    try { await api("/api/auth/logout", { method: "POST" }); } finally { localStorage.removeItem(tokenKey); setUser(null); }
  }
  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
