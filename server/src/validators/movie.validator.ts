import { z } from 'zod';

export const movieSearchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(1, 'Search query cannot be empty')
    .max(100, 'Search query too long'),
  page: z.coerce.number().int().min(1).default(1),
  type: z.enum(['all', 'movie', 'tv']).default('all'),
});

export const addMovieToCollectionSchema = z.object({
  tmdbId: z.coerce.number().int().positive('Valid TMDb ID is required'),
  mediaType: z.enum(['movie', 'tv']).default('movie'),
  note: z.string().trim().max(1000, 'Note cannot exceed 1000 characters').optional().nullable(),
});

export type MovieSearchQuery = z.infer<typeof movieSearchQuerySchema>;
export type AddMovieToCollectionInput = z.infer<typeof addMovieToCollectionSchema>;
