import React, { useState } from 'react';
import {
  Star,
  CheckCircle2,
  Clock,
  MoreVertical,
  StickyNote,
  Trash2,
  ArrowRightLeft,
  Film,
} from 'lucide-react';
import { CollectionMovie } from '../../types';
import { Badge } from '../common/Badge';

interface MovieCardProps {
  entry: CollectionMovie;
  canEdit?: boolean;
  onToggleStatus?: (entryId: string, newStatus: 'TO_WATCH' | 'WATCHED') => void;
  onOpenDetails: (entry: CollectionMovie) => void;
  onOpenMove?: (entry: CollectionMovie) => void;
  onOpenNote?: (entry: CollectionMovie) => void;
  onRemove?: (entryId: string) => void;
}

export const MovieCard: React.FC<MovieCardProps> = ({
  entry,
  canEdit = true,
  onToggleStatus,
  onOpenDetails,
  onOpenMove,
  onOpenNote,
  onRemove,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [imageError, setImageError] = useState(false);
  const { movie, status, watchedAt, note } = entry;

  const posterUrl =
    !imageError && movie.posterPath
      ? `https://image.tmdb.org/t/p/w500${movie.posterPath}`
      : null;

  const formattedWatchedDate = watchedAt
    ? new Date(watchedAt).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  return (
    <div className="group relative flex flex-col rounded-2xl bg-[#121622] border border-zinc-800/80 hover:border-zinc-700/80 transition-all duration-200 overflow-hidden shadow-lg hover:shadow-2xl hover:shadow-black/60">
      {/* Poster Container */}
      <div
        className="relative aspect-[2/3] w-full bg-zinc-900 cursor-pointer overflow-hidden"
        onClick={() => onOpenDetails(entry)}
      >
        {posterUrl ? (
          <img
            src={posterUrl}
            alt={movie.title}
            onError={() => setImageError(true)}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center p-4 text-center bg-gradient-to-b from-zinc-800 to-zinc-900 text-zinc-500">
            <Film className="w-12 h-12 mb-2 text-zinc-600" />
            <span className="text-xs font-medium text-zinc-400 line-clamp-2">{movie.title}</span>
          </div>
        )}

        {/* Rating Overlay */}
        {movie.voteAverage != null && movie.voteAverage > 0 && (
          <div className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded-md bg-black/75 backdrop-blur-md border border-zinc-700/50 flex items-center gap-1 text-xs font-semibold text-amber-400 shadow-sm">
            <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
            <span>{movie.voteAverage.toFixed(1)}</span>
          </div>
        )}

        {/* Status Badge */}
        <div className="absolute top-2.5 right-2.5">
          {status === 'WATCHED' ? (
            <Badge variant="emerald" size="sm">
              <CheckCircle2 className="w-3 h-3" />
              Watched
            </Badge>
          ) : (
            <Badge variant="amber" size="sm">
              <Clock className="w-3 h-3" />
              To Watch
            </Badge>
          )}
        </div>

        {/* Note Pin Indicator */}
        {note && (
          <div
            className="absolute bottom-2.5 left-2.5 p-1.5 rounded-lg bg-black/75 backdrop-blur-md border border-zinc-700/50 text-indigo-400 shadow-sm"
            title={`Note: ${note}`}
          >
            <StickyNote className="w-3.5 h-3.5" />
          </div>
        )}
      </div>

      {/* Card Info Content */}
      <div className="flex-1 p-3.5 flex flex-col justify-between">
        <div>
          <div className="flex items-start justify-between gap-1">
            <h4
              onClick={() => onOpenDetails(entry)}
              className="text-sm font-semibold text-slate-100 hover:text-red-400 cursor-pointer line-clamp-1 transition-colors"
              title={movie.title}
            >
              {movie.title}
            </h4>

            {/* Menu Trigger */}
            {canEdit && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setMenuOpen(!menuOpen)}
                  className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                >
                  <MoreVertical className="w-4 h-4" />
                </button>

                {menuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-20"
                      onClick={() => setMenuOpen(false)}
                    />
                    <div className="absolute right-0 top-full mt-1 w-44 rounded-xl bg-zinc-900 border border-zinc-700/80 shadow-xl z-30 py-1.5 text-xs text-zinc-200">
                      {onToggleStatus && (
                        <button
                          type="button"
                          onClick={() => {
                            setMenuOpen(false);
                            onToggleStatus(
                              entry.id,
                              status === 'WATCHED' ? 'TO_WATCH' : 'WATCHED'
                            );
                          }}
                          className="w-full px-3 py-2 text-left hover:bg-zinc-800 flex items-center gap-2"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          Mark {status === 'WATCHED' ? 'Unwatched' : 'Watched'}
                        </button>
                      )}

                      {onOpenNote && (
                        <button
                          type="button"
                          onClick={() => {
                            setMenuOpen(false);
                            onOpenNote(entry);
                          }}
                          className="w-full px-3 py-2 text-left hover:bg-zinc-800 flex items-center gap-2"
                        >
                          <StickyNote className="w-3.5 h-3.5 text-indigo-400" />
                          {note ? 'Edit Note' : 'Add Note'}
                        </button>
                      )}

                      {onOpenMove && (
                        <button
                          type="button"
                          onClick={() => {
                            setMenuOpen(false);
                            onOpenMove(entry);
                          }}
                          className="w-full px-3 py-2 text-left hover:bg-zinc-800 flex items-center gap-2"
                        >
                          <ArrowRightLeft className="w-3.5 h-3.5 text-amber-400" />
                          Move to Collection
                        </button>
                      )}

                      {onRemove && (
                        <button
                          type="button"
                          onClick={() => {
                            setMenuOpen(false);
                            onRemove(entry.id);
                          }}
                          className="w-full px-3 py-2 text-left hover:bg-red-500/10 text-red-400 flex items-center gap-2 border-t border-zinc-800 mt-1"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Remove Movie
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs text-zinc-400 mt-1">
            {movie.mediaType?.toLowerCase() === 'tv' ? (
              <span className="px-1.5 py-0.2 rounded bg-purple-500/15 border border-purple-500/30 text-[10px] font-bold text-purple-300">
                TV
              </span>
            ) : (
              <span className="px-1.5 py-0.2 rounded bg-sky-500/15 border border-sky-500/30 text-[10px] font-bold text-sky-300">
                Movie
              </span>
            )}
            <span>{movie.releaseYear || 'Unknown'}</span>
            {movie.genres && movie.genres.length > 0 && (
              <>
                <span>•</span>
                <span className="line-clamp-1">{movie.genres.slice(0, 2).join(', ')}</span>
              </>
            )}
          </div>

          {formattedWatchedDate && (
            <p className="text-[11px] text-zinc-500 mt-1.5 flex items-center gap-1">
              <span>Watched on {formattedWatchedDate}</span>
            </p>
          )}

          {note && (
            <p className="text-xs text-zinc-300/90 italic bg-zinc-900/60 rounded-lg p-2 mt-2 border border-zinc-800/60 line-clamp-2">
              "{note}"
            </p>
          )}
        </div>

        {/* Quick Toggle Button */}
        {canEdit && onToggleStatus && (
          <div className="pt-3 mt-3 border-t border-zinc-800/60">
            <button
              type="button"
              onClick={() =>
                onToggleStatus(
                  entry.id,
                  status === 'WATCHED' ? 'TO_WATCH' : 'WATCHED'
                )
              }
              className={`w-full py-1.5 px-3 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition-colors ${
                status === 'WATCHED'
                  ? 'bg-zinc-800/80 hover:bg-zinc-800 text-zinc-300'
                  : 'bg-emerald-600/15 hover:bg-emerald-600/25 text-emerald-400 border border-emerald-500/20'
              }`}
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              {status === 'WATCHED' ? 'Mark Unwatched' : 'Mark Watched'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
