import { FormEvent, useEffect, useState } from 'react';
import { Check, ImageOff, Loader2, Search, Trash2, Upload } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/auth';
import { BookBinding, BookCondition, BookFormat, BookSearchResult, CoverOption, UserBook } from '@/types/book';
import { bindingLabels, conditionLabels } from '@/lib/book-copy';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import ReadingTracker from '@/components/ReadingTracker';

type Providers = {
  googleBooks: 'available' | 'unavailable' | 'disabled';
  openLibrary: 'available' | 'unavailable' | 'disabled';
  hardcover: 'available' | 'unavailable' | 'disabled';
};

type Draft = {
  title: string;
  author: string;
  isbn: string;
  publisher: string;
  publishedYear: string;
  pageCount: string;
  genre: string;
  description: string;
  collection: string;
  series: string;
  seriesNumber: string;
  coverUrl: string;
  coverOptions: CoverOption[];
  source: 'google_books' | 'open_library' | 'manual';
  sourceId: string;
  formats: BookFormat[];
  status: 'owned' | 'wishlist' | 'backlog';
  readStatus: string;
  binding: BookBinding | '';
  edition: string;
  storageLocation: string;
  locationId: string;
  conditionGrade: BookCondition | '';
  conditionNotes: string;
  loanedOut: boolean;
  loanedTo: string;
  loanedAt: string;
  scope: 'personal' | 'household';
  priority: '' | 'low' | 'medium' | 'high';
  expectedPrice: string;
  notes: string;
  giftPrivate: boolean;
  intendedRecipientId: string;
  desiredEdition: string;
  ownerUserId: string;
  purchaseDate: string;
  purchasePrice: string;
  purchaseCurrency: string;
  purchaseSource: string;
  customBarcode: string;
  copyNotes: string;
};

const formatLabels: Record<BookFormat, string> = {
  physical: 'Physical',
  ebook: 'eBook',
  audiobook: 'Audiobook',
};

function draftFromBook(userBook: UserBook): Draft {
  const book = userBook.book;
  const coverOptions = [...(book.coverOptions || [])];
  if (book.coverUrl && !coverOptions.some(option => option.url === book.coverUrl)) {
    coverOptions.unshift({ url: book.coverUrl, source: 'Current', label: 'Current cover' });
  }
  return {
    title: book.title,
    author: book.author,
    isbn: book.isbn || '',
    publisher: book.publisher || '',
    publishedYear: book.publishedYear ? String(book.publishedYear) : '',
    pageCount: book.pageCount ? String(book.pageCount) : '',
    genre: book.genre || '',
    description: book.description || '',
    collection: book.collection || '',
    series: book.series || '',
    seriesNumber: book.seriesNumber == null ? '' : String(book.seriesNumber),
    coverUrl: book.coverUrl || '',
    coverOptions,
    source: book.source || 'manual',
    sourceId: book.sourceId || '',
    formats: userBook.formats.length ? userBook.formats : ['physical'],
    status: userBook.status,
    readStatus: userBook.readStatus,
    binding: book.binding || '',
    edition: book.edition || '',
    storageLocation: userBook.storageLocation || '',
    locationId: userBook.location?.id || '',
    conditionGrade: userBook.conditionGrade || '',
    conditionNotes: userBook.conditionNotes || '',
    loanedOut: userBook.loanedOut,
    loanedTo: userBook.activeLoan?.borrower || userBook.loanedTo || '',
    loanedAt: userBook.activeLoan?.checkoutAt?.slice(0, 10) || userBook.loanedAt || '',
    scope: userBook.list?.scope || 'personal',
    priority: userBook.list?.priority || '',
    expectedPrice: userBook.list?.expectedPrice == null ? '' : String(userBook.list.expectedPrice),
    notes: userBook.list?.notes || '',
    giftPrivate: Boolean(userBook.list?.giftPrivate),
    intendedRecipientId: userBook.list?.intendedRecipientId || '',
    desiredEdition: userBook.list?.desiredEdition || '',
    ownerUserId: userBook.owner?.id == null ? 'household' : userBook.owner.id,
    purchaseDate: userBook.purchaseDate || '',
    purchasePrice: userBook.purchasePrice == null ? '' : String(userBook.purchasePrice),
    purchaseCurrency: userBook.purchaseCurrency || 'USD',
    purchaseSource: userBook.purchaseSource || '',
    customBarcode: userBook.customBarcode || '',
    copyNotes: userBook.notes || '',
  };
}

export default function EditBookDialog({
  book,
  open,
  onOpenChange,
}: {
  book: UserBook | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [findingCovers, setFindingCovers] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [customFields, setCustomFields] = useState<{
    id: string;
    name: string;
    type: string;
    appliesTo: 'work' | 'edition' | 'copy';
    value: string;
  }[]>([]);
  const [failedCovers, setFailedCovers] = useState<Set<string>>(new Set());
  const [kindFromBookId, entityFromBookId] = book?.id.split(':') || [];
  const detailKind = book?.kind || (kindFromBookId === 'list' ? 'list' : 'copy');
  const detailEntityId = entityFromBookId || book?.copyId || book?.id;
  const { data: detailData } = useQuery({
    queryKey: ['catalog-detail', detailKind, detailEntityId],
    queryFn: () => api<{
      item: UserBook;
      tags: { name: string }[];
      collections: { name: string }[];
      customFields: {
        id: string;
        name: string;
        type: string;
        appliesTo: 'work' | 'edition' | 'copy';
        value: string;
      }[];
    }>(`/api/catalog/${detailKind}/${detailEntityId}`),
    enabled: open && Boolean(book && detailEntityId),
  });
  const { data: locationsData } = useQuery({
    queryKey: ['locations'],
    queryFn: () => api<{ locations: { id: string; breadcrumb: string }[] }>('/api/locations?archived=false'),
    enabled: open,
  });
  const { data: householdData } = useQuery({
    queryKey: ['household'],
    queryFn: () => api<{
      members: { id: number; name: string; disabled: boolean }[];
      permissions: { manageHousehold: boolean };
    }>('/api/household'),
    enabled: open,
  });

  useEffect(() => {
    if (open && book) {
      const detailed = detailData?.item || book;
      setDraft(draftFromBook({
        ...detailed,
        book: {
          ...detailed.book,
          genre: detailData?.tags.map(tag => tag.name).join(', ') || detailed.book.genre,
          collection: detailData?.collections[0]?.name || detailed.book.collection,
        },
      }));
      setFailedCovers(new Set());
      setCustomFields(detailData?.customFields || []);
      setDeleting(false);
    }
  }, [book, detailData, open]);

  function update<K extends keyof Draft>(field: K, value: Draft[K]) {
    setDraft(current => current ? { ...current, [field]: value } : current);
  }

  function toggleFormat(format: BookFormat) {
    setDraft(current => {
      if (!current) return current;
      const selected = current.formats.includes(format);
      if (selected && current.formats.length === 1) return current;
      return {
        ...current,
        formats: selected
          ? current.formats.filter(value => value !== format)
          : [...current.formats, format],
      };
    });
  }

  async function findMoreCovers() {
    if (!draft) return;
    setFindingCovers(true);
    try {
      const query = draft.isbn || draft.title;
      const type = draft.isbn ? 'isbn' : 'title';
      const response = await api<{ results: BookSearchResult[]; providers: Providers }>(
        `/api/book-search?q=${encodeURIComponent(query)}&type=${type}`,
      );
      const normalizedIsbn = draft.isbn.replace(/[^0-9X]/gi, '').toUpperCase();
      const match = response.results.find(result =>
        normalizedIsbn && result.identifiers?.some(value => value === normalizedIsbn))
        || response.results.find(result =>
          result.title.toLocaleLowerCase() === draft.title.toLocaleLowerCase())
        || response.results[0];
      const options = [...draft.coverOptions, ...(match?.coverOptions || [])]
        .filter((option, index, all) => all.findIndex(candidate => candidate.url === option.url) === index)
        .slice(0, 12);
      update('coverOptions', options);
      if (!draft.coverUrl && options[0]) update('coverUrl', options[0].url);
      if (!options.length) toast.info('No additional covers were found');
      else {
        const hardcover = response.providers.hardcover === 'available' ? ', including Hardcover' : '';
        toast.success(`Found ${options.length} cover option${options.length === 1 ? '' : 's'}${hardcover}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not refresh covers');
    } finally {
      setFindingCovers(false);
    }
  }

  async function uploadManualCover(file: File | undefined) {
    if (!file || !book?.editionId || !draft) return;
    if (!file.type.startsWith('image/') || file.size > 5 * 1024 * 1024) {
      toast.error('Choose a JPEG, PNG, GIF, or WebP image no larger than 5 MB');
      return;
    }
    setUploadingCover(true);
    try {
      const response = await fetch(`/api/covers/${book.editionId}`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Cover upload failed');
      const url = `/api/covers/${book.editionId}?v=${Date.now()}`;
      setDraft(current => current ? {
        ...current,
        coverUrl: url,
        coverOptions: [{ url, source: 'Manual upload', label: 'Uploaded cover' }, ...current.coverOptions.filter(option => !option.url.startsWith(`/api/covers/${book.editionId}`))],
      } : current);
      await queryClient.invalidateQueries({ queryKey: ['catalog-detail'] });
      await queryClient.invalidateQueries({ queryKey: ['catalog'] });
      toast.success('Cover uploaded to persistent /config storage');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not upload cover');
    } finally {
      setUploadingCover(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!book || !draft) return;
    setSaving(true);
    try {
      const [kindFromId, entityIdFromId] = book.id.split(':');
      const kind = book.kind || (kindFromId === 'copy' || kindFromId === 'list' ? kindFromId : book.status === 'owned' ? 'copy' : 'list');
      const entityId = entityIdFromId || book.copyId || book.id;
      await api(`/api/catalog/${kind}/${entityId}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...draft,
          format: draft.formats[0],
          publishedYear: draft.publishedYear || null,
          publicationDate: draft.publishedYear || null,
          pageCount: draft.pageCount || null,
          ownerUserId: draft.ownerUserId && draft.ownerUserId !== 'household' ? draft.ownerUserId : undefined,
          householdOwned: draft.ownerUserId === 'household',
        }),
      });
      await Promise.all(customFields.map(field => {
        const targetId = field.appliesTo === 'work'
          ? book.workId
          : field.appliesTo === 'edition'
            ? book.editionId
            : book.copyId;
        if (!targetId) return Promise.resolve();
        return api(`/api/custom-fields/${field.id}/${field.appliesTo}/${targetId}`, {
          method: 'PUT',
          body: JSON.stringify({ value: field.value }),
        });
      }));
      if (kind === 'copy' && book.activeLoan && !draft.loanedOut) {
        await api(`/api/loans/${book.activeLoan.id}/return`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
      } else if (kind === 'copy' && !book.activeLoan && draft.loanedOut && book.copyId) {
        await api('/api/loans', {
          method: 'POST',
          body: JSON.stringify({
            copyId: book.copyId,
            externalName: draft.loanedTo || 'Unspecified borrower',
            checkoutAt: draft.loanedAt || undefined,
          }),
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['catalog'] });
      await queryClient.invalidateQueries({ queryKey: ['catalog-duplicates'] });
      await queryClient.invalidateQueries({ queryKey: ['catalog-series'] });
      toast.success(`Updated “${draft.title}”`);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update book');
    } finally {
      setSaving(false);
    }
  }

  async function deleteBook() {
    if (!book || !draft) return;
    setDeleting(true);
    try {
      const [kindFromId, entityIdFromId] = book.id.split(':');
      const kind = book.kind || (kindFromId === 'copy' || kindFromId === 'list' ? kindFromId : book.status === 'owned' ? 'copy' : 'list');
      const entityId = entityIdFromId || book.copyId || book.id;
      await api(`/api/catalog/${kind}/${entityId}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['catalog'] });
      await queryClient.invalidateQueries({ queryKey: ['catalog-duplicates'] });
      await queryClient.invalidateQueries({ queryKey: ['catalog-series'] });
      toast.success(`Removed "${draft.title}"`);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove book');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit book</DialogTitle>
          <DialogDescription>
            {book?.shared
              ? `This family copy was added by ${book.owner?.name || 'another member'}. Its physical details are shared, while the reading status below is yours alone.`
              : 'Update its metadata, cover, ownership, reading status, condition, and loan details.'}
          </DialogDescription>
        </DialogHeader>

        {draft && (
          <form onSubmit={save} className="space-y-6">
            <div className="grid gap-6 md:grid-cols-[220px_1fr]">
              <section className="space-y-3">
                <div className="flex items-end justify-between gap-2">
                  <div>
                    <Label>Cover</Label>
                    <p className="mt-1 text-xs text-muted-foreground">Select an available edition.</p>
                  </div>
                  <Button type="button" size="sm" variant="outline" onClick={findMoreCovers} disabled={findingCovers}>
                    {findingCovers
                      ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      : <Search className="mr-1 h-3.5 w-3.5" />}
                    More
                  </Button>
                </div>
                {book?.kind === 'copy' && book.editionId && (
                  <label className="flex h-10 cursor-pointer items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent">
                    {uploadingCover ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                    Upload cover
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/gif,image/webp"
                      className="sr-only"
                      disabled={uploadingCover}
                      onChange={event => {
                        void uploadManualCover(event.target.files?.[0]);
                        event.target.value = '';
                      }}
                    />
                  </label>
                )}
                {draft.coverOptions.length ? (
                  <div className="grid grid-cols-2 gap-2">
                    {draft.coverOptions.map(option => (
                      <button
                        key={option.url}
                        type="button"
                        aria-label={`Use ${option.label}`}
                        onClick={() => update('coverUrl', option.url)}
                        className={cn(
                          'relative overflow-hidden rounded-md border-2 bg-muted text-left focus:outline-none focus:ring-2 focus:ring-ring',
                          draft.coverUrl === option.url ? 'border-primary' : 'border-border hover:border-primary/60',
                        )}
                      >
                        <div className="aspect-[2/3]">
                          {failedCovers.has(option.url) ? (
                            <div className="grid h-full place-items-center"><ImageOff className="h-6 w-6 text-muted-foreground" /></div>
                          ) : (
                            <img
                              src={option.url}
                              alt={option.label}
                              loading="lazy"
                              className="h-full w-full object-cover"
                              onError={() => setFailedCovers(current => new Set(current).add(option.url))}
                            />
                          )}
                        </div>
                        <div className="truncate border-t border-border bg-card px-1.5 py-1 text-[10px] text-muted-foreground">
                          {option.source}
                        </div>
                        {draft.coverUrl === option.url && (
                          <span className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-primary text-primary-foreground">
                            <Check className="h-3.5 w-3.5" />
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="grid aspect-[2/3] place-items-center rounded-md border border-dashed border-border bg-muted text-muted-foreground">
                    <ImageOff className="h-7 w-7" />
                  </div>
                )}
              </section>

              <section className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Label htmlFor="edit-title">Title</Label>
                  <Input id="edit-title" required maxLength={300} value={draft.title} onChange={event => update('title', event.target.value)} />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="edit-author">Author</Label>
                  <Input id="edit-author" required maxLength={300} value={draft.author} onChange={event => update('author', event.target.value)} />
                </div>
                <div>
                  <Label htmlFor="edit-status">Library section</Label>
                  <select id="edit-status" value={draft.status} disabled={book?.shared} onChange={event => update('status', event.target.value as Draft['status'])} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50">
                    <option value="owned">Collection</option>
                    <option value="wishlist">Wishlist</option>
                    <option value="backlog">Backlog</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="edit-read-status">Your reading status</Label>
                  <select id="edit-read-status" value={draft.readStatus} onChange={event => update('readStatus', event.target.value as Draft['readStatus'])} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                    <option value="unread">Unread</option>
                    <option value="want_to_read">Want to read</option>
                    <option value="reading">Currently reading</option>
                    <option value="paused">Paused</option>
                    <option value="did_not_finish">Did not finish</option>
                    <option value="read">Read</option>
                    <option value="reference">Reference</option>
                    <option value="abandoned">Abandoned</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="edit-isbn">ISBN</Label>
                  <Input id="edit-isbn" maxLength={30} value={draft.isbn} onChange={event => update('isbn', event.target.value)} />
                </div>
                <div>
                  <Label htmlFor="edit-publisher">Publisher</Label>
                  <Input id="edit-publisher" maxLength={200} value={draft.publisher} onChange={event => update('publisher', event.target.value)} />
                </div>
                <div>
                  <Label htmlFor="edit-year">Published year</Label>
                  <Input id="edit-year" type="number" min="0" max={new Date().getFullYear() + 5} value={draft.publishedYear} onChange={event => update('publishedYear', event.target.value)} />
                </div>
                <div>
                  <Label htmlFor="edit-pages">Page count</Label>
                  <Input id="edit-pages" type="number" min="1" max="100000" value={draft.pageCount} onChange={event => update('pageCount', event.target.value)} />
                </div>
                <div>
                  <Label htmlFor="edit-collection">Collection</Label>
                  <Input id="edit-collection" maxLength={150} value={draft.collection} onChange={event => update('collection', event.target.value)} />
                </div>
                <div>
                  <Label htmlFor="edit-genre">Genre</Label>
                  <Input id="edit-genre" maxLength={150} value={draft.genre} onChange={event => update('genre', event.target.value)} />
                </div>
                <div>
                  <Label htmlFor="edit-series">Series</Label>
                  <Input id="edit-series" maxLength={150} value={draft.series} onChange={event => update('series', event.target.value)} />
                </div>
                <div>
                  <Label htmlFor="edit-series-number">Series position</Label>
                  <Input id="edit-series-number" maxLength={30} value={draft.seriesNumber} onChange={event => update('seriesNumber', event.target.value)} />
                </div>
                {book?.kind === 'list' && (
                  <>
                    <div className="sm:col-span-2 border-t border-border pt-2">
                      <h3 className="font-heading font-semibold">Wishlist or backlog details</h3>
                    </div>
                    <div>
                      <Label htmlFor="edit-list-scope">Visibility</Label>
                      <select id="edit-list-scope" value={draft.scope} onChange={event => update('scope', event.target.value as Draft['scope'])} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                        <option value="personal">Personal</option><option value="household">Household</option>
                      </select>
                    </div>
                    <div>
                      <Label htmlFor="edit-list-priority">Priority</Label>
                      <select id="edit-list-priority" value={draft.priority} onChange={event => update('priority', event.target.value as Draft['priority'])} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                        <option value="">Not set</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
                      </select>
                    </div>
                    <div>
                      <Label htmlFor="edit-expected-price">Expected price</Label>
                      <Input id="edit-expected-price" type="number" min="0" step="0.01" value={draft.expectedPrice} onChange={event => update('expectedPrice', event.target.value)} />
                    </div>
                    <div>
                      <Label htmlFor="edit-desired-edition">Desired edition</Label>
                      <Input id="edit-desired-edition" maxLength={150} value={draft.desiredEdition} onChange={event => update('desiredEdition', event.target.value)} />
                    </div>
                    <div>
                      <Label htmlFor="edit-intended-recipient">Intended recipient</Label>
                      <select id="edit-intended-recipient" value={draft.intendedRecipientId} onChange={event => update('intendedRecipientId', event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                        <option value="">No recipient</option>
                        {(householdData?.members || []).filter(member => !member.disabled).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
                      </select>
                    </div>
                    <label className="flex items-center gap-2 self-end pb-2 text-sm">
                      <input type="checkbox" checked={draft.giftPrivate} onChange={event => update('giftPrivate', event.target.checked)} />
                      Hide gift from recipient
                    </label>
                    <div className="sm:col-span-2">
                      <Label htmlFor="edit-list-notes">Purchase notes</Label>
                      <Textarea id="edit-list-notes" maxLength={3000} value={draft.notes} onChange={event => update('notes', event.target.value)} />
                    </div>
                  </>
                )}
                <div className="sm:col-span-2 border-t border-border pt-2">
                  <h3 className="font-heading font-semibold">Copy details</h3>
                  <p className="mt-1 text-xs text-muted-foreground">These details apply to this physical copy, not every edition.</p>
                </div>
                <div>
                  <Label htmlFor="edit-binding">Binding</Label>
                  <select id="edit-binding" value={draft.binding} onChange={event => update('binding', event.target.value as Draft['binding'])} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                    <option value="">Not set</option>
                    {(Object.entries(bindingLabels) as [BookBinding, string][]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </div>
                <div>
                  <Label htmlFor="edit-edition">Edition</Label>
                  <Input id="edit-edition" maxLength={150} placeholder="e.g. First edition or Limited edition" value={draft.edition} onChange={event => update('edition', event.target.value)} />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="edit-storage-location">Physical location</Label>
                  <select
                    id="edit-storage-location"
                    value={draft.locationId}
                    onChange={event => update('locationId', event.target.value)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="">No physical location</option>
                    {(locationsData?.locations || []).map(location => (
                      <option key={location.id} value={location.id}>{location.breadcrumb}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="edit-condition">Condition</Label>
                  <select id="edit-condition" value={draft.conditionGrade} onChange={event => update('conditionGrade', event.target.value as Draft['conditionGrade'])} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                    <option value="">Not set</option>
                    {(Object.entries(conditionLabels) as [BookCondition, string][]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </div>
                {book?.kind === 'copy' && (
                  <>
                <div>
                  <Label htmlFor="edit-copy-owner">Copy owner</Label>
                  <select id="edit-copy-owner" value={draft.ownerUserId} disabled={!householdData?.permissions.manageHousehold} onChange={event => update('ownerUserId', event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-60">
                    <option value="household">Household</option>
                    {(householdData?.members || []).filter(member => !member.disabled).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
                  </select>
                </div>
                <div>
                  <Label htmlFor="edit-purchase-date">Purchase date</Label>
                  <Input id="edit-purchase-date" type="date" value={draft.purchaseDate} onChange={event => update('purchaseDate', event.target.value)} />
                </div>
                <div>
                  <Label htmlFor="edit-purchase-price">Purchase price</Label>
                  <div className="flex gap-2">
                    <Input id="edit-purchase-price" type="number" min="0" step="0.01" value={draft.purchasePrice} onChange={event => update('purchasePrice', event.target.value)} />
                    <Input aria-label="Purchase currency" maxLength={3} className="w-20 uppercase" value={draft.purchaseCurrency} onChange={event => update('purchaseCurrency', event.target.value.toUpperCase())} />
                  </div>
                </div>
                <div>
                  <Label htmlFor="edit-purchase-source">Purchase source</Label>
                  <Input id="edit-purchase-source" maxLength={150} value={draft.purchaseSource} onChange={event => update('purchaseSource', event.target.value)} />
                </div>
                <div>
                  <Label htmlFor="edit-custom-barcode">Custom barcode</Label>
                  <Input id="edit-custom-barcode" maxLength={100} value={draft.customBarcode} onChange={event => update('customBarcode', event.target.value)} />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="edit-copy-notes">Copy notes</Label>
                  <Textarea id="edit-copy-notes" maxLength={2000} rows={2} value={draft.copyNotes} onChange={event => update('copyNotes', event.target.value)} />
                </div>
                  </>
                )}
                <div className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2">
                  <div>
                    <Label htmlFor="edit-loaned">Loaned out</Label>
                    <p className="text-xs text-muted-foreground">{draft.status === 'owned' ? 'Track who has this copy.' : 'Only collection books can be loaned.'}</p>
                  </div>
                  <Switch id="edit-loaned" checked={draft.loanedOut && draft.status === 'owned'} disabled={draft.status !== 'owned'} onCheckedChange={value => update('loanedOut', value)} />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="edit-condition-notes">Condition / damage notes</Label>
                  <Textarea id="edit-condition-notes" maxLength={2000} rows={3} placeholder="e.g. Bent corners, broken spine, highlighting" value={draft.conditionNotes} onChange={event => update('conditionNotes', event.target.value)} />
                </div>
                {draft.loanedOut && draft.status === 'owned' && (
                  <>
                    <div>
                      <Label htmlFor="edit-loaned-to">Loaned to</Label>
                      <Input id="edit-loaned-to" maxLength={150} placeholder="Name or note" value={draft.loanedTo} onChange={event => update('loanedTo', event.target.value)} />
                    </div>
                    <div>
                      <Label htmlFor="edit-loaned-at">Loaned date</Label>
                      <Input id="edit-loaned-at" type="date" value={draft.loanedAt} onChange={event => update('loanedAt', event.target.value)} />
                    </div>
                  </>
                )}
                <div className="sm:col-span-2">
                  <Label>Formats</Label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(Object.keys(formatLabels) as BookFormat[]).map(format => (
                      <Button key={format} type="button" size="sm" variant={draft.formats.includes(format) ? 'default' : 'outline'} onClick={() => toggleFormat(format)}>
                        {formatLabels[format]}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="edit-description">Description</Label>
                  <Textarea id="edit-description" rows={5} maxLength={5000} value={draft.description} onChange={event => update('description', event.target.value)} />
                </div>
                {customFields.filter(field => (
                  field.appliesTo === 'work'
                  || (field.appliesTo === 'edition' && Boolean(book?.editionId))
                  || (field.appliesTo === 'copy' && Boolean(book?.copyId))
                )).map(field => (
                  <div key={field.id}>
                    <Label htmlFor={`custom-field-${field.id}`}>{field.name}</Label>
                    {field.type === 'boolean' ? (
                      <select
                        id={`custom-field-${field.id}`}
                        value={field.value}
                        onChange={event => setCustomFields(current => current.map(candidate => candidate.id === field.id ? { ...candidate, value: event.target.value } : candidate))}
                        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                      >
                        <option value="">Not set</option><option value="true">Yes</option><option value="false">No</option>
                      </select>
                    ) : (
                      <Input
                        id={`custom-field-${field.id}`}
                        type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                        maxLength={5000}
                        value={field.value}
                        onChange={event => setCustomFields(current => current.map(candidate => candidate.id === field.id ? { ...candidate, value: event.target.value } : candidate))}
                      />
                    )}
                  </div>
                ))}
              </section>
            </div>
            <DialogFooter className="gap-2 sm:justify-between sm:space-x-0">
              {book?.canDelete !== false ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button type="button" variant="destructive" disabled={saving || deleting}>
                      <Trash2 className="mr-2 h-4 w-4" />
                      Remove book
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove this book?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This removes the copy from the active collection while retaining its history as previously owned.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={deleting}>Keep book</AlertDialogCancel>
                      <AlertDialogAction
                        type="button"
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        disabled={deleting}
                        onClick={() => void deleteBook()}
                      >
                        {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Remove from collection
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : <span className="text-xs text-muted-foreground">Only {book.owner?.name || 'the member who added this book'} can remove this family copy.</span>}
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button type="button" variant="outline" disabled={deleting} onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button type="submit" disabled={saving || deleting}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save changes
                </Button>
              </div>
            </DialogFooter>
          </form>
        )}
        {draft && book?.workId && (
          <ReadingTracker workId={book.workId} editionId={book.editionId} />
        )}
      </DialogContent>
    </Dialog>
  );
}
