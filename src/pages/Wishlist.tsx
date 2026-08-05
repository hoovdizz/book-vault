import { useState } from 'react';
import { ArrowRight, Heart, Loader2, Plus } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import BookCard from '@/components/BookCard';
import AddBookDialog from '@/components/AddBookDialog';
import EditBookDialog from '@/components/EditBookDialog';
import { Button } from '@/components/ui/button';
import { fetchCatalog } from '@/lib/catalog';
import { api } from '@/lib/auth';
import { UserBook } from '@/types/book';

export default function Wishlist() {
  const queryClient = useQueryClient();
  const [showAddBook, setShowAddBook] = useState(false);
  const [movingBookId, setMovingBookId] = useState<string | null>(null);
  const [editingBook, setEditingBook] = useState<UserBook | null>(null);
  const [requester, setRequester] = useState('all');
  const { data, isLoading, error } = useQuery({
    queryKey: ['catalog', 'wishlist', requester],
    queryFn: () => fetchCatalog({ status: ['wishlist'], pageSize: 100, sort: 'dateAdded', direction: 'desc', requester: requester === 'all' ? undefined : [requester] }),
  });
  const { data: householdData } = useQuery({
    queryKey: ['household'],
    queryFn: () => api<{ members: { id: number; name: string; disabled: boolean }[] }>('/api/household'),
  });
  const { data: collectionsData } = useQuery({
    queryKey: ['collections'],
    queryFn: () => api<{ collections: { name: string }[] }>('/api/collections'),
  });
  const { data: seriesData } = useQuery({
    queryKey: ['catalog-series'],
    queryFn: () => api<{ series: { name: string }[] }>('/api/catalog/series'),
  });
  const wishlistBooks = data?.items || [];

  async function handleMoveToCollection(book: UserBook) {
    setMovingBookId(book.id);
    try {
      await api('/api/catalog', {
        method: 'POST',
        body: JSON.stringify({
          ...book.book,
          title: book.book.title,
          author: book.book.author,
          isbn: book.book.isbn,
          status: 'owned',
          formats: book.formats.length ? book.formats : ['physical'],
          moveWishlistToOwned: true,
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ['catalog'] });
      await queryClient.invalidateQueries({ queryKey: ['catalog-duplicates'] });
      toast.success(`Moved “${book.book.title}” to the collection`);
    } catch (moveError) {
      toast.error(moveError instanceof Error ? moveError.message : 'Could not move book');
    } finally {
      setMovingBookId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-3xl font-heading font-bold">Wishlist</h1>
          <p className="mt-1 text-muted-foreground">{data?.pagination.total || 0} personal or household requests</p>
        </div>
        <Button type="button" className="gradient-warm w-fit gap-2 text-primary-foreground" onClick={() => setShowAddBook(true)}>
          <Plus className="h-4 w-4" />Add to wishlist
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3">
        <label htmlFor="wishlist-requester" className="text-sm font-medium">Show requests from</label>
        <select id="wishlist-requester" value={requester} onChange={event => setRequester(event.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
          <option value="all">Everyone in the household</option>
          {(householdData?.members || []).filter(member => !member.disabled).map(member => <option key={member.id} value={String(member.id)}>{member.name}</option>)}
        </select>
        <span className="text-xs text-muted-foreground">Wishlists are shared; backlogs remain private to each login.</span>
      </div>

      {isLoading ? (
        <div className="py-16 text-center text-muted-foreground">Loading the wishlist…</div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-destructive">
          {error instanceof Error ? error.message : 'Could not load the wishlist'}
        </div>
      ) : wishlistBooks.length ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {wishlistBooks.map(book => (
            <div key={book.id} className="relative">
              <BookCard userBook={book} onSelect={setEditingBook} />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2 w-full gap-1 text-xs"
                disabled={movingBookId === book.id}
                onClick={() => handleMoveToCollection(book)}
              >
                {movingBookId === book.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRight className="h-3 w-3" />}
                Mark purchased and add copy
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="py-16 text-center text-muted-foreground">
          <Heart className="mx-auto mb-3 h-12 w-12 opacity-30" />
          <p className="text-lg font-heading">The visible wishlist is empty</p>
          <p className="mt-1 text-sm">Private gift requests stay hidden from their intended recipient.</p>
        </div>
      )}

      <AddBookDialog
        open={showAddBook}
        onOpenChange={setShowAddBook}
        collections={collectionsData?.collections.map(item => item.name) || []}
        seriesNames={seriesData?.series.map(item => item.name) || []}
        destination="wishlist"
      />
      <EditBookDialog book={editingBook} open={Boolean(editingBook)} onOpenChange={open => { if (!open) setEditingBook(null); }} />
    </div>
  );
}
