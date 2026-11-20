import { apiClient } from '../api/client';
import { ApiResponse, User } from '../types';

export const authService = {
  async register(data: {
    username: string;
    email: string;
    password: string;
    confirmPassword: string;
  }): Promise<User> {
    const res = await apiClient.post<ApiResponse<{ user: User }>>('/auth/register', data);
    return res.data.data!.user;
  },

  async login(data: { identifier: string; password: string }): Promise<User> {
    const res = await apiClient.post<ApiResponse<{ user: User }>>('/auth/login', data);
    return res.data.data!.user;
  },

  async logout(): Promise<void> {
    await apiClient.post<ApiResponse>('/auth/logout');
  },

  async refresh(): Promise<User> {
    const res = await apiClient.post<ApiResponse<{ user: User }>>('/auth/refresh');
    return res.data.data!.user;
  },

  async getMe(): Promise<User> {
    const res = await apiClient.get<ApiResponse<{ user: User }>>('/auth/me');
    return res.data.data!.user;
  },
};
