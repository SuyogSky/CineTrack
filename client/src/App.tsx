import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './context/AuthContext';
import { AppLayout } from './components/layout/AppLayout';
import { ProtectedRoute } from './components/layout/ProtectedRoute';

// Pages
import { LandingPage } from './pages/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { DashboardPage } from './pages/DashboardPage';
import { WatchlistPage } from './pages/WatchlistPage';
import { CollectionsListPage } from './pages/CollectionsListPage';
import { CollectionDetailPage } from './pages/CollectionDetailPage';
import { SharedWithMePage } from './pages/SharedWithMePage';
import { InvitationsPage } from './pages/InvitationsPage';
import { PublicCollectionPage } from './pages/PublicCollectionPage';
import { SettingsPage } from './pages/SettingsPage';
import { NotFoundPage } from './pages/NotFoundPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 60 * 1000,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            {/* Public Routes */}
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />

            {/* Public View-Only Collection Sharing */}
            <Route path="/c/:shareToken" element={<PublicCollectionPage />} />
            <Route path="/collections/share/:shareToken" element={<PublicCollectionPage />} />

            {/* Protected App Routes */}
            <Route
              element={
                <ProtectedRoute>
                  <AppLayout />
                </ProtectedRoute>
              }
            >
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/watchlist" element={<WatchlistPage />} />
              <Route path="/collections" element={<CollectionsListPage />} />
              <Route path="/collections/:id" element={<CollectionDetailPage />} />
              <Route path="/shared" element={<SharedWithMePage />} />
              <Route path="/invitations" element={<InvitationsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>

            {/* 404 Fallback */}
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
