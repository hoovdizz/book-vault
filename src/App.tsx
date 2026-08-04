import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
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

const queryClient = new QueryClient();

const ProtectedApp = () => {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen grid place-items-center text-muted-foreground">Loading BookVault…</div>;
  if (!user) return <Login />;
  return (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<AppLayout><Dashboard /></AppLayout>} />
          <Route path="/collection" element={<AppLayout><Collection /></AppLayout>} />
          <Route path="/backlog" element={<AppLayout><Backlog /></AppLayout>} />
          <Route path="/wishlist" element={<AppLayout><Wishlist /></AppLayout>} />
          <Route path="/series" element={<AppLayout><SeriesPage /></AppLayout>} />
          <Route path="/profile" element={<AppLayout><Profile /></AppLayout>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
  );
};

const App = () => <AuthProvider><ProtectedApp /></AuthProvider>;

export default App;
