import { prisma } from '../config/database';
import { CollectionService } from './collection.service';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../utils/errors';
import { InviteCollaboratorInput } from '../validators/collaboration.validator';

export class CollaborationService {
  static async inviteCollaborator(
    collectionId: string,
    inviterId: string,
    input: InviteCollaboratorInput
  ) {
    const { role, collection } = await CollectionService.checkCollectionAccess(
      collectionId,
      inviterId
    );

    if (role !== 'OWNER') {
      throw new ForbiddenError('Only the collection owner can invite collaborators');
    }

    const identifier = input.usernameOrEmail.trim();
    const isEmail = identifier.includes('@');

    const invitee = await prisma.user.findFirst({
      where: isEmail
        ? { email: identifier.toLowerCase() }
        : { username: { equals: identifier, mode: 'insensitive' } },
    });

    if (!invitee) {
      throw new NotFoundError('User not found. They must register first.');
    }

    if (invitee.id === inviterId) {
      throw new ConflictError('You cannot invite yourself');
    }

    // Check if already a member
    const existingMember = await prisma.collectionMember.findUnique({
      where: {
        collectionId_userId: {
          collectionId,
          userId: invitee.id,
        },
      },
    });

    if (existingMember) {
      throw new ConflictError('This user is already a collaborator on this collection');
    }

    // Check existing pending invitation
    const pendingInvitation = await prisma.collaborationInvitation.findFirst({
      where: {
        collectionId,
        inviteeId: invitee.id,
        status: 'PENDING',
      },
    });

    if (pendingInvitation) {
      throw new ConflictError('A pending invitation has already been sent to this user');
    }

    return prisma.collaborationInvitation.create({
      data: {
        collectionId,
        inviterId,
        inviteeId: invitee.id,
        status: 'PENDING',
      },
      include: {
        invitee: { select: { id: true, username: true, email: true } },
        collection: { select: { id: true, title: true } },
      },
    });
  }

  static async listUserInvitations(userId: string) {
    return prisma.collaborationInvitation.findMany({
      where: {
        inviteeId: userId,
        status: 'PENDING',
      },
      include: {
        inviter: { select: { id: true, username: true } },
        collection: {
          select: {
            id: true,
            title: true,
            description: true,
            _count: { select: { movies: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  static async acceptInvitation(invitationId: string, userId: string) {
    const invitation = await prisma.collaborationInvitation.findUnique({
      where: { id: invitationId },
      include: { collection: true },
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }

    if (invitation.inviteeId !== userId) {
      throw new ForbiddenError('You can only accept invitations addressed to you');
    }

    if (invitation.status !== 'PENDING') {
      throw new ConflictError(`This invitation has already been ${invitation.status.toLowerCase()}`);
    }

    // Accept transactionally
    return prisma.$transaction(async (tx) => {
      const updated = await tx.collaborationInvitation.update({
        where: { id: invitationId },
        data: {
          status: 'ACCEPTED',
          respondedAt: new Date(),
        },
      });

      // Check if already member
      const existing = await tx.collectionMember.findUnique({
        where: {
          collectionId_userId: {
            collectionId: invitation.collectionId,
            userId,
          },
        },
      });

      if (!existing) {
        await tx.collectionMember.create({
          data: {
            collectionId: invitation.collectionId,
            userId,
            role: 'MEMBER',
          },
        });
      }

      return updated;
    });
  }

  static async declineInvitation(invitationId: string, userId: string) {
    const invitation = await prisma.collaborationInvitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }

    if (invitation.inviteeId !== userId) {
      throw new ForbiddenError('You can only decline invitations addressed to you');
    }

    if (invitation.status !== 'PENDING') {
      throw new ConflictError(`This invitation has already been ${invitation.status.toLowerCase()}`);
    }

    return prisma.collaborationInvitation.update({
      where: { id: invitationId },
      data: {
        status: 'DECLINED',
        respondedAt: new Date(),
      },
    });
  }

  static async revokeInvitation(invitationId: string, userId: string) {
    const invitation = await prisma.collaborationInvitation.findUnique({
      where: { id: invitationId },
      include: { collection: true },
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }

    if (invitation.collection.ownerId !== userId && invitation.inviterId !== userId) {
      throw new ForbiddenError('Only the collection owner can revoke this invitation');
    }

    return prisma.collaborationInvitation.update({
      where: { id: invitationId },
      data: {
        status: 'REVOKED',
        respondedAt: new Date(),
      },
    });
  }

  static async listMembers(collectionId: string, userId: string) {
    const { role, collection } = await CollectionService.checkCollectionAccess(
      collectionId,
      userId
    );

    if (role === 'NONE') {
      throw new ForbiddenError('You do not have access to this collection');
    }

    const members = await prisma.collectionMember.findMany({
      where: { collectionId },
      include: {
        user: { select: { id: true, username: true, email: true } },
      },
      orderBy: { joinedAt: 'asc' },
    });

    const pendingInvitations =
      role === 'OWNER'
        ? await prisma.collaborationInvitation.findMany({
            where: { collectionId, status: 'PENDING' },
            include: {
              invitee: { select: { id: true, username: true, email: true } },
            },
          })
        : [];

    return {
      owner: collection.owner,
      members,
      pendingInvitations,
    };
  }

  static async removeMember(collectionId: string, targetUserId: string, requesterId: string) {
    const { role, collection } = await CollectionService.checkCollectionAccess(
      collectionId,
      requesterId
    );

    if (role !== 'OWNER') {
      throw new ForbiddenError('Only the collection owner can remove collaborators');
    }

    if (targetUserId === collection.ownerId) {
      throw new ForbiddenError('Cannot remove the owner of the collection');
    }

    const member = await prisma.collectionMember.findUnique({
      where: {
        collectionId_userId: {
          collectionId,
          userId: targetUserId,
        },
      },
    });

    if (!member) {
      throw new NotFoundError('Collaborator not found in this collection');
    }

    await prisma.collectionMember.delete({
      where: { id: member.id },
    });

    return { collectionId, userId: targetUserId, removed: true };
  }
}
