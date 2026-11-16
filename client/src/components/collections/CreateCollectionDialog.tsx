import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderPlus, Loader2, AlertCircle } from 'lucide-react';
import { Modal } from '../common/Modal';
import { collectionService } from '../../services/collectionService';

interface CreateCollectionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (id: string) => void;
}

export const CreateCollectionDialog: React.FC<CreateCollectionDialogProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      collectionService.createCollection({
        title: title.trim(),
        description: description.trim() || null,
      }),
    onSuccess: (newCollection) => {
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      setTitle('');
      setDescription('');
      onClose();
      if (onSuccess) onSuccess(newCollection.id);
    },
    onError: (err: Error) => {
      setErrorMessage(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setErrorMessage('Collection title is required');
      return;
    }
    setErrorMessage(null);
    createMutation.mutate();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <FolderPlus className="w-5 h-5 text-red-500" />
          <span>Create New Collection</span>
        </div>
      }
      maxWidth="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {errorMessage && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-400 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        <div>
          <label className="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-1.5">
            Title *
          </label>
          <input
            type="text"
            required
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. 90s Cyberpunk, Studio Ghibli, Oscar Winners..."
            className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-sm text-slate-100 placeholder-zinc-500 focus:outline-none focus:border-red-500/80 transition-colors"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-1.5">
            Description (Optional)
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this collection for? Notes for yourself or collaborators..."
            rows={3}
            className="w-full p-3.5 rounded-xl bg-zinc-900 border border-zinc-800 text-sm text-slate-100 placeholder-zinc-500 focus:outline-none focus:border-red-500/80 transition-colors resize-none"
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-800">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createMutation.isPending || !title.trim()}
            className="px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
          >
            {createMutation.isPending && (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            )}
            Create Collection
          </button>
        </div>
      </form>
    </Modal>
  );
};
