import { Library, ListTodo, Heart, Layers, BarChart3, Settings, Search, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Link, usePathname } from '@/lib/router';

const navItems = [
  { to: '/', icon: BarChart3, label: 'Dashboard' },
  { to: '/collection', icon: Library, label: 'Collection' },
  { to: '/backlog', icon: ListTodo, label: 'Backlog' },
  { to: '/wishlist', icon: Heart, label: 'Wishlist' },
  { to: '/series', icon: Layers, label: 'Series' },
  { to: '/duplicates', icon: Copy, label: 'Duplicates' },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="hidden md:flex w-64 flex-col gradient-sidebar border-r border-sidebar-border">
        <div className="flex items-center gap-3 px-6 py-6 border-b border-sidebar-border">
          <img src="/book-vault-icon.png" alt="" className="h-8 w-8 rounded-md" />
          <h1 className="text-xl font-heading font-bold text-sidebar-foreground">BookVault</h1>
        </div>

        <div className="px-3 py-4">
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-sidebar-foreground/50" />
            <input
              type="text"
              placeholder="Search books..."
              className="w-full pl-9 pr-3 py-2 rounded-md bg-sidebar-accent text-sidebar-foreground text-sm placeholder:text-sidebar-foreground/40 border border-sidebar-border focus:outline-none focus:ring-1 focus:ring-sidebar-primary"
            />
          </div>
        </div>

        <nav className="flex-1 px-3 space-y-1">
          {navItems.map(({ to, icon: Icon, label }) => (
            <Link
              key={to}
              href={to}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors',
                pathname === to
                  ? 'bg-sidebar-accent text-sidebar-primary'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
              )}
            >
              <Icon className="h-4.5 w-4.5" />
              {label}
            </Link>
          ))}
        </nav>

        <div className="px-3 py-4 border-t border-sidebar-border">
          <Link
            href="/settings"
            className="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground transition-colors"
          >
            <Settings className="h-4.5 w-4.5" />
            Settings
          </Link>
        </div>
      </aside>

      {/* Mobile header */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-50 bg-sidebar gradient-sidebar border-b border-sidebar-border">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <img src="/book-vault-icon.png" alt="" className="h-6 w-6 rounded" />
            <span className="font-heading font-bold text-sidebar-foreground">BookVault</span>
          </div>
        </div>
        <nav className="flex px-2 pb-2 gap-1 overflow-x-auto">
          {navItems.map(({ to, icon: Icon, label }) => (
            <Link
              key={to}
              href={to}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors',
                pathname === to
                  ? 'bg-sidebar-accent text-sidebar-primary'
                  : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/50'
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </Link>
          ))}
          <Link
            href="/settings"
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors',
              pathname === '/settings' || pathname === '/profile'
                ? 'bg-sidebar-accent text-sidebar-primary'
                : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/50',
            )}
          >
            <Settings className="h-3.5 w-3.5" />
            Settings
          </Link>
        </nav>
      </div>

      {/* Main content */}
      <main className="flex-1 min-h-screen md:ml-0 mt-[88px] md:mt-0">
        <div className="p-6 md:p-8 max-w-7xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
