import React from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  Film,
  Dices,
  Users,
  Globe,
  BookmarkCheck,
  ArrowRight,
  Star,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export const LandingPage: React.FC = () => {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return null;
  }

  // If already logged in, redirect to dashboard
  if (user) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="min-h-screen bg-[#0b0d13] text-slate-100 flex flex-col">
      {/* Top Bar */}
      <header className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-600 to-rose-700 flex items-center justify-center shadow-lg shadow-red-950/60">
            <Film className="w-5 h-5 text-white" />
          </div>
          <span className="text-xl font-bold tracking-tight text-white">
            Cine<span className="text-red-500">Track</span>
          </span>
        </div>

        <div className="flex items-center gap-3">
          <Link
            to="/login"
            className="px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold text-zinc-300 hover:text-white transition-colors"
          >
            Sign In
          </Link>
          <Link
            to="/register"
            className="px-4 sm:px-5 py-2 sm:py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs sm:text-sm font-semibold transition-colors shadow-lg shadow-red-950/40"
          >
            Get Started Free
          </Link>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative flex-1 flex flex-col items-center justify-center text-center px-4 sm:px-6 py-16 sm:py-24 overflow-hidden">
        {/* Subtle background glow */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[350px] bg-red-600/10 rounded-full blur-[120px] pointer-events-none" />

        <div className="relative z-10 max-w-3xl mx-auto space-y-6">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-900 border border-zinc-800 text-xs font-medium text-zinc-300">
            <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
            <span>The Premier Movie Watchlist & Collection Manager</span>
          </div>

          <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight text-white leading-tight">
            Never Spend 40 Minutes Choosing a Movie Again.
          </h1>

          <p className="text-base sm:text-lg text-zinc-400 max-w-2xl mx-auto leading-relaxed">
            Curate your personal watchlist, build collaborative collections with friends, share view-only links, and let <span className="text-amber-400 font-medium">Movie Night Roulette</span> pick what to watch next.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-4">
            <Link
              to="/register"
              className="w-full sm:w-auto px-7 py-3.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-all shadow-xl shadow-red-950/50 hover:scale-105"
            >
              <span>Start Your Watchlist</span>
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              to="/login"
              className="w-full sm:w-auto px-7 py-3.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-800 font-semibold text-sm transition-colors"
            >
              Sign In to Your Account
            </Link>
          </div>
        </div>

        {/* Feature Cards Grid */}
        <div className="relative z-10 max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-4 gap-4 mt-20 text-left">
          <div className="p-5 rounded-2xl bg-[#121622]/80 border border-zinc-800/80 backdrop-blur-sm space-y-2.5">
            <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-500">
              <BookmarkCheck className="w-5 h-5" />
            </div>
            <h3 className="text-sm font-bold text-slate-100">Smart Watchlist</h3>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Track movies to watch, record personal notes, and mark completed films with precise completion dates.
            </p>
          </div>

          <div className="p-5 rounded-2xl bg-[#121622]/80 border border-zinc-800/80 backdrop-blur-sm space-y-2.5">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
              <Dices className="w-5 h-5" />
            </div>
            <h3 className="text-sm font-bold text-slate-100">Movie Roulette</h3>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Click "PICK FOR US" to randomly pick an unwatched film with a suspenseful cinematic spin.
            </p>
          </div>

          <div className="p-5 rounded-2xl bg-[#121622]/80 border border-zinc-800/80 backdrop-blur-sm space-y-2.5">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
              <Users className="w-5 h-5" />
            </div>
            <h3 className="text-sm font-bold text-slate-100">Live Collaboration</h3>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Invite friends to manage shared movie lists together with enterprise role-based authorization.
            </p>
          </div>

          <div className="p-5 rounded-2xl bg-[#121622]/80 border border-zinc-800/80 backdrop-blur-sm space-y-2.5">
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400">
              <Globe className="w-5 h-5" />
            </div>
            <h3 className="text-sm font-bold text-slate-100">Public View-Only</h3>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Share collections with anyone via unguessable links. Visitors can view films without registering.
            </p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-900 bg-[#080a0f] py-6 text-center text-xs text-zinc-600">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>© 2026 CineTrack. All rights reserved.</span>
          <span>Powered by The Movie Database (TMDb).</span>
        </div>
      </footer>
    </div>
  );
};
