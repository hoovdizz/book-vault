import { useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight, Layers, Loader2, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/auth';
import { useAuth } from '@/lib/auth';
import { UserBook } from '@/types/book';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import AddSeriesDialog from '@/components/AddSeriesDialog';
import EditBookDialog from '@/components/EditBookDialog';

type SeriesResponse = {
  series: {
    id: string;
    name: string;
    workCount: number;
    ownedWorkCount: number;
    missingVolumes: number[];
    books: {
      workId: string;
      title: string;
      author: string;
      volume: string | null;
      readingOrder: number | null;
      role: string;
      includedVolumes: string[];
      editionCount: number;
      copyCount: number;
      wishlisted: boolean;
      copyId: string | null;
      listId: string | null;
    }[];
  }[];
};

export default function SeriesPage() {
  const [showAddSeries, setShowAddSeries] = useState(false);
  const [editingBook, setEditingBook] = useState<UserBook | null>(null);
  const [opening, setOpening] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ['catalog-series'],
    queryFn: () => api<SeriesResponse>('/api/catalog/series'),
  });

  async function openBook(copyId: string | null, listId: string | null) {
    const path = copyId ? `copy/${copyId}` : listId ? `list/${listId}` : null;
    if (!path) return;
    setOpening(path);
    try {
      const detail = await api<{ item: UserBook }>(`/api/catalog/${path}`);
      setEditingBook(detail.item);
    } finally {
      setOpening('');
    }
  }

  async function removeSeries(series: SeriesResponse['series'][number]) {
    if (series.ownedWorkCount > 0) return;
    if (!window.confirm(`Delete the empty series “${series.name}”? Wishlist entries will remain.`)) return;
    try {
      await api(`/api/catalog/series/${series.id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['catalog-series'] });
      toast.success(`Deleted ${series.name}`);
    } catch (removeError) {
      toast.error(removeError instanceof Error ? removeError.message : 'Could not delete series');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-3xl font-heading font-bold">Series</h1>
          <p className="mt-1 text-muted-foreground">Decimal positions, prequels, novellas, omnibus contents, and reading order stay intact.</p>
        </div>
        <Button type="button" className="gradient-warm w-fit gap-2 text-primary-foreground" onClick={() => setShowAddSeries(true)}>
          <Plus className="h-4 w-4" />Add book series
        </Button>
      </div>

      {isLoading ? (
        <div className="py-16 text-center text-muted-foreground">Loading series…</div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-destructive">
          {error instanceof Error ? error.message : 'Could not load series'}
        </div>
      ) : data?.series.length ? (
        <div className="space-y-5">
          {data.series.map(series => {
            const isCollapsed = collapsed.has(series.id);
            return (
              <section key={series.id} className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 border-b border-border px-5 py-4 text-left focus:outline-none focus:ring-2 focus:ring-inset focus:ring-ring"
                  aria-expanded={!isCollapsed}
                  onClick={() => setCollapsed(current => {
                    const next = new Set(current);
                    if (next.has(series.id)) next.delete(series.id); else next.add(series.id);
                    return next;
                  })}
                >
                  <div className="flex items-center gap-3">
                    <span className="grid h-9 w-9 place-items-center rounded-full bg-primary/10 text-primary"><Layers className="h-4 w-4" /></span>
                    <div>
                      <h2 className="font-heading text-xl font-bold">{series.name}</h2>
                      <p className="text-sm text-muted-foreground">{series.ownedWorkCount} owned of {series.workCount} tracked works</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {series.missingVolumes.length > 0 && (
                      <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-300">
                        <TriangleAlert className="mr-1 h-3 w-3" />Missing volumes: {series.missingVolumes.join(', ')}
                      </Badge>
                    )}
                    {isCollapsed ? <ChevronRight className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
                    {series.ownedWorkCount === 0 && (user?.role === 'admin' || user?.householdRole === 'household_admin') && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        aria-label={`Delete empty series ${series.name}`}
                        onClick={event => { event.stopPropagation(); void removeSeries(series); }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </button>
                {!isCollapsed && (
                  <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
                    {series.books.map(book => {
                      const path = book.copyId ? `copy/${book.copyId}` : book.listId ? `list/${book.listId}` : '';
                      return (
                        <button
                          key={`${book.workId}:${book.role}:${book.volume}`}
                          type="button"
                          disabled={!path}
                          className="flex gap-3 rounded-lg border border-border bg-background/50 p-3 text-left hover:border-primary focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-default"
                          onClick={() => void openBook(book.copyId, book.listId)}
                        >
                          <div className="grid h-16 w-11 flex-none place-items-center rounded bg-muted"><BookOpen className="h-5 w-5 text-muted-foreground/50" /></div>
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap gap-1">
                              {book.volume && <Badge variant="secondary">Volume {book.volume}</Badge>}
                              {book.readingOrder != null && <Badge variant="outline">Read {book.readingOrder}</Badge>}
                              {book.role !== 'main' && <Badge variant="outline">{book.role}</Badge>}
                              <Badge
                                variant={book.copyCount ? 'default' : 'outline'}
                                className={!book.copyCount && !book.wishlisted
                                  ? 'border-amber-500/60 bg-amber-500/10 text-amber-800 dark:text-amber-300'
                                  : undefined}
                              >
                                {book.copyCount ? `${book.copyCount} owned` : book.wishlisted ? 'Wishlist' : <><TriangleAlert className="mr-1 inline h-3 w-3" />Missing</>}
                              </Badge>
                            </div>
                            <h3 className="line-clamp-2 font-heading font-semibold">{book.title}</h3>
                            <p className="line-clamp-1 text-sm text-muted-foreground">{book.author}</p>
                            {book.includedVolumes.length > 0 && (
                              <p className="text-xs text-muted-foreground">Includes {book.includedVolumes.join(', ')}</p>
                            )}
                            {opening === path && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border py-16 text-center text-muted-foreground">
          <Layers className="mx-auto mb-3 h-9 w-9 opacity-50" />
          <p className="font-heading text-lg">No series yet</p>
        </div>
      )}

      <AddSeriesDialog open={showAddSeries} onOpenChange={setShowAddSeries} existingBooks={[]} />
      <EditBookDialog book={editingBook} open={Boolean(editingBook)} onOpenChange={open => { if (!open) setEditingBook(null); }} />
    </div>
  );
}
