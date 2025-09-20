/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { ProgressStage, VerifyClaimsResponse, SourceRef } from '@/features/research/types';

type ProgressLogItem = {
  stage: ProgressStage;
  message?: string;
  ts: number;
};

type UIState = {
  selectedSourceId: string | null;
  selectedClaimIndex: number | null;
  showConfidence: boolean;
};

type ResearchState = {
  // Run/session
  threadId: string | null;
  question: string;
  stage: ProgressStage | 'idle';
  startedAt: number | null;
  endedAt: number | null;
  lastEventAt: number | null;

  // Streaming answer
  answerMarkdown: string;
  tokensAppended: number;

  // Results
  sources: SourceRef[];
  claims: VerifyClaimsResponse | null;

  // Errors
  error: string | null;

  // Progress timeline
  progress: ProgressLogItem[];

  // Abort handle for current run (optional)
  abortController: AbortController | null;

  // UI prefs
  ui: UIState;
};

type ResearchActions = {
  // Lifecycle
  start: (args: { question: string; abortController?: AbortController }) => void;
  reset: () => void;
  finish: (threadId?: string) => void;
  cancel: (reason?: string) => void;

  // Mutations
  setStage: (stage: ProgressStage, message?: string) => void;
  appendToken: (delta: string) => void;
  setSources: (sources: SourceRef[]) => void;
  setClaims: (claims: VerifyClaimsResponse) => void;
  setError: (msg: string) => void;
  setThreadId: (id: string) => void;
  setQuestion: (q: string) => void;
  setAbortController: (ac: AbortController | null) => void;

  // UI
  selectSource: (sourceId: string | null) => void;
  selectClaim: (index: number | null) => void;
  setShowConfidence: (on: boolean) => void;

  // Helpers
  clearAnswer: () => void;
  durationMs: () => number;

  // SSE handler
  handleSSE: (evt: { event: string; data: any }) => void;
};

const initialUI: UIState = {
  selectedSourceId: null,
  selectedClaimIndex: null,
  showConfidence: true,
};

const initialState: ResearchState = {
  threadId: null,
  question: '',
  stage: 'idle',
  startedAt: null,
  endedAt: null,
  lastEventAt: null,

  answerMarkdown: '',
  tokensAppended: 0,

  sources: [],
  claims: null,

  error: null,

  progress: [],

  abortController: null,

  ui: initialUI,
};

export const useResearchStore = create<ResearchState & ResearchActions>()(
  devtools(
    (set, get) => ({
      ...initialState,

      // Lifecycle
      start: ({ question, abortController }) => {
        set(() => ({
          ...initialState,
          question,
          stage: 'plan',
          startedAt: Date.now(),
          lastEventAt: Date.now(),
          abortController: abortController ?? null,
        }));
      },

      reset: () => set(() => ({ ...initialState })),

      finish: (threadId) =>
        set((s) => ({
          stage: 'done',
          threadId: threadId ?? s.threadId,
          endedAt: Date.now(),
          lastEventAt: Date.now(),
        })),

      cancel: (reason) => {
        const ac = get().abortController;
        try {
          ac?.abort?.(reason ? new DOMException(reason, 'AbortError') : undefined);
        } catch {
          // ignore
        }
        set(() => ({
          stage: 'error',
          error: reason ?? 'Cancelled by user',
          endedAt: Date.now(),
          lastEventAt: Date.now(),
          abortController: null,
        }));
      },

      // Mutations
      setStage: (stage, message) =>
        set((s) => ({
          stage,
          lastEventAt: Date.now(),
          progress: [...s.progress, { stage, message, ts: Date.now() }],
        })),

      appendToken: (delta) =>
        set((s) => ({
          answerMarkdown: s.answerMarkdown + (delta ?? ''),
          tokensAppended: s.tokensAppended + (delta?.length ?? 0),
          lastEventAt: Date.now(),
        })),

      setSources: (sources) =>
        set(() => ({
          sources: Array.isArray(sources) ? sources : [],
          lastEventAt: Date.now(),
        })),

      setClaims: (claims) =>
        set(() => ({
          claims,
          lastEventAt: Date.now(),
        })),

      setError: (msg) =>
        set(() => ({
          error: msg,
          stage: 'error',
          endedAt: Date.now(),
          lastEventAt: Date.now(),
        })),

      setThreadId: (id) =>
        set(() => ({
          threadId: id,
          lastEventAt: Date.now(),
        })),

      setQuestion: (q) => set(() => ({ question: q })),

      setAbortController: (ac) => set(() => ({ abortController: ac })),

      // UI
      selectSource: (sourceId) => set((s) => ({ ui: { ...s.ui, selectedSourceId: sourceId } })),
      selectClaim: (index) => set((s) => ({ ui: { ...s.ui, selectedClaimIndex: index } })),
      setShowConfidence: (on) => set((s) => ({ ui: { ...s.ui, showConfidence: on } })),

      // Helpers
      clearAnswer: () => set(() => ({ answerMarkdown: '', tokensAppended: 0 })),
      durationMs: () => {
        const s = get();
        if (s.startedAt == null) return 0;
        const end = s.endedAt ?? Date.now();
        return end - s.startedAt;
      },

      // SSE handler
      handleSSE: ({ event, data }) => {
        const a = useResearchStore.getState(); // stable reference for programmatic calls

        switch (event) {
          case 'progress':
            a.setStage(data?.stage as ProgressStage, data?.message);
            break;
          case 'token':
            a.appendToken(String(data ?? ''));
            break;
          case 'sources':
            a.setSources((data ?? []) as SourceRef[]);
            break;
          case 'claims':
            a.setClaims((data ?? null) as VerifyClaimsResponse);
            break;
          case 'done':
            if (data?.threadId) a.setThreadId(String(data.threadId));
            a.finish();
            break;
          case 'error':
            a.setError(String(data?.message ?? 'Unknown error'));
            break;
          default:
            // ignore unknown events to be forward-compatible
            break;
        }
      },
    }),
    { name: 'research-store' }
  )
);

// Optional selectors for convenience
export const useResearchStage = () => useResearchStore((s) => s.stage);
export const useResearchAnswer = () => useResearchStore((s) => s.answerMarkdown);
export const useResearchSources = () => useResearchStore((s) => s.sources);
export const useResearchClaims = () => useResearchStore((s) => s.claims);
export const useResearchError = () => useResearchStore((s) => s.error);
export const useResearchUI = () => useResearchStore((s) => s.ui);