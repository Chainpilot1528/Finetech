'use client';

import { useQuery } from '@tanstack/react-query';
import { ApiError, api, unwrap } from '@/shared/api';

export const useMe = () =>
  useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await unwrap(api.GET('/me'));
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
  });

export const nextStep = (state: 'pending' | 'enroll' | 'ok') =>
  ({ pending: '/two-step', enroll: '/two-step/setup', ok: '/app/dashboard' })[state];
