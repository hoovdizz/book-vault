import { FormEvent, useCallback, useEffect, useState } from 'react';
import { User, BookOpen, Star, Calendar, LogOut, UserPlus } from 'lucide-react';
import { mockStats } from '@/data/mockData';
import { api, User as AppUser, useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';

export default function Profile() {
  const { user, logout } = useAuth();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'user' });
  const loadUsers = useCallback(() => {
    if (user?.role === 'admin') api<{ users: AppUser[] }>('/api/users').then(result => setUsers(result.users)).catch(error => toast.error(error.message));
  }, [user?.role]);
  useEffect(() => { loadUsers(); }, [loadUsers]);
  async function addUser(event: FormEvent) {
    event.preventDefault();
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify(form) });
      setForm({ name: '', email: '', password: '', role: 'user' });
      toast.success('User added');
      loadUsers();
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not add user'); }
  }
  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-3xl font-heading font-bold text-foreground">Profile</h1>

      <div className="bg-card rounded-lg border border-border shadow-card p-6">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
            <User className="h-8 w-8 text-primary" />
          </div>
          <div>
            <h2 className="text-xl font-heading font-semibold text-foreground">{user?.name}</h2>
            <p className="text-sm text-muted-foreground">{user?.email} · {user?.role}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { icon: BookOpen, label: 'Books Owned', value: mockStats.totalBooks },
            { icon: Star, label: 'Avg Rating', value: mockStats.averageRating.toFixed(1) },
            { icon: Calendar, label: 'Books Read', value: mockStats.booksRead },
            { icon: BookOpen, label: 'Collection Value', value: `$${mockStats.totalValue.toFixed(0)}` },
          ].map(stat => (
            <div key={stat.label} className="text-center p-3 rounded-md bg-muted/50">
              <stat.icon className="h-5 w-5 mx-auto text-primary mb-1" />
              <p className="text-lg font-heading font-bold text-foreground">{stat.value}</p>
              <p className="text-[10px] text-muted-foreground">{stat.label}</p>
            </div>
          ))}
        </div>
        <Button variant="outline" className="mt-6 gap-2" onClick={logout}><LogOut className="h-4 w-4" />Sign out</Button>
      </div>
      {user?.role === 'admin' && <div className="bg-card rounded-lg border border-border shadow-card p-6 space-y-5">
        <div><h2 className="text-xl font-heading font-semibold flex items-center gap-2"><UserPlus className="h-5 w-5" />Users</h2><p className="text-sm text-muted-foreground">Add accounts that can sign in to this BookVault.</p></div>
        <form onSubmit={addUser} className="grid gap-3 sm:grid-cols-2">
          <Input placeholder="Display name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
          <Input type="email" placeholder="Email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required />
          <Input type="password" minLength={8} placeholder="Password (8+ characters)" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required />
          <select className="rounded-md border bg-background px-3 text-sm" value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}><option value="user">User</option><option value="admin">Administrator</option></select>
          <Button className="sm:col-span-2 w-fit">Add user</Button>
        </form>
        <div className="divide-y">{users.map(item => <div key={item.id} className="flex justify-between py-3 text-sm"><span><strong>{item.name}</strong><br/><span className="text-muted-foreground">{item.email}</span></span><span className="capitalize text-muted-foreground">{item.role}</span></div>)}</div>
      </div>}
    </div>
  );
}
