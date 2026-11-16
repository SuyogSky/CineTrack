import { Request, Response, NextFunction } from 'express';
import { CollectionService } from '../services/collection.service';
import { sendSuccess } from '../utils/response';

export class PublicController {
  static async getPublicCollection(req: Request, res: Response, next: NextFunction) {
    try {
      const shareToken = req.params.shareToken as string;
      const collection = await CollectionService.getPublicCollectionByToken(shareToken);
      sendSuccess(res, { collection });
    } catch (error) {
      next(error);
    }
  }
}
