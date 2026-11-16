import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types';
import { CollaborationService } from '../services/collaboration.service';
import { inviteCollaboratorSchema } from '../validators/collaboration.validator';
import { sendSuccess } from '../utils/response';

export class CollaborationController {
  static async invite(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const id = req.params.id as string;
      const input = inviteCollaboratorSchema.parse(req.body);
      const invitation = await CollaborationService.inviteCollaborator(
        id,
        req.user!.id,
        input
      );
      sendSuccess(res, { invitation }, 'Invitation sent successfully', 201);
    } catch (error) {
      next(error);
    }
  }

  static async listInvitations(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const invitations = await CollaborationService.listUserInvitations(req.user!.id);
      sendSuccess(res, { invitations });
    } catch (error) {
      next(error);
    }
  }

  static async accept(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const id = req.params.id as string;
      const invitation = await CollaborationService.acceptInvitation(id, req.user!.id);
      sendSuccess(res, { invitation }, 'Invitation accepted successfully');
    } catch (error) {
      next(error);
    }
  }

  static async decline(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const id = req.params.id as string;
      const invitation = await CollaborationService.declineInvitation(id, req.user!.id);
      sendSuccess(res, { invitation }, 'Invitation declined');
    } catch (error) {
      next(error);
    }
  }

  static async revoke(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const id = req.params.id as string;
      const invitation = await CollaborationService.revokeInvitation(id, req.user!.id);
      sendSuccess(res, { invitation }, 'Invitation revoked');
    } catch (error) {
      next(error);
    }
  }

  static async listMembers(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const id = req.params.id as string;
      const result = await CollaborationService.listMembers(id, req.user!.id);
      sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  }

  static async removeMember(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const id = req.params.id as string;
      const userId = req.params.userId as string;
      const result = await CollaborationService.removeMember(id, userId, req.user!.id);
      sendSuccess(res, result, 'Collaborator removed successfully');
    } catch (error) {
      next(error);
    }
  }
}
