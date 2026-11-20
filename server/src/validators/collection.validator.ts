import { z } from 'zod';

export const createCollectionSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Collection title is required')
    .max(100, 'Title cannot exceed 100 characters'),
  description: z
    .string()
    .trim()
    .max(500, 'Description cannot exceed 500 characters')
    .optional()
    .nullable(),
});

export const updateCollectionSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Collection title cannot be empty')
    .max(100, 'Title cannot exceed 100 characters')
    .optional(),
  description: z
    .string()
    .trim()
    .max(500, 'Description cannot exceed 500 characters')
    .optional()
    .nullable(),
});

export const updateCollectionMovieSchema = z.object({
  status: z.enum(['TO_WATCH', 'WATCHED']).optional(),
  note: z.string().trim().max(1000, 'Note cannot exceed 1000 characters').optional().nullable(),
});

export const addMovieToCollectionSchema = z.object({
  tmdbId: z.coerce.number().int().positive('Valid TMDb ID is required'),
  mediaType: z.enum(['movie', 'tv']).default('movie'),
  note: z.string().trim().max(1000, 'Note cannot exceed 1000 characters').optional().nullable(),
});

export const moveMovieSchema = z.object({
  destinationCollectionId: z.string().uuid('Valid destination collection ID is required'),
});

export const multiCollectionRouletteSchema = z.object({
  collectionIds: z
    .preprocess((val) => {
      if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed.toUpperCase() === 'ALL') return 'ALL';
        const parts = trimmed
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);
        return parts;
      }
      return val;
    }, z.union([
      z
        .array(z.string().uuid('Invalid collection ID format'))
        .min(1, 'At least one collection ID must be specified'),
      z.literal('ALL'),
    ]))
    .optional(),
  includeWatched: z
    .preprocess((val) => {
      if (typeof val === 'string') {
        const low = val.trim().toLowerCase();
        if (low === 'true' || low === '1') return true;
        if (low === 'false' || low === '0') return false;
      }
      return val;
    }, z.boolean())
    .default(false),
});

export type CreateCollectionInput = z.infer<typeof createCollectionSchema>;
export type UpdateCollectionInput = z.infer<typeof updateCollectionSchema>;
export type UpdateCollectionMovieInput = z.infer<typeof updateCollectionMovieSchema>;
export type AddMovieToCollectionInput = z.infer<typeof addMovieToCollectionSchema>;
export type MoveMovieInput = z.infer<typeof moveMovieSchema>;
export type MultiCollectionRouletteInput = z.infer<typeof multiCollectionRouletteSchema>;
