import { motion } from 'framer-motion';
import { Heart, Plus, ArrowRight } from 'lucide-react';
import { mockUserBooks } from '@/data/mockData';
import BookCard from '@/components/BookCard';
import { Button } from '@/components/ui/button';

export default function Wishlist() {
  const wishlistBooks = mockUserBooks.filter(ub => ub.status === 'wishlist');

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-heading font-bold text-foreground">Wishlist</h1>
          <p className="text-muted-foreground mt-1">{wishlistBooks.length} books you'd love to own</p>
        </div>
        <Button className="gradient-warm text-primary-foreground gap-2 w-fit">
          <Plus className="h-4 w-4" />
          Add to Wishlist
        </Button>
      </div>

      {wishlistBooks.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {wishlistBooks.map((ub, i) => (
            <motion.div
              key={ub.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
              className="relative"
            >
              <BookCard userBook={ub} />
              <div className="mt-2">
                <Button variant="outline" size="sm" className="w-full text-xs gap-1 border-border text-foreground hover:bg-accent hover:text-accent-foreground">
                  <ArrowRight className="h-3 w-3" />
                  Move to Collection
                </Button>
              </div>
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="text-center py-16 text-muted-foreground">
          <Heart className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
          <p className="text-lg font-heading">Your wishlist is empty</p>
          <p className="text-sm mt-1">Search for books to add to your wishlist</p>
        </div>
      )}
    </div>
  );
}
