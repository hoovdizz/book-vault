import { FormEvent, useCallback, useEffect, useState } from 'react';
import { LogOut, MapPin, Save, Settings2, User, UserPlus, Users } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, User as AppUser, useAuth } from '@/lib/auth';
import { bindingLabels, conditionLabels } from '@/lib/book-copy';
import { BookBinding, BookCondition } from '@/types/book';
import { FamilyResponse, LibrarySettings } from '@/types/settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';

const blankSettings: LibrarySettings = {
  defaultLocation: '',
  defaultBinding: '',
  defaultCondition: '',
  locations: [],
  locationScope: 'personal',
};

export default function Profile() {
  const { user, logout } = useAuth();
  const queryClient = useQueryClient();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [userForm, setUserForm] = useState({ name: '', email: '', password: '', role: 'user' });
  const [settingsForm, setSettingsForm] = useState(blankSettings);
  const [locationsText, setLocationsText] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [familyName, setFamilyName] = useState('My Family');
  const [familyMemberIds, setFamilyMemberIds] = useState<Set<number>>(new Set());
  const [savingFamily, setSavingFamily] = useState(false);

  const { data: settingsData } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<{ settings: LibrarySettings }>('/api/settings'),
  });
  const { data: familyData } = useQuery({
    queryKey: ['family'],
    queryFn: () => api<FamilyResponse>('/api/family'),
  });

  const loadUsers = useCallback(() => {
    if (user?.role === 'admin') {
      api<{ users: AppUser[] }>('/api/users')
        .then(result => setUsers(result.users))
        .catch(error => toast.error(error.message));
    }
  }, [user?.role]);

  useEffect(() => { loadUsers(); }, [loadUsers]);
  useEffect(() => {
    if (!settingsData?.settings) return;
    setSettingsForm(settingsData.settings);
    setLocationsText(settingsData.settings.locations.join('\n'));
  }, [settingsData]);
  useEffect(() => {
    if (familyData?.family) {
      setFamilyName(familyData.family.name);
      setFamilyMemberIds(new Set(familyData.family.members.map(member => member.id)));
    } else if (user) {
      setFamilyName('My Family');
      setFamilyMemberIds(new Set([user.id]));
    }
  }, [familyData, user]);

  async function addUser(event: FormEvent) {
    event.preventDefault();
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify(userForm) });
      setUserForm({ name: '', email: '', password: '', role: 'user' });
      toast.success('User added');
      loadUsers();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add user');
    }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    setSavingSettings(true);
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          defaultLocation: settingsForm.defaultLocation,
          defaultBinding: settingsForm.defaultBinding,
          defaultCondition: settingsForm.defaultCondition,
          locations: locationsText.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Library defaults saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save library defaults');
    } finally {
      setSavingSettings(false);
    }
  }

  function toggleFamilyMember(memberId: number) {
    if (memberId === user?.id) return;
    setFamilyMemberIds(current => {
      const next = new Set(current);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  }

  async function saveFamily(event: FormEvent) {
    event.preventDefault();
    setSavingFamily(true);
    try {
      await api('/api/family', {
        method: 'PUT',
        body: JSON.stringify({ name: familyName, memberIds: [...familyMemberIds] }),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['family'] }),
        queryClient.invalidateQueries({ queryKey: ['settings'] }),
        queryClient.invalidateQueries({ queryKey: ['books'] }),
        queryClient.invalidateQueries({ queryKey: ['book-duplicates'] }),
      ]);
      toast.success('Family sharing updated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update family sharing');
    } finally {
      setSavingFamily(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-heading font-bold text-foreground">Settings</h1>
        <p className="mt-1 text-muted-foreground">Manage your account, book defaults, locations, and family library.</p>
      </div>

      <section className="rounded-lg border border-border bg-card p-6 shadow-card">
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <User className="h-8 w-8 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xl font-heading font-semibold text-foreground">{user?.name}</h2>
            <p className="truncate text-sm text-muted-foreground">{user?.email} · {user?.role}</p>
          </div>
          <Button variant="outline" className="gap-2" onClick={logout}>
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-6 shadow-card">
        <div className="mb-5">
          <h2 className="flex items-center gap-2 text-xl font-heading font-semibold">
            <Settings2 className="h-5 w-5" />
            Library defaults
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            These values are preselected for new physical books and can still be changed on each copy.
          </p>
        </div>
        <form onSubmit={saveSettings} className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="default-location">Default physical location</Label>
            <Input
              id="default-location"
              list="settings-locations"
              maxLength={150}
              placeholder="e.g. Bookshelf in den"
              value={settingsForm.defaultLocation}
              onChange={event => setSettingsForm(current => ({ ...current, defaultLocation: event.target.value }))}
            />
            <datalist id="settings-locations">
              {settingsForm.locations.map(location => <option key={location} value={location} />)}
            </datalist>
          </div>
          <div>
            <Label htmlFor="default-binding">Default binding</Label>
            <select
              id="default-binding"
              value={settingsForm.defaultBinding}
              onChange={event => setSettingsForm(current => ({ ...current, defaultBinding: event.target.value as BookBinding | '' }))}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Not set</option>
              {(Object.entries(bindingLabels) as [BookBinding, string][]).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="default-condition">Default condition</Label>
            <select
              id="default-condition"
              value={settingsForm.defaultCondition}
              onChange={event => setSettingsForm(current => ({ ...current, defaultCondition: event.target.value as BookCondition | '' }))}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Not set</option>
              {(Object.entries(conditionLabels) as [BookCondition, string][]).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="saved-locations">Saved physical locations</Label>
            <Textarea
              id="saved-locations"
              rows={5}
              maxLength={7600}
              placeholder={'Bookshelf in den\nTote in den\nBookshelf in kids room'}
              value={locationsText}
              onChange={event => setLocationsText(event.target.value)}
            />
            <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="h-3.5 w-3.5" />
              Enter one location per line. This list is {settingsForm.locationScope === 'family' ? 'shared with your family' : 'personal until you join a family'}.
            </p>
          </div>
          <Button type="submit" className="w-fit gap-2 sm:col-span-2" disabled={savingSettings}>
            <Save className="h-4 w-4" />
            {savingSettings ? 'Saving…' : 'Save defaults'}
          </Button>
        </form>
      </section>

      <section className="rounded-lg border border-border bg-card p-6 shadow-card">
        <div className="mb-5">
          <h2 className="flex items-center gap-2 text-xl font-heading font-semibold">
            <Users className="h-5 w-5" />
            Family library
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Family members share owned books and physical locations. Wishlists and backlogs stay personal, and everyone has their own reading status.
          </p>
        </div>
        {familyData?.canManage ? (
          <form onSubmit={saveFamily} className="space-y-4">
            <div>
              <Label htmlFor="family-name">Family name</Label>
              <Input id="family-name" required maxLength={100} value={familyName} onChange={event => setFamilyName(event.target.value)} />
            </div>
            <fieldset>
              <legend className="mb-2 text-sm font-medium">Members</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {users.map(member => {
                  const isCurrentUser = member.id === user?.id;
                  return (
                    <label key={member.id} className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3 text-sm">
                      <input
                        type="checkbox"
                        checked={familyMemberIds.has(member.id)}
                        disabled={isCurrentUser}
                        onChange={() => toggleFamilyMember(member.id)}
                        className="h-4 w-4 accent-primary"
                      />
                      <span className="min-w-0">
                        <strong className="block truncate">{member.name}{isCurrentUser ? ' (you)' : ''}</strong>
                        <span className="block truncate text-xs text-muted-foreground">{member.email}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <p className="text-xs text-muted-foreground">
              A shared copy can be edited by family members, but only the member who added it can remove it or move it out of the Collection.
            </p>
            <Button type="submit" className="gap-2" disabled={savingFamily}>
              <Users className="h-4 w-4" />
              {savingFamily ? 'Saving…' : familyData.family ? 'Update family' : 'Create family'}
            </Button>
          </form>
        ) : familyData?.family ? (
          <div>
            <h3 className="font-heading font-semibold">{familyData.family.name}</h3>
            <div className="mt-3 divide-y divide-border">
              {familyData.family.members.map(member => (
                <div key={member.id} className="flex justify-between py-3 text-sm">
                  <span><strong>{member.name}</strong><br /><span className="text-muted-foreground">{member.email}</span></span>
                  <span className="capitalize text-muted-foreground">{member.role}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">An administrator can add this account to a family from their Settings page.</p>
        )}
      </section>

      {user?.role === 'admin' && (
        <section className="space-y-5 rounded-lg border border-border bg-card p-6 shadow-card">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-heading font-semibold"><UserPlus className="h-5 w-5" />Users</h2>
            <p className="text-sm text-muted-foreground">Add accounts that can sign in to this BookVault, then select them in Family library above.</p>
          </div>
          <form onSubmit={addUser} className="grid gap-3 sm:grid-cols-2">
            <Input aria-label="Display name" placeholder="Display name" value={userForm.name} onChange={event => setUserForm({ ...userForm, name: event.target.value })} required />
            <Input aria-label="Email" type="email" placeholder="Email" value={userForm.email} onChange={event => setUserForm({ ...userForm, email: event.target.value })} required />
            <Input aria-label="Password" type="password" minLength={12} maxLength={128} placeholder="Password (12+ characters)" value={userForm.password} onChange={event => setUserForm({ ...userForm, password: event.target.value })} required />
            <select aria-label="Role" className="rounded-md border bg-background px-3 text-sm" value={userForm.role} onChange={event => setUserForm({ ...userForm, role: event.target.value })}>
              <option value="user">User</option>
              <option value="admin">Administrator</option>
            </select>
            <Button className="w-fit sm:col-span-2">Add user</Button>
          </form>
          <div className="divide-y divide-border">
            {users.map(item => (
              <div key={item.id} className="flex justify-between py-3 text-sm">
                <span><strong>{item.name}</strong><br /><span className="text-muted-foreground">{item.email}</span></span>
                <span className="capitalize text-muted-foreground">{item.role}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
