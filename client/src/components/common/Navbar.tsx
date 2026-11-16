import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Film,
  BookmarkCheck,
  FolderKanban,
  Users,
  Bell,
  Search,
  LogOut,
  Menu,
  X,
  Settings,
  Sparkles,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { ThemeToggle } from './ThemeToggle';

interface NavbarProps {
  onOpenSearch: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ onOpenSearch }) => {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const navLinks = [
    { label: 'Dashboard', path: '/dashboard', icon: Sparkles },
    { label: 'Watchlist', path: '/watchlist', icon: BookmarkCheck },
    { label: 'Collections', path: '/collections', icon: FolderKanban },
    { label: 'Shared', path: '/shared', icon: Users },
  ];

  const isActive = (path: string) => location.pathname === path;

  return (
    <header className="sticky top-0 z-40 w-full border-b border-zinc-800/80 bg-[#0b0d13]/90 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Brand Logo */}
        <div className="flex items-center gap-8">
          <Link to="/dashboard" className="flex items-center gap-2.5 group">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-600 to-rose-700 flex items-center justify-center shadow-lg shadow-red-950/40 group-hover:scale-105 transition-transform">
              <Film className="w-5 h-5 text-white" />
            </div>
            <span className="text-xl font-bold tracking-tight text-white group-hover:text-red-400 transition-colors">
              Cine<span className="text-red-500">Track</span>
            </span>
          </Link>

          {/* Desktop Navigation Links */}
          <nav className="hidden md:flex items-center gap-1">
            {navLinks.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.path);
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium transition-colors ${
                    active
                      ? 'bg-zinc-800/80 text-white shadow-sm'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                  }`}
                >
                  <Icon className={`w-4 h-4 ${active ? 'text-red-500' : 'text-zinc-400'}`} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Right Action Bar */}
        <div className="flex items-center gap-1.5 sm:gap-3">
          {/* Quick Search Button (Desktop & Tablet) */}
          <button
            type="button"
            onClick={onOpenSearch}
            className="hidden sm:flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl bg-zinc-900/90 border border-zinc-800 text-zinc-400 hover:text-slate-100 hover:border-zinc-700 text-xs sm:text-sm font-medium transition-all shadow-inner"
          >
            <Search className="w-4 h-4 text-red-500" />
            <span className="hidden sm:inline">Search Movies...</span>
            <kbd className="hidden sm:inline-block ml-2 px-1.5 py-0.5 text-[10px] bg-zinc-800 rounded border border-zinc-700 text-zinc-400">
              Ctrl+K
            </kbd>
          </button>

          {/* Invitations Alert Icon */}
          <Link
            to="/invitations"
            className="relative p-2.5 rounded-xl text-zinc-400 hover:text-slate-100 hover:bg-zinc-800/60 transition-colors"
            title="Collaboration Invitations"
          >
            <Bell className="w-5 h-5" />
            {user && (user.pendingInvitationsCount || 0) > 0 && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-red-500 ring-2 ring-[#0b0d13]" />
            )}
          </Link>

          {/* Theme Toggle Button */}
          <ThemeToggle />

          {/* User Profile / Logout */}
          <div className="hidden sm:flex items-center gap-2 pl-2 border-l border-zinc-800">
            <Link
              to="/settings"
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl hover:bg-zinc-800/60 transition-colors text-sm text-zinc-300"
              title="Account Settings"
            >
              <div className="w-7 h-7 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center text-xs font-semibold text-red-400">
                {user?.username?.[0]?.toUpperCase() || 'U'}
              </div>
              <span className="font-medium max-w-[120px] truncate">{user?.username}</span>
            </Link>

            <button
              type="button"
              onClick={handleLogout}
              className="p-2 rounded-xl text-zinc-400 hover:text-red-400 hover:bg-zinc-800/60 transition-colors"
              title="Sign Out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>

          {/* Mobile menu trigger */}
          <button
            type="button"
            data-testid="mobile-menu-button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-800/60 transition-colors"
          >
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>
      </div>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div data-testid="mobile-drawer" className="md:hidden border-b border-zinc-800 bg-[#0e121b] px-4 pt-2 pb-4 space-y-1">
          {navLinks.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.path);
            return (
              <Link
                key={item.path}
                to={item.path}
                data-testid={`mobile-nav-${item.label.toLowerCase()}`}
                onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-base font-medium ${
                  active ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white'
                }`}
              >
                <Icon className={`w-5 h-5 ${active ? 'text-red-500' : 'text-zinc-400'}`} />
                {item.label}
              </Link>
            );
          })}
          <div className="pt-3 border-t border-zinc-800/80 flex flex-col gap-1">
            <div className="px-3 py-2 flex items-center justify-between text-zinc-400">
              <span className="text-sm font-medium">Theme Mode</span>
              <ThemeToggle showLabel />
            </div>
            <Link
              to="/settings"
              onClick={() => setMobileMenuOpen(false)}
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-base text-zinc-400 hover:text-white"
            >
              <Settings className="w-5 h-5" />
              Settings ({user?.username})
            </Link>
            <button
              type="button"
              onClick={handleLogout}
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-base text-red-400 hover:bg-red-500/10 w-full text-left"
            >
              <LogOut className="w-5 h-5" />
              Sign Out
            </button>
          </div>
        </div>
      )}
    </header>
  );
};
