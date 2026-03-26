import { motion } from 'framer-motion';
import { BookOpen, Eye, Star, Heart, ListTodo, DollarSign, Layers, TrendingUp } from 'lucide-react';
import { mockStats, mockUserBooks } from '@/data/mockData';
import BookCard from '@/components/BookCard';

const statCards = [
  { label: 'Total Books', value: mockStats.totalBooks, icon: BookOpen, color: 'text-primary' },
  { label: 'Books Read', value: mockStats.booksRead, icon: Eye, color: 'text-accent' },
  { label: 'Avg Rating', value: mockStats.averageRating.toFixed(1), icon: Star, color: 'text-primary' },
  { label: 'Collection Value', value: `$${mockStats.totalValue.toFixed(2)}`, icon: DollarSign, color: 'text-accent' },
  { label: 'Wishlist', value: mockStats.wishlistCount, icon: Heart, color: 'text-chart-wishlist' },
  { label: 'Backlog', value: mockStats.backlogCount, icon: ListTodo, color: 'text-chart-backlog' },
  { label: 'Series', value: mockStats.seriesCount, icon: Layers, color: 'text-primary' },
  { label: 'Unread', value: mockStats.booksUnread, icon: TrendingUp, color: 'text-muted-foreground' },
];

export default function Dashboard() {
  const recentBooks = mockUserBooks.filter(ub => ub.status === 'owned').slice(0, 4);
  const currentlyReading = mockUserBooks.filter(ub => ub.readStatus === 'reading');

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-heading font-bold text-foreground">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Your reading life at a glance</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statCards.map((stat, i) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            className="bg-card rounded-lg p-4 shadow-card border border-border"
          >
            <div className="flex items-center justify-between mb-2">
              <stat.icon className={`h-5 w-5 ${stat.color}`} />
            </div>
            <p className="text-2xl font-heading font-bold text-foreground">{stat.value}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{stat.label}</p>
          </motion.div>
        ))}
      </div>

      {/* Currently Reading */}
      {currentlyReading.length > 0 && (
        <section>
          <h2 className="text-xl font-heading font-semibold text-foreground mb-4">Currently Reading</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {currentlyReading.map(ub => (
              <BookCard key={ub.id} userBook={ub} />
            ))}
          </div>
        </section>
      )}

      {/* Recent Collection */}
      <section>
        <h2 className="text-xl font-heading font-semibold text-foreground mb-4">Recent Additions</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {recentBooks.map(ub => (
            <BookCard key={ub.id} userBook={ub} />
          ))}
        </div>
      </section>
    </div>
  );
}
