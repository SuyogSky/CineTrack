import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FolderKanban, Plus, Users, Loader2 } from 'lucide-react';
import { collectionService } from '../services/collectionService';
import { CollectionCard } from '../components/collections/CollectionCard';
import { CreateCollectionDialog } from '../components/collections/CreateCollectionDialog';

export const CollectionsListPage: React.FC = () => {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const { data: collectionsData, isLoading } = useQuery({
    queryKey: ['collections'],
    queryFn: collectionService.listCollections,
  });

  const owned = collectionsData?.owned || [];
  const shared = collectionsData?.shared || [];

  return (
    <div className="space-y-10">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-zinc-800">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-600/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
            <FolderKanban className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-slate-100">My Collections</h1>
            <p className="text-xs text-zinc-400 mt-0.5">
              Organize films into custom themes, marathons, and shared clubs
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setCreateDialogOpen(true)}
          className="px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold flex items-center gap-2 transition-all shadow-md shadow-red-950/40 hover:scale-105"
        >
          <Plus className="w-4 h-4" />
          <span>New Collection</span>
        </button>
      </div>

      {isLoading ? (
        <div className="py-20 flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-red-500" />
          <p className="text-xs text-zinc-400">Loading your collections...</p>
        </div>
      ) : (
        <div className="space-y-10">
          {/* Owned Collections Section */}
          <div className="space-y-4">
            <h2 className="text-sm font-bold text-zinc-300 uppercase tracking-wider">
              Collections Created by You ({owned.length})
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              {owned.map((col) => (
                <CollectionCard key={col.id} collection={col} />
              ))}
            </div>
          </div>

          {/* Shared With Me Section */}
          {shared.length > 0 && (
            <div className="space-y-4 pt-6 border-t border-zinc-800">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-indigo-400" />
                <h2 className="text-sm font-bold text-zinc-300 uppercase tracking-wider">
                  Shared With Me ({shared.length})
                </h2>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {shared.map((col) => (
                  <CollectionCard key={col.id} collection={col} isSharedWithMe />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <CreateCollectionDialog
        isOpen={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
      />
    </div>
  );
};
