import { describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import type { FrogAssistantMessage, FrogContentPart, FrogToolCall, FrogToolResultMessage } from "../src/types";

function assistantOf(request: ReturnType<typeof parseRequest>, index = 0): FrogAssistantMessage {
  const assistants = request.context.messages.filter(m => m.role === "assistant") as FrogAssistantMessage[];
  const message = assistants[index];
  if (!message) throw new Error(`no assistant message at index ${index}`);
  return message;
}

function toolResults(request: ReturnType<typeof parseRequest>): FrogToolResultMessage[] {
  return request.context.messages.filter(m => m.role === "toolResult") as FrogToolResultMessage[];
}

describe("Responses request parser — request shape", () => {
  test("rejects a body that fails the Responses schema", () => {
    expect(() => parseRequest({ input: "hi" })).toThrow(/responses parse error/);
    expect(() => parseRequest({ model: "", input: "hi" })).toThrow(/responses parse error/);
  });

  test("string input becomes a single user message and instructions become the system prompt", () => {
    const request = parseRequest({ model: "gpt-5", instructions: "be terse", input: "hello", stream: true });
    expect(request.modelId).toBe("gpt-5");
    expect(request.stream).toBe(true);
    expect(request.context.systemPrompt).toEqual(["be terse"]);
    expect(request.context.messages).toHaveLength(1);
    expect(request.context.messages[0]).toMatchObject({ role: "user", content: "hello" });
  });

  test("empty instructions and a missing input yield no system prompt and no messages", () => {
    const request = parseRequest({ model: "gpt-5", instructions: "" });
    expect(request.context.systemPrompt).toBeUndefined();
    expect(request.context.messages).toEqual([]);
    expect(request.stream).toBe(false);
  });

  test("previous_response_id is preserved only when present", () => {
    expect(parseRequest({ model: "gpt-5", previous_response_id: "resp_1" }).previousResponseId).toBe("resp_1");
    expect(parseRequest({ model: "gpt-5" }).previousResponseId).toBeUndefined();
  });
});

describe("Responses request parser — input items", () => {
  test("system items append to the system prompt and empty ones are dropped", () => {
    const request = parseRequest({
      model: "gpt-5",
      instructions: "base",
      input: [
        { type: "message", role: "system", content: [{ type: "input_text", text: "extra" }] },
        { type: "message", role: "system", content: [] },
      ],
    });
    expect(request.context.systemPrompt).toEqual(["base", "extra"]);
    expect(request.context.messages).toEqual([]);
  });

  test("developer and user items keep their role, and images stay structured content parts", () => {
    const request = parseRequest({
      model: "gpt-5",
      input: [
        { role: "developer", content: "dev note" },
        {
          role: "user",
          content: [
            { type: "input_text", text: "look" },
            { type: "input_image", image_url: "data:image/png;base64,AAA", detail: "high" },
            { type: "input_image", file_id: "file_1" },
            { type: "input_file", file_id: "file_2" },
            { type: "input_file", filename: "notes.md" },
          ],
        },
      ],
    });
    expect(request.context.messages[0]).toMatchObject({ role: "developer", content: "dev note" });
    expect(request.context.messages[1]?.content).toEqual([
      { type: "text", text: "look" },
      { type: "image", imageUrl: "data:image/png;base64,AAA", detail: "high" },
      { type: "text", text: "[image: file_1]" },
      { type: "text", text: "[file: file_2]" },
      { type: "text", text: "[file: notes.md]" },
    ] satisfies FrogContentPart[]);
  });

  test("an input_image with neither image_url nor file_id is rejected by the schema", () => {
    expect(() => parseRequest({ model: "gpt-5", input: [{ role: "user", content: [{ type: "input_image" }] }] }))
      .toThrow(/responses parse error/);
  });

  test("assistant items map output_text, text and refusal blocks", () => {
    const request = parseRequest({
      model: "gpt-5",
      input: [
        {
          role: "assistant",
          content: [
            { type: "output_text", text: "one" },
            { type: "text", text: "two" },
            { type: "refusal", refusal: "policy" },
          ],
        },
      ],
    });
    expect(assistantOf(request).content).toEqual([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
      { type: "text", text: "[refusal: policy]" },
    ]);
  });

  test("an assistant item with a string body keeps the text, and an empty string produces no parts", () => {
    expect(assistantOf(parseRequest({ model: "gpt-5", input: [{ role: "assistant", content: "done" }] })).content)
      .toEqual([{ type: "text", text: "done" }]);
    expect(assistantOf(parseRequest({ model: "gpt-5", input: [{ role: "assistant", content: "" }] })).content).toEqual([]);
  });

  test("reasoning items become thinking content, preferring summary over content text", () => {
    const request = parseRequest({
      model: "gpt-5",
      input: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "sum" }], content: [{ type: "reasoning_text", text: "raw" }] },
        { type: "reasoning", content: [{ type: "reasoning_text", text: "raw only" }] },
      ],
    });
    const parts = assistantOf(request).content;
    expect(parts[0]).toMatchObject({ type: "thinking", thinking: "sum", itemId: "rs_1" });
    expect(parts[1]).toMatchObject({ type: "thinking", thinking: "raw only" });
    expect(parts[1]).not.toHaveProperty("itemId");
    expect(JSON.parse((parts[0] as { signature: string }).signature)).toMatchObject({ id: "rs_1" });
  });

  test("function_call items carry parsed arguments and tolerate empty or non-JSON arguments", () => {
    const request = parseRequest({
      model: "gpt-5",
      input: [
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "Read", arguments: '{"path":"a.ts"}', namespace: "mcp" },
        { type: "function_call", call_id: "call_2", name: "Ls", arguments: "  " },
        { type: "function_call", call_id: "call_3", name: "Broken", arguments: "not json" },
        { type: "function_call", call_id: "call_4", name: "Scalar", arguments: "42" },
      ],
    });
    const calls = assistantOf(request).content as FrogToolCall[];
    expect(calls[0]).toMatchObject({ id: "call_1", name: "Read", arguments: { path: "a.ts" }, thoughtSignature: "fc_1", namespace: "mcp" });
    expect(calls[1]).toMatchObject({ id: "call_2", arguments: {} });
    expect(calls[1]).not.toHaveProperty("thoughtSignature");
    expect(calls[2]?.arguments).toEqual({});
    expect(calls[3]?.arguments).toEqual({});
  });

  test("custom_tool_call keeps the raw body under `input` and records the wire name", () => {
    const request = parseRequest({
      model: "gpt-5",
      input: [{ type: "custom_tool_call", id: "ct_1", call_id: "call_1", name: "apply_patch", input: "*** Begin Patch" }],
    });
    expect((assistantOf(request).content as FrogToolCall[])[0]).toMatchObject({
      id: "call_1",
      name: "apply_patch",
      customWireName: "apply_patch",
      thoughtSignature: "ct_1",
      arguments: { input: "*** Begin Patch" },
    });
  });

  test("function_call_output resolves the tool name and namespace from the matching call", () => {
    const request = parseRequest({
      model: "gpt-5",
      input: [
        { type: "function_call", call_id: "call_1", name: "Read", namespace: "mcp", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "file body" },
        { type: "function_call_output", call_id: "unknown", output: "orphan" },
      ],
    });
    const results = toolResults(request);
    expect(results[0]).toMatchObject({ toolCallId: "call_1", toolName: "Read", toolNamespace: "mcp", content: "file body", isError: false });
    expect(results[1]).toMatchObject({ toolCallId: "unknown", toolName: "", content: "orphan" });
  });

  test("function_call_output content flattens to text, and keeps parts when an image is present", () => {
    const textOnly = parseRequest({
      model: "gpt-5",
      input: [{ type: "function_call_output", call_id: "call_1", output: [{ type: "output_text", text: "a" }, { type: "refusal", refusal: "no" }] }],
    });
    expect(toolResults(textOnly)[0]?.content).toBe("a[refusal: no]");

    const withImage = parseRequest({
      model: "gpt-5",
      input: [{
        type: "function_call_output",
        call_id: "call_1",
        output: [{ type: "text", text: "shot" }, { type: "input_image", image_url: "https://img/2.png", detail: "low" }, { type: "input_image" }, "junk"],
      }],
    });
    expect(toolResults(withImage)[0]?.content).toEqual([
      { type: "text", text: "shot" },
      { type: "image", imageUrl: "https://img/2.png", detail: "low" },
    ]);

    const missingOutput = parseRequest({ model: "gpt-5", input: [{ type: "function_call_output", call_id: "call_1" }] });
    expect(toolResults(missingOutput)[0]?.content).toBe("");
  });

  test("custom_tool_call_output pairs with its custom call", () => {
    const request = parseRequest({
      model: "gpt-5",
      input: [
        { type: "custom_tool_call", call_id: "call_1", name: "apply_patch", input: "patch" },
        { type: "custom_tool_call_output", call_id: "call_1", output: "applied" },
      ],
    });
    expect(toolResults(request)[0]).toMatchObject({ toolCallId: "call_1", toolName: "apply_patch", content: "applied" });
  });

  test("tool_search_call and tool_search_output round-trip into history plus re-injected tools", () => {
    const request = parseRequest({
      model: "gpt-5",
      input: [
        { type: "tool_search_call", id: "ts_1", arguments: { query: "docs" } },
        {
          type: "tool_search_output",
          call_id: "ts_1",
          tools: [
            { type: "function", name: "Explore", description: "explore" },
            { type: "namespace", name: "mcp", tools: [{ type: "function", name: "Fetch" }] },
          ],
        },
      ],
    });
    const call = (assistantOf(request).content as FrogToolCall[])[0];
    expect(call).toMatchObject({ id: "ts_1", name: "tool_search", arguments: { query: "docs" } });
    expect(toolResults(request)[0]?.content).toContain("Explore, mcp__Fetch");
    expect(request.context.tools?.map(t => t.name)).toEqual(["Explore", "Fetch"]);
  });

  test("a tool_search_output without tools reports that nothing was loaded", () => {
    const request = parseRequest({ model: "gpt-5", input: [{ type: "tool_search_output", tools: [] }] });
    expect(toolResults(request)[0]).toMatchObject({ toolCallId: "", content: "Tool search returned no tools." });
  });

  test("unknown item types are ignored", () => {
    const request = parseRequest({ model: "gpt-5", input: [{ type: "image_generation_call", result: "..." }] });
    expect(request.context.messages).toEqual([]);
  });
});

describe("Responses request parser — tools", () => {
  test("function, namespace, custom, tool_search and unmodelled tools are exposed; hosted tools are dropped", () => {
    const request = parseRequest({
      model: "gpt-5",
      tools: [
        { type: "function", name: "Read", description: "read", parameters: { type: "object" }, strict: true },
        { type: "namespace", name: "mcp", tools: [{ type: "function", name: "Fetch" }, { type: "function" }, "junk"] },
        { type: "custom", name: "apply_patch" },
        { type: "tool_search" },
        { type: "computer_use_preview", name: "computer" },
        { type: "web_search" },
        { type: "image_generation" },
        { type: "mcp" },
      ],
    });
    const tools = request.context.tools ?? [];
    expect(tools.map(t => t.name)).toEqual(["Read", "Fetch", "apply_patch", "tool_search", "computer"]);
    expect(tools[0]).toMatchObject({ description: "read", strict: true });
    expect(tools[1]).toMatchObject({ namespace: "mcp", description: "" });
    expect(tools[2]).toMatchObject({ freeform: true, parameters: { type: "object", required: ["input"] } });
    expect(tools[3]).toMatchObject({ toolSearch: true });
    expect(request._webSearch).toEqual({ type: "web_search" });
  });

  test("a tool_search tool keeps caller-supplied parameters and description", () => {
    const request = parseRequest({
      model: "gpt-5",
      tools: [{ type: "tool_search", description: "find tools", parameters: { type: "object", properties: { q: { type: "string" } } } }],
    });
    expect(request.context.tools?.[0]).toMatchObject({
      name: "tool_search",
      description: "find tools",
      parameters: { type: "object", properties: { q: { type: "string" } } },
    });
  });

  test("declared tools win over duplicate tool_search-loaded specs", () => {
    const request = parseRequest({
      model: "gpt-5",
      tools: [{ type: "function", name: "Read", description: "declared" }],
      input: [{ type: "tool_search_output", call_id: "ts_1", tools: [{ type: "function", name: "Read", description: "loaded" }, { type: "function", name: "Grep" }] }],
    });
    expect(request.context.tools?.map(t => [t.name, t.description])).toEqual([["Read", "declared"], ["Grep", ""]]);
  });

  test("no tools key is emitted when nothing survives filtering", () => {
    const request = parseRequest({ model: "gpt-5", tools: [{ type: "web_search" }] });
    expect(request.context.tools).toBeUndefined();
  });
});

describe("Responses request parser — options", () => {
  test("sampling, penalty and stop options map through", () => {
    const request = parseRequest({
      model: "gpt-5",
      max_output_tokens: 512,
      temperature: 0.3,
      top_p: 0.8,
      stop: ["END"],
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
    });
    expect(request.options).toMatchObject({
      maxOutputTokens: 512,
      temperature: 0.3,
      topP: 0.8,
      stopSequences: ["END"],
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
    });
  });

  test("a string stop becomes a one-element list and null stop is ignored", () => {
    expect(parseRequest({ model: "gpt-5", stop: "END" }).options.stopSequences).toEqual(["END"]);
    expect(parseRequest({ model: "gpt-5", stop: null }).options.stopSequences).toBeUndefined();
  });

  test("tool_choice maps literals, named function/custom choices and hosted choices", () => {
    expect(parseRequest({ model: "gpt-5", tool_choice: "required" }).options.toolChoice).toBe("required");
    expect(parseRequest({ model: "gpt-5", tool_choice: { type: "function", name: "Read" } }).options.toolChoice).toEqual({ name: "Read" });
    expect(parseRequest({ model: "gpt-5", tool_choice: { type: "custom", name: "apply_patch" } }).options.toolChoice).toEqual({ name: "apply_patch" });
    expect(parseRequest({ model: "gpt-5", tool_choice: { type: "image_generation" } }).options.toolChoice).toBe("auto");
    expect(parseRequest({ model: "gpt-5" }).options.toolChoice).toBeUndefined();
  });

  test("only known reasoning efforts are forwarded", () => {
    expect(parseRequest({ model: "gpt-5", reasoning: { effort: "xhigh" } }).options.reasoning).toBe("xhigh");
    expect(parseRequest({ model: "gpt-5", reasoning: { effort: "turbo" } }).options.reasoning).toBeUndefined();
    expect(parseRequest({ model: "gpt-5", reasoning: null }).options.reasoning).toBeUndefined();
  });

  test("thinking summaries stay hidden unless a summary mode other than none is requested", () => {
    expect(parseRequest({ model: "gpt-5" }).options.hideThinkingSummary).toBe(true);
    expect(parseRequest({ model: "gpt-5", reasoning: { summary: "none" } }).options.hideThinkingSummary).toBe(true);
    expect(parseRequest({ model: "gpt-5", reasoning: { summary: "auto" } }).options.hideThinkingSummary).toBeUndefined();
  });

  test("structured output is flagged only for json_schema/json_object text formats", () => {
    expect(parseRequest({ model: "gpt-5", text: { format: { type: "json_schema", schema: {} } } })._structuredOutput).toBe(true);
    expect(parseRequest({ model: "gpt-5", text: { format: { type: "json_object" } } })._structuredOutput).toBe(true);
    expect(parseRequest({ model: "gpt-5", text: { format: { type: "text" } } })._structuredOutput).toBeUndefined();
    expect(parseRequest({ model: "gpt-5", text: { format: "json_object" } })._structuredOutput).toBeUndefined();
    expect(parseRequest({ model: "gpt-5", text: "json" })._structuredOutput).toBeUndefined();
  });

  test("the raw body is preserved verbatim for downstream passthrough", () => {
    const body = { model: "gpt-5", input: "hi" };
    expect(parseRequest(body)._rawBody).toBe(body);
  });
});
