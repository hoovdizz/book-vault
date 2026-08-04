import { FormEvent, useState } from "react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try { await login(email, password); } catch (e) { setError(e instanceof Error ? e.message : "Login failed"); } finally { setBusy(false); }
  }
  return <main className="min-h-screen grid place-items-center bg-background p-4">
    <form onSubmit={submit} className="w-full max-w-sm rounded-lg border bg-card p-8 shadow-card space-y-5">
      <div className="text-center"><img src="/book-vault-icon.png" alt="" className="mx-auto h-12 w-12 rounded-lg" /><h1 className="mt-2 text-2xl font-heading font-bold">BookVault</h1><p className="text-sm text-muted-foreground">Sign in to your library</p></div>
      <div><label className="text-sm font-medium">Email</label><Input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus /></div>
      <div><label className="text-sm font-medium">Password</label><Input type="password" maxLength={128} value={password} onChange={e => setPassword(e.target.value)} required /></div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button className="w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
    </form>
  </main>;
}
