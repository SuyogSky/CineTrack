
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { collectionService } from '../services/collectionService';
import { Collection, DashboardStats, CollectionMovie } from '../types';

export interface ToggleMovieStatusArgs {
  collectionId: string;
  entryId: string;
  movieId: string;
  previousStatus: 'TO_WATCH' | 'WATCHED';
  status: 'TO_WATCH' | 'WATCHED';
}

interface OptimisticContext {
  previousCollections: Array<[QueryKey, Collection | undefined]>;
  previousDefaultWatchlist?: Collection;
  previousDashboardStats?: DashboardStats;
}

export function useToggleMovieStatus(options?: {
  onSuccess?: (data: CollectionMovie, variables: ToggleMovieStatusArgs) => void;
  onError?: (error: Error, variables: ToggleMovieStatusArgs) => void;
}) {
  const queryClient = useQueryClient();

  return useMutation<
    CollectionMovie,
    Error,
    ToggleMovieStatusArgs,
    OptimisticContext
  >({
    mutationFn: ({ collectionId, entryId, status }) => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        throw new Error(
          'You are offline. Your watched status was not saved.'
        );
      }

      return collectionService.updateMovie(collectionId, entryId, { status });
    },

    onMutate: async ({ movieId, previousStatus, status }) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ['collection'] }),
        queryClient.cancelQueries({ queryKey: ['defaultWatchlist'] }),
        queryClient.cancelQueries({ queryKey: ['dashboardStats'] }),
      ]);

      // Save every cached collection so failed requests can roll back safely.
      const previousCollections =
        queryClient.getQueriesData<Collection>({
          queryKey: ['collection'],
        });

      const previousDefaultWatchlist =
        queryClient.getQueryData<Collection>(['defaultWatchlist']);

      const previousDashboardStats =
        queryClient.getQueryData<DashboardStats>(['dashboardStats']);

      const now = new Date().toISOString();

      const updateCollection = (
        collection: Collection | undefined
      ): Collection | undefined => {
        if (!collection?.movies) return collection;

        return {
          ...collection,
          movies: collection.movies.map((entry) =>
            entry.movieId === movieId
              ? {
                  ...entry,
                  status,
                  watchedAt:
                    status === 'WATCHED'
                      ? entry.watchedAt || now
                      : null,
                }
              : entry
          ),
        };
      };

      // Update all cached collection-detail queries.
      for (const [queryKey] of previousCollections) {
        queryClient.setQueryData<Collection>(
          queryKey,
          updateCollection
        );
      }

      // Update the default watchlist if it contains this movie.
      queryClient.setQueryData<Collection>(
        ['defaultWatchlist'],
        updateCollection
      );

      // Update dashboard counts only when the status actually changes.
      if (previousDashboardStats && previousStatus !== status) {
        const watchedDelta = status === 'WATCHED' ? 1 : -1;

        queryClient.setQueryData<DashboardStats>(
          ['dashboardStats'],
          (old) => {
            if (!old) return old;

            return {
              ...old,
              totalWatched: Math.max(
                0,
                old.totalWatched + watchedDelta
              ),
              totalToWatch: Math.max(
                0,
                old.totalToWatch - watchedDelta
              ),
            };
          }
        );
      }

      return {
        previousCollections,
        previousDefaultWatchlist,
        previousDashboardStats,
      };
    },

    onError: (error, variables, context) => {
      // Restore all collection caches.
      context?.previousCollections.forEach(([queryKey, data]) => {
        if (data) {
          queryClient.setQueryData(queryKey, data);
        }
      });

      if (context?.previousDefaultWatchlist) {
        queryClient.setQueryData(
          ['defaultWatchlist'],
          context.previousDefaultWatchlist
        );
      }

      if (context?.previousDashboardStats) {
        queryClient.setQueryData(
          ['dashboardStats'],
          context.previousDashboardStats
        );
      }

      options?.onError?.(error, variables);
    },

    onSuccess: (data, variables) => {
      options?.onSuccess?.(data, variables);
    },

    onSettled: () => {
      // Reconcile optimistic state with the database-backed server response.
      queryClient.invalidateQueries({ queryKey: ['collection'] });
      queryClient.invalidateQueries({ queryKey: ['defaultWatchlist'] });
      queryClient.invalidateQueries({ queryKey: ['dashboardStats'] });
      queryClient.invalidateQueries({ queryKey: ['collections'] });
    },
  });
}
