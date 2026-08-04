import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Loader2, RefreshCw, ScanSearch } from 'lucide-react';
import { api } from '@/lib/auth';
import { UserBook } from '@/types/book';
import BookCard from '@/components/BookCard';
import EditBookDialog from '@/components/EditBookDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

type DuplicateGroup = {
  key: string;
  title: string;
  author: string;
  copies: UserBook[];
};

type DuplicateResponse = {
  groups: DuplicateGroup[];
  totalGroups: number;
  totalCopies: number;
  scannedBooks: number;
};

export default function Duplicates() {
  const [hasRun, setHasRun] = useState(false);
  const [editingBook, setEditingBook] = useState<UserBook | null>(null);
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ['book-duplicates'],
    queryFn: () => api<DuplicateResponse>('/api/books/duplicates'),
    enabled: false,
  });

  async function runScan() {
    setHasRun(true);
    await refetch();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-heading font-bold text-foreground">Duplicate Finder</h1>
          <p className="mt-1 text-muted-foreground">
            Find multiple owned copies of the same work, including different bindings, ISBNs, and editions.
          </p>
        </div>
        <Button type="button" className="w-fit gap-2" onClick={runScan} disabled={isFetching}>
          {isFetching
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : hasRun ? <RefreshCw className="h-4 w-4" /> : <ScanSearch className="h-4 w-4" />}
          {hasRun ? 'Rerun scan' : 'Run duplicate scan'}
        </Button>
      </div>

      {!hasRun && (
        <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center">
          <ScanSearch className="mx-auto h-10 w-10 text-muted-foreground/60" />
          <h2 className="mt-4 font-heading text-lg font-semibold">Ready to scan your collection</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
            Matching ignores ISBN, binding, and edition labels. Wishlist and backlog entries are not counted as duplicate copies.
          </p>
        </div>
      )}

      {hasRun && error && !isFetching && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-destructive">
          {error instanceof Error ? error.message : 'Could not scan the collection'}
        </div>
      )}

      {hasRun && data && (
        <>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">{data.scannedBooks} owned books scanned</Badge>
            <Badge variant="secondary">{data.totalGroups} duplicate groups</Badge>
            <Badge variant="secondary">{data.totalCopies} matching copies</Badge>
          </div>

          {data.groups.length ? (
            <div className="space-y-6">
              {data.groups.map(group => (
                <section key={group.key} className="rounded-lg border border-border bg-card p-4 shadow-card sm:p-5">
                  <div className="mb-4 flex items-start gap-3">
                    <span className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                      <Copy className="h-5 w-5" />
                    </span>
                    <div>
                      <h2 className="font-heading text-xl font-semibold">{group.title}</h2>
                      <p className="text-sm text-muted-foreground">{group.author} · {group.copies.length} copies</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                    {group.copies.map(copy => (
                      <BookCard key={copy.id} userBook={copy} onSelect={setEditingBook} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center">
              <Copy className="mx-auto h-10 w-10 text-muted-foreground/60" />
              <h2 className="mt-4 font-heading text-lg font-semibold">No duplicate copies found</h2>
              <p className="mt-2 text-sm text-muted-foreground">Rerun the scan after adding or editing books.</p>
            </div>
          )}
        </>
      )}

      <EditBookDialog
        book={editingBook}
        open={Boolean(editingBook)}
        onOpenChange={open => { if (!open) setEditingBook(null); }}
      />
    </div>
  );
}
