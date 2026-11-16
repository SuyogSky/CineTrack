import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, FolderKanban, Loader2, AlertCircle } from 'lucide-react';
import { Modal } from '../common/Modal';
import { collectionService } from '../../services/collectionService';
import { CollectionMovie } from '../../types';

interface MoveMovieDialogProps {
  entry: CollectionMovie | null;
  isOpen: boolean;
  onClose: () => void;
}

export const MoveMovieDialog: React.FC<MoveMovieDialogProps> = ({
  entry,
  isOpen,
  onClose,
}) => {
  const queryClient = useQueryClient();
  const [selectedDestinationId, setSelectedDestinationId] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { data: collectionsData, isLoading } = useQuery({
    queryKey: ['collections'],
    queryFn: collectionService.listCollections,
    enabled: isOpen,
  });

  const availableCollections = [
    ...(collectionsData?.owned || []),
    ...(collectionsData?.shared || []),
  ].filter((c) => c.id !== entry?.collectionId);

  // Set default selection
  React.useEffect(() => {
    if (availableCollections.length > 0 && !selectedDestinationId) {
      setSelectedDestinationId(availableCollections[0].id);
    }
  }, [availableCollections, selectedDestinationId]);

  const moveMutation = useMutation({
    mutationFn: () => {
      if (!entry || !selectedDestinationId) throw new Error('Missing selection');
      return collectionService.moveMovie(
        entry.collectionId,
        entry.id,
        selectedDestinationId
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collection'] });
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      queryClient.invalidateQueries({ queryKey: ['defaultWatchlist'] });
      onClose();
    },
    onError: (error: Error) => {
      setErrorMessage(error.message);
    },
  });

  if (!entry) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <ArrowRightLeft className="w-5 h-5 text-amber-400" />
          <span>Move Movie to Another Collection</span>
        </div>
      }
      maxWidth="md"
    >
      <div className="space-y-4">
        <p className="text-xs text-zinc-400">
          Transfer <span className="font-semibold text-slate-200">"{entry.movie.title}"</span> along with its watch status and personal note to another collection.
        </p>

        {errorMessage && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-400 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {isLoading ? (
          <div className="py-6 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-red-500" />
          </div>
        ) : availableCollections.length === 0 ? (
          <div className="py-6 text-center text-xs text-zinc-500">
            You don't have any other collections. Create a custom collection first!
          </div>
        ) : (
          <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
            {availableCollections.map((col) => {
              const isSelected = selectedDestinationId === col.id;
              return (
                <div
                  key={col.id}
                  onClick={() => setSelectedDestinationId(col.id)}
                  className={`p-3 rounded-xl border cursor-pointer flex items-center justify-between text-xs transition-colors ${
                    isSelected
                      ? 'bg-amber-500/10 border-amber-500/40 text-amber-300'
                      : 'bg-zinc-900/60 border-zinc-800 text-zinc-300 hover:bg-zinc-800/60'
                  }`}
                >
                  <div className="flex items-center gap-2.5 truncate">
                    <FolderKanban className="w-4 h-4 text-zinc-400 shrink-0" />
                    <span className="font-medium truncate">{col.title}</span>
                  </div>
                  <span className="text-[11px] text-zinc-500 shrink-0">
                    {col._count?.movies || 0} films
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-800">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={moveMutation.isPending || !selectedDestinationId}
            onClick={() => moveMutation.mutate()}
            className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
          >
            {moveMutation.isPending && (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            )}
            Move Movie
          </button>
        </div>
      </div>
    </Modal>
  );
};
