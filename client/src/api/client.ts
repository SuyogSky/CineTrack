import axios, { AxiosError } from 'axios';
import { ApiResponse } from '../types';

export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  withCredentials: true,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
});

function getXsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(^|;\s*)XSRF-TOKEN=([^;]+)/);
  return match ? decodeURIComponent(match[2]) : null;
}

// Request interceptor: attach CSRF token if cookie is present
apiClient.interceptors.request.use((config) => {
  const xsrfToken = getXsrfCookie();
  if (xsrfToken) {
    config.headers['X-CSRF-Token'] = xsrfToken;
    config.headers['X-XSRF-TOKEN'] = xsrfToken;
  }
  return config;
});

// Refresh token handling queue
let isRefreshing = false;
let failedQueue: Array<{
  resolve: (value?: unknown) => void;
  reject: (reason?: unknown) => void;
}> = [];

const processQueue = (error: unknown) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve();
    }
  });
  failedQueue = [];
};

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiResponse>) => {
    const originalRequest = error.config as (typeof error.config & { _retry?: boolean }) | undefined;

    const isAuthEndpoint =
      originalRequest?.url?.includes('/auth/login') ||
      originalRequest?.url?.includes('/auth/register') ||
      originalRequest?.url?.includes('/auth/refresh') ||
      originalRequest?.url?.includes('/auth/logout');

    if (
      error.response?.status === 401 &&
      originalRequest &&
      !originalRequest._retry &&
      !isAuthEndpoint
    ) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then(() => apiClient(originalRequest))
          .catch((err) => Promise.reject(err));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const xsrfToken = getXsrfCookie();
        await axios.post(
          `${apiClient.defaults.baseURL}/auth/refresh`,
          {},
          {
            withCredentials: true,
            headers: xsrfToken
              ? { 'X-CSRF-Token': xsrfToken, 'X-XSRF-TOKEN': xsrfToken }
              : undefined,
          }
        );
        processQueue(null);
        return apiClient(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('auth:expired'));
        }
        const message =
          error.response?.data?.message ||
          error.message ||
          'Session expired. Please log in again.';
        return Promise.reject(new Error(message));
      } finally {
        isRefreshing = false;
      }
    }

    // Extract formatted message from API response if present
    const message =
      error.response?.data?.message ||
      error.message ||
      'An unexpected error occurred';
    return Promise.reject(new Error(message));
  }
);
