import { apiClient } from '../api/client';
import { ApiResponse, Movie } from '../types';

export interface MovieSearchResult {
  items: Movie[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export const movieService = {
  async search(
    query: string,
    type: 'all' | 'movie' | 'tv' = 'all',
    page: number = 1
  ): Promise<MovieSearchResult> {
    const res = await apiClient.get<ApiResponse<MovieSearchResult>>('/movies/search', {
      params: { q: query, type, page },
    });
    return res.data.data!;
  },

  async getDetails(tmdbId: number, type: 'movie' | 'tv' = 'movie'): Promise<Movie> {
    const res = await apiClient.get<ApiResponse<{ movie: Movie }>>(`/movies/${tmdbId}`, {
      params: { type },
    });
    return res.data.data!.movie;
  },
};
