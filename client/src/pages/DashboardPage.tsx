import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Sparkles,
  Dices,
  FolderPlus,
  BookmarkCheck,
  FolderKanban,
  Search,
  ArrowRight,
  Clock,
  CheckCircle2,
  Film,
  Plus,
  Tv,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { collectionService } from '../services/collectionService';
import { CollectionCard } from '../components/collections/CollectionCard';
import { MovieCard } from '../components/movies/MovieCard';
import { CreateCollectionDialog } from '../components/collections/CreateCollectionDialog';
import { MovieRouletteModal } from '../components/movies/MovieRouletteModal';
import { MovieSearchModal } from '../components/movies/MovieSearchModal';
import { MovieModal } from '../components/movies/MovieModal';
import { CollectionMovie } from '../types';
import { useToggleMovieStatus } from '../hooks/useToggleMovieStatus';

export const DashboardPage: React.FC = () => {
  const { user } = useAuth();
  const toggleStatusMutation = useToggleMovieStatus();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [rouletteOpen, setRouletteOpen] = useState(false);
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [selectedMovieEntry, setSelectedMovieEntry] = useState<CollectionMovie | null>(null);

  // Queries
  const { data: stats } = useQuery({
    queryKey: ['dashboardStats'],
    queryFn: collectionService.getDashboardStats,
  });

  const { data: defaultWatchlist } = useQuery({
    queryKey: ['defaultWatchlist'],
    queryFn: collectionService.getDefaultWatchlist,
  });

  const { data: collectionsData } = useQuery({
    queryKey: ['collections'],
    queryFn: collectionService.listCollections,
  });

  const watchlistMovies = defaultWatchlist?.movies || [];
  const ownedCollections = collectionsData?.owned || [];

  return (
    <div className="space-y-10">
      {/* Welcome & Quick Action Hero */}
      <div className="relative rounded-3xl bg-gradient-to-r from-zinc-900 via-[#141926] to-[#121620] border border-zinc-800/80 p-6 sm:p-8 overflow-hidden shadow-2xl">
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2 max-w-xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-500/10 border border-red-500/20 text-xs font-semibold text-red-400">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Library Dashboard</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
              Welcome back, {user?.username}!
            </h1>
            <p className="text-xs sm:text-sm text-zinc-400 leading-relaxed">
              You have{' '}
              <span className="text-amber-400 font-semibold">
                {stats?.totalToWatch ?? 0} unwatched
              </span>{' '}
              titles across{' '}
              <span className="text-indigo-400 font-semibold">
                {stats?.totalCollections ?? 0} collections
              </span>
              .
            </p>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-testid="dashboard-pick-button"
              onClick={() => setRouletteOpen(true)}
              className="px-5 py-3 rounded-2xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 text-xs sm:text-sm font-bold flex items-center gap-2 transition-all shadow-lg shadow-amber-950/20 hover:scale-105"
            >
              <Dices className="w-4 h-4 text-amber-400" />
              <span>PICK FOR US</span>
            </button>

            <button
              type="button"
              onClick={() => setSearchModalOpen(true)}
              className="px-5 py-3 rounded-2xl bg-red-600 hover:bg-red-500 text-white text-xs sm:text-sm font-semibold flex items-center gap-2 transition-all shadow-lg shadow-red-950/40 hover:scale-105"
            >
              <Search className="w-4 h-4" />
              <span>Find Media</span>
            </button>

            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="px-4 py-3 rounded-2xl bg-zinc-800/80 hover:bg-zinc-800 text-zinc-300 hover:text-white text-xs sm:text-sm font-medium border border-zinc-700/60 flex items-center gap-2 transition-colors"
            >
              <FolderPlus className="w-4 h-4 text-zinc-400" />
              <span>New Collection</span>
            </button>
          </div>
        </div>
      </div>

      {/* Account-wide Aggregated Metrics Row (5 Cards) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
        {/* Total Movies */}
        <div className="p-3.5 sm:p-5 rounded-2xl bg-[#121622] border border-zinc-800/80 flex items-center gap-3">
          <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400 shrink-0">
            <Film className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="text-xl sm:text-2xl font-black text-slate-100">{stats?.totalMovies ?? 0}</div>
            <div className="text-[11px] sm:text-xs text-zinc-400 font-medium truncate">Movies</div>
          </div>
        </div>

        {/* Total TV Series */}
        <div className="p-3.5 sm:p-5 rounded-2xl bg-[#121622] border border-zinc-800/80 flex items-center gap-3">
          <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 shrink-0">
            <Tv className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="text-xl sm:text-2xl font-black text-slate-100">{stats?.totalTvSeries ?? 0}</div>
            <div className="text-[11px] sm:text-xs text-zinc-400 font-medium truncate">TV Series</div>
          </div>
        </div>

        {/* Total To Watch */}
        <Link
          to="/watchlist"
          className="p-3.5 sm:p-5 rounded-2xl bg-[#121622] border border-zinc-800/80 hover:border-zinc-700 transition-colors flex items-center gap-3"
        >
          <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 shrink-0">
            <Clock className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="text-xl sm:text-2xl font-black text-slate-100">{stats?.totalToWatch ?? 0}</div>
            <div className="text-[11px] sm:text-xs text-zinc-400 font-medium truncate">To Watch</div>
          </div>
        </Link>

        {/* Total Watched */}
        <Link
          to="/watchlist"
          className="p-3.5 sm:p-5 rounded-2xl bg-[#121622] border border-zinc-800/80 hover:border-zinc-700 transition-colors flex items-center gap-3"
        >
          <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="text-xl sm:text-2xl font-black text-slate-100">{stats?.totalWatched ?? 0}</div>
            <div className="text-[11px] sm:text-xs text-zinc-400 font-medium truncate">Watched</div>
          </div>
        </Link>

        {/* Total Collections */}
        <Link
          to="/collections"
          className="col-span-2 sm:col-span-1 p-3.5 sm:p-5 rounded-2xl bg-[#121622] border border-zinc-800/80 hover:border-zinc-700 transition-colors flex items-center gap-3"
        >
          <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-500 shrink-0">
            <FolderKanban className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="text-xl sm:text-2xl font-black text-slate-100">{stats?.totalCollections ?? 0}</div>
            <div className="text-[11px] sm:text-xs text-zinc-400 font-medium truncate">Collections</div>
          </div>
        </Link>
      </div>

      {/* Recent Watchlist Movies Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookmarkCheck className="w-5 h-5 text-red-500" />
            <h2 className="text-lg font-bold text-slate-100">My Watchlist Preview</h2>
          </div>
          <Link
            to="/watchlist"
            className="text-xs font-semibold text-red-400 hover:text-red-300 flex items-center gap-1 transition-colors"
          >
            <span>View All ({watchlistMovies.length})</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        {watchlistMovies.length === 0 ? (
          <div className="p-8 rounded-2xl bg-[#121622] border border-zinc-800/80 text-center space-y-3">
            <Film className="w-10 h-10 text-zinc-600 mx-auto" />
            <h3 className="text-sm font-semibold text-slate-200">
              Your watchlist is completely empty!
            </h3>
            <p className="text-xs text-zinc-400 max-w-md mx-auto">
              Search for films and TV series using the TMDb integration to populate your personal watchlist.
            </p>
            <button
              type="button"
              onClick={() => setSearchModalOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-semibold"
            >
              <Plus className="w-3.5 h-3.5" />
              Search & Add First Media
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {watchlistMovies.slice(0, 5).map((entry) => (
              <MovieCard
                key={entry.id}
                entry={entry}
                onOpenDetails={setSelectedMovieEntry}
                onToggleStatus={(entryId, st) =>
                  toggleStatusMutation.mutate({
                    collectionId: entry.collectionId,
                    entryId: entry.id,
                    movieId: entry.movieId,
                    previousStatus: entry.status,
                    status: st,
                  })
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* Collections Overview Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderKanban className="w-5 h-5 text-indigo-400" />
            <h2 className="text-lg font-bold text-slate-100">Recent Collections</h2>
          </div>
          <Link
            to="/collections"
            className="text-xs font-semibold text-indigo-400 hover:text-indigo-300 flex items-center gap-1 transition-colors"
          >
            <span>All Collections</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {ownedCollections.slice(0, 3).map((col) => (
            <CollectionCard key={col.id} collection={col} />
          ))}

          {/* Create new collection trigger card */}
          <button
            type="button"
            onClick={() => setCreateDialogOpen(true)}
            className="p-6 rounded-2xl border-2 border-dashed border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/40 text-zinc-400 hover:text-white transition-all flex flex-col items-center justify-center gap-2 min-h-[140px]"
          >
            <FolderPlus className="w-6 h-6 text-zinc-500" />
            <span className="text-xs font-semibold">Create Another Collection</span>
          </button>
        </div>
      </div>

      {/* Modals */}
      <CreateCollectionDialog
        isOpen={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
      />

      <MovieRouletteModal
        isOpen={rouletteOpen}
        onClose={() => setRouletteOpen(false)}
      />

      <MovieSearchModal
        isOpen={searchModalOpen}
        onClose={() => setSearchModalOpen(false)}
        targetCollectionId={defaultWatchlist?.id}
      />

      <MovieModal
        entry={selectedMovieEntry}
        isOpen={!!selectedMovieEntry}
        onClose={() => setSelectedMovieEntry(null)}
        onStatusChange={(updated) => setSelectedMovieEntry(updated)}
      />
    </div>
  );
};
