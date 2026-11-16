import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Users,
  UserPlus,
  Crown,
  Trash2,
  Clock,
  Loader2,
  AlertCircle,
  Check,
} from 'lucide-react';
import { Modal } from '../common/Modal';
import { collaborationService } from '../../services/collaborationService';
import { Collection } from '../../types';

interface CollaboratorsModalProps {
  collection: Collection;
  isOpen: boolean;
  onClose: () => void;
  isOwner?: boolean;
}

export const CollaboratorsModal: React.FC<CollaboratorsModalProps> = ({
  collection,
  isOpen,
  onClose,
  isOwner = true,
}) => {
  const queryClient = useQueryClient();
  const [inviteInput, setInviteInput] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const { data: membersData, isLoading } = useQuery({
    queryKey: ['collectionMembers', collection.id],
    queryFn: () => collaborationService.listMembers(collection.id),
    enabled: isOpen,
  });

  const inviteMutation = useMutation({
    mutationFn: () =>
      collaborationService.inviteCollaborator(collection.id, inviteInput.trim()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collectionMembers', collection.id] });
      setInviteInput('');
      setErrorMessage(null);
      setSuccessMessage('Invitation sent successfully!');
      setTimeout(() => setSuccessMessage(null), 3000);
    },
    onError: (err: Error) => {
      setErrorMessage(err.message);
      setSuccessMessage(null);
    },
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) =>
      collaborationService.removeMember(collection.id, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collectionMembers', collection.id] });
      queryClient.invalidateQueries({ queryKey: ['collection', collection.id] });
      setErrorMessage(null);
    },
    onError: (err: Error) => setErrorMessage(err.message),
  });

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteInput.trim()) return;
    setErrorMessage(null);
    inviteMutation.mutate();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-indigo-400" />
          <span>Collaborators — {collection.title}</span>
        </div>
      }
      maxWidth="md"
    >
      <div className="space-y-5">
        {/* Invite Form (Owner only) */}
        {isOwner && (
          <form onSubmit={handleInvite} className="space-y-2">
            <label className="block text-xs font-semibold text-zinc-300 uppercase tracking-wider">
              Invite a Friend
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={inviteInput}
                onChange={(e) => {
                  setInviteInput(e.target.value);
                  setErrorMessage(null);
                }}
                placeholder="Enter registered username or email..."
                className="flex-1 px-3.5 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-xs sm:text-sm text-slate-100 placeholder-zinc-500 focus:outline-none focus:border-red-500/80 transition-colors"
              />
              <button
                type="submit"
                disabled={inviteMutation.isPending || !inviteInput.trim()}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors shrink-0 shadow-sm"
              >
                {inviteMutation.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <UserPlus className="w-3.5 h-3.5" />
                )}
                Send Invite
              </button>
            </div>
          </form>
        )}

        {errorMessage && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-400 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {successMessage && (
          <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-400 flex items-center gap-2">
            <Check className="w-4 h-4 shrink-0" />
            <span>{successMessage}</span>
          </div>
        )}

        {/* Current Members List */}
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Active Members
          </h4>

          {isLoading ? (
            <div className="py-6 flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-red-500" />
            </div>
          ) : (
            <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
              {/* Owner Item */}
              <div className="flex items-center justify-between p-2.5 rounded-xl bg-zinc-900/60 border border-zinc-800">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 font-semibold text-xs">
                    <Crown className="w-3.5 h-3.5" />
                  </div>
                  <div>
                    <span className="text-xs font-medium text-slate-100">
                      @{membersData?.owner.username}
                    </span>
                    <span className="text-[10px] text-zinc-500 block">Owner</span>
                  </div>
                </div>
              </div>

              {/* Members */}
              {membersData?.members.map((member) => (
                <div
                  key={member.id}
                  className="flex items-center justify-between p-2.5 rounded-xl bg-zinc-900/60 border border-zinc-800 hover:border-zinc-700/60 transition-colors"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-semibold text-xs">
                      {member.user.username[0].toUpperCase()}
                    </div>
                    <div>
                      <span className="text-xs font-medium text-slate-100">
                        @{member.user.username}
                      </span>
                      <span className="text-[10px] text-zinc-500 block">Collaborator</span>
                    </div>
                  </div>

                  {isOwner && (
                    <button
                      type="button"
                      disabled={removeMutation.isPending}
                      onClick={() => removeMutation.mutate(member.userId)}
                      className="p-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      title="Remove collaborator"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}

              {membersData?.members.length === 0 && (
                <p className="text-xs text-zinc-500 py-2 italic text-center">
                  No other collaborators yet. Invite someone above!
                </p>
              )}
            </div>
          )}
        </div>

        {/* Pending Invitations (Owner only) */}
        {isOwner && (membersData?.pendingInvitations.length || 0) > 0 && (
          <div className="space-y-2 pt-2 border-t border-zinc-800">
            <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-amber-400" />
              <span>Pending Invitations ({membersData?.pendingInvitations.length})</span>
            </h4>

            <div className="space-y-1 max-h-36 overflow-y-auto">
              {membersData?.pendingInvitations.map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between p-2 rounded-xl bg-zinc-900/40 border border-zinc-800/60 text-xs text-zinc-400"
                >
                  <span>@{inv.invitee.username}</span>
                  <span className="text-[10px] text-amber-400/90 font-medium bg-amber-500/10 px-2 py-0.5 rounded-md border border-amber-500/20">
                    Awaiting response
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end pt-2 border-t border-zinc-800">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-zinc-800 text-xs font-semibold text-zinc-300 hover:text-white"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
};
