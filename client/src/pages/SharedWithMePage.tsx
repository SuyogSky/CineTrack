import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users, Loader2, Sparkles, FolderKanban } from 'lucide-react';
import { collectionService } from '../services/collectionService';
import { CollectionCard } from '../components/collections/CollectionCard';
import { Link } from 'react-router-dom';

export const SharedWithMePage: React.FC = () => {
  const { data: collectionsData, isLoading } = useQuery({
    queryKey: ['collections'],
    queryFn: collectionService.listCollections,
  });

  const shared = collectionsData?.shared || [];

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="pb-6 border-b border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-600/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-slate-100">Shared With Me</h1>
            <p className="text-xs text-zinc-400 mt-0.5">
              Collections where you have been invited as a collaborator
            </p>
          </div>
        </div>

        <Link
          to="/invitations"
          className="text-xs font-semibold text-indigo-400 hover:text-indigo-300 transition-colors"
        >
          Check Pending Invitations →
        </Link>
      </div>

      {isLoading ? (
        <div className="py-20 flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-red-500" />
          <p className="text-xs text-zinc-400">Loading shared collections...</p>
        </div>
      ) : shared.length === 0 ? (
        <div className="py-20 rounded-2xl bg-[#121622] border border-zinc-800 text-center space-y-3 max-w-md mx-auto p-8">
          <div className="w-14 h-14 rounded-2xl bg-zinc-800 flex items-center justify-center mx-auto text-zinc-500">
            <Users className="w-7 h-7" />
          </div>
          <h3 className="text-base font-bold text-slate-100">
            No Shared Collections Yet
          </h3>
          <p className="text-xs text-zinc-400 leading-relaxed">
            When other CineTrack users invite you to collaborate on their movie collections, they will appear here.
          </p>
          <Link
            to="/invitations"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>View Pending Invitations</span>
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {shared.map((col) => (
            <CollectionCard key={col.id} collection={col} isSharedWithMe />
          ))}
        </div>
      )}
    </div>
  );
};
