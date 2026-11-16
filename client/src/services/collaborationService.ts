import { apiClient } from '../api/client';
import { ApiResponse, CollaborationInvitation, CollectionMember } from '../types';

export const collaborationService = {
  async listInvitations(): Promise<CollaborationInvitation[]> {
    const res = await apiClient.get<ApiResponse<{ invitations: CollaborationInvitation[] }>>(
      '/invitations'
    );
    return res.data.data!.invitations;
  },

  async acceptInvitation(id: string): Promise<CollaborationInvitation> {
    const res = await apiClient.post<ApiResponse<{ invitation: CollaborationInvitation }>>(
      `/invitations/${id}/accept`
    );
    return res.data.data!.invitation;
  },

  async declineInvitation(id: string): Promise<CollaborationInvitation> {
    const res = await apiClient.post<ApiResponse<{ invitation: CollaborationInvitation }>>(
      `/invitations/${id}/decline`
    );
    return res.data.data!.invitation;
  },

  async revokeInvitation(id: string): Promise<CollaborationInvitation> {
    const res = await apiClient.delete<ApiResponse<{ invitation: CollaborationInvitation }>>(
      `/invitations/${id}`
    );
    return res.data.data!.invitation;
  },

  async listMembers(
    collectionId: string
  ): Promise<{
    owner: { id: string; username: string; email: string };
    members: CollectionMember[];
    pendingInvitations: CollaborationInvitation[];
  }> {
    const res = await apiClient.get<
      ApiResponse<{
        owner: { id: string; username: string; email: string };
        members: CollectionMember[];
        pendingInvitations: CollaborationInvitation[];
      }>
    >(`/collections/${collectionId}/members`);
    return res.data.data!;
  },

  async inviteCollaborator(
    collectionId: string,
    usernameOrEmail: string
  ): Promise<CollaborationInvitation> {
    const res = await apiClient.post<ApiResponse<{ invitation: CollaborationInvitation }>>(
      `/collections/${collectionId}/invitations`,
      { usernameOrEmail }
    );
    return res.data.data!.invitation;
  },

  async removeMember(
    collectionId: string,
    userId: string
  ): Promise<{ collectionId: string; userId: string; removed: boolean }> {
    const res = await apiClient.delete<
      ApiResponse<{ collectionId: string; userId: string; removed: boolean }>
    >(`/collections/${collectionId}/members/${userId}`);
    return res.data.data!;
  },
};
