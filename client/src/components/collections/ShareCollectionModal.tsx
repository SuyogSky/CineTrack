import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Globe, Copy, Check, Lock, Loader2, AlertCircle } from 'lucide-react';
import { Modal } from '../common/Modal';
import { collectionService } from '../../services/collectionService';
import { Collection } from '../../types';

interface ShareCollectionModalProps {
  collection: Collection;
  isOpen: boolean;
  onClose: () => void;
}

export const ShareCollectionModal: React.FC<ShareCollectionModalProps> = ({
  collection,
  isOpen,
  onClose,
}) => {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isPublic = collection.visibility === 'PUBLIC_LINK';
  const publicUrl = collection.shareToken
    ? `${window.location.origin}/c/${collection.shareToken}`
    : '';

  const enableMutation = useMutation({
    mutationFn: () => collectionService.enableSharing(collection.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collection', collection.id] });
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      setErrorMessage(null);
    },
    onError: (err: Error) => setErrorMessage(err.message),
  });

  const disableMutation = useMutation({
    mutationFn: () => collectionService.disableSharing(collection.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collection', collection.id] });
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      setErrorMessage(null);
    },
    onError: (err: Error) => setErrorMessage(err.message),
  });

  const handleCopy = async () => {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <Globe className="w-5 h-5 text-purple-400" />
          <span>Share Collection — Public View-Only Link</span>
        </div>
      }
      maxWidth="md"
    >
      <div className="space-y-4">
        {errorMessage && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-400 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {isPublic ? (
          <div className="space-y-4">
            <div className="p-4 rounded-xl bg-purple-500/10 border border-purple-500/25 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-purple-300">
                <Globe className="w-4 h-4" />
                <span>Public Link is Active</span>
              </div>
              <p className="text-xs text-zinc-400">
                Anyone with this link can view this collection and read notes, even without an account. Visitors cannot modify or delete anything.
              </p>
            </div>

            {/* URL Box */}
            <div className="flex items-center gap-2 p-2 rounded-xl bg-zinc-900 border border-zinc-800">
              <input
                type="text"
                readOnly
                value={publicUrl}
                className="flex-1 bg-transparent text-xs text-zinc-200 outline-none px-2 font-mono truncate"
              />
              <button
                type="button"
                onClick={handleCopy}
                className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-white flex items-center gap-1.5 transition-colors shrink-0"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy Link</span>
                  </>
                )}
              </button>
            </div>

            {/* Disable Link Action */}
            <div className="pt-2 flex justify-between items-center">
              <button
                type="button"
                disabled={disableMutation.isPending}
                onClick={() => disableMutation.mutate()}
                className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1.5 transition-colors"
              >
                {disableMutation.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Lock className="w-3.5 h-3.5" />
                )}
                Disable Public Link (Revoke Access)
              </button>

              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl bg-zinc-800 text-xs font-semibold text-zinc-300 hover:text-white"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
                <Lock className="w-4 h-4 text-zinc-400" />
                <span>Collection is currently Private</span>
              </div>
              <p className="text-xs text-zinc-400">
                Only you and invited collaborators can view this collection. Enable public link sharing to generate a view-only shareable URL.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={enableMutation.isPending}
                onClick={() => enableMutation.mutate()}
                className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
              >
                {enableMutation.isPending && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                )}
                Enable Public Sharing
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};
