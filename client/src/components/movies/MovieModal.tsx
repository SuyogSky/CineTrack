import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Star,
  CheckCircle2,
  Clock,
  Film,
  Calendar,
  Globe,
  Save,
  Loader2,
} from 'lucide-react';
import { Modal } from '../common/Modal';
import { CollectionMovie } from '../../types';
import { collectionService } from '../../services/collectionService';
import { useToggleMovieStatus } from '../../hooks/useToggleMovieStatus';

interface MovieModalProps {
  entry: CollectionMovie | null;
  isOpen: boolean;
  onClose: () => void;
  canEdit?: boolean;
  onStatusChange?: (updatedEntry: CollectionMovie) => void;
}

export const MovieModal: React.FC<MovieModalProps> = ({
  entry,
  isOpen,
  onClose,
  canEdit = true,
  onStatusChange,
}) => {
  const queryClient = useQueryClient();
  const [noteText, setNoteText] = useState(entry?.note || '');
  const [currentStatus, setCurrentStatus] = useState<'TO_WATCH' | 'WATCHED'>(
    entry?.status || 'TO_WATCH'
  );
  const [isSaved, setIsSaved] = useState(false);

  // Sync noteText and currentStatus when entry changes
  React.useEffect(() => {
    if (entry) {
      setNoteText(entry.note || '');
      setCurrentStatus(entry.status);
      setIsSaved(false);
    }
  }, [entry?.id, entry?.status, entry?.note]);

  const toggleStatusMutation = useToggleMovieStatus({
    onSuccess: () => {
      setIsSaved(true);
      setTimeout(() => setIsSaved(false), 2000);
    },
    onError: () => {
      if (entry) {
        setCurrentStatus(entry.status);
        if (onStatusChange) {
          onStatusChange(entry);
        }
      }
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: { status?: 'TO_WATCH' | 'WATCHED'; note?: string | null }) => {
      if (!entry) throw new Error('No entry');
      return collectionService.updateMovie(entry.collectionId, entry.id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collection'] });
      queryClient.invalidateQueries({ queryKey: ['defaultWatchlist'] });
      queryClient.invalidateQueries({ queryKey: ['dashboardStats'] });
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      setIsSaved(true);
      setTimeout(() => setIsSaved(false), 2000);
    },
  });

  const handleToggleStatus = () => {
    if (!entry) return;
    const nextStatus = currentStatus === 'WATCHED' ? 'TO_WATCH' : 'WATCHED';
    setCurrentStatus(nextStatus);
    if (onStatusChange) {
      onStatusChange({
        ...entry,
        status: nextStatus,
        watchedAt: nextStatus === 'WATCHED' ? new Date().toISOString() : null,
      });
    }
    toggleStatusMutation.mutate({
      collectionId: entry.collectionId,
      entryId: entry.id,
      status: nextStatus,
    });
  };

  if (!entry) return null;
  const { movie } = entry;

  const backdropUrl = movie.backdropPath
    ? `https://image.tmdb.org/t/p/w1280${movie.backdropPath}`
    : null;
  const posterUrl = movie.posterPath
    ? `https://image.tmdb.org/t/p/w500${movie.posterPath}`
    : null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="3xl">
      <div className="space-y-6">
        {/* Backdrop Banner Header */}
        <div className="relative -mt-6 -mx-6 h-48 sm:h-64 bg-zinc-900 overflow-hidden">
          {backdropUrl ? (
            <img
              src={backdropUrl}
              alt={movie.title}
              className="w-full h-full object-cover opacity-60"
            />
          ) : (
            <div className="w-full h-full bg-gradient-to-r from-red-950/40 via-zinc-900 to-zinc-950" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-[#121620] via-[#121620]/60 to-transparent" />

          {/* Quick status pill in backdrop */}
          <div className="absolute top-4 left-6 z-20">
            <span
              data-testid="modal-status-badge"
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold backdrop-blur-md shadow-lg ${
                currentStatus === 'WATCHED'
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                  : 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
              }`}
            >
              {currentStatus === 'WATCHED' ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Watched
                </>
              ) : (
                <>
                  <Clock className="w-3.5 h-3.5" />
                  To Watch
                </>
              )}
            </span>
          </div>
        </div>

        {/* Content Layout */}
        <div className="flex flex-col sm:flex-row gap-6 items-start">
          {/* Poster */}
          <div className="w-32 sm:w-44 aspect-[2/3] rounded-xl overflow-hidden bg-zinc-800 shrink-0 shadow-xl border border-zinc-700/60 -mt-16 sm:-mt-24 relative z-10">
            {posterUrl ? (
              <img
                src={posterUrl}
                alt={movie.title}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center p-3 text-zinc-600 bg-zinc-900">
                <Film className="w-8 h-8 mb-1" />
                <span className="text-[10px] text-center">{movie.title}</span>
              </div>
            )}
          </div>

          {/* Metadata */}
          <div className="flex-1 space-y-3 min-w-0">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl sm:text-2xl font-bold text-slate-100">
                  {movie.title}
                </h2>
                {movie.mediaType?.toLowerCase() === 'tv' ? (
                  <span className="px-2 py-0.5 rounded-md bg-purple-500/15 border border-purple-500/30 text-xs font-bold text-purple-300 shrink-0">
                    TV Series
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-md bg-sky-500/15 border border-sky-500/30 text-xs font-bold text-sky-300 shrink-0">
                    Movie
                  </span>
                )}
              </div>
              {movie.originalTitle && movie.originalTitle !== movie.title && (
                <p className="text-xs text-zinc-400 italic">
                  Original: {movie.originalTitle}
                </p>
              )}
            </div>

            {/* Quick Badges Bar */}
            <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-300">
              {movie.voteAverage != null && movie.voteAverage > 0 && (
                <div className="flex items-center gap-1 text-amber-400 font-semibold px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20">
                  <Star className="w-3.5 h-3.5 fill-amber-400" />
                  <span>{movie.voteAverage.toFixed(1)} / 10</span>
                </div>
              )}

              {movie.releaseDate && (
                <div className="flex items-center gap-1 text-zinc-400">
                  <Calendar className="w-3.5 h-3.5" />
                  <span>{movie.releaseDate}</span>
                </div>
              )}

              {movie.originalLanguage && (
                <div className="flex items-center gap-1 text-zinc-400 uppercase">
                  <Globe className="w-3.5 h-3.5" />
                  <span>{movie.originalLanguage}</span>
                </div>
              )}
            </div>

            {/* Genres */}
            {movie.genres && movie.genres.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {movie.genres.map((g) => (
                  <span
                    key={g}
                    className="px-2.5 py-0.5 rounded-md text-xs font-medium bg-zinc-800 text-zinc-300 border border-zinc-700/60"
                  >
                    {g}
                  </span>
                ))}
              </div>
            )}

            {/* Overview */}
            {movie.overview && (
              <div className="pt-2">
                <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
                  Synopsis
                </h4>
                <p className="text-xs sm:text-sm text-zinc-300 leading-relaxed">
                  {movie.overview}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Notes & Status Editor Section */}
        {canEdit && (
          <div className="pt-4 border-t border-zinc-800/80 space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                Personal Movie Note
              </label>

              {/* Status Toggle Button */}
              <button
                type="button"
                data-testid="modal-status-toggle-button"
                disabled={updateMutation.isPending}
                onClick={handleToggleStatus}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all min-h-[44px] shadow-sm ${
                  currentStatus === 'WATCHED'
                    ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700/60'
                    : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                }`}
              >
                <CheckCircle2 className="w-4 h-4" />
                {currentStatus === 'WATCHED' ? 'Mark as Unwatched' : 'Mark as Watched'}
              </button>
            </div>

            <div className="relative">
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="Add your thoughts, review, who recommended it, or where to stream..."
                rows={3}
                className="w-full p-3 rounded-xl bg-zinc-900 border border-zinc-800 text-xs sm:text-sm text-slate-200 placeholder-zinc-500 focus:outline-none focus:border-red-500/80 transition-colors resize-none"
              />
            </div>

            <div className="flex items-center justify-end gap-2">
              {isSaved && (
                <span className="text-xs text-emerald-400 font-medium animate-fade-in">
                  Saved successfully!
                </span>
              )}
              <button
                type="button"
                disabled={updateMutation.isPending}
                onClick={() => updateMutation.mutate({ note: noteText })}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
              >
                {updateMutation.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                Save Note
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};
