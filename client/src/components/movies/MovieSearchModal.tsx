import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Film, Plus, Check, Loader2, Star, Tv, Bookmark, Folder, Users } from 'lucide-react';
import { Modal } from '../common/Modal';
import { CustomSelect, SelectOption } from '../common/CustomSelect';
import { movieService } from '../../services/movieService';
import { collectionService } from '../../services/collectionService';
import { MediaType, Movie } from '../../types';

interface MovieSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  targetCollectionId?: string;
  onMovieAdded?: () => void;
}

export const MovieSearchModal: React.FC<MovieSearchModalProps> = ({
  isOpen,
  onClose,
  targetCollectionId,
  onMovieAdded,
}) => {
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedType, setSelectedType] = useState<'all' | 'movie' | 'tv'>('all');
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>(
    targetCollectionId || ''
  );
  const [addedMovieIds, setAddedMovieIds] = useState<Set<string>>(new Set());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Fetch collections for collection dropdown if targetCollectionId isn't provided
  const { data: collectionsData } = useQuery({
    queryKey: ['collections'],
    queryFn: collectionService.listCollections,
    enabled: isOpen,
  });

  // Watchlist query for default collection ID
  const { data: defaultWatchlist } = useQuery({
    queryKey: ['defaultWatchlist'],
    queryFn: collectionService.getDefaultWatchlist,
    enabled: isOpen,
  });

  const activeColId = selectedCollectionId || defaultWatchlist?.id;

  // Query active collection movies so existing collection items show as already added
  const { data: activeCollection } = useQuery({
    queryKey: ['collection', activeColId],
    queryFn: () => collectionService.getCollection(activeColId!),
    enabled: isOpen && !!activeColId && activeColId !== defaultWatchlist?.id,
  });

  const currentCollectionMovies = React.useMemo(() => {
    if (activeColId && defaultWatchlist && activeColId === defaultWatchlist.id) {
      return defaultWatchlist.movies || [];
    }
    return activeCollection?.movies || [];
  }, [activeColId, defaultWatchlist, activeCollection]);

  useEffect(() => {
    if (targetCollectionId) {
      setSelectedCollectionId(targetCollectionId);
    } else if (defaultWatchlist?.id) {
      setSelectedCollectionId(defaultWatchlist.id);
    }
  }, [targetCollectionId, defaultWatchlist]);

  // Reset temporary search state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setSearchTerm('');
      setDebouncedQuery('');
      setAddedMovieIds(new Set());
      setErrorMessage(null);
    }
  }, [isOpen]);

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchTerm.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Query TMDb search API
  const {
    data: searchResults,
    isLoading: isSearching,
  } = useQuery({
    queryKey: ['movieSearch', debouncedQuery, selectedType],
    queryFn: () => movieService.search(debouncedQuery, selectedType),
    enabled: isOpen && debouncedQuery.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  // Add movie mutation
  const addMutation = useMutation({
    mutationFn: ({
      colId,
      tmdbId,
      mediaType,
    }: {
      colId: string;
      tmdbId: number;
      mediaType?: MediaType;
    }) => collectionService.addMovie(colId, { tmdbId, mediaType }),
    onSuccess: (_, variables) => {
      const typeKey = (variables.mediaType || 'movie').toLowerCase();
      const key = `${variables.colId}:${typeKey}:${variables.tmdbId}`;
      setAddedMovieIds((prev) => new Set([...prev, key]));
      queryClient.invalidateQueries({ queryKey: ['collection', variables.colId] });
      queryClient.invalidateQueries({ queryKey: ['defaultWatchlist'] });
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      queryClient.invalidateQueries({ queryKey: ['dashboardStats'] });
      if (onMovieAdded) onMovieAdded();
    },
    onError: (error: Error) => {
      setErrorMessage(error.message);
    },
  });

  const handleAdd = (movie: Movie) => {
    const colId = selectedCollectionId || defaultWatchlist?.id;
    if (!colId) {
      setErrorMessage('Please select a collection first');
      return;
    }
    setErrorMessage(null);
    const mediaType: MediaType =
      movie.mediaType?.toLowerCase() === 'tv' ? 'tv' : 'movie';
    addMutation.mutate({ colId, tmdbId: movie.tmdbId, mediaType });
  };

  const allCollections = [
    ...(collectionsData?.owned || []),
    ...(collectionsData?.shared || []),
  ];

  const collectionOptions: SelectOption[] = React.useMemo(() => {
    const opts: SelectOption[] = [];
    if (defaultWatchlist) {
      opts.push({
        value: defaultWatchlist.id,
        label: `${defaultWatchlist.title} (Default)`,
        icon: <Bookmark className="w-3.5 h-3.5 text-amber-400" />,
        badge: 'Default',
      });
    }
    const custom = allCollections.filter((c) => c.id !== defaultWatchlist?.id);
    for (const c of custom) {
      opts.push({
        value: c.id,
        label: c.title,
        icon:
          c.userRole === 'COLLABORATOR' ? (
            <Users className="w-3.5 h-3.5 text-sky-400" />
          ) : (
            <Folder className="w-3.5 h-3.5 text-indigo-400" />
          ),
        badge: c.userRole === 'COLLABORATOR' ? 'Shared' : undefined,
      });
    }
    return opts;
  }, [defaultWatchlist, allCollections]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <Film className="w-5 h-5 text-red-500" />
          <span>Search & Add Movies</span>
        </div>
      }
      maxWidth="2xl"
    >
      <div className="space-y-4">
        {/* Collection Selector & Search Input */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
            <input
              type="text"
              autoFocus
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setErrorMessage(null);
              }}
              placeholder="Search by title (e.g. Inception, Loki, Dune)..."
              className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-sm text-slate-100 placeholder-zinc-500 focus:outline-none focus:border-red-500/80 transition-colors"
            />
          </div>

          {/* Collection destination dropdown */}
          <CustomSelect
            options={collectionOptions}
            value={selectedCollectionId}
            onChange={(val) => setSelectedCollectionId(val)}
            dataTestId="search-collection-select"
            className="w-full sm:w-64 shrink-0"
          />
        </div>

        {/* Media Type Segmented Filter */}
        <div className="flex items-center gap-2 p-1 rounded-xl bg-zinc-900/90 border border-zinc-800/80 w-fit">
          <button
            type="button"
            onClick={() => setSelectedType('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              selectedType === 'all'
                ? 'bg-red-600 text-white shadow-sm'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            All Media
          </button>
          <button
            type="button"
            onClick={() => setSelectedType('movie')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              selectedType === 'movie'
                ? 'bg-red-600 text-white shadow-sm'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Film className="w-3.5 h-3.5" />
            <span>Movies</span>
          </button>
          <button
            type="button"
            onClick={() => setSelectedType('tv')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              selectedType === 'tv'
                ? 'bg-purple-600 text-white shadow-sm'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Tv className="w-3.5 h-3.5" />
            <span>TV Series</span>
          </button>
        </div>

        {errorMessage && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-400">
            {errorMessage}
          </div>
        )}

        {/* Search Results Container */}
        <div className="max-h-[52vh] overflow-y-auto space-y-2.5 pr-1">
          {isSearching && (
            <div className="py-12 flex flex-col items-center justify-center gap-2 text-zinc-400">
              <Loader2 className="w-6 h-6 animate-spin text-red-500" />
              <p className="text-xs">Searching TMDb movie and TV database...</p>
            </div>
          )}

          {!isSearching && debouncedQuery && searchResults?.items.length === 0 && (
            <div className="py-12 text-center text-zinc-500 text-sm">
              No results found matching "{debouncedQuery}". Try another title!
            </div>
          )}

          {!debouncedQuery && !isSearching && (
            <div className="py-12 text-center text-zinc-500 text-xs">
              Type a title to search millions of movies and TV series via TMDb.
            </div>
          )}

          {searchResults?.items.map((movie) => {
            const rawType = movie.mediaType?.toLowerCase() === 'tv' ? 'tv' : 'movie';
            const addKey = `${activeColId}:${rawType}:${movie.tmdbId}`;
            const isAlreadyInTarget = currentCollectionMovies.some(
              (m) =>
                m.movie.tmdbId === movie.tmdbId &&
                (m.movie.mediaType || 'movie').toLowerCase() === rawType
            );
            const isAdded = isAlreadyInTarget || addedMovieIds.has(addKey);
            const isPending =
              addMutation.isPending &&
              addMutation.variables?.tmdbId === movie.tmdbId;
            const posterUrl = movie.posterPath
              ? `https://image.tmdb.org/t/p/w185${movie.posterPath}`
              : null;
            const isTv = rawType === 'tv';

            return (
              <div
                key={`${rawType}-${movie.tmdbId}`}
                className="flex items-center gap-3.5 p-2.5 rounded-xl bg-zinc-900/60 hover:bg-zinc-800/60 border border-zinc-800/80 transition-colors"
              >
                {/* Poster */}
                <div className="w-12 h-16 rounded-lg bg-zinc-800 overflow-hidden shrink-0 flex items-center justify-center">
                  {posterUrl ? (
                    <img
                      src={posterUrl}
                      alt={movie.title}
                      className="w-full h-full object-cover"
                    />
                  ) : isTv ? (
                    <Tv className="w-6 h-6 text-zinc-600" />
                  ) : (
                    <Film className="w-6 h-6 text-zinc-600" />
                  )}
                </div>

                {/* Details */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-semibold text-slate-100 truncate">
                      {movie.title}
                    </h4>
                    {isTv ? (
                      <span className="px-1.5 py-0.5 rounded bg-purple-500/15 border border-purple-500/30 text-[10px] font-bold text-purple-300 shrink-0">
                        TV
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 text-[10px] font-bold text-sky-300 shrink-0">
                        Movie
                      </span>
                    )}
                    {movie.releaseYear && (
                      <span className="text-xs text-zinc-400">
                        ({movie.releaseYear})
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 mt-1 text-xs text-zinc-400">
                    {movie.voteAverage != null && movie.voteAverage > 0 && (
                      <span className="flex items-center gap-1 text-amber-400 font-medium">
                        <Star className="w-3 h-3 fill-amber-400" />
                        {movie.voteAverage.toFixed(1)}
                      </span>
                    )}
                    {movie.genres && movie.genres.length > 0 && (
                      <span className="truncate">
                        • {movie.genres.slice(0, 3).join(', ')}
                      </span>
                    )}
                  </div>

                  {movie.overview && (
                    <p className="text-xs text-zinc-500 line-clamp-1 mt-1">
                      {movie.overview}
                    </p>
                  )}
                </div>

                {/* Add Action Button */}
                <button
                  type="button"
                  data-testid="modal-add-button"
                  disabled={isAdded || isPending}
                  onClick={() => handleAdd(movie)}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors shrink-0 ${
                    isAdded
                      ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                      : 'bg-red-600 hover:bg-red-700 text-white shadow-sm'
                  }`}
                >
                  {isPending ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : isAdded ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      Added
                    </>
                  ) : (
                    <>
                      <Plus className="w-3.5 h-3.5" />
                      Add
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
};
