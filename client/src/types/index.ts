export interface User {
  id: string;
  username: string;
  email: string;
  createdAt: string;
  updatedAt: string;
  collectionsCount?: number;
  pendingInvitationsCount?: number;
}

export type MediaType = 'movie' | 'tv';

export interface Movie {
  id: string;
  tmdbId: number;
  mediaType?: 'movie' | 'tv' | 'MOVIE' | 'TV';
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

export type WatchStatus = 'TO_WATCH' | 'WATCHED';

export interface CollectionMovie {
  id: string;
  collectionId: string;
  movieId: string;
  addedBy: string;
  status: WatchStatus;
  watchedAt?: string | null;
  note?: string | null;
  createdAt: string;
  updatedAt: string;
  movie: Movie;
  adder?: {
    id: string;
    username: string;
  };
}

export interface CollectionMember {
  id: string;
  collectionId: string;
  userId: string;
  role: 'MEMBER' | 'ADMIN';
  joinedAt: string;
  user: {
    id: string;
    username: string;
    email: string;
  };
}

export type CollectionVisibility = 'PRIVATE' | 'PUBLIC_LINK';

export interface Collection {
  id: string;
  ownerId: string;
  title: string;
  description?: string | null;
  visibility: CollectionVisibility;
  shareToken?: string | null;
  isDefaultWatchlist: boolean;
  createdAt: string;
  updatedAt: string;
  owner: {
    id: string;
    username: string;
  };
  members?: CollectionMember[];
  movies?: CollectionMovie[];
  _count?: {
    movies: number;
    members?: number;
  };
  userRole?: 'OWNER' | 'COLLABORATOR';
}

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'REVOKED';

export interface CollaborationInvitation {
  id: string;
  collectionId: string;
  inviterId: string;
  inviteeId: string;
  status: InvitationStatus;
  createdAt: string;
  respondedAt?: string | null;
  inviter: {
    id: string;
    username: string;
  };
  invitee: {
    id: string;
    username: string;
    email: string;
  };
  collection: {
    id: string;
    title: string;
    description?: string | null;
    _count?: {
      movies: number;
    };
  };
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  code?: string;
  errors?: unknown;
}

export interface DashboardStats {
  totalMovies: number;
  totalTvSeries: number;
  totalItems: number;
  totalToWatch: number;
  totalWatched: number;
  totalCollections: number;
  ownedCollectionsCount: number;
  sharedCollectionsCount: number;
}

export interface RouletteResult {
  entry: CollectionMovie | null;
  movie: Movie | null;
  sourceCollections: { id: string; title: string }[];
  allEntries?: {
    id: string;
    collectionId: string;
    collectionTitle: string;
    status: WatchStatus;
  }[];
}
