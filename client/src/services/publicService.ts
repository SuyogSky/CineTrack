import { apiClient } from '../api/client';
import { ApiResponse, CollectionMovie } from '../types';

export interface PublicCollectionData {
  id: string;
  title: string;
  description?: string | null;
  ownerUsername: string;
  createdAt: string;
  movies: CollectionMovie[];
  totalMovies: number;
}

export const publicService = {
  async getPublicCollection(shareToken: string): Promise<PublicCollectionData> {
    const res = await apiClient.get<ApiResponse<{ collection: PublicCollectionData }>>(
      `/public/collections/${shareToken}`
    );
    return res.data.data!.collection;
  },
};
