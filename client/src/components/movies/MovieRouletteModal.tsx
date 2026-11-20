import React, { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dices,
  CheckCircle2,
  RotateCcw,
  Star,
  Film,
  Sparkles,
  Loader2,
  Tv,
  Filter,
  Check,
  AlertTriangle,
  Bookmark,
  Folder,
  Users,
} from 'lucide-react';
import { Modal } from '../common/Modal';
import { CustomCheckbox } from '../common/CustomCheckbox';
import { collectionService } from '../../services/collectionService';
import { Collection, Movie, RouletteResult } from '../../types';

interface MovieRouletteModalProps {
  isOpen: boolean;
  onClose: () => void;
  collectionId?: string;
  initialCollectionId?: string;
  collectionTitle?: string;
}

export const MovieRouletteModal: React.FC<MovieRouletteModalProps> = ({
  isOpen,
  onClose,
  collectionId,
  initialCollectionId,
  collectionTitle,
}) => {
  const effectiveColId = initialCollectionId || collectionId;
  const queryClient = useQueryClient();
  const pickerRef = useRef<HTMLDivElement>(null);
  const [rouletteResult, setRouletteResult] = useState<RouletteResult | null>(null);
  const [isSpinning, setIsSpinning] = useState(false);
  const [emptyMessage, setEmptyMessage] = useState<string | null>(null);
  const [isAllSelected, setIsAllSelected] = useState<boolean>(!effectiveColId);
  const [selectedIds, setSelectedIds] = useState<string[]>(
    effectiveColId ? [effectiveColId] : []
  );
  const [showCollectionPicker, setShowCollectionPicker] = useState(false);
  const [isWatchedSuccess, setIsWatchedSuccess] = useState(false);

  // Fetch all user collections (owned + shared)
  const { data: collectionsData } = useQuery({
    queryKey: ['collections'],
    queryFn: collectionService.listCollections,
    enabled: isOpen,
  });

  const { data: defaultWatchlist } = useQuery({
    queryKey: ['defaultWatchlist'],
    queryFn: collectionService.getDefaultWatchlist,
    enabled: isOpen,
  });

  // Combine accessible collections
  const allAccessibleCollections: Collection[] = React.useMemo(() => {
    const list: Collection[] = [];
    if (defaultWatchlist) {
      list.push(defaultWatchlist);
    }
    if (collectionsData?.owned) {
      for (const col of collectionsData.owned) {
        if (!list.some((c) => c.id === col.id)) {
          list.push(col);
        }
      }
    }
    if (collectionsData?.shared) {
      for (const col of collectionsData.shared) {
        if (!list.some((c) => c.id === col.id)) {
          list.push(col);
        }
      }
    }
    return list;
  }, [defaultWatchlist, collectionsData]);

  const isZeroSelected = !isAllSelected && selectedIds.length === 0;

  // Handle outside clicks to dismiss dropdown
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowCollectionPicker(false);
      }
    };
    if (showCollectionPicker) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showCollectionPicker]);

  // Handle Escape key to dismiss dropdown without closing modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showCollectionPicker) {
        e.stopPropagation();
        e.preventDefault();
        setShowCollectionPicker(false);
      }
    };
    if (showCollectionPicker) {
      window.addEventListener('keydown', handleKeyDown, true);
    }
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [showCollectionPicker]);

  // Mutation to fetch random movie from chosen collections
  const rouletteMutation = useMutation({
    mutationFn: (overrideTarget?: string[] | 'ALL') => {
      const targetIds = overrideTarget !== undefined ? overrideTarget : (isAllSelected ? 'ALL' : selectedIds);
      return collectionService.getMultiCollectionRoulette(targetIds, false);
    },
    onSuccess: (data) => {
      if (!data || !data.movie) {
        setRouletteResult(null);
        setEmptyMessage(
          'No unwatched titles found in the selected collection(s)! Try selecting more collections or adding unwatched titles.'
        );
      } else {
        setEmptyMessage(null);
        setRouletteResult(data);
      }
    },
    onError: (err: Error) => {
      setEmptyMessage(err.message || 'Failed to select a movie');
    },
  });

  // Mark as Watched mutation
  const markWatchedMutation = useMutation({
    mutationFn: async () => {
      if (!rouletteResult || !rouletteResult.entry) return;
      const targetEntries =
        rouletteResult.allEntries && rouletteResult.allEntries.length > 0
          ? rouletteResult.allEntries
          : [
              {
                id: rouletteResult.entry.id,
                collectionId: rouletteResult.entry.collectionId,
              },
            ];

      await Promise.all(
        targetEntries.map((e) =>
          collectionService.updateMovie(e.collectionId, e.id, { status: 'WATCHED' })
        )
      );
    },
    onSuccess: () => {
      setIsWatchedSuccess(true);
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      queryClient.invalidateQueries({ queryKey: ['defaultWatchlist'] });
      queryClient.invalidateQueries({ queryKey: ['collection'] });
      queryClient.invalidateQueries({ queryKey: ['dashboardStats'] });
    },
  });

  const spinRoulette = (overrideTarget?: string[] | 'ALL') => {
    const isTargetZero = overrideTarget !== undefined
      ? (overrideTarget !== 'ALL' && overrideTarget.length === 0)
      : isZeroSelected;
    if (isTargetZero) return;
    setIsSpinning(true);
    setEmptyMessage(null);
    setIsWatchedSuccess(false);

    setTimeout(() => {
      rouletteMutation.mutate(overrideTarget, {
        onSettled: () => {
          setIsSpinning(false);
        },
      });
    }, 650); // Cinematic spinning suspense delay
  };

  useEffect(() => {
    if (isOpen) {
      let initialTarget: string[] | 'ALL';
      if (effectiveColId) {
        setSelectedIds([effectiveColId]);
        setIsAllSelected(false);
        initialTarget = [effectiveColId];
      } else {
        setIsAllSelected(true);
        setSelectedIds([]);
        initialTarget = 'ALL';
      }
      spinRoulette(initialTarget);
    } else {
      setRouletteResult(null);
      setEmptyMessage(null);
      setShowCollectionPicker(false);
      setIsWatchedSuccess(false);
      setIsAllSelected(true);
      setSelectedIds([]);
    }
  }, [isOpen, effectiveColId]);

  const handleToggleAll = (nextChecked: boolean) => {
    if (nextChecked) {
      setIsAllSelected(true);
      setSelectedIds([]);
    } else {
      setIsAllSelected(false);
      setSelectedIds([]);
    }
  };

  const handleToggleCollection = (colId: string) => {
    if (isAllSelected) {
      // Uncheck this specific collection, keep the rest checked
      setIsAllSelected(false);
      const remaining = allAccessibleCollections
        .filter((c) => c.id !== colId)
        .map((c) => c.id);
      setSelectedIds(remaining);
    } else {
      if (selectedIds.includes(colId)) {
        // Uncheck
        const next = selectedIds.filter((id) => id !== colId);
        setSelectedIds(next);
      } else {
        // Check
        const next = [...selectedIds, colId];
        if (next.length >= allAccessibleCollections.length) {
          setIsAllSelected(true);
          setSelectedIds([]);
        } else {
          setSelectedIds(next);
        }
      }
    }
  };

  const movie = rouletteResult?.movie;
  const posterUrl = movie?.posterPath
    ? `https://image.tmdb.org/t/p/w500${movie.posterPath}`
    : null;
  const isTv = movie?.mediaType?.toLowerCase() === 'tv';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <Dices className="w-5 h-5 text-amber-400" />
          <span>Pick for Us — Movie Night Roulette</span>
        </div>
      }
      maxWidth="lg"
    >
      <div className="space-y-5">
        {/* Collection Pool Selector Bar */}
        <div
          ref={pickerRef}
          className="p-3 rounded-2xl bg-zinc-900/90 border border-zinc-800 flex flex-col gap-2"
        >
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 text-zinc-300">
              <Filter className="w-3.5 h-3.5 text-amber-400" />
              <span className="font-semibold">Candidate Pool:</span>
              <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 font-bold">
                {isAllSelected
                  ? `All Collections (${allAccessibleCollections.length})`
                  : isZeroSelected
                  ? '0 Collections Selected'
                  : `${selectedIds.length} Collection${
                      selectedIds.length > 1 ? 's' : ''
                    } Selected`}
              </span>
            </div>

            <button
              type="button"
              data-testid="roulette-toggle-picker-button"
              onClick={() => setShowCollectionPicker(!showCollectionPicker)}
              className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white font-medium transition-colors min-h-[36px]"
            >
              {showCollectionPicker ? 'Hide Options' : 'Customize Pool'}
            </button>
          </div>

          {/* Collapsible Collection Selection Drawer */}
          {showCollectionPicker && (
            <div
              className="pt-2 border-t border-zinc-800 space-y-2 max-h-56 overflow-y-auto pr-1 animate-in fade-in duration-150"
              onClick={(e) => e.stopPropagation()}
            >
              <CustomCheckbox
                dataTestId="roulette-all-collections-checkbox"
                checked={isAllSelected}
                onChange={handleToggleAll}
                label="✨ All Accessible Collections (Master Pool)"
                description="Include all default, custom, and collaborated collections"
              />

              {allAccessibleCollections.map((col) => {
                const isChecked = isAllSelected || selectedIds.includes(col.id);
                return (
                  <CustomCheckbox
                    key={col.id}
                    dataTestId={`roulette-collection-checkbox-${col.id}`}
                    checked={isChecked}
                    onChange={() => handleToggleCollection(col.id)}
                    label={
                      <span className="flex items-center gap-1.5 truncate">
                        {col.isDefaultWatchlist ? (
                          <Bookmark className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        ) : col.userRole === 'COLLABORATOR' ? (
                          <Users className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                        ) : (
                          <Folder className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                        )}
                        <span className="truncate">{col.title}</span>
                        {col.isDefaultWatchlist && (
                          <span className="text-[10px] text-zinc-500 font-normal shrink-0">
                            (Default)
                          </span>
                        )}
                      </span>
                    }
                  />
                );
              })}

              <button
                type="button"
                data-testid="roulette-picker-done-button"
                onClick={() => setShowCollectionPicker(false)}
                className="w-full mt-2 py-2 px-3 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 text-amber-300 font-semibold text-xs transition-colors"
              >
                Done Customizing
              </button>
            </div>
          )}
        </div>

        {/* Validation Alert for 0 Collections */}
        {isZeroSelected && (
          <div
            data-testid="roulette-zero-validation-message"
            className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-center gap-2"
          >
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
            <span>Please select at least one collection to roll.</span>
          </div>
        )}

        {/* Animated Spin / Loading State */}
        {isSpinning && (
          <div className="py-16 flex flex-col items-center justify-center gap-4 text-center">
            <div className="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center animate-spin">
              <Dices className="w-8 h-8 text-amber-400" />
            </div>
            <div>
              <h4 className="text-base font-semibold text-slate-100">
                Finding the Perfect Title...
              </h4>
              <p className="text-xs text-zinc-400 mt-1">
                Picking randomly across your selected collections
              </p>
            </div>
          </div>
        )}

        {/* Empty Collection State */}
        {!isSpinning && emptyMessage && (
          <div className="py-12 px-4 text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center mx-auto text-zinc-500">
              <Film className="w-6 h-6" />
            </div>
            <h4 className="text-sm font-semibold text-slate-200">
              {emptyMessage}
            </h4>
            <div className="flex justify-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => handleToggleAll(true)}
                className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold transition-colors"
              >
                Switch to All Collections
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl bg-zinc-800 text-xs font-semibold text-zinc-300 hover:text-white"
              >
                Close
              </button>
            </div>
          </div>
        )}

        {/* Selected Media Reveal */}
        {!isSpinning && rouletteResult && movie && (
          <div className="space-y-4 text-center">
            <div className="relative mx-auto w-44 aspect-[2/3] rounded-2xl overflow-hidden shadow-2xl shadow-amber-950/40 border-2 border-amber-500/50">
              {posterUrl ? (
                <img
                  src={posterUrl}
                  alt={movie.title}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center p-4 bg-zinc-900 text-zinc-600">
                  {isTv ? <Tv className="w-10 h-10 mb-2" /> : <Film className="w-10 h-10 mb-2" />}
                  <span className="text-xs text-zinc-400">{movie.title}</span>
                </div>
              )}
            </div>

            <div>
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400 text-xs font-semibold mb-2">
                <Sparkles className="w-3.5 h-3.5" />
                TONIGHT'S PICK
              </div>

              <div className="flex items-center justify-center gap-2">
                <h3 className="text-xl font-bold text-slate-100">
                  {movie.title}
                </h3>
                {isTv ? (
                  <span className="px-1.5 py-0.5 rounded bg-purple-500/15 border border-purple-500/30 text-[10px] font-bold text-purple-300">
                    TV
                  </span>
                ) : (
                  <span className="px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 text-[10px] font-bold text-sky-300">
                    Movie
                  </span>
                )}
              </div>

              <div className="flex items-center justify-center gap-2 text-xs text-zinc-400 mt-1">
                <span>{movie.releaseYear || 'Unknown Year'}</span>
                {movie.voteAverage != null && movie.voteAverage > 0 && (
                  <>
                    <span>•</span>
                    <span className="flex items-center gap-1 text-amber-400 font-semibold">
                      <Star className="w-3 h-3 fill-amber-400" />
                      {movie.voteAverage.toFixed(1)}
                    </span>
                  </>
                )}
                {movie.genres && movie.genres.length > 0 && (
                  <>
                    <span>•</span>
                    <span>{movie.genres.slice(0, 2).join(', ')}</span>
                  </>
                )}
              </div>

              {/* Source Collections Pill */}
              {rouletteResult.sourceCollections && rouletteResult.sourceCollections.length > 0 && (
                <div className="mt-2.5 flex items-center justify-center flex-wrap gap-1.5 text-[11px] text-zinc-400">
                  <span className="text-zinc-500">Found in:</span>
                  {rouletteResult.sourceCollections.map((col) => (
                    <span
                      key={col.id}
                      className="px-2 py-0.5 rounded-md bg-zinc-800 border border-zinc-700/80 text-zinc-300 font-medium"
                    >
                      {col.title}
                    </span>
                  ))}
                </div>
              )}

              {movie.overview && (
                <p className="text-xs text-zinc-400 line-clamp-3 mt-3 px-4 leading-relaxed">
                  {movie.overview}
                </p>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                type="button"
                data-testid="roulette-roll-again"
                disabled={isSpinning || isZeroSelected}
                onClick={() => spinRoulette()}
                className="px-4 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-200 text-xs font-semibold flex items-center gap-2 transition-colors min-h-[44px]"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Pick Again</span>
                <span className="sr-only">Roll Again</span>
              </button>

              {!isWatchedSuccess ? (
                <button
                  type="button"
                  disabled={markWatchedMutation.isPending}
                  onClick={() => markWatchedMutation.mutate()}
                  className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-2 transition-colors shadow-lg shadow-emerald-950/40"
                >
                  {markWatchedMutation.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  )}
                  Mark as Watched
                </button>
              ) : (
                <span className="px-4 py-2.5 rounded-xl bg-emerald-500/20 text-emerald-400 text-xs font-semibold flex items-center gap-1.5 border border-emerald-500/30">
                  <Check className="w-3.5 h-3.5" />
                  Marked as Watched!
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};
