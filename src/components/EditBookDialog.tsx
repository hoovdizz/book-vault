import { FormEvent, useEffect, useState } from 'react';
import { Check, ImageOff, Loader2, Search } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/auth';
import { BookFormat, BookSearchResult, CoverOption, UserBook } from '@/types/book';
import { cn } from '@/lib/utils';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

type Providers = {
  googleBooks: 'available' | 'unavailable';
  openLibrary: 'available' | 'unavailable';
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
  readStatus: 'read' | 'unread' | 'reading';
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
  const [findingCovers, setFindingCovers] = useState(false);
  const [failedCovers, setFailedCovers] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open && book) {
      setDraft(draftFromBook(book));
      setFailedCovers(new Set());
    }
  }, [book, open]);

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

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!book || !draft) return;
    setSaving(true);
    try {
      await api(`/api/books/${book.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...draft,
          publishedYear: draft.publishedYear || null,
          pageCount: draft.pageCount || null,
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ['books'] });
      toast.success(`Updated “${draft.title}”`);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update book');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit book</DialogTitle>
          <DialogDescription>
            Update its metadata, location, cover, ownership, and whether you have read it.
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
                  <Label htmlFor="edit-status">Location</Label>
                  <select id="edit-status" value={draft.status} onChange={event => update('status', event.target.value as Draft['status'])} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                    <option value="owned">Collection</option>
                    <option value="wishlist">Wishlist</option>
                    <option value="backlog">Backlog</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="edit-read-status">Reading status</Label>
                  <select id="edit-read-status" value={draft.readStatus} onChange={event => update('readStatus', event.target.value as Draft['readStatus'])} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                    <option value="unread">Unread</option>
                    <option value="reading">Currently reading</option>
                    <option value="read">Read</option>
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
              </section>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save changes
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
