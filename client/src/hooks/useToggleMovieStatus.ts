import { useMutation, useQueryClient } from '@tanstack/react-query';
import { collectionService } from '../services/collectionService';
import { Collection, DashboardStats, CollectionMovie } from '../types';

export interface ToggleMovieStatusArgs {
  collectionId: string;
  entryId: string;
  status: 'TO_WATCH' | 'WATCHED';
}

interface OptimisticContext {
  previousCollectionData?: Collection;
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
    mutationFn: ({ collectionId, entryId, status }) =>
      collectionService.updateMovie(collectionId, entryId, { status }),

    onMutate: async ({ collectionId, entryId, status }) => {
      // 1. Cancel in-flight queries so they don't overwrite optimistic updates
      await Promise.all([
        collectionId
          ? queryClient.cancelQueries({ queryKey: ['collection', collectionId] })
          : Promise.resolve(),
        queryClient.cancelQueries({ queryKey: ['defaultWatchlist'] }),
        queryClient.cancelQueries({ queryKey: ['dashboardStats'] }),
      ]);

      // 2. Snapshot previous values for rollback
      const previousCollectionData = collectionId
        ? queryClient.getQueryData<Collection>(['collection', collectionId])
        : undefined;
      const previousDefaultWatchlist = queryClient.getQueryData<Collection>(['defaultWatchlist']);
      const previousDashboardStats = queryClient.getQueryData<DashboardStats>(['dashboardStats']);

      const nowIso = new Date().toISOString();

      const updateCollectionMovies = (col: Collection | undefined): Collection | undefined => {
        if (!col || !col.movies) return col;
        return {
          ...col,
          movies: col.movies.map((m) =>
            m.id === entryId
              ? {
                  ...m,
                  status,
                  watchedAt: status === 'WATCHED' ? (m.watchedAt || nowIso) : null,
                }
              : m
          ),
        };
      };

      // 3. Optimistically update ['collection', collectionId]
      if (collectionId) {
        queryClient.setQueryData<Collection>(['collection', collectionId], updateCollectionMovies);
      }

      // 4. Optimistically update ['defaultWatchlist']
      queryClient.setQueryData<Collection>(['defaultWatchlist'], updateCollectionMovies);

      // 5. Optimistically update ['dashboardStats']
      if (previousDashboardStats) {
        queryClient.setQueryData<DashboardStats>(['dashboardStats'], (old) => {
          if (!old) return old;
          const delta = status === 'WATCHED' ? 1 : -1;
          return {
            ...old,
            totalToWatch: Math.max(0, old.totalToWatch - delta),
            totalWatched: Math.max(0, old.totalWatched + delta),
          };
        });
      }

      return {
        previousCollectionData,
        previousDefaultWatchlist,
        previousDashboardStats,
      };
    },

    onError: (err, variables, context) => {
      if (context?.previousCollectionData && variables.collectionId) {
        queryClient.setQueryData(['collection', variables.collectionId], context.previousCollectionData);
      }
      if (context?.previousDefaultWatchlist) {
        queryClient.setQueryData(['defaultWatchlist'], context.previousDefaultWatchlist);
      }
      if (context?.previousDashboardStats) {
        queryClient.setQueryData(['dashboardStats'], context.previousDashboardStats);
      }
      options?.onError?.(err, variables);
    },

    onSuccess: (data, variables) => {
      options?.onSuccess?.(data, variables);
    },

    onSettled: (_data, _err, variables) => {
      if (variables.collectionId) {
        queryClient.invalidateQueries({ queryKey: ['collection', variables.collectionId] });
      }
      queryClient.invalidateQueries({ queryKey: ['defaultWatchlist'] });
      queryClient.invalidateQueries({ queryKey: ['dashboardStats'] });
      queryClient.invalidateQueries({ queryKey: ['collections'] });
    },
  });
}
