import { useState } from 'react';
import { CheckCircle2, Loader2, MapPin, ScanLine, Trash2, TriangleAlert, XCircle } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/auth';
import { normalizeIsbn } from '@/lib/isbn';
import { BookSearchResult } from '@/types/book';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import IsbnScannerDialog from '@/components/IsbnScannerDialog';

type QueueItem = {
  key: string;
  isbn: string;
  state: 'queued' | 'looking_up' | 'success' | 'duplicate' | 'warning' | 'failure';
  book?: BookSearchResult;
  duplicateCount?: number;
  action?: string;
  error?: string;
};

export default function BatchScanDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [scannerOpen, setScannerOpen] = useState(false);
  const [locationScannerOpen, setLocationScannerOpen] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hardwareIsbn, setHardwareIsbn] = useState('');
  const [destinationLocationId, setDestinationLocationId] = useState('');
  const { data: locationsData } = useQuery({
    queryKey: ['locations'],
    queryFn: () => api<{ locations: { id: string; breadcrumb: string }[] }>('/api/locations?archived=false'),
    enabled: open,
  });

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setScannerOpen(false);
      setLocationScannerOpen(false);
      setQueue([]);
      setReviewing(false);
      setSaving(false);
      setHardwareIsbn('');
      setDestinationLocationId('');
    }
  }

  function addScan(isbn: string) {
    if (queue.length >= 100) {
      toast.error('A batch can contain at most 100 scans. Save this queue before scanning more.');
      return;
    }
    setQueue(current => [
      ...current,
      {
        key: `${Date.now()}-${current.length}-${isbn}`,
        isbn,
        state: current.some(item => item.isbn === isbn) ? 'warning' : 'queued',
        error: current.some(item => item.isbn === isbn) ? 'Repeated ISBN in this queue; saving it can create another copy.' : undefined,
      },
    ]);
  }

  function updateItem(key: string, changes: Partial<QueueItem>) {
    setQueue(current => current.map(item => item.key === key ? { ...item, ...changes } : item));
  }

  async function reviewQueue() {
    if (!queue.length) return;
    setReviewing(true);
    for (const item of queue) {
      updateItem(item.key, { state: 'looking_up', error: undefined });
      try {
        const lookup = await api<{ results: BookSearchResult[] }>(
          `/api/book-search?q=${encodeURIComponent(item.isbn)}&type=isbn`,
        );
        const book = lookup.results[0];
        if (!book) {
          updateItem(item.key, { state: 'failure', error: 'No provider result. Add this ISBN manually from Add book.' });
          continue;
        }
        const duplicate = await api<{ warnings: unknown[] }>('/api/catalog/duplicates', {
          method: 'POST',
          body: JSON.stringify(book),
        });
        updateItem(item.key, {
          book,
          duplicateCount: duplicate.warnings.length,
          state: duplicate.warnings.length ? 'duplicate' : 'success',
          action: duplicate.warnings.length ? 'cancel' : 'save',
        });
      } catch (error) {
        updateItem(item.key, { state: 'failure', error: error instanceof Error ? error.message : 'Lookup failed' });
      }
    }
    setReviewing(false);
  }

  async function saveQueue() {
    const entries = queue.flatMap(item => item.book && item.action !== 'cancel'
      ? [{
          ...item.book,
          isbn: item.isbn,
          status: 'owned',
          formats: ['physical'],
          locationId: destinationLocationId || null,
          duplicateAction: item.action === 'save' ? undefined : item.action,
        }]
      : []);
    if (!entries.length) {
      toast.error('Choose at least one reviewed scan to save');
      return;
    }
    setSaving(true);
    try {
      const result = await api<{ results: { state: string; error?: string }[] }>('/api/catalog/batch', {
        method: 'POST',
        body: JSON.stringify({ mode: 'save', entries }),
      });
      const successes = result.results.filter(item => item.state === 'success').length;
      const failures = result.results.length - successes;
      await queryClient.invalidateQueries({ queryKey: ['catalog'] });
      await queryClient.invalidateQueries({ queryKey: ['catalog-duplicates'] });
      await queryClient.invalidateQueries({ queryKey: ['catalog-series'] });
      if (failures) toast.warning(`Saved ${successes}; ${failures} scans need another review`);
      else toast.success(`Saved ${successes} scanned ${successes === 1 ? 'copy' : 'copies'}`);
      if (!failures) close(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save scan queue');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Batch ISBN scanner</DialogTitle>
            <DialogDescription>
              Scan continuously, review metadata and duplicate warnings, then save intentional copies in one batch.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => setScannerOpen(true)}><ScanLine className="mr-2 h-4 w-4" />Open continuous scanner</Button>
            <Button type="button" variant="outline" disabled={!queue.length || reviewing} onClick={() => void reviewQueue()}>
              {reviewing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Review {queue.length} scans
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <label className="text-sm">
              Destination for physical copies
              <select
                value={destinationLocationId}
                onChange={event => setDestinationLocationId(event.target.value)}
                className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Use household default</option>
                {(locationsData?.locations || []).map(location => <option key={location.id} value={location.id}>{location.breadcrumb}</option>)}
              </select>
            </label>
            <Button type="button" variant="outline" className="self-end" onClick={() => setLocationScannerOpen(true)}>
              <MapPin className="mr-2 h-4 w-4" />Scan location QR
            </Button>
          </div>
          <form
            className="flex gap-2"
            onSubmit={event => {
              event.preventDefault();
              const isbn = normalizeIsbn(hardwareIsbn);
              if (!isbn) {
                toast.error('The scanner input is not a valid ISBN-10 or ISBN-13');
                return;
              }
              addScan(isbn);
              setHardwareIsbn('');
            }}
          >
            <Input
              value={hardwareIsbn}
              onChange={event => setHardwareIsbn(event.target.value)}
              placeholder="Focus here, scan with USB/Bluetooth, or type an ISBN"
              aria-label="USB, Bluetooth, or typed ISBN"
              autoComplete="off"
            />
            <Button type="submit" variant="outline">Add scan</Button>
          </form>
          {queue.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-10 text-center text-muted-foreground">
              The queue is empty. Camera scans and USB/Bluetooth scanner input can both be added here.
            </div>
          ) : (
            <div className="space-y-2">
              {queue.map((item, index) => (
                <div key={item.key} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[40px_1fr_220px] sm:items-start">
                  <span className="text-sm text-muted-foreground">{index + 1}</span>
                  <div className="min-w-0">
                    {item.book ? (
                      <div className="grid gap-2 sm:grid-cols-[64px_1fr]">
                        <div className="aspect-[2/3] overflow-hidden rounded bg-muted">
                          {item.book.coverUrl && <img src={item.book.coverUrl} alt="" className="h-full w-full object-cover" />}
                        </div>
                        <div className="space-y-2">
                          <Input
                            aria-label={`Correct title for scan ${index + 1}`}
                            value={item.book.title}
                            maxLength={300}
                            onChange={event => updateItem(item.key, { book: { ...item.book!, title: event.target.value } })}
                          />
                          <Input
                            aria-label={`Correct author for scan ${index + 1}`}
                            value={item.book.author}
                            maxLength={300}
                            onChange={event => updateItem(item.key, { book: { ...item.book!, author: event.target.value } })}
                          />
                          <Input
                            aria-label={`Correct ISBN for scan ${index + 1}`}
                            value={item.isbn}
                            maxLength={30}
                            onChange={event => updateItem(item.key, { isbn: event.target.value })}
                          />
                        </div>
                      </div>
                    ) : (
                      <>
                        <p className="font-medium">{item.isbn}</p>
                        <p className="text-sm text-muted-foreground">{item.error || 'Waiting for metadata review'}</p>
                      </>
                    )}
                    <p className="mt-1 flex items-center gap-1 text-xs">
                      {item.state === 'looking_up' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {item.state === 'success' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}
                      {['duplicate', 'warning'].includes(item.state) && <TriangleAlert className="h-3.5 w-3.5 text-amber-600" />}
                      {item.state === 'failure' && <XCircle className="h-3.5 w-3.5 text-destructive" />}
                      {item.state === 'duplicate' ? `${item.duplicateCount} existing edition match${item.duplicateCount === 1 ? '' : 'es'}` : item.state.replace('_', ' ')}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {item.book ? (
                      <select
                        aria-label={`Duplicate action for ${item.book.title}`}
                        value={item.action}
                        onChange={event => updateItem(item.key, { action: event.target.value })}
                        className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
                      >
                        {item.duplicateCount ? (
                          <>
                            <option value="cancel">Skip existing book</option>
                            <option value="add_another_copy">Add another copy</option>
                            <option value="add_different_edition">Add a different edition</option>
                            <option value="move_wishlist_to_owned">Move wishlist to owned</option>
                          </>
                        ) : <option value="save">Save copy</option>}
                      </select>
                    ) : (
                      <Input
                        aria-label={`ISBN scan ${index + 1}`}
                        value={item.isbn}
                        onChange={event => updateItem(item.key, { isbn: event.target.value, state: 'queued' })}
                      />
                    )}
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove scan ${index + 1}`}
                      onClick={() => setQueue(current => current.filter(candidate => candidate.key !== item.key))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>Cancel</Button>
            <Button type="button" disabled={saving || reviewing || !queue.some(item => item.book && item.action !== 'cancel')} onClick={() => void saveQueue()}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save reviewed queue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <IsbnScannerDialog
        open={scannerOpen}
        onOpenChange={setScannerOpen}
        onDetected={addScan}
        continuous
      />
      <IsbnScannerDialog
        open={locationScannerOpen}
        onOpenChange={setLocationScannerOpen}
        onDetected={value => {
          const id = value.split(':')[1];
          if (!(locationsData?.locations || []).some(location => location.id === id)) {
            toast.error('That location is archived or belongs to another household');
            return;
          }
          setDestinationLocationId(id);
          setLocationScannerOpen(false);
          toast.success('Batch destination selected');
        }}
        scanMode="location"
      />
    </>
  );
}
