import type { ProviderAdapter } from "./base";
import type {
  AdapterEvent,
  FrogAssistantContentPart,
  FrogContentPart,
  FrogParsedRequest,
  FrogProviderConfig,
  FrogTool,
} from "../types";
import { namespacedToolName } from "../types";

const KIRO_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
const MAX_EVENT_MESSAGE_BYTES = 16 * 1024 * 1024;
const REGION_PATTERN = /^[a-z]+(?:-[a-z0-9]+)+-\d+$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface KiroImage {
  format: string;
  source: { bytes: string };
}

interface KiroUserInput {
  content: string;
  modelId: string;
  origin: "AI_EDITOR";
  images?: KiroImage[];
  userInputMessageContext?: {
    tools?: unknown[];
    toolResults?: unknown[];
  };
}

interface KiroToolUse {
  name: string;
  input: Record<string, unknown>;
  toolUseId: string;
}

type KiroConversationEntry =
  | { userInputMessage: KiroUserInput }
  | { assistantResponseMessage: { content: string; toolUses?: KiroToolUse[] } };

interface DecodedEventMessage {
  headers: Map<string, string>;
  payload: Uint8Array;
}

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC32_TABLE.length; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC32_TABLE[i] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function parseEventHeaders(bytes: Uint8Array): Map<string, string> {
  const headers = new Map<string, string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const nameLength = bytes[offset++]!;
    if (nameLength === 0 || offset + nameLength + 1 > bytes.byteLength) throw new Error("invalid event header");
    const name = textDecoder.decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    const type = bytes[offset++]!;
    if (type === 0) {
      headers.set(name, "true");
    } else if (type === 1) {
      headers.set(name, "false");
    } else if (type === 2) {
      if (offset + 1 > bytes.byteLength) throw new Error("invalid byte header");
      offset += 1;
    } else if (type === 3) {
      if (offset + 2 > bytes.byteLength) throw new Error("invalid short header");
      offset += 2;
    } else if (type === 4) {
      if (offset + 4 > bytes.byteLength) throw new Error("invalid integer header");
      offset += 4;
    } else if (type === 5 || type === 8) {
      if (offset + 8 > bytes.byteLength) throw new Error("invalid long header");
      offset += 8;
    } else if (type === 6 || type === 7) {
      if (offset + 2 > bytes.byteLength) throw new Error("invalid variable header");
      const length = view.getUint16(offset, false);
      offset += 2;
      if (offset + length > bytes.byteLength) throw new Error("truncated variable header");
      if (type === 7) headers.set(name, textDecoder.decode(bytes.subarray(offset, offset + length)));
      offset += length;
    } else if (type === 9) {
      if (offset + 16 > bytes.byteLength) throw new Error("invalid uuid header");
      offset += 16;
    } else {
      throw new Error("unknown event header type");
    }
  }
  return headers;
}

class AwsEventStreamDecoder {
  #buffer = new Uint8Array(0);

  feed(chunk: Uint8Array): DecodedEventMessage[] {
    if (chunk.byteLength > 0) {
      const combined = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
      combined.set(this.#buffer);
      combined.set(chunk, this.#buffer.byteLength);
      this.#buffer = combined;
    }

    const messages: DecodedEventMessage[] = [];
    while (this.#buffer.byteLength >= 12) {
      const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, this.#buffer.byteLength);
      const totalLength = view.getUint32(0, false);
      const headersLength = view.getUint32(4, false);
      if (totalLength < 16 || totalLength > MAX_EVENT_MESSAGE_BYTES || headersLength > totalLength - 16) {
        throw new Error("invalid event message length");
      }
      if (this.#buffer.byteLength < totalLength) break;

      const message = this.#buffer.subarray(0, totalLength);
      const messageView = new DataView(message.buffer, message.byteOffset, message.byteLength);
      if (crc32(message.subarray(0, 8)) !== messageView.getUint32(8, false)) throw new Error("invalid event prelude checksum");
      if (crc32(message.subarray(0, totalLength - 4)) !== messageView.getUint32(totalLength - 4, false)) {
        throw new Error("invalid event message checksum");
      }

      const payloadStart = 12 + headersLength;
      messages.push({
        headers: parseEventHeaders(message.subarray(12, payloadStart)),
        payload: message.slice(payloadStart, totalLength - 4),
      });
      this.#buffer = this.#buffer.slice(totalLength);
    }
    return messages;
  }

  finish(): void {
    if (this.#buffer.byteLength !== 0) throw new Error("truncated event stream");
  }
}

function contentToKiro(content: string | FrogContentPart[]): { text: string; images?: KiroImage[] } {
  if (typeof content === "string") return { text: content || "(empty placeholder)" };
  const text: string[] = [];
  const images: KiroImage[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text) text.push(part.text);
      continue;
    }
    const match = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(part.imageUrl);
    if (!match) throw new Error("Kiro supports only embedded data images on this route");
    images.push({ format: match[1]!.toLowerCase() === "jpg" ? "jpeg" : match[1]!.toLowerCase(), source: { bytes: match[2]!.replace(/\s/g, "") } });
  }
  return {
    text: text.join("\n\n") || (images.length > 0 ? "(image)" : "(empty placeholder)"),
    ...(images.length > 0 ? { images } : {}),
  };
}

function assistantToKiro(content: FrogAssistantContentPart[], includeTools: boolean): { content: string; toolUses?: KiroToolUse[] } {
  const text = content.filter(part => part.type === "text").map(part => part.text).filter(Boolean).join("\n\n");
  const toolCalls = content.filter(part => part.type === "toolCall");
  if (!includeTools && toolCalls.length > 0) {
    const summaries = toolCalls.map(part =>
      `Tool call ${namespacedToolName(part.namespace, part.customWireName ?? part.name)}: ${JSON.stringify(part.arguments)}`,
    );
    return { content: [text, ...summaries].filter(Boolean).join("\n\n") || "(empty placeholder)" };
  }
  const toolUses = toolCalls.map(part => ({
    name: namespacedToolName(part.namespace, part.customWireName ?? part.name),
    input: part.arguments,
    toolUseId: part.id,
  }));
  return {
    content: text || "(empty placeholder)",
    ...(toolUses.length > 0 ? { toolUses } : {}),
  };
}

function sanitizeKiroSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties") continue;
    if (key === "required" && Array.isArray(value) && value.length === 0) continue;
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([propertyName, propertySchema]) => [
          propertyName,
          propertySchema && typeof propertySchema === "object" && !Array.isArray(propertySchema)
            ? sanitizeKiroSchema(propertySchema as Record<string, unknown>)
            : propertySchema,
        ]),
      );
    } else if (Array.isArray(value)) {
      result[key] = value.map(item =>
        item && typeof item === "object" && !Array.isArray(item)
          ? sanitizeKiroSchema(item as Record<string, unknown>)
          : item
      );
    } else if (value && typeof value === "object") {
      result[key] = sanitizeKiroSchema(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function toolSpecification(tool: FrogTool): unknown {
  const name = namespacedToolName(tool.namespace, tool.name);
  if (name.length > 64) throw new Error("Kiro tool names must be 64 characters or fewer");
  return {
    toolSpecification: {
      name,
      description: tool.description.trim() || `Tool: ${name}`,
      inputSchema: { json: sanitizeKiroSchema(tool.parameters) },
    },
  };
}

function mergeAdjacentEntries(entries: KiroConversationEntry[]): KiroConversationEntry[] {
  const merged: KiroConversationEntry[] = [];
  for (const entry of entries) {
    const previous = merged.at(-1);
    if (previous && "userInputMessage" in previous && "userInputMessage" in entry) {
      previous.userInputMessage.content += `\n\n${entry.userInputMessage.content}`;
      previous.userInputMessage.images = [...(previous.userInputMessage.images ?? []), ...(entry.userInputMessage.images ?? [])];
      const priorResults = previous.userInputMessage.userInputMessageContext?.toolResults ?? [];
      const nextResults = entry.userInputMessage.userInputMessageContext?.toolResults ?? [];
      if (priorResults.length > 0 || nextResults.length > 0) {
        previous.userInputMessage.userInputMessageContext = { toolResults: [...priorResults, ...nextResults] };
      }
    } else if (previous && "assistantResponseMessage" in previous && "assistantResponseMessage" in entry) {
      previous.assistantResponseMessage.content += `\n\n${entry.assistantResponseMessage.content}`;
      previous.assistantResponseMessage.toolUses = [
        ...(previous.assistantResponseMessage.toolUses ?? []),
        ...(entry.assistantResponseMessage.toolUses ?? []),
      ];
    } else {
      merged.push(entry);
    }
  }
  return merged;
}

function buildConversation(parsed: FrogParsedRequest, profileArn: string): Record<string, unknown> {
  if (parsed.options.toolChoice === "required" || typeof parsed.options.toolChoice === "object") {
    throw new Error("Kiro does not expose forced or named tool choice on this route");
  }
  const tools = parsed.options.toolChoice === "none" ? [] : (parsed.context.tools ?? []).map(toolSpecification);
  const includeTools = tools.length > 0;
  const entries: KiroConversationEntry[] = [];
  let pendingToolUseIds = new Set<string>();
  for (const message of parsed.context.messages) {
    if (message.role === "assistant") {
      const assistant = assistantToKiro(message.content, includeTools);
      entries.push({ assistantResponseMessage: assistant });
      pendingToolUseIds = new Set((assistant.toolUses ?? []).map(toolUse => toolUse.toolUseId));
    } else if (message.role === "toolResult") {
      const result = contentToKiro(message.content);
      if (!includeTools) {
        entries.push({
          userInputMessage: {
            content: `Tool result for ${namespacedToolName(message.toolNamespace, message.toolName)}: ${result.text}`,
            modelId: parsed.modelId,
            origin: "AI_EDITOR",
            ...(result.images ? { images: result.images } : {}),
          },
        });
        continue;
      }
      const priorUse = pendingToolUseIds.has(message.toolCallId);
      if (!priorUse) {
        entries.push({
          assistantResponseMessage: {
            content: "(tool call)",
            toolUses: [{
              name: namespacedToolName(message.toolNamespace, message.toolName),
              input: {},
              toolUseId: message.toolCallId,
            }],
          },
        });
        pendingToolUseIds = new Set([message.toolCallId]);
      }
      entries.push({
        userInputMessage: {
          content: result.text,
          modelId: parsed.modelId,
          origin: "AI_EDITOR",
          ...(result.images ? { images: result.images } : {}),
          userInputMessageContext: {
            toolResults: [{
              content: [{ text: result.text }],
              status: message.isError ? "error" : "success",
              toolUseId: message.toolCallId,
            }],
          },
        },
      });
    } else {
      pendingToolUseIds.clear();
      const converted = contentToKiro(message.content);
      entries.push({
        userInputMessage: {
          content: converted.text,
          modelId: parsed.modelId,
          origin: "AI_EDITOR",
          ...(converted.images ? { images: converted.images } : {}),
        },
      });
    }
  }

  const normalized = mergeAdjacentEntries(entries);
  if (normalized.length === 0 || "assistantResponseMessage" in normalized[0]!) {
    normalized.unshift({ userInputMessage: { content: "(empty placeholder)", modelId: parsed.modelId, origin: "AI_EDITOR" } });
  }
  if ("assistantResponseMessage" in normalized.at(-1)!) {
    normalized.push({ userInputMessage: { content: "(empty placeholder)", modelId: parsed.modelId, origin: "AI_EDITOR" } });
  }

  const current = normalized.pop()!;
  if (!("userInputMessage" in current)) throw new Error("Kiro conversation did not end with user input");

  const systemPrompt = parsed.context.systemPrompt?.filter(Boolean).join("\n\n");
  if (systemPrompt) {
    const firstUser = normalized.find(entry => "userInputMessage" in entry) as { userInputMessage: KiroUserInput } | undefined;
    const target = firstUser?.userInputMessage ?? current.userInputMessage;
    target.content = `${systemPrompt}\n\n${target.content}`;
  }

  if (tools.length > 0) {
    current.userInputMessage.userInputMessageContext = {
      ...(current.userInputMessage.userInputMessageContext ?? {}),
      tools,
    };
  }

  return {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: crypto.randomUUID(),
      currentMessage: current,
      ...(normalized.length > 0 ? { history: normalized } : {}),
    },
    profileArn,
  };
}

function sanitizedExceptionCode(headers: Map<string, string>): string | undefined {
  const raw = headers.get(":exception-type") ?? headers.get(":event-type");
  return raw && /^[A-Za-z0-9_.-]{1,80}$/.test(raw) ? raw : undefined;
}

function payloadObject(payload: Uint8Array): Record<string, unknown> {
  const parsed = JSON.parse(textDecoder.decode(payload));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid event payload");
  return parsed as Record<string, unknown>;
}

async function* parseKiroEventStream(response: Response): AsyncGenerator<AdapterEvent> {
  if (!response.body) {
    yield { type: "error", message: "Kiro upstream returned an empty stream" };
    return;
  }

  const decoder = new AwsEventStreamDecoder();
  let activeTool = false;
  let sawOutput = false;
  let sawTool = false;
  let lastContent: string | undefined;
  try {
    for await (const chunk of response.body) {
      for (const message of decoder.feed(chunk)) {
        const messageType = message.headers.get(":message-type");
        if (messageType === "exception" || messageType === "error") {
          const code = sanitizedExceptionCode(message.headers);
          yield { type: "error", message: code ? `Kiro upstream stream error (${code})` : "Kiro upstream stream error" };
          return;
        }

        const payload = payloadObject(message.payload);
        if (typeof payload.content === "string" && payload.content.length > 0 && !payload.followupPrompt) {
          if (payload.content !== lastContent) {
            lastContent = payload.content;
            sawOutput = true;
            yield { type: "text_delta", text: payload.content };
          }
        }
        if (typeof payload.name === "string") {
          if (!payload.name) {
            yield { type: "error", message: "Kiro upstream started an unnamed tool call" };
            return;
          }
          if (activeTool) yield { type: "tool_call_end" };
          activeTool = true;
          sawOutput = true;
          sawTool = true;
          const id = typeof payload.toolUseId === "string" && payload.toolUseId ? payload.toolUseId : crypto.randomUUID();
          yield { type: "tool_call_start", id, name: payload.name };
          if (typeof payload.input === "string" && payload.input) yield { type: "tool_call_delta", arguments: payload.input };
          else if (payload.input && typeof payload.input === "object" && Object.keys(payload.input).length > 0) {
            yield { type: "tool_call_delta", arguments: JSON.stringify(payload.input) };
          }
        } else if (Object.hasOwn(payload, "input")) {
          if (!activeTool) {
            yield { type: "error", message: "Kiro upstream sent tool input without an active tool call" };
            return;
          }
          if (typeof payload.input === "string") yield { type: "tool_call_delta", arguments: payload.input };
          else if (payload.input && typeof payload.input === "object") yield { type: "tool_call_delta", arguments: JSON.stringify(payload.input) };
        }
        if (payload.stop === true && activeTool) {
          activeTool = false;
          yield { type: "tool_call_end" };
        }
        if (Object.hasOwn(payload, "usage") || Object.hasOwn(payload, "contextUsagePercentage")) {
          yield { type: "activity" };
        }
      }
    }
    decoder.finish();
  } catch {
    yield { type: "error", message: "Kiro upstream returned a malformed event stream" };
    return;
  }

  if (activeTool) {
    yield { type: "error", message: "Kiro upstream ended during a tool call" };
    return;
  }
  if (!sawOutput) {
    yield { type: "error", message: "Kiro upstream ended without response events" };
    return;
  }
  yield { type: "done", stopReason: sawTool ? "tool_use" : "end_turn" };
}

export function createKiroAdapter(provider: FrogProviderConfig): ProviderAdapter {
  return {
    name: "kiro",
    buildRequest(parsed) {
      if (!provider.apiKey || provider.runtimeAuth?.kind !== "kiro") {
        throw new Error("Kiro authentication is unavailable. Run: frogp login kiro");
      }
      if (!REGION_PATTERN.test(provider.runtimeAuth.region)) throw new Error("Kiro credential region is invalid");
      const body = buildConversation(parsed, provider.runtimeAuth.profileArn);
      return {
        url: `https://runtime.${provider.runtimeAuth.region}.kiro.dev/generateAssistantResponse`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          "Content-Type": "application/x-amz-json-1.0",
          Accept: "application/vnd.amazon.eventstream",
          "x-amz-target": KIRO_TARGET,
          "User-Agent": "frogprogsy",
          "x-amz-user-agent": "frogprogsy",
          "x-amzn-codewhisperer-optout": "true",
          "x-amzn-kiro-agent-mode": "vibe",
          "amz-sdk-invocation-id": crypto.randomUUID(),
          "amz-sdk-request": "attempt=1; max=1",
        },
        body: JSON.stringify(body),
      };
    },
    parseStream: parseKiroEventStream,
    async parseResponse(response) {
      const events: AdapterEvent[] = [];
      for await (const event of parseKiroEventStream(response)) events.push(event);
      return events;
    },
  };
}

export const __kiroEventStreamTestUtils = {
  crc32,
  encodePayloadForTest(payload: Record<string, unknown>): Uint8Array {
    return textEncoder.encode(JSON.stringify(payload));
  },
};
