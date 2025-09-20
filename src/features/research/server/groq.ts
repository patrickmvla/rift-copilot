/* eslint-disable @typescript-eslint/no-explicit-any */
import "server-only";
import { createGroq } from "@ai-sdk/groq";
import {
  customProvider,
  wrapLanguageModel,
  defaultSettingsMiddleware,
  streamText,
  generateText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type ToolChoice,
} from "ai";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

export const MODELS = {
  plan: "plan",
  answer: "answer",
  verify: "verify",
  reasoning: "reasoning",
} as const;

export type ModelAlias = keyof typeof MODELS;
export type ModelName = (typeof MODELS)[ModelAlias] | string;

export const groqProvider = createGroq({
  apiKey: env.GROQ_API_KEY,
});
export const groqTools = groqProvider.tools;

export const myGroq = customProvider({
  languageModels: {
    [MODELS.plan]: wrapLanguageModel({
      model: groqProvider("llama-3.1-8b-instant"),
      middleware: defaultSettingsMiddleware({
        settings: {
          temperature: 0,
          providerOptions: {
            groq: {
              structuredOutputs: false,
              parallelToolCalls: true,
              serviceTier: "on_demand",
            },
          },
        },
      }),
    }),
    [MODELS.answer]: wrapLanguageModel({
      model: groqProvider("llama-3.3-70b-versatile"),
      middleware: defaultSettingsMiddleware({
        settings: {
          temperature: 0.2,
          providerOptions: {
            groq: {
              structuredOutputs: false,
              parallelToolCalls: true,
              serviceTier: "on_demand",
            },
          },
        },
      }),
    }),
    [MODELS.verify]: wrapLanguageModel({
      model: groqProvider("llama-3.1-8b-instant"),
      middleware: defaultSettingsMiddleware({
        settings: {
          temperature: 0,
          providerOptions: {
            groq: {
              structuredOutputs: true,
              parallelToolCalls: true,
              serviceTier: "on_demand",
            },
          },
        },
      }),
    }),
    [MODELS.reasoning]: wrapLanguageModel({
      model: groqProvider("deepseek-r1-distill-llama-70b"),
      middleware: defaultSettingsMiddleware({
        settings: {
          temperature: 0.2,
          providerOptions: {
            groq: {
              reasoningFormat: "hidden",
              reasoningEffort: "default",
              structuredOutputs: false,
              parallelToolCalls: true,
              serviceTier: "on_demand",
            },
          },
        },
      }),
    }),
  },
  fallbackProvider: groqProvider,
});

export type GroqProviderOptions = {
  reasoningFormat?: "parsed" | "raw" | "hidden";
  reasoningEffort?: "low" | "medium" | "high" | "none" | "default";
  structuredOutputs?: boolean;
  parallelToolCalls?: boolean;
  user?: string;
  serviceTier?: "on_demand" | "flex" | "auto";
};

function sanitizeGroqOptions(
  o?: GroqProviderOptions
): GroqProviderOptions | undefined {
  if (!o) return undefined;
  if (o.serviceTier === "auto") return { ...o, serviceTier: "on_demand" };
  return o;
}

type CommonCall = {
  model?: ModelAlias | ModelName | LanguageModel;
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  groqOptions?: GroqProviderOptions;
  tools?: ToolSet;
  toolChoice?: ToolChoice<ToolSet>;
};

type PromptCall = CommonCall & {
  prompt: string;
  messages?: never;
};

type MessagesCall = CommonCall & {
  messages: ModelMessage[];
  prompt?: never;
};

function isPromptCall(x: PromptCall | MessagesCall): x is PromptCall {
  return typeof (x as any).prompt === "string";
}

/* ---------------------------------- Stream --------------------------------- */

export function streamCompletion(
  opts: PromptCall
): ReturnType<typeof streamText>;
export function streamCompletion(
  opts: MessagesCall
): ReturnType<typeof streamText>;
export function streamCompletion(opts: PromptCall | MessagesCall) {
  const {
    model,
    system,
    temperature = 0.2,
    maxOutputTokens = 1200,
    abortSignal,
    groqOptions,
    tools,
    toolChoice,
  } = opts;

  const resolved = getModel(model, "answer");
  const base = {
    model: resolved,
    system,
    temperature,
    maxOutputTokens,
    abortSignal,
    tools,
    toolChoice,
    providerOptions: sanitizeGroqOptions(groqOptions)
      ? { groq: sanitizeGroqOptions(groqOptions)! }
      : undefined,
  };

  if (isPromptCall(opts)) {
    return streamText({ ...base, prompt: opts.prompt });
  }
  return streamText({ ...base, messages: opts.messages });
}

/* ------------------------------- Convenience ------------------------------- */

export async function streamAnswer(args: {
  system: string;
  user: string;
  context?: string;
  model?: ModelAlias | ModelName | LanguageModel;
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  groqOptions?: GroqProviderOptions;
  tools?: ToolSet;
  toolChoice?: ToolChoice<ToolSet>;
}) {
  const {
    system,
    user,
    context,
    model,
    temperature,
    maxOutputTokens,
    abortSignal,
    groqOptions,
    tools,
    toolChoice,
  } = args;

  const combined = context ? `${user}\n\nContext:\n${context}` : user;

  return streamCompletion({
    model: model ?? "answer",
    system,
    prompt: combined,
    temperature: temperature ?? 0.2,
    maxOutputTokens: maxOutputTokens ?? 1200,
    abortSignal,
    groqOptions,
    tools,
    toolChoice,
  });
}

/* ------------------------------- Generation -------------------------------- */

export function generateCompletion(
  opts: PromptCall
): ReturnType<typeof generateText>;
export function generateCompletion(
  opts: MessagesCall
): ReturnType<typeof generateText>;
export function generateCompletion(opts: PromptCall | MessagesCall) {
  const {
    model,
    system,
    temperature = 0,
    maxOutputTokens = 800,
    abortSignal,
    groqOptions,
    tools,
    toolChoice,
  } = opts;

  const resolved = getModel(model, "plan");
  const base = {
    model: resolved,
    system,
    temperature,
    maxOutputTokens,
    abortSignal,
    tools,
    toolChoice,
    providerOptions: sanitizeGroqOptions(groqOptions)
      ? { groq: sanitizeGroqOptions(groqOptions)! }
      : undefined,
  };

  if (isPromptCall(opts)) {
    return generateText({ ...base, prompt: opts.prompt });
  }
  return generateText({ ...base, messages: opts.messages });
}

/* --------------------------------- Helpers -------------------------------- */

export function getModel(
  input?: ModelAlias | ModelName | LanguageModel,
  fallback: ModelAlias = "answer"
): LanguageModel {
  if (!input) return myGroq.languageModel(MODELS[fallback]);
  if (typeof input === "string") return myGroq.languageModel(input);
  return input;
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (typeof err === "object" &&
      err !== null &&
      (err as any).name === "AbortError")
  );
}

export function logModelUsage(ctx: {
  purpose: "plan" | "answer" | "verify" | "reasoning" | string;
  model?: ModelAlias | ModelName | LanguageModel;
  temperature?: number;
  maxOutputTokens?: number;
  groqOptions?: GroqProviderOptions;
}) {
  const m =
    typeof ctx.model === "string"
      ? ctx.model
      : ctx.model
      ? "custom-language-model"
      : MODELS.answer;
  logger.debug(
    {
      mod: "groq",
      purpose: ctx.purpose,
      model: m,
      temperature: ctx.temperature,
      maxOutputTokens: ctx.maxOutputTokens,
      groqOptions: ctx.groqOptions,
    },
    "LLM call"
  );
}
