/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { z } from 'zod';
import {
  modelMessageSchema,
  type ModelMessage,
  type TextPart,
  type ImagePart,
  type FilePart,
  type ToolCallPart,
  type ToolResultPart,
  type JSONValue,
} from 'ai';

type UserParts = Array<TextPart | ImagePart | FilePart>;
type AssistantParts = Array<TextPart | FilePart | ToolCallPart | ToolResultPart>;

/* -------------------------------- Builders -------------------------------- */

export function system(text: string): ModelMessage {
  return { role: 'system', content: String(text ?? '') };
}

/* User */
export function userText(text: string): ModelMessage {
  return { role: 'user', content: String(text ?? '') };
}
export function userParts(parts: UserParts): ModelMessage {
  return { role: 'user', content: parts };
}
export function user(content: string | UserParts): ModelMessage {
  return typeof content === 'string' ? userText(content) : userParts(content);
}

/* Assistant */
export function assistantText(text: string): ModelMessage {
  return { role: 'assistant', content: String(text ?? '') };
}
export function assistantParts(parts: AssistantParts): ModelMessage {
  return { role: 'assistant', content: parts };
}
export function assistant(content: string | AssistantParts): ModelMessage {
  return typeof content === 'string' ? assistantText(content) : assistantParts(content);
}

/* Tool (tool-result messages only; tool-call parts belong to assistant content) */
export function toolResults(parts: ToolResultPart | ToolResultPart[]): ModelMessage {
  const arr = Array.isArray(parts) ? parts : [parts];
  return { role: 'tool', content: arr };
}
export function tool(content: ToolResultPart | ToolResultPart[]): ModelMessage {
  return toolResults(content);
}

/* ------------------------------ Part helpers ------------------------------ */

export function text(text: string): TextPart {
  return { type: 'text', text: String(text ?? '') };
}

export function image(
  input: string | URL | Uint8Array | ArrayBuffer,
  mediaType?: string
): ImagePart {
  return { type: 'image', image: input, mediaType };
}

export function file(
  data: string | URL | Uint8Array | ArrayBuffer,
  mediaType: string,
  filename?: string
): FilePart {
  return { type: 'file', data, mediaType, filename };
}

/* Tool-call part (assistant content) – v5 uses `input` (not `args`) */
export function toolCall(args: {
  toolCallId: string;
  toolName: string;
  params?: JSONValue; // your app API
}): ToolCallPart {
  return {
    type: 'tool-call',
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    input: args.params as JSONValue | undefined,
  } as ToolCallPart;
}

/* Tool-result part (tool message) – ensure JSONValue for json/error-json outputs */
export function toolResult(args: {
  toolCallId: string;
  toolName: string;
  output:
    | { type: 'text'; value: string }
    | { type: 'json'; value: unknown }
    | { type: 'error-text'; value: string }
    | { type: 'error-json'; value: unknown }
    | {
        type: 'content';
        value: Array<{ type: 'text'; text: string } | { type: 'media'; data: string; mediaType: string }>;
      };
  providerOptions?: ToolResultPart['providerOptions']; // v5-compatible
}): ToolResultPart {
  const toJSONValue = (v: unknown): JSONValue => {
    try {
      return JSON.parse(JSON.stringify(v)) as JSONValue;
    } catch {
      return null as unknown as JSONValue;
    }
  };

  let output: any = args.output;
  if (output?.type === 'json') {
    output = { type: 'json', value: toJSONValue(output.value) };
  } else if (output?.type === 'error-json') {
    output = { type: 'error-json', value: toJSONValue(output.value) };
  }

  return {
    type: 'tool-result',
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    output,
    providerOptions: args.providerOptions,
  } as ToolResultPart;
}

/* ------------------------------- Validation -------------------------------- */

const messagesArraySchema = z.array(modelMessageSchema);

export function validateMessages(input: unknown): ModelMessage[] {
  const parsed = messagesArraySchema.parse(input);
  return deepClone(parsed);
}

export function tryValidateMessages(
  input: unknown
): { ok: true; data: ModelMessage[] } | { ok: false; error: string } {
  const parsed = messagesArraySchema.safeParse(input);
  if (parsed.success) return { ok: true, data: deepClone(parsed.data) };
  return { ok: false, error: parsed.error.message };
}

/* --------------------------- Interop / convenience ------------------------- */

export type DBMessageLite = {
  role: 'user' | 'assistant' | 'system';
  contentMd: string;
};

export function fromDbMessages(messages: DBMessageLite[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push(userText(m.contentMd));
    else if (m.role === 'assistant') out.push(assistantText(m.contentMd));
    else out.push(system(m.contentMd));
  }
  return out;
}

/* --------------------------------- Guards --------------------------------- */

export function isModelMessage(x: unknown): x is ModelMessage {
  return modelMessageSchema.safeParse(x).success;
}

/* -------------------------------- Internals -------------------------------- */

function deepClone<T>(x: T): T {
  const sc = (globalThis as any).structuredClone;
  if (typeof sc === 'function') return sc(x);
  return JSON.parse(JSON.stringify(x));
}