/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import {
  useQuery,
  useMutation,
  type UseQueryOptions,
  type UseMutationOptions,
  type QueryKey,
} from '@tanstack/react-query';
import type {
  SearchResult,
  VerifyClaimsResponse,
  SourceRef,
} from '@/features/research/types';

/* --------------------------------- Errors --------------------------------- */

export class ApiError extends Error {
  status: number;
  info?: unknown;
  constructor(message: string, status: number, info?: unknown) {
    super(message);
    this.status = status;
    this.info = info;
  }
}

/* --------------------------------- Fetchers -------------------------------- */

async function jsonFetch<T>(
  input: RequestInfo,
  init?: RequestInit & { signal?: AbortSignal }
): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  const ct = res.headers.get('content-type') || '';
  const isJSON = ct.includes('application/json') || ct.includes('json');
  if (!res.ok) {
    let info: unknown = undefined;
    try {
      info = isJSON ? await res.json() : await res.text();
    } catch {
      /* ignore */
    }
    throw new ApiError(
      `HTTP ${res.status} ${res.statusText || ''}`.trim(),
      res.status,
      info
    );
  }
  return (isJSON ? res.json() : (res.text() as any)) as T;
}

/* ------------------------------- Query Keys -------------------------------- */

export const qk = {
  // non-streaming queries
  source: (id: string) => ['source', id] as const,
  search: (query: string, params?: SearchParams) =>
    ['search', query, params ?? {}] as const,
  threadSources: (threadId: string) => ['thread', threadId, 'sources'] as const,
  // mutations (not used as keys, but kept for consistency)
  verifyClaims: () => ['verify-claims'] as const,
  ingestUrls: () => ['ingest-urls'] as const,
};

/* ---------------------------------- Types ---------------------------------- */

// Search
export type SearchParams = {
  size?: number;
  timeRange?: { from?: string; to?: string };
  region?: string;
  allowedDomains?: string[];
  disallowedDomains?: string[];
};

// Verify
export type Snippet = { sourceId: string; chunkId?: string; text: string };
export type VerifyPayload = { answerMarkdown: string; snippets: Snippet[] };

// Ingest
export type IngestPayload = { urls: string[] };
export type IngestResponse = { sourceIds: string[] };

/* --------------------------------- Queries --------------------------------- */

/**
 * GET /api/source/:id
 * Returns a source preview (metadata + optional snippet).
 * Adjust return shape to your route’s response if needed.
 */
export function useSource<T = any>(
  id: string | null | undefined,
  options?: Omit<UseQueryOptions<T, ApiError, T, QueryKey>, 'queryKey' | 'queryFn'>
) {
  return useQuery<T, ApiError>({
    queryKey: qk.source(String(id || '')),
    enabled: !!id,
    queryFn: ({ signal }) => jsonFetch<T>(`/api/source/${id}`, { signal }),
    ...options,
  });
}

/**
 * POST /api/search
 * Body: { query, ...params }
 * Returns SearchResult[]
 */
export function useSearchQuery(
  query: string | null | undefined,
  params?: SearchParams,
  options?: Omit<
    UseQueryOptions<SearchResult[], ApiError, SearchResult[], QueryKey>,
    'queryKey' | 'queryFn'
  >
) {
  const enabled = !!query && query.trim().length > 1;
  return useQuery<SearchResult[], ApiError>({
    queryKey: qk.search(query || '', params),
    enabled,
    queryFn: ({ signal }) =>
      jsonFetch<SearchResult[]>('/api/search', {
        method: 'POST',
        body: JSON.stringify({ query, ...(params ?? {}) }),
        signal,
      }),
    staleTime: 60_000,
    ...options,
  });
}

/**
 * GET /api/thread/:id/sources (optional if you implement it)
 * If you don’t have this route, remove or update accordingly.
 */
export function useThreadSources<T = SourceRef[]>(
  threadId: string | null | undefined,
  options?: Omit<UseQueryOptions<T, ApiError, T, QueryKey>, 'queryKey' | 'queryFn'>
) {
  return useQuery<T, ApiError>({
    queryKey: qk.threadSources(String(threadId || '')),
    enabled: !!threadId,
    queryFn: ({ signal }) => jsonFetch<T>(`/api/thread/${threadId}/sources`, { signal }),
    ...options,
  });
}

/* -------------------------------- Mutations -------------------------------- */

/**
 * POST /api/verify
 * Body: VerifyPayload
 * Returns VerifyClaimsResponse
 */
export function useVerifyClaimsMutation(
  options?: UseMutationOptions<VerifyClaimsResponse, ApiError, VerifyPayload>
) {
  return useMutation<VerifyClaimsResponse, ApiError, VerifyPayload>({
    mutationKey: qk.verifyClaims(),
    mutationFn: (payload) =>
      jsonFetch<VerifyClaimsResponse>('/api/verify', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    ...options,
  });
}

/**
 * POST /api/ingest
 * Body: { urls: string[] }
 * Returns { sourceIds: string[] }
 */
export function useIngestUrlsMutation(
  options?: UseMutationOptions<IngestResponse, ApiError, IngestPayload>
) {
  return useMutation<IngestResponse, ApiError, IngestPayload>({
    mutationKey: qk.ingestUrls(),
    mutationFn: (payload) =>
      jsonFetch<IngestResponse>('/api/ingest', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    ...options,
  });
}

/* --------------------------- Optional: helpers ----------------------------- */

/**
 * Helper to safely stringify query keys/params for logs or debugging.
 */
export function stableKey(obj: unknown): string {
  try {
    return JSON.stringify(obj, Object.keys(obj as any).sort());
  } catch {
    return String(obj);
  }
}