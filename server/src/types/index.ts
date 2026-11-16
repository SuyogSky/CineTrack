import { Request } from 'express';

export interface AuthUserPayload {
  id: string;
  username: string;
  email: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUserPayload;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  code?: string;
  errors?: unknown;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export type MediaType = 'movie' | 'tv';

export interface NormalizedMovie {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  originalTitle?: string | null;
  overview?: string | null;
  posterPath?: string | null;
  backdropPath?: string | null;
  releaseDate?: string | null;
  releaseYear?: number | null;
  originalLanguage?: string | null;
  popularity?: number | null;
  voteAverage?: number | null;
  genres: string[];
}
