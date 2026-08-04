import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import AppLayout from "@/components/AppLayout";
import Dashboard from "@/pages/Dashboard";
import Collection from "@/pages/Collection";
import Backlog from "@/pages/Backlog";
import Wishlist from "@/pages/Wishlist";
import SeriesPage from "@/pages/SeriesPage";
import Profile from "@/pages/Profile";
import NotFound from "./pages/NotFound.tsx";
import Login from "@/pages/Login";
import { AuthProvider, useAuth } from "@/lib/auth";
import { usePathname } from "@/lib/router";

const queryClient = new QueryClient();

const ProtectedApp = () => {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  if (loading) return <div className="min-h-screen grid place-items-center text-muted-foreground">Loading BookVault…</div>;
  if (!user) return <Login />;
  return (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      {(() => {
        const pages: Record<string, React.ReactNode> = {
          "/": <Dashboard />, "/collection": <Collection />, "/backlog": <Backlog />,
          "/wishlist": <Wishlist />, "/series": <SeriesPage />, "/profile": <Profile />,
        };
        return pathname in pages ? <AppLayout>{pages[pathname]}</AppLayout> : <NotFound />;
      })()}
    </TooltipProvider>
  </QueryClientProvider>
  );
};

const App = () => <AuthProvider><ProtectedApp /></AuthProvider>;

export default App;
