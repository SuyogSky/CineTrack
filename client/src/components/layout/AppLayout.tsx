import React, { useState, useEffect } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { Sparkles, Search, Dices, FolderKanban, Settings } from 'lucide-react';
import { Navbar } from '../common/Navbar';
import { Footer } from '../common/Footer';
import { MovieSearchModal } from '../movies/MovieSearchModal';
import { MovieRouletteModal } from '../movies/MovieRouletteModal';

export const AppLayout: React.FC = () => {
  const location = useLocation();
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [rouletteModalOpen, setRouletteModalOpen] = useState(false);

  // Global Ctrl+K / Cmd+K keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchModalOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const isActive = (path: string) => location.pathname === path;

  return (
    <div className="min-h-screen flex flex-col bg-[#0b0d13] text-slate-100 antialiased selection:bg-red-500/20 selection:text-red-300">
      <Navbar onOpenSearch={() => setSearchModalOpen(true)} />

      {/* Main content with mobile bottom nav safe-area padding */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 pb-24 md:pb-8">
        <Outlet />
      </main>

      <Footer />

      {/* Mobile Bottom Navigation Bar */}
      <nav
        aria-label="Mobile Navigation"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#0e121b]/95 backdrop-blur-lg border-t border-zinc-800/80 px-2 py-1.5 flex items-center justify-around shadow-2xl safe-area-inset-bottom"
      >
        {/* Home / Dashboard */}
        <Link
          to="/dashboard"
          data-testid="mobile-bottom-nav-home"
          className={`flex flex-col items-center justify-center min-w-[56px] min-h-[44px] py-1 px-2 rounded-xl transition-colors ${
            isActive('/dashboard')
              ? 'text-red-500 font-semibold'
              : 'text-zinc-400 hover:text-white'
          }`}
        >
          <Sparkles className="w-5 h-5 mb-0.5" />
          <span className="text-[10px]">Home</span>
        </Link>

        {/* Search */}
        <button
          type="button"
          data-testid="mobile-bottom-nav-search"
          onClick={() => setSearchModalOpen(true)}
          className="flex flex-col items-center justify-center min-w-[56px] min-h-[44px] py-1 px-2 rounded-xl text-zinc-400 hover:text-white transition-colors"
        >
          <Search className="w-5 h-5 mb-0.5" />
          <span className="text-[10px]">Search</span>
        </button>

        {/* Center Pick for Us Floating Action */}
        <button
          type="button"
          data-testid="mobile-bottom-nav-pick"
          onClick={() => setRouletteModalOpen(true)}
          className="flex flex-col items-center justify-center -mt-4 bg-gradient-to-tr from-amber-600 to-amber-500 text-zinc-950 p-2.5 rounded-2xl shadow-lg shadow-amber-950/50 hover:scale-105 active:scale-95 transition-all"
        >
          <Dices className="w-5 h-5" />
          <span className="text-[9px] font-black uppercase tracking-tight mt-0.5">
            Pick
          </span>
        </button>

        {/* Collections */}
        <Link
          to="/collections"
          data-testid="mobile-bottom-nav-collections"
          className={`flex flex-col items-center justify-center min-w-[56px] min-h-[44px] py-1 px-2 rounded-xl transition-colors ${
            isActive('/collections')
              ? 'text-red-500 font-semibold'
              : 'text-zinc-400 hover:text-white'
          }`}
        >
          <FolderKanban className="w-5 h-5 mb-0.5" />
          <span className="text-[10px]">Collections</span>
        </Link>

        {/* Settings / Profile */}
        <Link
          to="/settings"
          data-testid="mobile-bottom-nav-settings"
          className={`flex flex-col items-center justify-center min-w-[56px] min-h-[44px] py-1 px-2 rounded-xl transition-colors ${
            isActive('/settings')
              ? 'text-red-500 font-semibold'
              : 'text-zinc-400 hover:text-white'
          }`}
        >
          <Settings className="w-5 h-5 mb-0.5" />
          <span className="text-[10px]">Profile</span>
        </Link>
      </nav>

      {/* Global Movie Search Modal */}
      <MovieSearchModal
        isOpen={searchModalOpen}
        onClose={() => setSearchModalOpen(false)}
      />

      {/* Global Pick for Us Roulette Modal */}
      <MovieRouletteModal
        isOpen={rouletteModalOpen}
        onClose={() => setRouletteModalOpen(false)}
      />
    </div>
  );
};
