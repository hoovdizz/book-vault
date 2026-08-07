import { FormEvent, useEffect, useState } from 'react';
import { Archive, ArrowDown, ArrowUp, LogOut, MapPin, Pencil, Plus, Save, Shield, User, UserPlus, Users } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import QRCode from 'qrcode';
import { toast } from 'sonner';
import { api, useAuth } from '@/lib/auth';
import { bindingLabels, conditionLabels } from '@/lib/book-copy';
import { BookBinding, BookCondition } from '@/types/book';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type Member = {
  id: number;
  name: string;
  email: string;
  systemRole: string;
  householdRole: 'household_admin' | 'adult' | 'child' | 'viewer';
  disabled: boolean;
  hideCollection: boolean;
};
type HouseholdResponse = {
  household: {
    id: string;
    name: string;
    role: string;
    systemRole: string;
    defaults: { locationId: string | null; binding: BookBinding | ''; condition: BookCondition | '' };
    ratings: { scale: 'stars5' | 'points10'; increment: number };
    backups: { retention: number; schedule: string };
  };
  members: Member[];
  permissions: { manageHousehold: boolean; editInventory: boolean; editReading: boolean };
};
type Location = {
  id: string;
  parentId: string | null;
  name: string;
  levelType: string;
  breadcrumb: string;
  archived: boolean;
  sortOrder: number;
  copyCount: number;
};

export default function Profile() {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const queryClient = useQueryClient();
  const [householdForm, setHouseholdForm] = useState({
    name: '',
    defaultLocationId: '',
    defaultBinding: '',
    defaultCondition: '',
    ratingScale: 'stars5',
    ratingIncrement: '0.5',
    backupRetention: '14',
    backupSchedule: '',
  });
  const [memberForm, setMemberForm] = useState({ name: '', email: '', password: '', householdRole: 'adult' });
  const [invitationForm, setInvitationForm] = useState({ email: '', householdRole: 'adult' });
  const [invitationToken, setInvitationToken] = useState('');
  const [locationForm, setLocationForm] = useState({ name: '', levelType: 'room', parentId: '' });
  const [locationLabel, setLocationLabel] = useState<{
    title: string;
    breadcrumb: string;
    qrValue: string;
    dataUrl: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['household'],
    queryFn: () => api<HouseholdResponse>('/api/household'),
  });
  const { data: locationsData } = useQuery({
    queryKey: ['locations'],
    queryFn: () => api<{ locations: Location[] }>('/api/locations'),
  });
  const { data: statusData } = useQuery({
    queryKey: ['reading-statuses'],
    queryFn: () => api<{ statuses: { key: string; label: string; enabled: boolean; sortOrder: number }[] }>('/api/household/reading-statuses'),
  });
  const { data: preferenceData } = useQuery({
    queryKey: ['preferences'],
    queryFn: () => api<{ preferences: { theme: string } }>('/api/preferences'),
  });

  useEffect(() => {
    if (!data?.household) return;
    const household = data.household;
    setHouseholdForm({
      name: household.name,
      defaultLocationId: household.defaults.locationId || '',
      defaultBinding: household.defaults.binding || '',
      defaultCondition: household.defaults.condition || '',
      ratingScale: household.ratings.scale,
      ratingIncrement: String(household.ratings.increment),
      backupRetention: String(household.backups.retention),
      backupSchedule: household.backups.schedule || '',
    });
  }, [data]);

  useEffect(() => {
    if (preferenceData?.preferences.theme) setTheme(preferenceData.preferences.theme);
  }, [preferenceData, setTheme]);

  async function changeTheme(nextTheme: string) {
    setTheme(nextTheme);
    try {
      await api('/api/preferences', { method: 'PUT', body: JSON.stringify({ theme: nextTheme }) });
      await queryClient.invalidateQueries({ queryKey: ['preferences'] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save theme');
    }
  }

  async function refreshHousehold() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['household'] }),
      queryClient.invalidateQueries({ queryKey: ['locations'] }),
      queryClient.invalidateQueries({ queryKey: ['catalog'] }),
    ]);
  }

  async function saveHousehold(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api('/api/household', {
        method: 'PUT',
        body: JSON.stringify({
          ...householdForm,
          backupRetention: Number(householdForm.backupRetention),
          ratingIncrement: Number(householdForm.ratingIncrement),
        }),
      });
      await refreshHousehold();
      toast.success('Household defaults saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save household');
    } finally {
      setSaving(false);
    }
  }

  async function addMember(event: FormEvent) {
    event.preventDefault();
    try {
      await api('/api/household/members', { method: 'POST', body: JSON.stringify(memberForm) });
      setMemberForm({ name: '', email: '', password: '', householdRole: 'adult' });
      await refreshHousehold();
      toast.success('Household member created');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create member');
    }
  }

  async function inviteMember(event: FormEvent) {
    event.preventDefault();
    try {
      const response = await api<{ invitation: { token: string } }>('/api/household/invitations', {
        method: 'POST',
        body: JSON.stringify(invitationForm),
      });
      setInvitationToken(`${window.location.origin}/?invitation=${response.invitation.token}`);
      toast.success('Controlled invitation created');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create invitation');
    }
  }

  async function updateMember(member: Member, changes: Partial<Member>) {
    try {
      await api(`/api/household/members/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify(changes),
      });
      await refreshHousehold();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update member');
    }
  }

  async function resetPassword(member: Member) {
    const password = window.prompt(`Enter a new password for ${member.name} (12–128 characters):`);
    if (!password) return;
    try {
      await api(`/api/household/members/${member.id}/password`, {
        method: 'PUT',
        body: JSON.stringify({ password }),
      });
      toast.success('Credentials reset and active sessions revoked');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not reset credentials');
    }
  }

  async function addLocation(event: FormEvent) {
    event.preventDefault();
    try {
      await api('/api/locations', { method: 'POST', body: JSON.stringify(locationForm) });
      setLocationForm({ name: '', levelType: 'room', parentId: locationForm.parentId });
      await refreshHousehold();
      toast.success('Location added');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add location');
    }
  }

  async function archiveLocation(location: Location) {
    try {
      await api(`/api/locations/${location.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: !location.archived }),
      });
      await refreshHousehold();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not change location');
    }
  }

  async function updateLocation(location: Location, changes: { name?: string; sortOrder?: number }) {
    try {
      await api(`/api/locations/${location.id}`, {
        method: 'PATCH',
        body: JSON.stringify(changes),
      });
      await refreshHousehold();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update location');
    }
  }

  function renameLocation(location: Location) {
    const name = window.prompt('Location name', location.name)?.trim();
    if (name && name !== location.name) void updateLocation(location, { name });
  }

  async function showLocationLabel(location: Location) {
    try {
      const response = await api<{ label: { title: string; breadcrumb: string; qrValue: string } }>(
        `/api/locations/${location.id}/label`,
      );
      const dataUrl = await QRCode.toDataURL(response.label.qrValue, {
        width: 384,
        margin: 2,
        errorCorrectionLevel: 'M',
      });
      setLocationLabel({ ...response.label, dataUrl });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create location QR label');
    }
  }

  async function toggleReadingStatus(key: string, enabled: boolean) {
    if (!statusData) return;
    try {
      await api('/api/household/reading-statuses', {
        method: 'PUT',
        body: JSON.stringify({
          statuses: statusData.statuses.map(status => status.key === key ? { ...status, enabled } : status),
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ['reading-statuses'] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update reading statuses');
    }
  }

  if (isLoading) return <div className="py-16 text-center text-muted-foreground">Loading settings…</div>;
  const canManage = Boolean(data?.permissions.manageHousehold);
  const locations = locationsData?.locations || [];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-3xl font-heading font-bold">Settings</h1>
        <p className="mt-1 text-muted-foreground">Account, household roles, defaults, reading options, and physical locations.</p>
      </div>

      <section className="rounded-lg border border-border bg-card p-6 shadow-card">
        <div className="flex flex-wrap items-center gap-4">
          <div className="grid h-16 w-16 place-items-center rounded-full bg-primary/10"><User className="h-8 w-8 text-primary" /></div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xl font-heading font-semibold">{user?.name}</h2>
            <p className="truncate text-sm text-muted-foreground">{user?.email} · {data?.household.role.replaceAll('_', ' ')}</p>
          </div>
          <label className="text-sm">
            Theme
            <select
              value={theme || 'system'}
              onChange={event => void changeTheme(event.target.value)}
              className="ml-2 h-10 rounded-md border border-input bg-background px-3"
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <Button type="button" variant="outline" className="gap-2" onClick={logout}><LogOut className="h-4 w-4" />Sign out</Button>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-6 shadow-card">
        <h2 className="mb-1 flex items-center gap-2 text-xl font-heading font-semibold"><Shield className="h-5 w-5" />Household defaults</h2>
        <p className="mb-5 text-sm text-muted-foreground">Defaults apply to new copies and remain editable on each copy.</p>
        <form onSubmit={saveHousehold} className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="household-name">Household name</Label>
            <Input id="household-name" disabled={!canManage} value={householdForm.name} onChange={event => setHouseholdForm(current => ({ ...current, name: event.target.value }))} />
          </div>
          <div>
            <Label htmlFor="default-location">Default location</Label>
            <select id="default-location" disabled={!canManage} value={householdForm.defaultLocationId} onChange={event => setHouseholdForm(current => ({ ...current, defaultLocationId: event.target.value }))} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">No default</option>
              {locations.filter(location => !location.archived).map(location => <option key={location.id} value={location.id}>{location.breadcrumb}</option>)}
            </select>
          </div>
          <div>
            <Label htmlFor="default-binding">Default binding</Label>
            <select id="default-binding" disabled={!canManage} value={householdForm.defaultBinding} onChange={event => setHouseholdForm(current => ({ ...current, defaultBinding: event.target.value }))} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">No default</option>
              {(Object.entries(bindingLabels) as [BookBinding, string][]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <div>
            <Label htmlFor="default-condition">Default condition</Label>
            <select id="default-condition" disabled={!canManage} value={householdForm.defaultCondition} onChange={event => setHouseholdForm(current => ({ ...current, defaultCondition: event.target.value }))} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">No default</option>
              {(Object.entries(conditionLabels) as [BookCondition, string][]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <div>
            <Label htmlFor="rating-scale">Rating scale</Label>
            <select id="rating-scale" disabled={!canManage} value={householdForm.ratingScale} onChange={event => setHouseholdForm(current => ({ ...current, ratingScale: event.target.value, ratingIncrement: event.target.value === 'points10' ? '1' : '0.5' }))} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="stars5">Five stars</option>
              <option value="points10">Ten points</option>
            </select>
          </div>
          <div>
            <Label htmlFor="rating-increment">Rating increment</Label>
            <select id="rating-increment" disabled={!canManage} value={householdForm.ratingIncrement} onChange={event => setHouseholdForm(current => ({ ...current, ratingIncrement: event.target.value }))} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              {householdForm.ratingScale === 'points10'
                ? <option value="1">1 point</option>
                : <><option value="1">Whole star</option><option value="0.5">Half star</option><option value="0.25">Quarter star</option></>}
            </select>
          </div>
          <div>
            <Label htmlFor="backup-retention">Backup retention</Label>
            <Input id="backup-retention" type="number" min="1" max="365" disabled={!canManage} value={householdForm.backupRetention} onChange={event => setHouseholdForm(current => ({ ...current, backupRetention: event.target.value }))} />
          </div>
          <div>
            <Label htmlFor="backup-schedule">Backup schedule</Label>
            <Input id="backup-schedule" disabled={!canManage} placeholder="daily@02:00" value={householdForm.backupSchedule} onChange={event => setHouseholdForm(current => ({ ...current, backupSchedule: event.target.value }))} />
          </div>
          {canManage && <Button type="submit" disabled={saving} className="sm:col-span-2 w-fit"><Save className="mr-2 h-4 w-4" />Save defaults</Button>}
        </form>
      </section>

      <section className="rounded-lg border border-border bg-card p-6 shadow-card">
        <h2 className="mb-1 flex items-center gap-2 text-xl font-heading font-semibold"><MapPin className="h-5 w-5" />Hierarchical locations</h2>
        <p className="mb-4 text-sm text-muted-foreground">Create buildings, rooms, bookcases, shelves, and bins. Archiving preserves historical paths.</p>
        {canManage && (
          <form onSubmit={addLocation} className="mb-4 grid gap-2 sm:grid-cols-[1fr_160px_1fr_auto]">
            <Input required maxLength={100} placeholder="Location name" value={locationForm.name} onChange={event => setLocationForm(current => ({ ...current, name: event.target.value }))} />
            <select value={locationForm.levelType} onChange={event => setLocationForm(current => ({ ...current, levelType: event.target.value }))} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
              {['household', 'building', 'room', 'bookcase', 'shelf', 'bin', 'custom'].map(level => <option key={level} value={level}>{level}</option>)}
            </select>
            <select value={locationForm.parentId} onChange={event => setLocationForm(current => ({ ...current, parentId: event.target.value }))} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
              <option value="">Top level</option>
              {locations.filter(location => !location.archived).map(location => <option key={location.id} value={location.id}>{location.breadcrumb}</option>)}
            </select>
            <Button type="submit"><Plus className="mr-1 h-4 w-4" />Add</Button>
          </form>
        )}
        <div className="divide-y divide-border rounded-md border border-border">
          {locations.map(location => (
            <div key={location.id} className="flex items-center gap-3 p-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className={location.archived ? 'text-muted-foreground line-through' : ''}>{location.breadcrumb}</p>
                <p className="text-xs text-muted-foreground">{location.levelType} · {location.copyCount} copies below</p>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => void showLocationLabel(location)}>QR label</Button>
              {canManage && (
                <>
                  <Button type="button" size="icon" variant="ghost" aria-label={`Rename ${location.name}`} onClick={() => renameLocation(location)}><Pencil className="h-4 w-4" /></Button>
                  <Button type="button" size="icon" variant="ghost" aria-label={`Move ${location.name} earlier`} onClick={() => void updateLocation(location, { sortOrder: location.sortOrder - 10 })}><ArrowUp className="h-4 w-4" /></Button>
                  <Button type="button" size="icon" variant="ghost" aria-label={`Move ${location.name} later`} onClick={() => void updateLocation(location, { sortOrder: location.sortOrder + 10 })}><ArrowDown className="h-4 w-4" /></Button>
                </>
              )}
              {canManage && <Button type="button" size="sm" variant="ghost" aria-label={`${location.archived ? 'Restore' : 'Archive'} ${location.name}`} onClick={() => void archiveLocation(location)}><Archive className="h-4 w-4" /></Button>}
            </div>
          ))}
        </div>
      </section>

      <Dialog open={Boolean(locationLabel)} onOpenChange={next => { if (!next) setLocationLabel(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{locationLabel?.title}</DialogTitle>
            <DialogDescription>{locationLabel?.breadcrumb}</DialogDescription>
          </DialogHeader>
          {locationLabel && (
            <div className="space-y-4 text-center">
              <img src={locationLabel.dataUrl} alt={`QR code for ${locationLabel.breadcrumb}`} className="mx-auto w-full max-w-[320px] rounded border border-border bg-white" />
              <p className="break-all font-mono text-xs text-muted-foreground">{locationLabel.qrValue}</p>
              <div className="flex justify-center gap-2">
                <Button type="button" variant="outline" onClick={() => window.print()}>Print</Button>
                <Button asChild>
                  <a href={locationLabel.dataUrl} download={`book-vault-location-${locationLabel.title}.png`}>Download PNG</a>
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <section className="rounded-lg border border-border bg-card p-6 shadow-card">
        <h2 className="mb-4 flex items-center gap-2 text-xl font-heading font-semibold"><Users className="h-5 w-5" />Household members</h2>
        <div className="space-y-2">
          {data?.members.map(member => (
            <div key={member.id} className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3">
              <div className="min-w-[180px] flex-1">
                <p className="font-medium">{member.name}{member.disabled ? ' (disabled)' : ''}</p>
                <p className="text-xs text-muted-foreground">{member.email}</p>
              </div>
              <select
                aria-label={`Role for ${member.name}`}
                disabled={!canManage || member.id === user?.id}
                value={member.householdRole}
                onChange={event => void updateMember(member, { householdRole: event.target.value as Member['householdRole'] })}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="household_admin">Household administrator</option>
                <option value="adult">Adult member</option>
                <option value="child">Child member</option>
                <option value="viewer">Read-only viewer</option>
              </select>
              {canManage && member.id !== user?.id && (
                <>
                  <Button type="button" size="sm" variant="outline" onClick={() => void resetPassword(member)}>Reset password</Button>
                  <Button type="button" size="sm" variant={member.disabled ? 'outline' : 'destructive'} onClick={() => void updateMember(member, { disabled: !member.disabled })}>
                    {member.disabled ? 'Enable' : 'Disable'}
                  </Button>
                  <Button type="button" size="sm" variant={member.hideCollection ? 'default' : 'outline'} onClick={() => void updateMember(member, { hideCollection: !member.hideCollection })}>
                    {member.hideCollection ? 'Show collection' : 'Hide collection'}
                  </Button>
                </>
              )}
              {member.hideCollection && <p className="w-full text-xs text-muted-foreground">This member’s owned copies are hidden from the household collection view. Household administrators can still see them.</p>}
            </div>
          ))}
        </div>
        {canManage && (
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <form onSubmit={addMember} className="space-y-3 rounded-md border border-border p-4">
              <h3 className="flex items-center gap-2 font-heading font-semibold"><UserPlus className="h-4 w-4" />Create account or child profile</h3>
              <Input required placeholder="Name" value={memberForm.name} onChange={event => setMemberForm(current => ({ ...current, name: event.target.value }))} />
              <Input required type="email" placeholder="Email" value={memberForm.email} onChange={event => setMemberForm(current => ({ ...current, email: event.target.value }))} />
              <Input required type="password" minLength={12} placeholder="Temporary password" value={memberForm.password} onChange={event => setMemberForm(current => ({ ...current, password: event.target.value }))} />
              <select value={memberForm.householdRole} onChange={event => setMemberForm(current => ({ ...current, householdRole: event.target.value }))} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="adult">Adult member</option><option value="child">Child profile</option><option value="viewer">Read-only viewer</option><option value="household_admin">Household administrator</option>
              </select>
              <Button type="submit">Create member</Button>
            </form>
            <form onSubmit={inviteMember} className="space-y-3 rounded-md border border-border p-4">
              <h3 className="font-heading font-semibold">Controlled invitation</h3>
              <p className="text-xs text-muted-foreground">Public registration remains disabled. Share the one-time invitation only with its recipient.</p>
              <Input required type="email" placeholder="Email" value={invitationForm.email} onChange={event => setInvitationForm(current => ({ ...current, email: event.target.value }))} />
              <select value={invitationForm.householdRole} onChange={event => setInvitationForm(current => ({ ...current, householdRole: event.target.value }))} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="adult">Adult member</option><option value="child">Child profile</option><option value="viewer">Read-only viewer</option><option value="household_admin">Household administrator</option>
              </select>
              <Button type="submit">Create invitation</Button>
              {invitationToken && <Input readOnly aria-label="One-time invitation link" value={invitationToken} onFocus={event => event.currentTarget.select()} />}
            </form>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-6 shadow-card">
        <h2 className="mb-1 text-xl font-heading font-semibold">Reading statuses</h2>
        <p className="mb-4 text-sm text-muted-foreground">Unread and Read remain available so imported and basic records always have a valid status.</p>
        <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-4">
          {statusData?.statuses.map(status => (
            <label key={status.key} className="flex items-center gap-2 rounded-md border border-border p-3 text-sm">
              <input
                type="checkbox"
                checked={status.enabled}
                disabled={!canManage || ['unread', 'read'].includes(status.key)}
                onChange={event => void toggleReadingStatus(status.key, event.target.checked)}
              />
              {status.label}
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}
