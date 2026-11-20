import axios from 'axios';
import { env } from '../config/env';
import { MediaType, NormalizedMovie, PaginatedResult } from '../types';
import { BadGatewayError, ServiceUnavailableError } from '../utils/errors';

interface TmdbSearchItemResult {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  original_language?: string;
  popularity?: number;
  vote_average?: number;
  genre_ids?: number[];
}

interface TmdbDetailsResult {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  original_language?: string;
  popularity?: number;
  vote_average?: number;
  genres?: { id: number; name: string }[];
}

// Known TMDb Genre Map for Movies and TV
const GENRE_MAP: Record<number, string> = {
  // Movie genres
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Science Fiction',
  10770: 'TV Movie',
  53: 'Thriller',
  10752: 'War',
  37: 'Western',
  // TV specific genres
  10759: 'Action & Adventure',
  10762: 'Kids',
  10763: 'News',
  10764: 'Reality',
  10765: 'Sci-Fi & Fantasy',
  10766: 'Soap',
  10767: 'Talk',
  10768: 'War & Politics',
};

// Curated catalog fallback for offline / test / no API key scenarios
const CURATED_MEDIA: NormalizedMovie[] = [
  // Curated Movies
  {
    tmdbId: 27205,
    mediaType: 'movie',
    title: 'Inception',
    originalTitle: 'Inception',
    overview: 'Cobb, a skilled thief who commits corporate espionage by infiltrating the subconscious of his targets, is offered a chance to regain his old life as payment for a task considered to be impossible: "inception", the implantation of another person\'s idea into a target\'s subconscious.',
    posterPath: '/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg',
    backdropPath: '/8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg',
    releaseDate: '2010-07-15',
    releaseYear: 2010,
    originalLanguage: 'en',
    popularity: 85.4,
    voteAverage: 8.4,
    genres: ['Action', 'Science Fiction', 'Adventure'],
  },
  {
    tmdbId: 157336,
    mediaType: 'movie',
    title: 'Interstellar',
    originalTitle: 'Interstellar',
    overview: 'The adventures of a group of explorers who make use of a newly discovered wormhole to surpass the limitations on human space travel and conquer the vast distances involved in an interstellar voyage.',
    posterPath: '/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg',
    backdropPath: '/xJHokMbljvjADYdit5fK5VQsXEG.jpg',
    releaseDate: '2014-11-05',
    releaseYear: 2014,
    originalLanguage: 'en',
    popularity: 92.1,
    voteAverage: 8.4,
    genres: ['Adventure', 'Drama', 'Science Fiction'],
  },
  {
    tmdbId: 155,
    mediaType: 'movie',
    title: 'The Dark Knight',
    originalTitle: 'The Dark Knight',
    overview: 'Batman raises the stakes in his war on crime. With the help of Lt. Jim Gordon and District Attorney Harvey Dent, Batman sets out to dismantle the remaining criminal organizations that plague the streets.',
    posterPath: '/qJ2tW6WMUDux911r6m7haRef0WH.jpg',
    backdropPath: '/nMKdUUepR0i5zn0y1T4CsSB5chy.jpg',
    releaseDate: '2008-07-16',
    releaseYear: 2008,
    originalLanguage: 'en',
    popularity: 98.7,
    voteAverage: 8.5,
    genres: ['Drama', 'Action', 'Crime', 'Thriller'],
  },
  {
    tmdbId: 680,
    mediaType: 'movie',
    title: 'Pulp Fiction',
    originalTitle: 'Pulp Fiction',
    overview: 'A burger-loving hit man, his philosophical partner, a drug-addled gangster\'s moll and a washed-up boxer converge in this sprawling, comedic crime caper.',
    posterPath: '/d5iIlFn5s0ImszYzBPb8JPIfbXD.jpg',
    backdropPath: '/suaEOtk1N1sgg2MTM7oZd2cfVp3.jpg',
    releaseDate: '1994-09-10',
    releaseYear: 1994,
    originalLanguage: 'en',
    popularity: 78.3,
    voteAverage: 8.5,
    genres: ['Thriller', 'Crime'],
  },
  {
    tmdbId: 603,
    mediaType: 'movie',
    title: 'The Matrix',
    originalTitle: 'The Matrix',
    overview: 'Set in the 22nd century, The Matrix tells the story of a computer hacker who joins a group of underground insurgents fighting the vast and powerful computers who now rule the earth.',
    posterPath: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
    backdropPath: '/7u3DUTMhvBvr93eq494jU44n995.jpg',
    releaseDate: '1999-03-30',
    releaseYear: 1999,
    originalLanguage: 'en',
    popularity: 76.5,
    voteAverage: 8.2,
    genres: ['Action', 'Science Fiction'],
  },
  {
    tmdbId: 496243,
    mediaType: 'movie',
    title: 'Parasite',
    originalTitle: '기생충',
    overview: 'All unemployed, Ki-taek\'s family takes peculiar interest in the wealthy and glamorous Parks for their livelihood until they get entangled in an unexpected incident.',
    posterPath: '/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg',
    backdropPath: '/hiKmpZMGZsrkA3cdce8a7Dpos1j.jpg',
    releaseDate: '2019-05-30',
    releaseYear: 2019,
    originalLanguage: 'ko',
    popularity: 64.9,
    voteAverage: 8.5,
    genres: ['Comedy', 'Thriller', 'Drama'],
  },
  {
    tmdbId: 438631,
    mediaType: 'movie',
    title: 'Dune',
    originalTitle: 'Dune',
    overview: 'Paul Atreides, a brilliant and gifted young man born into a great destiny beyond his understanding, must travel to the most dangerous planet in the universe.',
    posterPath: '/d5NXSklXo0qyIYkgV94XAgMIckC.jpg',
    backdropPath: '/jYEW5xZkZk2WTrdbMGAPFuBqbDc.jpg',
    releaseDate: '2021-09-15',
    releaseYear: 2021,
    originalLanguage: 'en',
    popularity: 88.2,
    voteAverage: 7.8,
    genres: ['Science Fiction', 'Adventure'],
  },
  {
    tmdbId: 129,
    mediaType: 'movie',
    title: 'Spirited Away',
    originalTitle: '千と千尋の神隠し',
    overview: 'A young girl, Chihiro, becomes trapped in a strange new world of spirits. When her parents undergo a mysterious transformation, she must call upon the courage she never knew she had.',
    posterPath: '/39wmItIWsg5sZMyRUHLkWBcuVCM.jpg',
    backdropPath: '/bXNvzjYEsnEnPnXkd2Nbe09Y7Fh.jpg',
    releaseDate: '2001-07-20',
    releaseYear: 2001,
    originalLanguage: 'ja',
    popularity: 72.8,
    voteAverage: 8.5,
    genres: ['Animation', 'Family', 'Fantasy'],
  },

  // Curated TV Series
  {
    tmdbId: 84958,
    mediaType: 'tv',
    title: 'Loki',
    originalTitle: 'Loki',
    overview: 'The mercurial villain Loki resumes his role as the God of Mischief in a new series that takes place after the events of “Avengers: Endgame.”',
    posterPath: '/voHUmlviYlo5sgFLMQCRBPWqNx4.jpg',
    backdropPath: '/57vVugvjQ2rV4g0w5v5z2m1pT1Z.jpg',
    releaseDate: '2021-06-09',
    releaseYear: 2021,
    originalLanguage: 'en',
    popularity: 94.6,
    voteAverage: 8.2,
    genres: ['Sci-Fi & Fantasy', 'Action & Adventure', 'Drama'],
  },
  {
    tmdbId: 85271,
    mediaType: 'tv',
    title: 'WandaVision',
    originalTitle: 'WandaVision',
    overview: 'Wanda Maximoff and Vision—two super-powered beings living idealized suburban lives—begin to suspect that everything is not as it seems.',
    posterPath: '/glKDVTyp9t6bSlvdT1huNx297Yn.jpg',
    backdropPath: '/1RR5uv8zxicirHp0H5eEcxjD3nC.jpg',
    releaseDate: '2021-01-15',
    releaseYear: 2021,
    originalLanguage: 'en',
    popularity: 86.3,
    voteAverage: 8.3,
    genres: ['Sci-Fi & Fantasy', 'Mystery', 'Drama'],
  },
  {
    tmdbId: 84332,
    mediaType: 'tv',
    title: 'Kurukshetra',
    originalTitle: 'Kurukshetra',
    overview: 'An epic television depiction of the monumental Kurukshetra war from Indian mythology, exploring honor, duty, fate, and complex familial conflict.',
    posterPath: null,
    backdropPath: null,
    releaseDate: '2008-01-01',
    releaseYear: 2008,
    originalLanguage: 'hi',
    popularity: 62.1,
    voteAverage: 8.0,
    genres: ['Drama', 'War & Politics', 'Action & Adventure'],
  },
];

// In-memory cache with 1-hour TTL
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry<unknown>>();

function getFromCache<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setToCache<T>(key: string, data: T, ttlMs: number = 60 * 60 * 1000): void {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

export class TmdbService {
  private static normalizeItem(
    item: TmdbSearchItemResult,
    defaultType: MediaType = 'movie'
  ): NormalizedMovie {
    const rawType = item.media_type || defaultType;
    const mediaType: MediaType = rawType === 'tv' ? 'tv' : 'movie';

    const title = mediaType === 'tv' ? item.name || item.title || 'Untitled' : item.title || item.name || 'Untitled';
    const originalTitle = mediaType === 'tv' ? item.original_name || item.original_title : item.original_title || item.original_name;
    const rawDate = mediaType === 'tv' ? item.first_air_date || item.release_date : item.release_date || item.first_air_date;

    const releaseYear = rawDate ? parseInt(rawDate.substring(0, 4), 10) || null : null;

    const genres = (item.genre_ids || [])
      .map((id) => GENRE_MAP[id])
      .filter((g): g is string => Boolean(g));

    return {
      tmdbId: item.id,
      mediaType,
      title,
      originalTitle: originalTitle || null,
      overview: item.overview || null,
      posterPath: item.poster_path || null,
      backdropPath: item.backdrop_path || null,
      releaseDate: rawDate || null,
      releaseYear,
      originalLanguage: item.original_language || null,
      popularity: item.popularity ?? null,
      voteAverage: item.vote_average ?? null,
      genres,
    };
  }

  private static normalizeDetails(
    item: TmdbDetailsResult,
    mediaType: MediaType
  ): NormalizedMovie {
    const title = mediaType === 'tv' ? item.name || item.title || 'Untitled' : item.title || item.name || 'Untitled';
    const originalTitle = mediaType === 'tv' ? item.original_name || item.original_title : item.original_title || item.original_name;
    const rawDate = mediaType === 'tv' ? item.first_air_date || item.release_date : item.release_date || item.first_air_date;

    const releaseYear = rawDate ? parseInt(rawDate.substring(0, 4), 10) || null : null;
    const genres = (item.genres || []).map((g) => g.name);

    return {
      tmdbId: item.id,
      mediaType,
      title,
      originalTitle: originalTitle || null,
      overview: item.overview || null,
      posterPath: item.poster_path || null,
      backdropPath: item.backdrop_path || null,
      releaseDate: rawDate || null,
      releaseYear,
      originalLanguage: item.original_language || null,
      popularity: item.popularity ?? null,
      voteAverage: item.vote_average ?? null,
      genres,
    };
  }

  static async search(
    query: string,
    type: 'all' | 'movie' | 'tv' = 'all',
    page: number = 1
  ): Promise<PaginatedResult<NormalizedMovie>> {
    const trimmed = query.trim();
    if (!trimmed) {
      return { items: [], total: 0, page: 1, limit: 20, totalPages: 0 };
    }

    const cacheKey = `search:${type}:${trimmed.toLowerCase()}:${page}`;
    const cached = getFromCache<PaginatedResult<NormalizedMovie>>(cacheKey);
    if (cached) return cached;

    // Offline / fallback when no API key is provided
    if (!env.TMDB_API_KEY) {
      if (env.NODE_ENV === 'production') {
        throw new ServiceUnavailableError('TMDb service is unconfigured in production');
      }
      const qLower = trimmed.toLowerCase();
      let matched = CURATED_MEDIA.filter(
        (m) =>
          m.title.toLowerCase().includes(qLower) ||
          (m.overview && m.overview.toLowerCase().includes(qLower)) ||
          m.genres.some((g) => g.toLowerCase().includes(qLower))
      );

      if (type === 'movie') {
        matched = matched.filter((m) => m.mediaType === 'movie');
      } else if (type === 'tv') {
        matched = matched.filter((m) => m.mediaType === 'tv');
      }

      const result: PaginatedResult<NormalizedMovie> = {
        items: matched,
        total: matched.length,
        page,
        limit: 20,
        totalPages: Math.ceil(matched.length / 20) || 1,
      };
      setToCache(cacheKey, result);
      return result;
    }

    // Call TMDb API based on requested type
    try {
      let endpoint = '/search/multi';
      if (type === 'movie') endpoint = '/search/movie';
      if (type === 'tv') endpoint = '/search/tv';

      const response = await axios.get(`${env.TMDB_BASE_URL}${endpoint}`, {
        params: {
          api_key: env.TMDB_API_KEY,
          query: trimmed,
          page,
          include_adult: false,
        },
        timeout: 7000,
      });

      const data = response.data;
      const rawResults: TmdbSearchItemResult[] = data.results || [];

      // Filter out people or unwanted media types when multi search is used
      const filtered = rawResults.filter((r) => {
        if (type === 'all') {
          return !r.media_type || r.media_type === 'movie' || r.media_type === 'tv';
        }
        return true;
      });

      const defaultType: MediaType = type === 'tv' ? 'tv' : 'movie';
      const normalizedItems = filtered.map((r) => this.normalizeItem(r, defaultType));

      const result: PaginatedResult<NormalizedMovie> = {
        items: normalizedItems,
        total: data.total_results || normalizedItems.length,
        page: data.page || page,
        limit: 20,
        totalPages: data.total_pages || 1,
      };

      setToCache(cacheKey, result);
      return result;
    } catch (err: unknown) {
      if (env.NODE_ENV === 'production') {
        throw new BadGatewayError('TMDb search service returned an upstream error');
      }
      // Fallback to matching in curated list on error in development / test
      const qLower = trimmed.toLowerCase();
      let matched = CURATED_MEDIA.filter(
        (m) =>
          m.title.toLowerCase().includes(qLower) ||
          (m.overview && m.overview.toLowerCase().includes(qLower))
      );

      if (type === 'movie') matched = matched.filter((m) => m.mediaType === 'movie');
      if (type === 'tv') matched = matched.filter((m) => m.mediaType === 'tv');

      return {
        items: matched,
        total: matched.length,
        page,
        limit: 20,
        totalPages: 1,
      };
    }
  }

  static async searchMovies(
    query: string,
    page: number = 1
  ): Promise<PaginatedResult<NormalizedMovie>> {
    return this.search(query, 'movie', page);
  }

  static async searchTv(
    query: string,
    page: number = 1
  ): Promise<PaginatedResult<NormalizedMovie>> {
    return this.search(query, 'tv', page);
  }

  static async searchMulti(
    query: string,
    page: number = 1
  ): Promise<PaginatedResult<NormalizedMovie>> {
    return this.search(query, 'all', page);
  }

  static async getMediaDetails(
    tmdbId: number,
    mediaType: MediaType = 'movie'
  ): Promise<NormalizedMovie | null> {
    const cacheKey = `media:${mediaType}:${tmdbId}`;
    const cached = getFromCache<NormalizedMovie>(cacheKey);
    if (cached) return cached;

    // Check curated catalog first in non-production
    const curated = CURATED_MEDIA.find(
      (m) => m.tmdbId === tmdbId && m.mediaType === mediaType
    );

    if (!env.TMDB_API_KEY) {
      if (env.NODE_ENV === 'production') {
        throw new ServiceUnavailableError('TMDb service is unconfigured in production');
      }
      if (curated) {
        setToCache(cacheKey, curated);
        return curated;
      }
      return null;
    }

    try {
      const endpoint = mediaType === 'tv' ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
      const response = await axios.get(`${env.TMDB_BASE_URL}${endpoint}`, {
        params: {
          api_key: env.TMDB_API_KEY,
        },
        timeout: 7000,
      });

      const normalized = this.normalizeDetails(response.data, mediaType);
      setToCache(cacheKey, normalized);
      return normalized;
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status?: number } };
      if (axiosErr?.response?.status === 404) {
        return null;
      }
      if (env.NODE_ENV === 'production') {
        throw new BadGatewayError('TMDb details service returned an upstream error');
      }
      if (curated) {
        setToCache(cacheKey, curated);
        return curated;
      }
      return null;
    }
  }

  static async getMovieDetails(tmdbId: number): Promise<NormalizedMovie | null> {
    return this.getMediaDetails(tmdbId, 'movie');
  }

  static async getTvDetails(tmdbId: number): Promise<NormalizedMovie | null> {
    return this.getMediaDetails(tmdbId, 'tv');
  }
}
