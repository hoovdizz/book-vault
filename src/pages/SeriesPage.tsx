import { motion } from 'framer-motion';
import { mockSeries } from '@/data/mockData';
import { Progress } from '@/components/ui/progress';
import { BookOpen, Check, AlertCircle } from 'lucide-react';

export default function SeriesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-heading font-bold text-foreground">Series Tracking</h1>
        <p className="text-muted-foreground mt-1">Track your progress across book series</p>
      </div>

      <div className="space-y-4">
        {mockSeries.map((series, i) => {
          const ownedPercent = (series.ownedBooks / series.totalBooks) * 100;
          const readPercent = (series.readBooks / series.totalBooks) * 100;
          const missing = series.totalBooks - series.ownedBooks;

          return (
            <motion.div
              key={series.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08 }}
              className="bg-card rounded-lg border border-border shadow-card p-5 space-y-4"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-xl font-heading font-bold text-foreground">{series.name}</h2>
                  <p className="text-sm text-muted-foreground">{series.totalBooks} books in series</p>
                </div>
                {missing > 0 && (
                  <div className="flex items-center gap-1 text-primary text-sm">
                    <AlertCircle className="h-4 w-4" />
                    {missing} missing
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="flex items-center justify-between text-sm mb-1.5">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <BookOpen className="h-3.5 w-3.5" /> Owned
                    </span>
                    <span className="font-medium text-foreground">{series.ownedBooks}/{series.totalBooks}</span>
                  </div>
                  <Progress value={ownedPercent} className="h-2" />
                </div>
                <div>
                  <div className="flex items-center justify-between text-sm mb-1.5">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <Check className="h-3.5 w-3.5" /> Read
                    </span>
                    <span className="font-medium text-foreground">{series.readBooks}/{series.totalBooks}</span>
                  </div>
                  <Progress value={readPercent} className="h-2" />
                </div>
              </div>

              {/* Book list */}
              <div className="flex gap-2 overflow-x-auto pb-1">
                {series.books.map((item, idx) => {
                  const isOwned = 'id' in item;
                  const book = isOwned ? item.book : item.book;
                  return (
                    <div
                      key={idx}
                      className={`w-16 h-24 rounded overflow-hidden flex-shrink-0 border ${
                        isOwned ? 'border-accent' : 'border-border opacity-40'
                      }`}
                    >
                      {book.coverUrl ? (
                        <img src={book.coverUrl} alt={book.title} className="w-full h-full object-cover" loading="lazy" />
                      ) : (
                        <div className="w-full h-full bg-muted flex items-center justify-center">
                          <span className="text-[10px] text-muted-foreground text-center px-1">#{book.seriesNumber}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
