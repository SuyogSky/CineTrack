import { apiClient } from '../api/client';
import {
  ApiResponse,
  Collection,
  CollectionMovie,
  DashboardStats,
  MediaType,
  RouletteResult,
  WatchStatus,
} from '../types';

export const collectionService = {
  async getDashboardStats(): Promise<DashboardStats> {
    const res = await apiClient.get<ApiResponse<DashboardStats>>('/dashboard/stats');
    return res.data.data!;
  },

  async getDefaultWatchlist(): Promise<Collection> {
    const res = await apiClient.get<ApiResponse<{ collection: Collection }>>(
      '/collections/default-watchlist'
    );
    return res.data.data!.collection;
  },

  async listCollections(): Promise<{ owned: Collection[]; shared: Collection[] }> {
    const res = await apiClient.get<
      ApiResponse<{ owned: Collection[]; shared: Collection[] }>
    >('/collections');
    return res.data.data!;
  },

  async createCollection(data: {
    title: string;
    description?: string | null;
  }): Promise<Collection> {
    const res = await apiClient.post<ApiResponse<{ collection: Collection }>>(
      '/collections',
      data
    );
    return res.data.data!.collection;
  },

  async getCollection(id: string): Promise<Collection> {
    const res = await apiClient.get<ApiResponse<{ collection: Collection }>>(
      `/collections/${id}`
    );
    return res.data.data!.collection;
  },

  async updateCollection(
    id: string,
    data: { title?: string; description?: string | null }
  ): Promise<Collection> {
    const res = await apiClient.patch<ApiResponse<{ collection: Collection }>>(
      `/collections/${id}`,
      data
    );
    return res.data.data!.collection;
  },

  async deleteCollection(id: string): Promise<{ id: string; deleted: boolean }> {
    const res = await apiClient.delete<ApiResponse<{ id: string; deleted: boolean }>>(
      `/collections/${id}`
    );
    return res.data.data!;
  },

  async addMovie(
    collectionId: string,
    data: { tmdbId: number; mediaType?: MediaType; note?: string | null }
  ): Promise<CollectionMovie> {
    const res = await apiClient.post<ApiResponse<{ entry: CollectionMovie }>>(
      `/collections/${collectionId}/movies`,
      data
    );
    return res.data.data!.entry;
  },

  async updateMovie(
    collectionId: string,
    entryId: string,
    data: { status?: WatchStatus; note?: string | null }
  ): Promise<CollectionMovie> {
    const res = await apiClient.patch<ApiResponse<{ entry: CollectionMovie }>>(
      `/collections/${collectionId}/movies/${entryId}`,
      data
    );
    return res.data.data!.entry;
  },

  async removeMovie(
    collectionId: string,
    entryId: string
  ): Promise<{ id: string; deleted: boolean }> {
    const res = await apiClient.delete<ApiResponse<{ id: string; deleted: boolean }>>(
      `/collections/${collectionId}/movies/${entryId}`
    );
    return res.data.data!;
  },

  async moveMovie(
    collectionId: string,
    entryId: string,
    destinationCollectionId: string
  ): Promise<CollectionMovie> {
    const res = await apiClient.post<ApiResponse<{ entry: CollectionMovie }>>(
      `/collections/${collectionId}/movies/${entryId}/move`,
      { destinationCollectionId }
    );
    return res.data.data!.entry;
  },

  async getRandomMovie(collectionId: string): Promise<RouletteResult> {
    const res = await apiClient.get<ApiResponse<RouletteResult>>(
      `/collections/${collectionId}/random`
    );
    return res.data.data!;
  },

  async getMultiCollectionRoulette(
    collectionIds?: string[] | 'ALL',
    includeWatched: boolean = false
  ): Promise<RouletteResult> {
    const res = await apiClient.post<ApiResponse<RouletteResult>>(
      '/collections/roulette',
      { collectionIds, includeWatched }
    );
    return res.data.data!;
  },

  async enableSharing(
    collectionId: string
  ): Promise<{ id: string; visibility: string; shareToken: string }> {
    const res = await apiClient.post<
      ApiResponse<{ id: string; visibility: string; shareToken: string }>
    >(`/collections/${collectionId}/share`);
    return res.data.data!;
  },

  async disableSharing(
    collectionId: string
  ): Promise<{ id: string; visibility: string; shareToken: null }> {
    const res = await apiClient.delete<
      ApiResponse<{ id: string; visibility: string; shareToken: null }>
    >(`/collections/${collectionId}/share`);
    return res.data.data!;
  },
};
