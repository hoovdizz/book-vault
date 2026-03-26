import { motion } from 'framer-motion';
import { mockUserBooks } from '@/data/mockData';
import BookCard from '@/components/BookCard';
import { Badge } from '@/components/ui/badge';

const priorities = ['high', 'medium', 'low'] as const;
const priorityLabels = { high: 'High Priority', medium: 'Medium Priority', low: 'Low Priority' };
const priorityColors = {
  high: 'bg-destructive/10 text-destructive border-destructive/20',
  medium: 'bg-primary/10 text-primary border-primary/20',
  low: 'bg-muted text-muted-foreground border-border',
};

export default function Backlog() {
  const backlogBooks = mockUserBooks.filter(ub => ub.status === 'backlog');

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-heading font-bold text-foreground">Reading Backlog</h1>
        <p className="text-muted-foreground mt-1">{backlogBooks.length} books waiting to be read</p>
      </div>

      {priorities.map(priority => {
        const books = backlogBooks.filter(ub => ub.priority === priority);
        if (books.length === 0) return null;

        return (
          <section key={priority}>
            <div className="flex items-center gap-2 mb-4">
              <Badge variant="outline" className={priorityColors[priority]}>{priorityLabels[priority]}</Badge>
              <span className="text-sm text-muted-foreground">({books.length})</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {books.map((ub, i) => (
                <motion.div
                  key={ub.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05 }}
                >
                  <BookCard userBook={ub} />
                </motion.div>
              ))}
            </div>
          </section>
        );
      })}

      {backlogBooks.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-lg font-heading">Your backlog is empty</p>
          <p className="text-sm mt-1">Add books you want to read next</p>
        </div>
      )}
    </div>
  );
}
