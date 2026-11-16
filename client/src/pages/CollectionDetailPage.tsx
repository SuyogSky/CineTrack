import React, { useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FolderKanban,
  Dices,
  Share2,
  Users,
  Plus,
  Edit2,
  Trash2,
  Clock,
  CheckCircle2,
  Search,
  ArrowUpDown,
  Loader2,
  Globe,
  Lock,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
} from 'lucide-react';
import { collectionService } from '../services/collectionService';
import { MovieCard } from '../components/movies/MovieCard';
import { MovieSearchModal } from '../components/movies/MovieSearchModal';
import { MovieRouletteModal } from '../components/movies/MovieRouletteModal';
import { MovieModal } from '../components/movies/MovieModal';
import { MoveMovieDialog } from '../components/movies/MoveMovieDialog';
import { ShareCollectionModal } from '../components/collections/ShareCollectionModal';
import { CollaboratorsModal } from '../components/collections/CollaboratorsModal';
import { Modal } from '../components/common/Modal';
import { CollectionMovie } from '../types';
import { Badge } from '../components/common/Badge';

export const CollectionDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'TO_WATCH' | 'WATCHED'>('ALL');
  const [sortBy, setSortBy] = useState<'RECENT' | 'TITLE' | 'RATING' | 'YEAR'>('RECENT');
  const [watchedSectionCollapsed, setWatchedSectionCollapsed] = useState(false);

  // Modals state
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [rouletteOpen, setRouletteOpen] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [collaboratorsModalOpen, setCollaboratorsModalOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Edit form state
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');

  // Selected movie for modal or move
  const [selectedMovieEntry, setSelectedMovieEntry] = useState<CollectionMovie | null>(null);
  const [moveMovieEntry, setMoveMovieEntry] = useState<CollectionMovie | null>(null);

  // Collection Query
  const {
    data: collection,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['collection', id],
    queryFn: () => collectionService.getCollection(id!),
    enabled: !!id,
  });

  // Init edit form
  React.useEffect(() => {
    if (collection) {
      setEditTitle(collection.title);
      setEditDesc(collection.description || '');
    }
  }, [collection]);

  const isOwner = collection?.userRole === 'OWNER';
  const allMovies = collection?.movies || [];

  // Mutations
  const toggleStatusMutation = useMutation({
    mutationFn: ({
      entryId,
      status,
    }: {
      entryId: string;
      status: 'TO_WATCH' | 'WATCHED';
    }) => collectionService.updateMovie(id!, entryId, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collection', id] });
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      queryClient.invalidateQueries({ queryKey: ['dashboardStats'] });
    },
  });

  const removeMovieMutation = useMutation({
    mutationFn: (entryId: string) => collectionService.removeMovie(id!, entryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collection', id] });
      queryClient.invalidateQueries({ queryKey: ['collections'] });
    },
  });

  const updateCollectionMutation = useMutation({
    mutationFn: () =>
      collectionService.updateCollection(id!, {
        title: editTitle.trim(),
        description: editDesc.trim() || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collection', id] });
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      setEditDialogOpen(false);
    },
  });

  const deleteCollectionMutation = useMutation({
    mutationFn: () => collectionService.deleteCollection(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      navigate('/collections');
    },
  });

  // Filter & Sort
  const filteredMovies = useMemo(() => {
    let result = [...allMovies];

    if (statusFilter !== 'ALL') {
      result = result.filter((m) => m.status === statusFilter);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(
        (m) =>
          m.movie.title.toLowerCase().includes(q) ||
          m.movie.genres.some((g) => g.toLowerCase().includes(q)) ||
          (m.note && m.note.toLowerCase().includes(q))
      );
    }

    result.sort((a, b) => {
      if (sortBy === 'TITLE') return a.movie.title.localeCompare(b.movie.title);
      if (sortBy === 'RATING') return (b.movie.voteAverage || 0) - (a.movie.voteAverage || 0);
      if (sortBy === 'YEAR') return (b.movie.releaseYear || 0) - (a.movie.releaseYear || 0);
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    return result;
  }, [allMovies, statusFilter, searchQuery, sortBy]);

  const pendingList = filteredMovies.filter((m) => m.status === 'TO_WATCH');
  const watchedList = filteredMovies.filter((m) => m.status === 'WATCHED');

  if (isLoading) {
    return (
      <div className="py-24 flex flex-col items-center justify-center gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-red-500" />
        <p className="text-xs text-zinc-400">Loading collection...</p>
      </div>
    );
  }

  if (isError || !collection) {
    return (
      <div className="py-24 text-center space-y-4">
        <h2 className="text-lg font-bold text-slate-100">Collection Not Found</h2>
        <p className="text-xs text-zinc-400">
          This collection does not exist, was deleted, or you do not have permission to view it.
        </p>
        <button
          type="button"
          onClick={() => navigate('/collections')}
          className="px-4 py-2 rounded-xl bg-zinc-800 text-xs font-semibold text-white"
        >
          Return to Collections
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Top Header Card */}
      <div className="p-6 sm:p-8 rounded-3xl bg-[#121622] border border-zinc-800 space-y-5">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
          <div className="space-y-2 max-w-2xl">
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-500">
                <FolderKanban className="w-4 h-4" />
              </div>

              {isOwner ? (
                <Badge variant="amber" size="sm">Owner</Badge>
              ) : (
                <Badge variant="indigo" size="sm">Collaborator</Badge>
              )}

              {collection.visibility === 'PUBLIC_LINK' ? (
                <Badge variant="purple" size="sm">
                  <Globe className="w-3 h-3" />
                  Public Link Active
                </Badge>
              ) : (
                <Badge variant="zinc" size="sm">
                  <Lock className="w-3 h-3" />
                  Private
                </Badge>
              )}
            </div>

            <h1 className="text-2xl sm:text-3xl font-black text-slate-100">
              {collection.title}
            </h1>

            {collection.description && (
              <p className="text-xs sm:text-sm text-zinc-400 leading-relaxed">
                {collection.description}
              </p>
            )}

            <div className="text-xs text-zinc-500 pt-1">
              Curated by <span className="text-zinc-300 font-medium">@{collection.owner.username}</span> • {allMovies.length} total films
            </div>
          </div>

          {/* Action Buttons Toolbar */}
          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            {/* Roulette Button */}
            <button
              type="button"
              onClick={() => setRouletteOpen(true)}
              className="px-4 py-2.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 text-xs font-bold flex items-center gap-2 transition-all shadow-md shadow-amber-950/20"
            >
              <Dices className="w-4 h-4 text-amber-400" />
              <span>PICK FOR US</span>
            </button>

            {/* Add Movies */}
            <button
              type="button"
              onClick={() => setSearchModalOpen(true)}
              className="px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold flex items-center gap-2 transition-all shadow-md shadow-red-950/40"
            >
              <Plus className="w-4 h-4" />
              <span>Add Movies</span>
            </button>

            {/* Share Modal Trigger (Owner only) */}
            {isOwner && (
              <button
                type="button"
                onClick={() => setShareModalOpen(true)}
                className="px-3.5 py-2.5 rounded-xl bg-zinc-800/80 hover:bg-zinc-800 border border-zinc-700/60 text-zinc-300 text-xs font-medium flex items-center gap-2 transition-colors"
                title="Public Sharing"
              >
                <Share2 className="w-4 h-4 text-purple-400" />
                <span>Share</span>
              </button>
            )}

            {/* Collaborators Modal Trigger */}
            <button
              type="button"
              onClick={() => setCollaboratorsModalOpen(true)}
              className="px-3.5 py-2.5 rounded-xl bg-zinc-800/80 hover:bg-zinc-800 border border-zinc-700/60 text-zinc-300 text-xs font-medium flex items-center gap-2 transition-colors"
              title="Collaborators"
            >
              <Users className="w-4 h-4 text-indigo-400" />
              <span>Collaborators</span>
            </button>

            {/* Owner Edit / Delete Settings */}
            {isOwner && !collection.isDefaultWatchlist && (
              <>
                <button
                  type="button"
                  onClick={() => setEditDialogOpen(true)}
                  className="p-2.5 rounded-xl bg-zinc-800/80 hover:bg-zinc-800 border border-zinc-700/60 text-zinc-400 hover:text-white transition-colors"
                  title="Edit collection details"
                >
                  <Edit2 className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  onClick={() => setDeleteDialogOpen(true)}
                  className="p-2.5 rounded-xl bg-zinc-800/80 hover:bg-red-500/10 border border-zinc-700/60 text-zinc-400 hover:text-red-400 transition-colors"
                  title="Delete collection"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Search, Filter & Sort Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-[#121622] p-3 rounded-2xl border border-zinc-800">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search in this collection..."
            className="w-full pl-9 pr-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-xs text-slate-200 placeholder-zinc-500 focus:outline-none focus:border-red-500/80"
          />
        </div>

        {/* Status Filters */}
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

        {/* Sort Select */}
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

      {/* Movies Grid / Sections */}
      {allMovies.length === 0 ? (
        <div className="py-20 rounded-2xl bg-[#121622] border border-zinc-800 text-center space-y-4 max-w-lg mx-auto p-8">
          <FolderKanban className="w-12 h-12 text-zinc-600 mx-auto" />
          <h3 className="text-base font-bold text-slate-100">
            This Collection is Empty
          </h3>
          <p className="text-xs text-zinc-400 leading-relaxed">
            Search for movies to add to this collection or move movies from your watchlist.
          </p>
          <button
            type="button"
            onClick={() => setSearchModalOpen(true)}
            className="px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold inline-flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            <span>Search & Add Movies</span>
          </button>
        </div>
      ) : (
        <div className="space-y-12">
          {/* TO WATCH */}
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
                  No unwatched movies in this collection.
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  {pendingList.map((entry) => (
                    <MovieCard
                      key={entry.id}
                      entry={entry}
                      onToggleStatus={(id, st) =>
                        toggleStatusMutation.mutate({ entryId: id, status: st })
                      }
                      onOpenDetails={setSelectedMovieEntry}
                      onOpenMove={setMoveMovieEntry}
                      onOpenNote={setSelectedMovieEntry}
                      onRemove={(id) => removeMovieMutation.mutate(id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* WATCHED */}
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
                      No watched movies yet in this collection.
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                      {watchedList.map((entry) => (
                        <MovieCard
                          key={entry.id}
                          entry={entry}
                          onToggleStatus={(id, st) =>
                            toggleStatusMutation.mutate({ entryId: id, status: st })
                          }
                          onOpenDetails={setSelectedMovieEntry}
                          onOpenMove={setMoveMovieEntry}
                          onOpenNote={setSelectedMovieEntry}
                          onRemove={(id) => removeMovieMutation.mutate(id)}
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

      {/* Edit Collection Dialog */}
      <Modal
        isOpen={editDialogOpen}
        onClose={() => setEditDialogOpen(false)}
        title="Edit Collection Details"
        maxWidth="md"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            updateCollectionMutation.mutate();
          }}
          className="space-y-4"
        >
          <div>
            <label className="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-1">
              Title
            </label>
            <input
              type="text"
              required
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-sm text-slate-100 focus:outline-none focus:border-red-500/80"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-1">
              Description
            </label>
            <textarea
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              rows={3}
              className="w-full p-3.5 rounded-xl bg-zinc-900 border border-zinc-800 text-sm text-slate-100 focus:outline-none focus:border-red-500/80 resize-none"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-zinc-800">
            <button
              type="button"
              onClick={() => setEditDialogOpen(false)}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={updateCollectionMutation.isPending}
              className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold"
            >
              Save Changes
            </button>
          </div>
        </form>
      </Modal>

      {/* Delete Collection Dialog */}
      <Modal
        isOpen={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        title="Delete Collection"
        maxWidth="md"
      >
        <div className="space-y-4">
          <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-400 flex items-center gap-3">
            <AlertTriangle className="w-6 h-6 shrink-0" />
            <span>
              Are you sure you want to delete <strong className="text-white">"{collection.title}"</strong>? This will permanently remove the collection and its movie associations for all collaborators.
            </span>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setDeleteDialogOpen(false)}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deleteCollectionMutation.isPending}
              onClick={() => deleteCollectionMutation.mutate()}
              className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-semibold"
            >
              Confirm Delete
            </button>
          </div>
        </div>
      </Modal>

      {/* Common Modals */}
      <MovieSearchModal
        isOpen={searchModalOpen}
        onClose={() => setSearchModalOpen(false)}
        targetCollectionId={collection.id}
      />

      <MovieRouletteModal
        isOpen={rouletteOpen}
        onClose={() => setRouletteOpen(false)}
        collectionId={collection.id}
        collectionTitle={collection.title}
      />

      <ShareCollectionModal
        collection={collection}
        isOpen={shareModalOpen}
        onClose={() => setShareModalOpen(false)}
      />

      <CollaboratorsModal
        collection={collection}
        isOpen={collaboratorsModalOpen}
        onClose={() => setCollaboratorsModalOpen(false)}
        isOwner={isOwner}
      />

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
