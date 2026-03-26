import { User, BookOpen, Star, Calendar } from 'lucide-react';
import { mockStats } from '@/data/mockData';

export default function Profile() {
  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-3xl font-heading font-bold text-foreground">Profile</h1>

      <div className="bg-card rounded-lg border border-border shadow-card p-6">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
            <User className="h-8 w-8 text-primary" />
          </div>
          <div>
            <h2 className="text-xl font-heading font-semibold text-foreground">Book Lover</h2>
            <p className="text-sm text-muted-foreground">reader@bookvault.app</p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { icon: BookOpen, label: 'Books Owned', value: mockStats.totalBooks },
            { icon: Star, label: 'Avg Rating', value: mockStats.averageRating.toFixed(1) },
            { icon: Calendar, label: 'Books Read', value: mockStats.booksRead },
            { icon: BookOpen, label: 'Collection Value', value: `$${mockStats.totalValue.toFixed(0)}` },
          ].map(stat => (
            <div key={stat.label} className="text-center p-3 rounded-md bg-muted/50">
              <stat.icon className="h-5 w-5 mx-auto text-primary mb-1" />
              <p className="text-lg font-heading font-bold text-foreground">{stat.value}</p>
              <p className="text-[10px] text-muted-foreground">{stat.label}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
