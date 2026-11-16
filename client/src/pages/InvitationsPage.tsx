import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, Check, X, Film, FolderKanban, Loader2, Sparkles, CheckCircle2 } from 'lucide-react';
import { collaborationService } from '../services/collaborationService';
import { Link } from 'react-router-dom';

export const InvitationsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [successFeedback, setSuccessFeedback] = useState<string | null>(null);

  const { data: invitations, isLoading } = useQuery({
    queryKey: ['invitations'],
    queryFn: collaborationService.listInvitations,
  });

  const acceptMutation = useMutation({
    mutationFn: (id: string) => collaborationService.acceptInvitation(id),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['invitations'] });
      queryClient.invalidateQueries({ queryKey: ['collections'] });
      queryClient.invalidateQueries({ queryKey: ['authMe'] });
      setSuccessFeedback(`Accepted invitation to join "${data.collection?.title || 'collection'}"!`);
      setTimeout(() => setSuccessFeedback(null), 4000);
    },
  });

  const declineMutation = useMutation({
    mutationFn: (id: string) => collaborationService.declineInvitation(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invitations'] });
      setSuccessFeedback('Declined invitation.');
      setTimeout(() => setSuccessFeedback(null), 4000);
    },
  });

  const pendingList = invitations || [];

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="pb-6 border-b border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400">
            <Bell className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-slate-100">Collaboration Invitations</h1>
            <p className="text-xs text-zinc-400 mt-0.5">
              Review and respond to invitations from other CineTrack members
            </p>
          </div>
        </div>
      </div>

      {successFeedback && (
        <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-xs font-semibold text-emerald-400 flex items-center gap-2.5 animate-fade-in">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{successFeedback}</span>
        </div>
      )}

      {isLoading ? (
        <div className="py-20 flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-red-500" />
          <p className="text-xs text-zinc-400">Loading invitations...</p>
        </div>
      ) : pendingList.length === 0 ? (
        <div className="py-20 rounded-2xl bg-[#121622] border border-zinc-800 text-center space-y-3 max-w-md mx-auto p-8">
          <div className="w-14 h-14 rounded-2xl bg-zinc-800 flex items-center justify-center mx-auto text-zinc-500">
            <Bell className="w-7 h-7" />
          </div>
          <h3 className="text-base font-bold text-slate-100">No Pending Invitations</h3>
          <p className="text-xs text-zinc-400 leading-relaxed">
            You're all caught up! When a friend invites you to manage a collection together, it will show up here.
          </p>
          <Link
            to="/collections"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-semibold mt-2"
          >
            <FolderKanban className="w-3.5 h-3.5" />
            <span>Browse My Collections</span>
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {pendingList.map((inv) => (
            <div
              key={inv.id}
              className="p-5 rounded-2xl bg-[#121622] border border-zinc-800 hover:border-zinc-700 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-4"
            >
              <div className="space-y-1 max-w-md">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-indigo-400">
                    @{inv.inviter.username}
                  </span>
                  <span className="text-xs text-zinc-400">invited you to collaborate on:</span>
                </div>

                <h3 className="text-base font-bold text-slate-100">
                  {inv.collection.title}
                </h3>

                {inv.collection.description && (
                  <p className="text-xs text-zinc-400 line-clamp-1">
                    "{inv.collection.description}"
                  </p>
                )}

                <div className="text-[11px] text-zinc-500 flex items-center gap-1.5 pt-1">
                  <Film className="w-3 h-3 text-zinc-500" />
                  <span>{inv.collection._count?.movies || 0} movies in collection</span>
                  <span>•</span>
                  <span>Received {new Date(inv.createdAt).toLocaleDateString()}</span>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2.5 shrink-0 self-end sm:self-auto">
                <button
                  type="button"
                  disabled={declineMutation.isPending || acceptMutation.isPending}
                  onClick={() => declineMutation.mutate(inv.id)}
                  className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-zinc-300 hover:text-white flex items-center gap-1.5 transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                  <span>Decline</span>
                </button>

                <button
                  type="button"
                  disabled={acceptMutation.isPending || declineMutation.isPending}
                  onClick={() => acceptMutation.mutate(inv.id)}
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white flex items-center gap-1.5 transition-colors shadow-sm"
                >
                  {acceptMutation.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Check className="w-3.5 h-3.5" />
                  )}
                  <span>Accept Invitation</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
