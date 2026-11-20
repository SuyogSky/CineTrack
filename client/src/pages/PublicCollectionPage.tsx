import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Film,
  Globe,
  Star,
  CheckCircle2,
  Clock,
  StickyNote,
  Loader2,
  Calendar,
  AlertCircle,
  Sparkles,
} from 'lucide-react';
import { publicService } from '../services/publicService';
import { Badge } from '../components/common/Badge';
import { CollectionMovie } from '../types';

export const PublicCollectionPage: React.FC = () => {
  const { shareToken } = useParams<{ shareToken: string }>();
  const [selectedMovie, setSelectedMovie] = useState<CollectionMovie | null>(null);

  const {
    data: collection,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['publicCollection', shareToken],
    queryFn: () => publicService.getPublicCollection(shareToken!),
    enabled: !!shareToken,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0b0d13] flex flex-col items-center justify-center gap-3 text-slate-100">
        <Loader2 className="w-8 h-8 animate-spin text-purple-500" />
        <p className="text-xs text-zinc-400">Loading shared collection...</p>
      </div>
    );
  }

  if (isError || !collection) {
    return (
      <div className="min-h-screen bg-[#0b0d13] flex flex-col items-center justify-center p-6 text-center text-slate-100">
        <div className="w-16 h-16 rounded-2xl bg-zinc-800/80 border border-zinc-700/60 flex items-center justify-center mx-auto text-zinc-500 mb-4">
          <AlertCircle className="w-8 h-8 text-red-400" />
        </div>
        <h2 className="text-2xl font-bold">Collection Not Found or Link Expired</h2>
        <p className="text-xs sm:text-sm text-zinc-400 max-w-md mt-2">
          This shared collection link is invalid, private, or the owner has disabled public access.
        </p>
        <Link
          to="/"
          className="mt-6 px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold"
        >
          Explore CineTrack
        </Link>
      </div>
    );
  }

  const movies = collection.movies || [];

  return (
    <div className="min-h-screen bg-[#0b0d13] text-slate-100 flex flex-col">
      {/* Public Top Navbar */}
      <header className="border-b border-zinc-800/80 bg-[#0b0d13]/90 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-red-600 to-rose-700 flex items-center justify-center shadow-lg shadow-red-950/60">
              <Film className="w-4 h-4 text-white" />
            </div>
            <span className="text-lg font-bold tracking-tight text-white">
              Cine<span className="text-red-500">Track</span>
            </span>
          </Link>

          <div className="flex items-center gap-3">
            <span className="hidden sm:inline-block text-xs text-zinc-400">
              Curate your own movies
            </span>
            <Link
              to="/register"
              className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold shadow-md shadow-red-950/40"
            >
              Join CineTrack Free
            </Link>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* Collection Hero Header */}
        <div className="p-6 sm:p-8 rounded-3xl bg-gradient-to-r from-[#121622] via-[#141a29] to-[#121622] border border-zinc-800 shadow-2xl space-y-4">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-500/15 border border-purple-500/30 text-purple-300 text-xs font-semibold">
            <Globe className="w-3.5 h-3.5" />
            <span>Shared Public Collection</span>
          </div>

          <h1 className="text-2xl sm:text-4xl font-extrabold tracking-tight text-white">
            {collection.title}
          </h1>

          {collection.description && (
            <p className="text-xs sm:text-sm text-zinc-300 max-w-3xl leading-relaxed">
              {collection.description}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-400 pt-2 border-t border-zinc-800/80">
            <span>
              Curated by <strong className="text-slate-200">@{collection.ownerUsername}</strong>
            </span>
            <span>•</span>
            <span>{collection.totalMovies} {collection.totalMovies === 1 ? 'Movie' : 'Movies'}</span>
            <span>•</span>
            <span className="text-zinc-500">View-only mode</span>
          </div>
        </div>

        {/* Movies Grid */}
        <div className="space-y-4">
          <h2 className="text-sm font-bold text-zinc-300 uppercase tracking-wider">
            Featured Films ({movies.length})
          </h2>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {movies.map((entry) => {
              const movie = entry.movie;
              const posterUrl = movie.posterPath
                ? `https://image.tmdb.org/t/p/w500${movie.posterPath}`
                : null;

              return (
                <div
                  key={entry.id}
                  onClick={() => setSelectedMovie(entry)}
                  className="group relative flex flex-col rounded-2xl bg-[#121622] border border-zinc-800/80 hover:border-zinc-700 transition-all duration-200 overflow-hidden shadow-lg hover:shadow-2xl cursor-pointer"
                >
                  <div className="relative aspect-[2/3] w-full bg-zinc-900 overflow-hidden">
                    {posterUrl ? (
                      <img
                        src={posterUrl}
                        alt={movie.title}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center p-3 text-zinc-600 bg-zinc-900">
                        <Film className="w-10 h-10 mb-1" />
                        <span className="text-[10px] text-zinc-400 text-center">{movie.title}</span>
                      </div>
                    )}

                    {movie.voteAverage != null && movie.voteAverage > 0 && (
                      <div className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded-md bg-black/75 backdrop-blur-md border border-zinc-700/50 flex items-center gap-1 text-xs font-semibold text-amber-400">
                        <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                        <span>{movie.voteAverage.toFixed(1)}</span>
                      </div>
                    )}

                    <div className="absolute top-2.5 right-2.5">
                      {entry.status === 'WATCHED' ? (
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
                  </div>

                  <div className="p-3 flex-1 flex flex-col justify-between">
                    <div>
                      <h4 className="text-xs sm:text-sm font-semibold text-slate-100 group-hover:text-red-400 line-clamp-1 transition-colors">
                        {movie.title}
                      </h4>
                      <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 mt-0.5">
                        <span>{movie.releaseYear || 'Unknown'}</span>
                        {movie.genres && movie.genres.length > 0 && (
                          <>
                            <span>•</span>
                            <span className="truncate">{movie.genres.slice(0, 2).join(', ')}</span>
                          </>
                        )}
                      </div>
                    </div>

                    {entry.note && (
                      <p className="text-[11px] text-zinc-400 italic bg-zinc-900/80 rounded-lg p-2 mt-2 border border-zinc-800 line-clamp-2">
                        "{entry.note}"
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </main>

      {/* Movie Details Modal (View Only) */}
      {selectedMovie && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          onClick={() => setSelectedMovie(null)}
        >
          <div
            className="relative w-full max-w-2xl rounded-2xl bg-[#121620] border border-zinc-800 shadow-2xl p-6 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col sm:flex-row gap-5 items-start">
              <div className="w-28 sm:w-36 aspect-[2/3] rounded-xl overflow-hidden bg-zinc-800 shrink-0">
                {selectedMovie.movie.posterPath ? (
                  <img
                    src={`https://image.tmdb.org/t/p/w500${selectedMovie.movie.posterPath}`}
                    alt={selectedMovie.movie.title}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-zinc-900 text-zinc-600">
                    <Film className="w-8 h-8" />
                  </div>
                )}
              </div>

              <div className="flex-1 space-y-2">
                <h3 className="text-xl font-bold text-slate-100">
                  {selectedMovie.movie.title}
                </h3>

                <div className="flex items-center gap-2 text-xs text-zinc-400">
                  <span>{selectedMovie.movie.releaseYear || 'Unknown'}</span>
                  {selectedMovie.movie.voteAverage != null && selectedMovie.movie.voteAverage > 0 && (
                    <span className="flex items-center gap-1 text-amber-400 font-semibold">
                      <Star className="w-3 h-3 fill-amber-400" />
                      {selectedMovie.movie.voteAverage.toFixed(1)} / 10
                    </span>
                  )}
                </div>

                {selectedMovie.movie.genres && selectedMovie.movie.genres.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-1">
                    {selectedMovie.movie.genres.map((g) => (
                      <span
                        key={g}
                        className="px-2 py-0.5 rounded text-[11px] bg-zinc-800 text-zinc-300"
                      >
                        {g}
                      </span>
                    ))}
                  </div>
                )}

                {selectedMovie.movie.overview && (
                  <p className="text-xs text-zinc-300 leading-relaxed pt-2">
                    {selectedMovie.movie.overview}
                  </p>
                )}

                {selectedMovie.note && (
                  <div className="p-3 rounded-xl bg-zinc-900/80 border border-zinc-800 text-xs text-zinc-300 italic mt-2">
                    Curator note: "{selectedMovie.note}"
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end pt-4 mt-4 border-t border-zinc-800">
              <button
                type="button"
                onClick={() => setSelectedMovie(null)}
                className="px-4 py-2 rounded-xl bg-zinc-800 text-xs font-semibold text-white"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-zinc-800 bg-[#080a0f] py-8 text-center text-xs text-zinc-500 mt-auto">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Film className="w-4 h-4 text-red-500" />
            <span className="font-semibold text-zinc-400">CineTrack</span>
            <span>— The Modern Movie Watchlist & Collection Manager</span>
          </div>
          <Link
            to="/register"
            className="text-red-400 hover:text-red-300 font-semibold flex items-center gap-1"
          >
            <span>Create your free watchlist today</span>
          </Link>
        </div>
      </footer>
    </div>
  );
};
