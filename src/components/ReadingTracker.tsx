import { FormEvent, useEffect, useState } from 'react';
import { BookOpenCheck, Loader2, Plus } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

type ReadingDetail = {
  state: {
    status: string;
    rating: number | null;
    favorite: boolean;
    privateNotes?: string;
    householdNotes: string;
  } | null;
  sessions: {
    id: string;
    startedAt: string | null;
    finishedAt: string | null;
    currentPage: number | null;
    percentage: number | null;
    minutesRead: number | null;
    audiobookMinutes: number | null;
    formatUsed: string | null;
    rating: number | null;
    privateNotes?: string;
    householdNotes: string;
    reread: boolean;
  }[];
};

export default function ReadingTracker({ workId, editionId }: { workId: string; editionId?: string | null }) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState('');
  const [stateForm, setStateForm] = useState({ status: 'unread', rating: '', favorite: false, privateNotes: '', householdNotes: '' });
  const [sessionForm, setSessionForm] = useState({
    startedAt: '', finishedAt: '', currentPage: '', percentage: '', minutesRead: '',
    audiobookHours: '', audiobookMinutes: '', formatUsed: '', rating: '', privateNotes: '',
    householdNotes: '', favorite: false, reread: false,
  });
  const { data } = useQuery({
    queryKey: ['reading', workId],
    queryFn: () => api<ReadingDetail>(`/api/reading/works/${workId}`),
  });
  const { data: statuses } = useQuery({
    queryKey: ['reading-statuses'],
    queryFn: () => api<{ statuses: { key: string; label: string; enabled: boolean }[] }>('/api/household/reading-statuses'),
  });
  const { data: household } = useQuery({
    queryKey: ['household'],
    queryFn: () => api<{ household: { ratings: { scale: string; increment: number } } }>('/api/household'),
  });

  useEffect(() => {
    if (!data?.state) return;
    setStateForm({
      status: data.state.status,
      rating: data.state.rating == null ? '' : String(data.state.rating),
      favorite: data.state.favorite,
      privateNotes: data.state.privateNotes || '',
      householdNotes: data.state.householdNotes || '',
    });
  }, [data]);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['reading', workId] }),
      queryClient.invalidateQueries({ queryKey: ['reading-statistics'] }),
      queryClient.invalidateQueries({ queryKey: ['catalog'] }),
    ]);
  }

  async function saveState(event: FormEvent) {
    event.preventDefault();
    setSaving('state');
    try {
      await api(`/api/reading/works/${workId}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...stateForm,
          editionId,
          rating: stateForm.rating || null,
        }),
      });
      await refresh();
      toast.success('Personal reading status saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save reading status');
    } finally {
      setSaving('');
    }
  }

  async function addSession(event: FormEvent) {
    event.preventDefault();
    setSaving('session');
    try {
      const audiobookMinutes = (Number(sessionForm.audiobookHours || 0) * 60) + Number(sessionForm.audiobookMinutes || 0);
      await api(`/api/reading/works/${workId}/sessions`, {
        method: 'POST',
        body: JSON.stringify({
          ...sessionForm,
          editionId,
          currentPage: sessionForm.currentPage || null,
          percentage: sessionForm.percentage || null,
          minutesRead: sessionForm.minutesRead || null,
          audiobookMinutes: audiobookMinutes || null,
          rating: sessionForm.rating || null,
        }),
      });
      setSessionForm({
        startedAt: '', finishedAt: '', currentPage: '', percentage: '', minutesRead: '',
        audiobookHours: '', audiobookMinutes: '', formatUsed: '', rating: '', privateNotes: '',
        householdNotes: '', favorite: false, reread: false,
      });
      await refresh();
      toast.success('Reading session added');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add reading session');
    } finally {
      setSaving('');
    }
  }

  const maximumRating = household?.household.ratings.scale === 'points10' ? 10 : 5;
  const ratingStep = household?.household.ratings.increment || 0.5;

  return (
    <section className="mt-6 space-y-5 border-t border-border pt-6">
      <div>
        <h3 className="flex items-center gap-2 text-xl font-heading font-semibold"><BookOpenCheck className="h-5 w-5" />My reading activity</h3>
        <p className="mt-1 text-sm text-muted-foreground">Reading status belongs to you and the work or edition—not to the shared physical copy.</p>
      </div>
      <form onSubmit={saveState} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2">
        <div>
          <Label htmlFor={`reading-status-${workId}`}>Status</Label>
          <select id={`reading-status-${workId}`} value={stateForm.status} onChange={event => setStateForm(current => ({ ...current, status: event.target.value }))} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
            {statuses?.statuses.filter(status => status.enabled).map(status => <option key={status.key} value={status.key}>{status.label}</option>)}
          </select>
        </div>
        <div>
          <Label htmlFor={`reading-rating-${workId}`}>Rating ({maximumRating}-point maximum)</Label>
          <Input id={`reading-rating-${workId}`} type="number" min="0" max={maximumRating} step={ratingStep} value={stateForm.rating} onChange={event => setStateForm(current => ({ ...current, rating: event.target.value }))} />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor={`private-notes-${workId}`}>Private notes</Label>
          <Textarea id={`private-notes-${workId}`} maxLength={5000} value={stateForm.privateNotes} onChange={event => setStateForm(current => ({ ...current, privateNotes: event.target.value }))} />
          <p className="mt-1 text-xs text-muted-foreground">No other household member or administrator can read these through Book Vault.</p>
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor={`household-notes-${workId}`}>Notes visible to household</Label>
          <Textarea id={`household-notes-${workId}`} maxLength={5000} value={stateForm.householdNotes} onChange={event => setStateForm(current => ({ ...current, householdNotes: event.target.value }))} />
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={stateForm.favorite} onChange={event => setStateForm(current => ({ ...current, favorite: event.target.checked }))} />Favorite book</label>
        <Button type="submit" className="w-fit" disabled={saving === 'state'}>{saving === 'state' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save reading status</Button>
      </form>

      <form onSubmit={addSession} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2 lg:grid-cols-4">
        <h4 className="sm:col-span-2 lg:col-span-4 font-heading font-semibold">Add a reading session</h4>
        <div><Label>Start date</Label><Input type="date" value={sessionForm.startedAt} onChange={event => setSessionForm(current => ({ ...current, startedAt: event.target.value }))} /></div>
        <div><Label>Finish date</Label><Input type="date" value={sessionForm.finishedAt} onChange={event => setSessionForm(current => ({ ...current, finishedAt: event.target.value }))} /></div>
        <div><Label>Current page</Label><Input type="number" min="0" value={sessionForm.currentPage} onChange={event => setSessionForm(current => ({ ...current, currentPage: event.target.value }))} /></div>
        <div><Label>Percent</Label><Input type="number" min="0" max="100" step="0.1" value={sessionForm.percentage} onChange={event => setSessionForm(current => ({ ...current, percentage: event.target.value }))} /></div>
        <div><Label>Minutes read</Label><Input type="number" min="0" value={sessionForm.minutesRead} onChange={event => setSessionForm(current => ({ ...current, minutesRead: event.target.value }))} /></div>
        <div><Label>Audiobook hours</Label><Input type="number" min="0" value={sessionForm.audiobookHours} onChange={event => setSessionForm(current => ({ ...current, audiobookHours: event.target.value }))} /></div>
        <div><Label>Audiobook minutes</Label><Input type="number" min="0" max="59" value={sessionForm.audiobookMinutes} onChange={event => setSessionForm(current => ({ ...current, audiobookMinutes: event.target.value }))} /></div>
        <div>
          <Label>Format used</Label>
          <select value={sessionForm.formatUsed} onChange={event => setSessionForm(current => ({ ...current, formatUsed: event.target.value }))} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
            <option value="">Not specified</option><option value="physical">Physical</option><option value="ebook">eBook</option><option value="audiobook">Audiobook</option>
          </select>
        </div>
        <div><Label>Session rating</Label><Input type="number" min="0" max={maximumRating} step={ratingStep} value={sessionForm.rating} onChange={event => setSessionForm(current => ({ ...current, rating: event.target.value }))} /></div>
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={sessionForm.reread} onChange={event => setSessionForm(current => ({ ...current, reread: event.target.checked }))} />Re-read</label>
        <div className="sm:col-span-2 lg:col-span-4"><Label>Private session notes</Label><Textarea maxLength={5000} value={sessionForm.privateNotes} onChange={event => setSessionForm(current => ({ ...current, privateNotes: event.target.value }))} /></div>
        <div className="sm:col-span-2 lg:col-span-4"><Label>Household-visible session notes</Label><Textarea maxLength={5000} value={sessionForm.householdNotes} onChange={event => setSessionForm(current => ({ ...current, householdNotes: event.target.value }))} /></div>
        <Button type="submit" className="w-fit sm:col-span-2 lg:col-span-4" disabled={saving === 'session'}><Plus className="mr-2 h-4 w-4" />Add session</Button>
      </form>

      {data?.sessions.length ? (
        <div>
          <h4 className="mb-2 font-heading font-semibold">Reading history</h4>
          <div className="space-y-2">
            {data.sessions.map(session => (
              <div key={session.id} className="rounded-md border border-border p-3 text-sm">
                <p className="font-medium">{session.startedAt ? new Date(session.startedAt).toLocaleDateString() : 'No start date'} → {session.finishedAt ? new Date(session.finishedAt).toLocaleDateString() : 'In progress'}</p>
                <p className="text-muted-foreground">
                  {[session.formatUsed, session.currentPage != null && `page ${session.currentPage}`, session.percentage != null && `${session.percentage}%`, session.minutesRead && `${session.minutesRead} min`, session.audiobookMinutes && `${Math.floor(session.audiobookMinutes / 60)}h ${session.audiobookMinutes % 60}m audio`, session.reread && 're-read'].filter(Boolean).join(' · ')}
                </p>
                {session.privateNotes && <p className="mt-1">Private: {session.privateNotes}</p>}
                {session.householdNotes && <p className="mt-1">Household: {session.householdNotes}</p>}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
