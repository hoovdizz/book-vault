import { FormEvent, useState } from "react";
import { api, useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [accepted, setAccepted] = useState(false);
  const invitationToken = new URLSearchParams(window.location.search).get("invitation");
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try { await login(email, password); } catch (e) { setError(e instanceof Error ? e.message : "Login failed"); } finally { setBusy(false); }
  }
  async function acceptInvitation(event: FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      await api("/api/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token: invitationToken, name, password }),
      });
      setAccepted(true);
      setPassword("");
      window.history.replaceState({}, "", "/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not accept invitation");
    } finally {
      setBusy(false);
    }
  }
  if (invitationToken && !accepted) {
    return <main className="min-h-screen grid place-items-center bg-background p-4">
      <form onSubmit={acceptInvitation} className="w-full max-w-sm rounded-lg border bg-card p-8 shadow-card space-y-5">
        <div className="text-center"><img src="/book-vault-icon.png" alt="" className="mx-auto h-12 w-12 rounded-lg" /><h1 className="mt-2 text-2xl font-heading font-bold">Join Book Vault</h1><p className="text-sm text-muted-foreground">Create the account approved by your household administrator</p></div>
        <div><label htmlFor="invited-name" className="text-sm font-medium">Name</label><Input id="invited-name" value={name} onChange={e => setName(e.target.value)} required autoFocus /></div>
        <div><label htmlFor="invited-password" className="text-sm font-medium">Password</label><Input id="invited-password" type="password" minLength={12} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} required /></div>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <Button className="w-full" disabled={busy}>{busy ? "Creating account…" : "Accept invitation"}</Button>
      </form>
    </main>;
  }
  return <main className="min-h-screen grid place-items-center bg-background p-4">
    <form onSubmit={submit} className="w-full max-w-sm rounded-lg border bg-card p-8 shadow-card space-y-5">
      <div className="text-center"><img src="/book-vault-icon.png" alt="" className="mx-auto h-12 w-12 rounded-lg" /><h1 className="mt-2 text-2xl font-heading font-bold">BookVault</h1><p className="text-sm text-muted-foreground">Sign in to your library</p></div>
      <div><label className="text-sm font-medium">Email</label><Input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus /></div>
      <div><label className="text-sm font-medium">Password</label><Input type="password" maxLength={128} value={password} onChange={e => setPassword(e.target.value)} required /></div>
      {accepted && <p className="text-sm text-emerald-700 dark:text-emerald-300">Account created. Sign in with the email address that received the invitation.</p>}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <Button className="w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
    </form>
  </main>;
}
