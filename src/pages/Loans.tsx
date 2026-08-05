import { FormEvent, useState } from 'react';
import { CheckCircle2, ClockAlert, Loader2, RefreshCw, ScanLine } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/auth';
import { fetchCatalog } from '@/lib/catalog';
import { UserBook } from '@/types/book';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Loan = {
  id: string;
  copyId: string;
  title: string;
  author: string;
  coverUrl: string | null;
  isbn: string | null;
  customBarcode: string | null;
  format: string;
  owner: { id: string | null; name: string };
  borrower: { type: string; id: string; name: string };
  checkoutAt: string;
  dueAt: string | null;
  returnedAt: string | null;
  renewedCount: number;
  status: string;
  notes: string;
  overdue: boolean;
};

export default function Loans() {
  const queryClient = useQueryClient();
  const [history, setHistory] = useState(false);
  const [barcode, setBarcode] = useState('');
  const [batch, setBatch] = useState<string[]>([]);
  const [working, setWorking] = useState('');
  const [checkoutSearch, setCheckoutSearch] = useState('');
  const [checkoutCopies, setCheckoutCopies] = useState<UserBook[]>([]);
  const [checkoutForm, setCheckoutForm] = useState({
    copyId: '',
    borrowerUserId: '',
    externalName: '',
    dueAt: '',
    notes: '',
  });
  const { data, isLoading, error } = useQuery({
    queryKey: ['loans', history],
    queryFn: () => api<{ loans: Loan[] }>(`/api/loans?history=${history}`),
  });
  const { data: holds } = useQuery({
    queryKey: ['holds'],
    queryFn: () => api<{ holds: { id: string; title: string; requestedBy: { name: string }; queuePosition: number }[] }>('/api/holds'),
  });
  const { data: household } = useQuery({
    queryKey: ['household'],
    queryFn: () => api<{ members: { id: number; name: string; disabled: boolean }[] }>('/api/household'),
  });

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['loans'] }),
      queryClient.invalidateQueries({ queryKey: ['catalog'] }),
      queryClient.invalidateQueries({ queryKey: ['catalog-stats'] }),
    ]);
  }

  async function returnCopy(loan: Loan) {
    setWorking(loan.id);
    try {
      await api(`/api/loans/${loan.id}/return`, { method: 'POST', body: JSON.stringify({}) });
      await refresh();
      toast.success(`Checked in “${loan.title}”`);
    } catch (returnError) {
      toast.error(returnError instanceof Error ? returnError.message : 'Check-in failed');
    } finally {
      setWorking('');
    }
  }

  async function renew(loan: Loan) {
    const dueAt = window.prompt('New due date (YYYY-MM-DD):', loan.dueAt?.slice(0, 10) || '');
    if (!dueAt) return;
    setWorking(loan.id);
    try {
      await api(`/api/loans/${loan.id}/renew`, { method: 'POST', body: JSON.stringify({ dueAt }) });
      await refresh();
      toast.success('Loan renewed');
    } catch (renewError) {
      toast.error(renewError instanceof Error ? renewError.message : 'Renewal failed');
    } finally {
      setWorking('');
    }
  }

  async function markLoanStatus(loan: Loan, status: 'lost' | 'damaged') {
    setWorking(loan.id);
    try {
      await api(`/api/loans/${loan.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      await refresh();
      toast.warning(`Loan marked ${status}`);
    } catch (statusError) {
      toast.error(statusError instanceof Error ? statusError.message : 'Could not update loan');
    } finally {
      setWorking('');
    }
  }

  async function findCheckoutCopy(event: FormEvent) {
    event.preventDefault();
    if (!checkoutSearch.trim()) return;
    setWorking('checkout-search');
    try {
      const result = await fetchCatalog({
        q: checkoutSearch.trim(),
        status: ['owned'],
        pageSize: 25,
        sort: 'title',
      });
      const available = result.items.filter(item => item.kind === 'copy' && !item.activeLoan);
      setCheckoutCopies(available);
      setCheckoutForm(current => ({ ...current, copyId: available.length === 1 ? available[0].copyId || '' : '' }));
      if (!available.length) toast.warning('No available copy matched that ISBN, custom barcode, title, or author');
      else if (result.pagination.total > available.length) toast.info('Some matching copies are already checked out');
    } catch (checkoutError) {
      toast.error(checkoutError instanceof Error ? checkoutError.message : 'Copy lookup failed');
    } finally {
      setWorking('');
    }
  }

  async function checkoutCopy(event: FormEvent) {
    event.preventDefault();
    if (!checkoutForm.copyId) return toast.error('Select a copy to check out');
    if (!checkoutForm.borrowerUserId && !checkoutForm.externalName.trim()) {
      return toast.error('Choose a household member or enter an external borrower');
    }
    setWorking('checkout');
    try {
      await api('/api/loans', {
        method: 'POST',
        body: JSON.stringify({
          copyId: checkoutForm.copyId,
          borrowerUserId: checkoutForm.borrowerUserId || null,
          externalName: checkoutForm.borrowerUserId ? null : checkoutForm.externalName,
          dueAt: checkoutForm.dueAt || null,
          notes: checkoutForm.notes,
        }),
      });
      setCheckoutCopies([]);
      setCheckoutSearch('');
      setCheckoutForm({ copyId: '', borrowerUserId: '', externalName: '', dueAt: '', notes: '' });
      await refresh();
      toast.success('Copy checked out');
    } catch (checkoutError) {
      toast.error(checkoutError instanceof Error ? checkoutError.message : 'Checkout failed');
    } finally {
      setWorking('');
    }
  }

  function addBarcode(event: FormEvent) {
    event.preventDefault();
    if (!barcode.trim()) return;
    setBatch(current => [...current, barcode.trim()]);
    setBarcode('');
  }

  async function checkInBatch() {
    setWorking('batch');
    try {
      const result = await api<{ results: { state: string; message?: string }[] }>('/api/loans/batch-check-in', {
        method: 'POST',
        body: JSON.stringify({ barcodes: batch }),
      });
      const returned = result.results.filter(item => item.state === 'success').length;
      const warnings = result.results.length - returned;
      toast.success(`Checked in ${returned}${warnings ? `; ${warnings} scans need manual review` : ''}`);
      setBatch([]);
      await refresh();
    } catch (batchError) {
      toast.error(batchError instanceof Error ? batchError.message : 'Batch check-in failed');
    } finally {
      setWorking('');
    }
  }

  const activeLoans = data?.loans.filter(loan => !loan.returnedAt) || [];
  const overdue = activeLoans.filter(loan => loan.overdue);

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-3xl font-heading font-bold">Loans and circulation</h1>
          <p className="mt-1 text-muted-foreground">{activeLoans.length} checked out · {overdue.length} overdue · returned loans retain their history</p>
        </div>
        <Button type="button" variant={history ? 'default' : 'outline'} onClick={() => setHistory(current => !current)}>
          {history ? 'Show active only' : 'Show loan history'}
        </Button>
      </div>

      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="font-heading text-lg font-semibold">Check out a specific copy</h2>
        <p className="mt-1 text-sm text-muted-foreground">Scan an ISBN or custom barcode, or search by title or author. Multiple matching copies remain selectable.</p>
        <form onSubmit={findCheckoutCopy} className="mt-3 flex gap-2">
          <Input value={checkoutSearch} onChange={event => setCheckoutSearch(event.target.value)} placeholder="ISBN, custom barcode, title, or author" autoComplete="off" />
          <Button type="submit" variant="outline" disabled={working === 'checkout-search'}>
            {working === 'checkout-search' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Find copy
          </Button>
        </form>
        {checkoutCopies.length > 0 && (
          <form onSubmit={checkoutCopy} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <select value={checkoutForm.copyId} onChange={event => setCheckoutForm(current => ({ ...current, copyId: event.target.value }))} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
              <option value="">Select an available copy</option>
              {checkoutCopies.map(copy => <option key={copy.id} value={copy.copyId || ''}>{copy.book.title} · {copy.owner?.name} · {copy.book.edition || copy.book.binding || copy.formats[0]} · {copy.storageLocation || 'no location'}</option>)}
            </select>
            <select
              value={checkoutForm.borrowerUserId}
              onChange={event => setCheckoutForm(current => ({ ...current, borrowerUserId: event.target.value, externalName: event.target.value ? '' : current.externalName }))}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">External borrower</option>
              {(household?.members || []).filter(member => !member.disabled).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
            </select>
            <Input disabled={Boolean(checkoutForm.borrowerUserId)} maxLength={150} placeholder="External borrower name" value={checkoutForm.externalName} onChange={event => setCheckoutForm(current => ({ ...current, externalName: event.target.value }))} />
            <Input type="date" aria-label="Optional due date" value={checkoutForm.dueAt} onChange={event => setCheckoutForm(current => ({ ...current, dueAt: event.target.value }))} />
            <Input maxLength={2000} placeholder="Loan notes (optional)" value={checkoutForm.notes} onChange={event => setCheckoutForm(current => ({ ...current, notes: event.target.value }))} />
            <Button type="submit" disabled={working === 'checkout'}>{working === 'checkout' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Check out copy</Button>
          </form>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="flex items-center gap-2 font-heading text-lg font-semibold"><ScanLine className="h-5 w-5" />Batch check-in by barcode</h2>
        <form onSubmit={addBarcode} className="mt-3 flex gap-2">
          <Input value={barcode} onChange={event => setBarcode(event.target.value)} placeholder="Scan custom barcode or ISBN, then press Enter" autoComplete="off" />
          <Button type="submit" variant="outline">Queue</Button>
        </form>
        {batch.length > 0 && (
          <div className="mt-3">
            <p className="text-sm text-muted-foreground">{batch.length} queued: {batch.join(', ')}</p>
            <Button type="button" className="mt-2" disabled={working === 'batch'} onClick={() => void checkInBatch()}>
              {working === 'batch' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Check in queue
            </Button>
          </div>
        )}
      </section>

      {overdue.length > 0 && (
        <section className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4">
          <h2 className="flex items-center gap-2 font-heading font-semibold"><ClockAlert className="h-5 w-5" />Overdue items</h2>
          <p className="mt-1 text-sm">{overdue.map(loan => `${loan.title} (${loan.borrower.name})`).join(' · ')}</p>
        </section>
      )}

      {isLoading ? (
        <div className="py-16 text-center text-muted-foreground">Loading loans…</div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-destructive">
          {error instanceof Error ? error.message : 'Could not load loans'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead><tr className="border-b border-border bg-muted/50"><th className="p-3">Book and copy</th><th className="p-3">Borrower</th><th className="p-3">Dates</th><th className="p-3">Status</th><th className="p-3">Actions</th></tr></thead>
            <tbody>
              {data?.loans.map(loan => (
                <tr key={loan.id} className="border-b border-border last:border-0">
                  <td className="p-3"><p className="font-medium">{loan.title}</p><p className="text-xs text-muted-foreground">{loan.owner.name} · {loan.format} · {loan.customBarcode || loan.isbn || `copy ${loan.copyId}`}</p></td>
                  <td className="p-3">{loan.borrower.name}<p className="text-xs text-muted-foreground">{loan.borrower.type}</p></td>
                  <td className="p-3"><p>Out {new Date(loan.checkoutAt).toLocaleDateString()}</p><p className="text-xs text-muted-foreground">{loan.returnedAt ? `Returned ${new Date(loan.returnedAt).toLocaleDateString()}` : loan.dueAt ? `Due ${new Date(loan.dueAt).toLocaleDateString()}` : 'No due date'}</p></td>
                  <td className={`p-3 ${loan.overdue ? 'font-medium text-amber-700 dark:text-amber-300' : ''}`}>{loan.status.replaceAll('_', ' ')}</td>
                  <td className="p-3">
                    {!loan.returnedAt && (
                      <div className="flex gap-2">
                        <Button type="button" size="sm" disabled={working === loan.id} onClick={() => void returnCopy(loan)}>
                          {working === loan.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}Return
                        </Button>
                        <Button type="button" size="sm" variant="outline" disabled={working === loan.id} onClick={() => void renew(loan)}><RefreshCw className="mr-1 h-3.5 w-3.5" />Renew</Button>
                        <Button type="button" size="sm" variant="outline" disabled={working === loan.id} onClick={() => void markLoanStatus(loan, 'damaged')}>Damaged</Button>
                        <Button type="button" size="sm" variant="destructive" disabled={working === loan.id} onClick={() => void markLoanStatus(loan, 'lost')}>Lost</Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data?.loans.length && <p className="p-8 text-center text-muted-foreground">No loans in this view.</p>}
        </div>
      )}

      {(holds?.holds.length || 0) > 0 && (
        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="font-heading text-lg font-semibold">Reservation queue</h2>
          {holds?.holds.map(hold => <p key={hold.id} className="mt-2 text-sm">#{hold.queuePosition} {hold.title} · {hold.requestedBy.name}</p>)}
        </section>
      )}
    </div>
  );
}
