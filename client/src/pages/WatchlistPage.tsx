import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BookmarkCheck,
  Search,
  Filter,
  ArrowUpDown,
  Plus,
  Dices,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Clock,
  Film,
  Loader2,
} from 'lucide-react';
import { collectionService } from '../services/collectionService';
import { MovieCard } from '../components/movies/MovieCard';
import { MovieSearchModal } from '../components/movies/MovieSearchModal';
import { MovieRouletteModal } from '../components/movies/MovieRouletteModal';
import { MovieModal } from '../components/movies/MovieModal';
import { MoveMovieDialog } from '../components/movies/MoveMovieDialog';
import { CollectionMovie } from '../types';
import { useToggleMovieStatus } from '../hooks/useToggleMovieStatus';

export const WatchlistPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'TO_WATCH' | 'WATCHED'>('ALL');
  const [sortBy, setSortBy] = useState<'RECENT' | 'TITLE' | 'RATING' | 'YEAR'>('RECENT');
  const [watchedSectionCollapsed, setWatchedSectionCollapsed] = useState(false);

  // Modals state
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [rouletteOpen, setRouletteOpen] = useState(false);
  const [selectedMovieEntry, setSelectedMovieEntry] = useState<CollectionMovie | null>(null);
  const [moveMovieEntry, setMoveMovieEntry] = useState<CollectionMovie | null>(null);

  // Query default watchlist
  const { data: watchlist, isLoading } = useQuery({
    queryKey: ['defaultWatchlist'],
    queryFn: collectionService.getDefaultWatchlist,
  });

  // Centralized optimistic toggle watch status mutation
  const toggleStatusMutation = useToggleMovieStatus();

  // Remove movie mutation
  const removeMutation = useMutation({
    mutationFn: (entryId: string) => {
      if (!watchlist) throw new Error('No watchlist');
      return collectionService.removeMovie(watchlist.id, entryId);
    },
    onMutate: async (entryId: string) => {
      await queryClient.cancelQueries({ queryKey: ['defaultWatchlist'] });
      const previousWatchlist = queryClient.getQueryData(['defaultWatchlist']);

      queryClient.setQueryData(['defaultWatchlist'], (old: any) => {
        if (!old || !old.movies) return old;
        return {
          ...old,
          movies: old.movies.filter((m: any) => m.id !== entryId),
        };
      });

      return { previousWatchlist };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousWatchlist) {
        queryClient.setQueryData(['defaultWatchlist'], context.previousWatchlist);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['defaultWatchlist'] });
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      queryClient.invalidateQueries({ queryKey: ['dashboardStats'] });
    },
  });

  const allMovies = watchlist?.movies || [];

  // Filter & Sort
  const filteredMovies = useMemo(() => {
    let result = [...allMovies];

    // Status filter
    if (statusFilter !== 'ALL') {
      result = result.filter((m) => m.status === statusFilter);
    }

    // Text search query filter (title or genre)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(
        (m) =>
          m.movie.title.toLowerCase().includes(q) ||
          m.movie.genres.some((g) => g.toLowerCase().includes(q)) ||
          (m.note && m.note.toLowerCase().includes(q))
      );
    }

    // Sorting
    result.sort((a, b) => {
      if (sortBy === 'TITLE') {
        return a.movie.title.localeCompare(b.movie.title);
      }
      if (sortBy === 'RATING') {
        return (b.movie.voteAverage || 0) - (a.movie.voteAverage || 0);
      }
      if (sortBy === 'YEAR') {
        return (b.movie.releaseYear || 0) - (a.movie.releaseYear || 0);
      }
      // RECENT (default)
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    return result;
  }, [allMovies, statusFilter, searchQuery, sortBy]);

  const pendingList = filteredMovies.filter((m) => m.status === 'TO_WATCH');
  const watchedList = filteredMovies.filter((m) => m.status === 'WATCHED');

  return (
    <div className="space-y-8">
      {/* Header Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-zinc-800">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-red-600/10 border border-red-500/20 flex items-center justify-center text-red-500">
              <BookmarkCheck className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-2xl font-black text-slate-100">My Watchlist</h1>
              <p className="text-xs text-zinc-400 mt-0.5">
                {allMovies.length} total films • {allMovies.filter((m) => m.status === 'TO_WATCH').length} pending • {allMovies.filter((m) => m.status === 'WATCHED').length} watched
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setRouletteOpen(true)}
            className="px-4 py-2.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 text-xs font-bold flex items-center gap-2 transition-all shadow-md shadow-amber-950/20 hover:scale-105"
          >
            <Dices className="w-4 h-4 text-amber-400" />
            <span>PICK FOR US</span>
          </button>

          <button
            type="button"
            onClick={() => setSearchModalOpen(true)}
            className="px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold flex items-center gap-2 transition-all shadow-md shadow-red-950/40 hover:scale-105"
          >
            <Plus className="w-4 h-4" />
            <span>Add Movies</span>
          </button>
        </div>
      </div>

      {/* Search, Filter, & Sort Controls */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-[#121622] p-3 rounded-2xl border border-zinc-800">
        {/* Search inside watchlist */}
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search watchlist..."
            className="w-full pl-9 pr-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-xs text-slate-200 placeholder-zinc-500 focus:outline-none focus:border-red-500/80 transition-colors"
          />
        </div>

        {/* Status filter tabs */}
        <div className="flex items-center gap-1 bg-zinc-900 p-1 rounded-xl border border-zinc-800 self-stretch sm:self-auto justify-center">
          <button
            type="button"
            onClick={() => setStatusFilter('ALL')}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
              statusFilter === 'ALL'
                ? 'bg-zinc-800 text-white shadow-sm'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            All ({allMovies.length})
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter('TO_WATCH')}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
              statusFilter === 'TO_WATCH'
                ? 'bg-amber-500/20 text-amber-300 shadow-sm border border-amber-500/30'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            To Watch ({allMovies.filter((m) => m.status === 'TO_WATCH').length})
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter('WATCHED')}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
              statusFilter === 'WATCHED'
                ? 'bg-emerald-500/20 text-emerald-300 shadow-sm border border-emerald-500/30'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            Watched ({allMovies.filter((m) => m.status === 'WATCHED').length})
          </button>
        </div>

        {/* Sort Dropdown */}
        <div className="flex items-center gap-2 self-end sm:self-auto">
          <ArrowUpDown className="w-3.5 h-3.5 text-zinc-400" />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="bg-zinc-900 border border-zinc-800 rounded-xl px-2.5 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-red-500/80"
          >
            <option value="RECENT">Recently Added</option>
            <option value="TITLE">Title (A - Z)</option>
            <option value="RATING">Highest Rating</option>
            <option value="YEAR">Release Year</option>
          </select>
        </div>
      </div>

      {/* Loading state */}
      {isLoading ? (
        <div className="py-20 flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-red-500" />
          <p className="text-xs text-zinc-400">Loading your watchlist...</p>
        </div>
      ) : allMovies.length === 0 ? (
        /* Empty Watchlist */
        <div className="py-20 rounded-2xl bg-[#121622] border border-zinc-800 text-center space-y-4 max-w-lg mx-auto p-8">
          <div className="w-16 h-16 rounded-2xl bg-zinc-800/80 border border-zinc-700/60 flex items-center justify-center mx-auto text-zinc-500">
            <Film className="w-8 h-8" />
          </div>
          <h3 className="text-base font-bold text-slate-100">
            Your Watchlist is Ready for Movies!
          </h3>
          <p className="text-xs text-zinc-400 leading-relaxed">
            Search for movies to keep track of what you want to watch next.
          </p>
          <button
            type="button"
            onClick={() => setSearchModalOpen(true)}
            className="px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold inline-flex items-center gap-2 shadow-lg shadow-red-950/40"
          >
            <Plus className="w-4 h-4" />
            <span>Search & Add Movie</span>
          </button>
        </div>
      ) : filteredMovies.length === 0 ? (
        /* No search matches */
        <div className="py-16 text-center text-zinc-500 text-xs">
          No movies in your watchlist match your current filter or search criteria.
        </div>
      ) : (
        /* Movie Lists */
        <div className="space-y-12">
          {/* TO WATCH Section */}
          {(statusFilter === 'ALL' || statusFilter === 'TO_WATCH') && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-amber-400" />
                <h3 className="text-base font-bold text-slate-100">
                  To Watch ({pendingList.length})
                </h3>
              </div>

              {pendingList.length === 0 ? (
                <div className="p-6 rounded-2xl bg-[#121622]/60 border border-zinc-800/60 text-center text-xs text-zinc-500">
                  No unwatched movies found. You're all caught up!
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  {pendingList.map((entry) => (
                    <MovieCard
                      key={entry.id}
                      entry={entry}
                      onToggleStatus={(id, st) =>
                        toggleStatusMutation.mutate({
                          collectionId: watchlist?.id || entry.collectionId,
                          entryId: id,
                          status: st,
                        })
                      }
                      onOpenDetails={setSelectedMovieEntry}
                      onOpenMove={setMoveMovieEntry}
                      onOpenNote={setSelectedMovieEntry}
                      onRemove={(id) => removeMutation.mutate(id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* WATCHED Section (Collapsible) */}
          {(statusFilter === 'ALL' || statusFilter === 'WATCHED') && (
            <div className="space-y-4 pt-4 border-t border-zinc-800">
              <div
                onClick={() => setWatchedSectionCollapsed(!watchedSectionCollapsed)}
                className="flex items-center justify-between cursor-pointer group py-2"
              >
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <h3 className="text-base font-bold text-slate-100 group-hover:text-emerald-400 transition-colors">
                    Watched Movies ({watchedList.length})
                  </h3>
                </div>
                <button
                  type="button"
                  className="p-1 rounded-lg text-zinc-400 group-hover:text-white"
                >
                  {watchedSectionCollapsed ? (
                    <ChevronDown className="w-5 h-5" />
                  ) : (
                    <ChevronUp className="w-5 h-5" />
                  )}
                </button>
              </div>

              {!watchedSectionCollapsed && (
                <>
                  {watchedList.length === 0 ? (
                    <div className="p-6 rounded-2xl bg-[#121622]/60 border border-zinc-800/60 text-center text-xs text-zinc-500">
                      No watched movies yet. Check movies off as you watch them!
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                      {watchedList.map((entry) => (
                        <MovieCard
                          key={entry.id}
                          entry={entry}
                          onToggleStatus={(id, st) =>
                            toggleStatusMutation.mutate({
                              collectionId: watchlist?.id || entry.collectionId,
                              entryId: id,
                              status: st,
                            })
                          }
                          onOpenDetails={setSelectedMovieEntry}
                          onOpenMove={setMoveMovieEntry}
                          onOpenNote={setSelectedMovieEntry}
                          onRemove={(id) => removeMutation.mutate(id)}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      {watchlist && (
        <>
          <MovieSearchModal
            isOpen={searchModalOpen}
            onClose={() => setSearchModalOpen(false)}
            targetCollectionId={watchlist.id}
          />
          <MovieRouletteModal
            isOpen={rouletteOpen}
            onClose={() => setRouletteOpen(false)}
            collectionId={watchlist.id}
            collectionTitle={watchlist.title}
          />
        </>
      )}

      <MovieModal
        entry={selectedMovieEntry}
        isOpen={!!selectedMovieEntry}
        onClose={() => setSelectedMovieEntry(null)}
        onStatusChange={(updated) => setSelectedMovieEntry(updated)}
      />

      <MoveMovieDialog
        entry={moveMovieEntry}
        isOpen={!!moveMovieEntry}
        onClose={() => setMoveMovieEntry(null)}
      />
    </div>
  );
};
