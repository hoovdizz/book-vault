import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import AppLayout from "@/components/AppLayout";
import Login from "@/pages/Login";
import { AuthProvider, useAuth } from "@/lib/auth";
import { usePathname } from "@/lib/router";
import { ThemeProvider } from "next-themes";

const queryClient = new QueryClient();
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Collection = lazy(() => import("@/pages/Collection"));
const Backlog = lazy(() => import("@/pages/Backlog"));
const Wishlist = lazy(() => import("@/pages/Wishlist"));
const SeriesPage = lazy(() => import("@/pages/SeriesPage"));
const Duplicates = lazy(() => import("@/pages/Duplicates"));
const Profile = lazy(() => import("@/pages/Profile"));
const Loans = lazy(() => import("@/pages/Loans"));
const Statistics = lazy(() => import("@/pages/Statistics"));
const Admin = lazy(() => import("@/pages/Admin"));
const NotFound = lazy(() => import("@/pages/NotFound"));

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
          "/wishlist": <Wishlist />, "/series": <SeriesPage />, "/duplicates": <Duplicates />,
          "/loans": <Loans />, "/statistics": <Statistics />,
          "/admin": user.role === "admin" ? <Admin /> : <Profile />,
          "/settings": <Profile />, "/profile": <Profile />,
        };
        return (
          <Suspense fallback={<div className="grid min-h-[50vh] place-items-center text-muted-foreground">Loading page…</div>}>
            {pathname in pages ? <AppLayout>{pages[pathname]}</AppLayout> : <NotFound />}
          </Suspense>
        );
      })()}
    </TooltipProvider>
  </QueryClientProvider>
  );
};

const App = () => (
  <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
    <AuthProvider><ProtectedApp /></AuthProvider>
  </ThemeProvider>
);

export default App;
