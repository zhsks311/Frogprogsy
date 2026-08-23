import type { AdapterEvent, AdapterStopReason, FrogUsage } from "../types";
import { classifyError } from "../errors";

function uuid(prefix = "msg"): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function usageFromAdapter(usage: FrogUsage | undefined): Record<string, unknown> {
  if (!usage) return { input_tokens: 0, output_tokens: 0 };
  const out: Record<string, unknown> = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
  };
  if (usage.cachedInputTokens !== undefined) out.cache_read_input_tokens = usage.cachedInputTokens;
  if (usage.reasoningOutputTokens !== undefined) out.reasoning_output_tokens = usage.reasoningOutputTokens;
  return out;
}

function sseEvent(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
}

function parseToolInput(args: string): Record<string, unknown> {
  if (!args.trim()) return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return { input: args };
  }
}

/**
 * Merge a `done` event's provider stop metadata into the locally tracked stop reason.
 * Precedence (binding, from the approved plan amendment): `max_tokens`, `stop_sequence`, and
 * `tool_use` always set the final stop reason; `end_turn` — including `unknown_normalized`
 * end_turn — never overwrites a locally established `tool_use`.
 */
function applyStopReason(local: AdapterStopReason, event: { stopReason?: AdapterStopReason }): AdapterStopReason {
  if (!event.stopReason) return local;
  if (event.stopReason === "end_turn" && local === "tool_use") return local;
  return event.stopReason;
}

interface MessageBuildOptions {
  hideThinkingSummary?: boolean;
}

type MessageStreamErrorCode =
  | "provider_stream_error"
  | "upstream_stall_timeout"
  | "adapter_eof"
  | "bridge_parse_error";

interface MessageStreamOptions extends MessageBuildOptions {
  stallTimeoutSec?: number;
  onTerminalError?: (code: MessageStreamErrorCode) => void;
}

type AnthropicErrorType =
  | "api_error"
  | "overloaded_error"
  | "rate_limit_error"
  | "invalid_request_error"
  | "authentication_error"
  | "billing_error"
  | "permission_error"
  | "not_found_error"
  | "request_too_large";

function anthropicError(status: number, type: string, message: string): { type: AnthropicErrorType; message: string } {
  const classified = classifyError(status, type, message);
  let errorType: AnthropicErrorType;
  if (classified.code === "server_is_overloaded") {
    errorType = "overloaded_error";
  } else if (classified.code === "insufficient_quota") {
    errorType = "billing_error";
  } else {
    switch (classified.type) {
      case "rate_limit_error":
      case "invalid_request_error":
      case "authentication_error":
      case "billing_error":
      case "permission_error":
      case "not_found_error":
      case "request_too_large":
        errorType = classified.type;
        break;
      default:
        errorType = "api_error";
        break;
    }
  }
  return { type: errorType, message: classified.message };
}

export function buildMessageJSON(
  events: AdapterEvent[],
  modelId: string,
  options?: MessageBuildOptions,
): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  let currentText = "";
  let currentThinking = "";
  let currentTool: { id: string; name: string; args: string } | null = null;
  let usage: FrogUsage | undefined;
  let errorMessage: string | undefined;
  let stopReason: AdapterStopReason = "end_turn";
  let providerStopReason: AdapterStopReason | undefined;

  const flushText = () => {
    if (!currentText) return;
    content.push({ type: "text", text: currentText });
    currentText = "";
  };
  const flushThinking = () => {
    if (!currentThinking || options?.hideThinkingSummary) {
      currentThinking = "";
      return;
    }
    content.push({ type: "thinking", thinking: currentThinking });
    currentThinking = "";
  };
  const flushTool = () => {
    if (!currentTool) return;
    content.push({
      type: "tool_use",
      id: currentTool.id,
      name: currentTool.name,
      input: parseToolInput(currentTool.args),
    });
    stopReason = "tool_use";
    currentTool = null;
  };

  for (const event of events) {
    switch (event.type) {
      case "text_delta":
        flushThinking();
        flushTool();
        currentText += event.text;
        break;
      case "thinking_delta":
      case "reasoning_raw_delta":
        flushText();
        flushTool();
        currentThinking += event.type === "thinking_delta" ? event.thinking : event.text;
        break;
      case "tool_call_start":
        flushText();
        flushThinking();
        flushTool();
        currentTool = { id: event.id || uuid("toolu"), name: event.name, args: "" };
        break;
      case "tool_call_delta":
        if (currentTool) currentTool.args += event.arguments;
        break;
      case "tool_call_end":
        flushTool();
        break;
      case "diagnostic":
        // Request-log-safe adapter diagnostics are recorded by the server observer, never bridged.
        break;
      case "done":
        usage = event.usage;
        if (event.stopReason) providerStopReason = event.stopReason;
        break;
      case "error":
        errorMessage = event.message;
        break;
    }
  }

  flushText();
  flushThinking();
  flushTool();

  if (errorMessage) {
    return {
      id: uuid(),
      type: "message",
      role: "assistant",
      model: modelId,
      content,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: usageFromAdapter(usage),
      error: { message: errorMessage },
    };
  }

  return {
    id: uuid(),
    type: "message",
    role: "assistant",
    model: modelId,
    content,
    stop_reason: applyStopReason(stopReason, { stopReason: providerStopReason }),
    stop_sequence: null,
    usage: usageFromAdapter(usage),
  };
}

export function bridgeToMessagesSSE(
  events: AsyncIterable<AdapterEvent>,
  modelId: string,
  onCancel?: () => void,
  heartbeatMs = 2_000,
  options?: MessageStreamOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const messageId = uuid();
  let closed = false;
  let upstreamCancelled = false;
  let heartbeat: Timer | undefined;
  let activity = false;

  const cancelUpstream = () => {
    if (upstreamCancelled) return;
    upstreamCancelled = true;
    onCancel?.();
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (name: string, data: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseEvent(name, data)));
        } catch {
          closed = true;
          cancelUpstream();
        }
      };
      const closeController = () => {
        if (closed) return;
        try {
          controller.close();
        } catch {
          // The client may have cancelled between the terminal enqueue and close.
        }
        closed = true;
      };

      emit("message_start", {
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: modelId,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      let index = 0;
      let current: "text" | "thinking" | "tool" | null = null;
      let currentTool: { id: string; name: string; args: string; index: number } | null = null;
      let stopReason: AdapterStopReason = "end_turn";
      let providerStopReason: AdapterStopReason | undefined;
      let usage: FrogUsage | undefined;
      let terminated = false;

      const closeCurrent = () => {
        if (current === null) return;
        emit("content_block_stop", { index: currentTool?.index ?? index - 1 });
        current = null;
        currentTool = null;
      };
      const startText = () => {
        if (current === "text") return;
        closeCurrent();
        emit("content_block_start", { index, content_block: { type: "text", text: "" } });
        current = "text";
        index++;
      };
      const startThinking = () => {
        if (options?.hideThinkingSummary) return;
        if (current === "thinking") return;
        closeCurrent();
        emit("content_block_start", { index, content_block: { type: "thinking", thinking: "" } });
        current = "thinking";
        index++;
      };
      const startTool = (id: string, name: string) => {
        closeCurrent();
        const toolIndex = index++;
        currentTool = { id: id || uuid("toolu"), name, args: "", index: toolIndex };
        current = "tool";
        stopReason = "tool_use";
        emit("content_block_start", {
          index: toolIndex,
          content_block: { type: "tool_use", id: currentTool.id, name, input: {} },
        });
      };
      const emitTerminalError = (
        status: number,
        type: string,
        message: string,
        abort: boolean,
        code: MessageStreamErrorCode,
      ) => {
        if (terminated || closed) return;
        closeCurrent();
        emit("error", { error: anthropicError(status, type, message) });
        terminated = true;
        clearInterval(heartbeat);
        options?.onTerminalError?.(code);
        if (abort) cancelUpstream();
        closeController();
      };

      const stallSec = Math.max(1, options?.stallTimeoutSec ?? 90);
      const maxStallTicks = Math.ceil((stallSec * 1000) / heartbeatMs);
      let stallTicks = 0;
      heartbeat = setInterval(() => {
        if (closed || terminated) return;
        if (activity) {
          activity = false;
          stallTicks = 0;
          return;
        }
        if (++stallTicks >= maxStallTicks) {
          emitTerminalError(502, "upstream_error", "upstream stream stalled", true, "upstream_stall_timeout");
          return;
        }
        try {
          controller.enqueue(encoder.encode(": frogprogsy keepalive\n\n"));
        } catch {
          closed = true;
          cancelUpstream();
        }
      }, heartbeatMs);

      try {
        for await (const event of events) {
          if (closed) break;
          activity = true;
          stallTicks = 0;
          switch (event.type) {
            case "text_delta":
              startText();
              emit("content_block_delta", { index: index - 1, delta: { type: "text_delta", text: event.text } });
              break;
            case "thinking_delta":
            case "reasoning_raw_delta": {
              const text = event.type === "thinking_delta" ? event.thinking : event.text;
              if (options?.hideThinkingSummary) break;
              startThinking();
              emit("content_block_delta", { index: index - 1, delta: { type: "thinking_delta", thinking: text } });
              break;
            }
            case "tool_call_start":
              startTool(event.id, event.name);
              break;
            case "tool_call_delta":
              if (!currentTool) startTool(uuid("toolu"), "tool");
              currentTool!.args += event.arguments;
              emit("content_block_delta", { index: currentTool!.index, delta: { type: "input_json_delta", partial_json: event.arguments } });
              break;
            case "tool_call_end":
              closeCurrent();
              break;
            case "diagnostic":
              // Request-log-safe adapter diagnostics are recorded by the server observer, never bridged.
              break;
            case "done":
              usage = event.usage;
              if (event.stopReason) providerStopReason = event.stopReason;
              terminated = true;
              break;
            case "error":
              emitTerminalError(502, "upstream_error", event.message, true, "provider_stream_error");
              break;
          }
          if (terminated || closed) break;
        }

        if (!closed && terminated) {
          closeCurrent();
          emit("message_delta", {
            delta: { stop_reason: applyStopReason(stopReason, { stopReason: providerStopReason }), stop_sequence: null },
            usage: usageFromAdapter(usage),
          });
          emit("message_stop", {});
          closeController();
        } else if (!closed) {
          emitTerminalError(502, "upstream_error", "upstream stream ended without a terminal event", false, "adapter_eof");
        }
      } catch (err) {
        if (!closed) {
          const message = err instanceof Error ? err.message : String(err);
          emitTerminalError(500, "proxy_error", message, true, "bridge_parse_error");
        }
      } finally {
        clearInterval(heartbeat);
      }
    },
    cancel() {
      closed = true;
      clearInterval(heartbeat);
      cancelUpstream();
    },
  });
}

export function formatAnthropicErrorResponse(
  status: number,
  type: string,
  message: string,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ type: "error", error: anthropicError(status, type, message) }), {
    status,
    headers: responseHeaders,
  });
}
