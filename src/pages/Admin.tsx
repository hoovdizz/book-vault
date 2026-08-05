import { ChangeEvent, FormEvent, useState } from 'react';
import { AlertTriangle, Archive, Database, Download, FileUp, HardDrive, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Status = {
  application: { version: string; health: string; telemetry: boolean };
  database: { version: number; supportedVersion: number; sizeBytes: number };
  covers: { sizeBytes: number };
  counts: { users: number; households: number; works: number; editions: number; copies: number };
  backup: { status: string; lastSuccessAt: string | null; error: string | null };
  providers: { providers: { provider: string; enabled: boolean; priority: number }[] };
  failedJobs: { id: string; type: string; error: string; completedAt: string }[];
  recentJobs: { id: string; type: string; status: string; progress: number; error: string | null }[];
  failedImports: { id: string; preset: string; filename: string; completedAt: string }[];
  securityEvents: { id: string; type: string; targetType: string; actor: string; createdAt: string }[];
  storage: { availableBytes: number; totalBytes: number } | null;
};
type Backup = {
  id: string;
  type: string;
  filename: string | null;
  size: number | null;
  integrity: string | null;
  status: string;
  error: string | null;
  createdAt: string;
  downloadable: boolean;
};
type ImportPreview = {
  runId: string;
  preset: string;
  headers: string[];
  mapping: Record<string, string>;
  unknownHeaders: string[];
  rowCount: number;
  canCommit: boolean;
  preview: {
    row: number;
    data: { title: string; author: string; isbn: string };
    errors: string[];
    duplicateCount: number;
  }[];
};

function bytes(value: number | null | undefined) {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export default function Admin() {
  const queryClient = useQueryClient();
  const [working, setWorking] = useState('');
  const [preset, setPreset] = useState('generic');
  const [importFile, setImportFile] = useState<{ name: string; csv: string } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mappingDraft, setMappingDraft] = useState<Record<string, string>>({});
  const [fieldForm, setFieldForm] = useState({ name: '', type: 'text', appliesTo: 'copy' });
  const { data: status, error: statusError } = useQuery({
    queryKey: ['admin-status'],
    queryFn: () => api<Status>('/api/admin/status'),
    refetchInterval: query => query.state.data?.recentJobs.some(job => ['queued', 'running'].includes(job.status)) ? 3000 : false,
  });
  const { data: backupData } = useQuery({
    queryKey: ['backups'],
    queryFn: () => api<{ backups: Backup[] }>('/api/admin/backups'),
  });
  const { data: quality } = useQuery({
    queryKey: ['metadata-quality'],
    queryFn: () => api<{ totals: Record<string, number>; incomplete: { workId: string; title: string; author: string; missing: string[] }[] }>('/api/metadata/quality'),
  });
  const { data: providerData } = useQuery({
    queryKey: ['metadata-providers'],
    queryFn: () => api<{ providers: { provider: string; enabled: boolean; priority: number; settings: Record<string, unknown> }[] }>('/api/metadata/providers'),
  });
  const { data: presets } = useQuery({
    queryKey: ['import-presets'],
    queryFn: () => api<{ presets: { key: string; label: string }[] }>('/api/imports/presets'),
  });
  const { data: customFieldData } = useQuery({
    queryKey: ['custom-fields'],
    queryFn: () => api<{ fields: { id: string; name: string; type: string; appliesTo: string }[] }>('/api/custom-fields'),
  });
  const { data: householdData } = useQuery({
    queryKey: ['admin-households'],
    queryFn: () => api<{ households: { id: string; name: string; members: number; works: number; copies: number }[] }>('/api/admin/households'),
    retry: false,
  });

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin-status'] }),
      queryClient.invalidateQueries({ queryKey: ['backups'] }),
      queryClient.invalidateQueries({ queryKey: ['metadata-quality'] }),
    ]);
  }

  async function saveProviders(providers: { provider: string; enabled: boolean; priority: number; settings: Record<string, unknown> }[]) {
    setWorking('providers');
    try {
      await api('/api/metadata/providers', {
        method: 'PUT',
        body: JSON.stringify({ providers }),
      });
      await queryClient.invalidateQueries({ queryKey: ['metadata-providers'] });
      toast.success('Metadata lookup order updated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update metadata providers');
    } finally {
      setWorking('');
    }
  }

  async function queueMetadataJob(jobType: 'metadata_refresh' | 'cover_backfill') {
    setWorking(jobType);
    try {
      const result = await api<{ job: { records: number } }>('/api/metadata/jobs', {
        method: 'POST',
        body: JSON.stringify({ jobType, limit: 250 }),
      });
      await queryClient.invalidateQueries({ queryKey: ['admin-status'] });
      toast.success(`${jobType === 'cover_backfill' ? 'Cover backfill' : 'Metadata refresh'} queued for ${result.job.records} editions`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not queue metadata job');
    } finally {
      setWorking('');
    }
  }

  async function createCustomField(event: FormEvent) {
    event.preventDefault();
    try {
      await api('/api/custom-fields', {
        method: 'POST',
        body: JSON.stringify(fieldForm),
      });
      setFieldForm({ name: '', type: 'text', appliesTo: 'copy' });
      await queryClient.invalidateQueries({ queryKey: ['custom-fields'] });
      toast.success('Custom catalog field created');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create custom field');
    }
  }

  async function createBackup() {
    setWorking('backup');
    try {
      await api('/api/admin/backups', { method: 'POST' });
      await refresh();
      toast.success('Backup completed and passed SQLite integrity validation');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Backup failed');
    } finally {
      setWorking('');
    }
  }

  async function runIntegrity() {
    setWorking('integrity');
    try {
      const result = await api<{ status: string }>('/api/admin/integrity', { method: 'POST' });
      toast.success(`Database integrity: ${result.status}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Integrity check failed');
    } finally {
      setWorking('');
    }
  }

  async function previewRestore(backup: Backup) {
    setWorking(`restore-${backup.id}`);
    try {
      const response = await api<{ preview: { database: { integrity: string; counts: Record<string, number> }; coverFiles: number } }>(
        `/api/admin/backups/${backup.id}/restore-preview`,
        { method: 'POST' },
      );
      const confirmation = window.prompt(
        `Backup validated (${response.preview.database.integrity}); ${response.preview.coverFiles} cover files. `
        + 'A safety backup will be created. Type RESTORE to stage this restore for the next container restart.',
      );
      if (confirmation !== 'RESTORE') return;
      const staged = await api<{ restore: { message: string } }>(`/api/admin/backups/${backup.id}/restore`, {
        method: 'POST',
        body: JSON.stringify({ confirmation }),
      });
      toast.warning(staged.restore.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Restore validation failed');
    } finally {
      setWorking('');
    }
  }

  async function chooseImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast.error('Import CSV must be 10 MB or smaller');
      return;
    }
    setImportFile({ name: file.name, csv: await file.text() });
    setPreview(null);
    setMappingDraft({});
  }

  async function previewCsv() {
    if (!importFile) return;
    setWorking('import-preview');
    try {
      const result = await api<{ preview: ImportPreview }>('/api/imports/preview', {
        method: 'POST',
        body: JSON.stringify({ filename: importFile.name, csv: importFile.csv, preset, mapping: mappingDraft }),
      });
      setPreview(result.preview);
      setMappingDraft(result.preview.mapping);
      toast.success(`Dry run parsed ${result.preview.rowCount} rows without changing the catalog`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Import preview failed');
    } finally {
      setWorking('');
    }
  }

  async function commitCsv() {
    if (!preview) return;
    setWorking('import-commit');
    try {
      const result = await api<{ import: { imported: number; skipped: number } }>(`/api/imports/${preview.runId}/commit`, {
        method: 'POST',
        body: JSON.stringify({ duplicateAction: 'cancel' }),
      });
      toast.success(`Imported ${result.import.imported}; skipped ${result.import.skipped} duplicate rows`);
      setPreview(null);
      setImportFile(null);
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ['catalog'] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Import failed');
    } finally {
      setWorking('');
    }
  }

  if (statusError) {
    return <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-destructive">
      {statusError instanceof Error ? statusError.message : 'Administrator access required'}
    </div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-heading font-bold">Administration</h1>
        <p className="mt-1 text-muted-foreground">Health, data quality, backups, imports, exports, and audit history without exposing secrets.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Application', status?.application.version || '…', `Health: ${status?.application.health || 'loading'}`],
          ['Database', `Schema ${status?.database.version || '…'}`, bytes(status?.database.sizeBytes)],
          ['Catalog', `${status?.counts.copies || 0} copies`, `${status?.counts.works || 0} works · ${status?.counts.editions || 0} editions`],
          ['Storage', bytes(status?.storage?.availableBytes), `${bytes(status?.covers.sizeBytes)} cover cache`],
        ].map(([label, value, detail]) => (
          <div key={label} className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-xl font-heading font-semibold">{value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
          </div>
        ))}
      </div>

      {householdData?.households && (
        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="text-xl font-heading font-semibold">Households</h2>
          <p className="mt-1 text-sm text-muted-foreground">System-wide inventory overview. Household administrators manage their own members and defaults in Settings.</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead><tr className="border-b border-border"><th className="p-2">Household</th><th className="p-2">Members</th><th className="p-2">Works</th><th className="p-2">Copies</th></tr></thead>
              <tbody>{householdData.households.map(household => <tr key={household.id} className="border-b border-border last:border-0"><td className="p-2 font-medium">{household.name}</td><td className="p-2">{household.members}</td><td className="p-2">{household.works}</td><td className="p-2">{household.copies}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      )}

      <section className="rounded-lg border border-border bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-heading font-semibold"><Archive className="h-5 w-5" />Backups and integrity</h2>
            <p className="mt-1 text-sm text-muted-foreground">Archives include a consistent SQLite snapshot and cached covers under persistent /config storage.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={Boolean(working)} onClick={() => void runIntegrity()}>
              {working === 'integrity' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}Integrity check
            </Button>
            <Button type="button" disabled={Boolean(working)} onClick={() => void createBackup()}>
              {working === 'backup' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Database className="mr-2 h-4 w-4" />}Create backup
            </Button>
          </div>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead><tr className="border-b border-border"><th className="p-2">Created</th><th className="p-2">Type</th><th className="p-2">Size</th><th className="p-2">Status</th><th className="p-2">Actions</th></tr></thead>
            <tbody>
              {backupData?.backups.map(backup => (
                <tr key={backup.id} className="border-b border-border">
                  <td className="p-2">{new Date(backup.createdAt).toLocaleString()}</td>
                  <td className="p-2">{backup.type}</td>
                  <td className="p-2">{bytes(backup.size)}</td>
                  <td className="p-2">{backup.status}{backup.error ? ` · ${backup.error}` : ''}</td>
                  <td className="p-2">
                    <div className="flex gap-2">
                      {backup.downloadable && <Button asChild size="sm" variant="outline"><a href={`/api/admin/backups/${backup.id}/download`}><Download className="mr-1 h-3.5 w-3.5" />Download</a></Button>}
                      {backup.downloadable && <Button type="button" size="sm" variant="destructive" disabled={Boolean(working)} onClick={() => void previewRestore(backup)}>Restore…</Button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-6">
        <h2 className="flex items-center gap-2 text-xl font-heading font-semibold"><RefreshCw className="h-5 w-5" />Metadata providers</h2>
        <p className="mt-1 text-sm text-muted-foreground">The first enabled provider supplies preferred fields; later providers fill gaps. Manual entry always remains available when external services fail.</p>
        <div className="mt-4 space-y-2">
          {providerData?.providers.map((provider, index, all) => (
            <div key={provider.provider} className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3">
              <span className="w-7 text-sm text-muted-foreground">{index + 1}</span>
              <span className="min-w-[150px] flex-1 font-medium">{provider.provider.replaceAll('_', ' ')}</span>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={provider.enabled}
                  disabled={provider.provider === 'manual' || Boolean(working)}
                  onChange={event => void saveProviders(all.map(item => item.provider === provider.provider ? { ...item, enabled: event.target.checked } : item))}
                />
                Enabled
              </label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={index === 0 || Boolean(working)}
                aria-label={`Move ${provider.provider} earlier`}
                onClick={() => {
                  const next = [...all];
                  [next[index - 1], next[index]] = [next[index], next[index - 1]];
                  void saveProviders(next);
                }}
              >
                Up
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={index === all.length - 1 || Boolean(working)}
                aria-label={`Move ${provider.provider} later`}
                onClick={() => {
                  const next = [...all];
                  [next[index], next[index + 1]] = [next[index + 1], next[index]];
                  void saveProviders(next);
                }}
              >
                Down
              </Button>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-xl font-heading font-semibold"><RefreshCw className="h-5 w-5" />Metadata quality</h2>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={Boolean(working)} onClick={() => void queueMetadataJob('metadata_refresh')}>Refresh incomplete metadata</Button>
            <Button type="button" variant="outline" disabled={Boolean(working)} onClick={() => void queueMetadataJob('cover_backfill')}>Backfill covers</Button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Object.entries(quality?.totals || {}).map(([label, value]) => (
            <div key={label} className="rounded-md border border-border p-3">
              <p className="text-xl font-semibold">{value}</p>
              <p className="text-xs text-muted-foreground">{label.replaceAll(/([A-Z])/g, ' $1').replaceAll('_', ' ')}</p>
            </div>
          ))}
        </div>
        {(quality?.incomplete.length || 0) > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium">Review incomplete records</summary>
            <div className="mt-2 max-h-64 overflow-y-auto">
              {quality?.incomplete.map(record => (
                <p key={`${record.workId}:${record.title}`} className="border-b border-border py-2 text-sm">
                  {record.title} · {record.author} <span className="text-muted-foreground">Missing: {record.missing.join(', ')}</span>
                </p>
              ))}
            </div>
          </details>
        )}
        {(status?.recentJobs.length || 0) > 0 && (
          <div className="mt-4 space-y-2">
            <h3 className="text-sm font-medium">Recent background jobs</h3>
            {status?.recentJobs.slice(0, 5).map(job => (
              <p key={job.id} className="text-sm text-muted-foreground">
                {job.type.replaceAll('_', ' ')} · {job.status} · {Math.round(job.progress * 100)}%
                {job.error ? ` · ${job.error}` : ''}
              </p>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-6">
        <h2 className="flex items-center gap-2 text-xl font-heading font-semibold"><FileUp className="h-5 w-5" />Import with dry run</h2>
        <p className="mt-1 text-sm text-muted-foreground">Choose a preset, preview inferred columns and duplicates, then commit. Unknown columns are retained in the import report.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-[180px_1fr_auto]">
          <select value={preset} onChange={event => { setPreset(event.target.value); setPreview(null); }} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
            {presets?.presets.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
          </select>
          <Input type="file" accept=".csv,text/csv" onChange={event => void chooseImportFile(event)} />
          <Button type="button" disabled={!importFile || Boolean(working)} onClick={() => void previewCsv()}>
            {working === 'import-preview' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Preview
          </Button>
        </div>
        {preview && (
          <div className="mt-4 rounded-md border border-border p-4">
            <p className="font-medium">{preview.rowCount} rows · {preview.unknownHeaders.length} unknown columns retained</p>
            <p className="text-xs text-muted-foreground">Mapping: {Object.entries(preview.mapping).map(([field, column]) => `${field} ← ${column}`).join(' · ')}</p>
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-medium">Adjust column mapping</summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {['title', 'author', 'isbn', 'publisher', 'publicationDate', 'pageCount', 'binding', 'status', 'readStatus', 'rating', 'series', 'seriesNumber', 'location', 'conditionGrade', 'conditionNotes', 'notes', 'tags', 'startDate', 'finishDate'].map(field => (
                  <label key={field} className="text-xs">
                    {field}
                    <select
                      value={mappingDraft[field] || ''}
                      onChange={event => setMappingDraft(current => ({ ...current, [field]: event.target.value }))}
                      className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    >
                      <option value="">Not mapped</option>
                      {preview.headers.map(header => <option key={header} value={header}>{header}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              <Button type="button" size="sm" variant="outline" className="mt-3" disabled={Boolean(working)} onClick={() => void previewCsv()}>
                Re-run dry preview with mapping
              </Button>
            </details>
            <div className="mt-3 max-h-56 overflow-y-auto text-sm">
              {preview.preview.slice(0, 100).map(row => (
                <p key={row.row} className="border-b border-border py-2">
                  Row {row.row}: {row.data.title} · {row.data.author}
                  {row.duplicateCount ? <span className="ml-2 text-amber-700 dark:text-amber-300">{row.duplicateCount} duplicate warning(s)</span> : null}
                  {row.errors.length ? <span className="ml-2 text-destructive">{row.errors.join(', ')}</span> : null}
                </p>
              ))}
            </div>
            <Button type="button" className="mt-3" disabled={!preview.canCommit || Boolean(working)} onClick={() => void commitCsv()}>
              {working === 'import-commit' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Commit import, skipping duplicates
            </Button>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-6">
        <h2 className="text-xl font-heading font-semibold">Custom catalog fields</h2>
        <p className="mt-1 text-sm text-muted-foreground">Define household fields for a conceptual work, a publication edition, or an individual copy.</p>
        <form onSubmit={createCustomField} className="mt-4 grid gap-3 sm:grid-cols-[1fr_160px_160px_auto]">
          <Input required maxLength={100} placeholder="Field name" value={fieldForm.name} onChange={event => setFieldForm(current => ({ ...current, name: event.target.value }))} />
          <select value={fieldForm.type} onChange={event => setFieldForm(current => ({ ...current, type: event.target.value }))} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
            <option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="boolean">Yes / no</option><option value="choice">Choice text</option>
          </select>
          <select value={fieldForm.appliesTo} onChange={event => setFieldForm(current => ({ ...current, appliesTo: event.target.value }))} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
            <option value="work">Work</option><option value="edition">Edition</option><option value="copy">Copy</option>
          </select>
          <Button type="submit">Add field</Button>
        </form>
        <div className="mt-3 flex flex-wrap gap-2">
          {customFieldData?.fields.map(field => <span key={field.id} className="rounded-full border border-border px-3 py-1 text-xs">{field.name} · {field.type} · {field.appliesTo}</span>)}
          {!customFieldData?.fields.length && <p className="text-sm text-muted-foreground">No custom fields defined.</p>}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-6">
        <h2 className="flex items-center gap-2 text-xl font-heading font-semibold"><Download className="h-5 w-5" />Data exports</h2>
        <p className="mt-1 text-sm text-muted-foreground">Household JSON omits other members’ private notes. Each member can export their own private reading history separately.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button asChild variant="outline"><a href="/api/exports/catalog.csv">Full catalog CSV</a></Button>
          <Button asChild variant="outline"><a href="/api/exports/household.json">Household JSON</a></Button>
          <Button asChild variant="outline"><a href="/api/exports/loans.csv">Loan history CSV</a></Button>
          <Button asChild variant="outline"><a href="/api/exports/reading.json">My reading JSON</a></Button>
        </div>
      </section>

      {(status?.failedJobs.length || status?.failedImports.length || status?.securityEvents.length) ? (
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="flex items-center gap-2 font-heading text-lg font-semibold"><AlertTriangle className="h-4 w-4" />Failed jobs</h2>
            {status?.failedJobs.length ? status.failedJobs.map(job => <p key={job.id} className="mt-2 text-sm">{job.type}: {job.error}</p>) : <p className="mt-2 text-sm text-muted-foreground">No failed jobs.</p>}
            {status?.failedImports.map(run => <p key={`import-${run.id}`} className="mt-2 text-sm">Import {run.filename} ({run.preset}) failed.</p>)}
          </div>
          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="flex items-center gap-2 font-heading text-lg font-semibold"><HardDrive className="h-4 w-4" />Recent security events</h2>
            {status?.securityEvents.map(event => <p key={event.id} className="mt-2 text-sm">{event.type.replaceAll('_', ' ')} · {event.actor} · {new Date(event.createdAt).toLocaleString()}</p>)}
          </div>
        </section>
      ) : null}
    </div>
  );
}
