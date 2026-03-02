import { describe, it, expect, vi, beforeEach } from "vitest";
import { createProxyServer } from "../src/proxy.js";
import { clearSchemaCache } from "../src/file-interceptor.js";

function createMockClient() {
  return {
    listTools: vi.fn().mockResolvedValue({
      tools: [
        {
          name: "test-tool",
          description: "A test tool",
          inputSchema: {
            type: "object",
            properties: {
              file: { type: "string", format: "binary", description: "The raw document data" },
              name: { type: "string", description: "A name" },
            },
          },
        },
      ],
    }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "result" }],
    }),
    listResources: vi.fn().mockResolvedValue({
      resources: [{ uri: "res://test", name: "Test Resource" }],
    }),
    listResourceTemplates: vi.fn().mockResolvedValue({
      resourceTemplates: [],
    }),
    readResource: vi.fn().mockResolvedValue({
      contents: [{ uri: "res://test", text: "content" }],
    }),
    listPrompts: vi.fn().mockResolvedValue({
      prompts: [{ name: "test-prompt", description: "A test prompt" }],
    }),
    getPrompt: vi.fn().mockResolvedValue({
      messages: [{ role: "user", content: { type: "text", text: "hello" } }],
    }),
  };
}

type MockClient = ReturnType<typeof createMockClient>;

/**
 * Invokes a request handler on the server by simulating the JSON-RPC flow.
 * We access the internal handler map via the protected setRequestHandler
 * registration that was done during createProxyServer.
 */
async function invokeHandler(
  server: ReturnType<typeof createProxyServer>,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  // The Server class stores handlers internally. We can trigger them
  // by accessing _requestHandlers which is set by setRequestHandler.
  const handlers = (server as unknown as { _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>> })._requestHandlers;
  const handler = handlers.get(method);

  if (!handler) {
    throw new Error(`No handler registered for method: ${method}`);
  }

  return handler({ method, params }, {});
}

describe("createProxyServer", () => {
  let mockClient: MockClient;

  beforeEach(() => {
    clearSchemaCache();
    mockClient = createMockClient();
  });

  it("creates a server instance", () => {
    const server = createProxyServer(mockClient as never, { name: "test", version: "0.0.0" });
    expect(server).toBeDefined();
  });

  describe("tools/list forwarding", () => {
    it("forwards listTools to remote client", async () => {
      const server = createProxyServer(mockClient as never, { name: "test", version: "0.0.0" });
      const result = await invokeHandler(server, "tools/list");

      expect(mockClient.listTools).toHaveBeenCalled();
      expect(result).toEqual({
        tools: [
          expect.objectContaining({ name: "test-tool" }),
        ],
      });
    });
  });

  describe("tools/call forwarding", () => {
    it("forwards callTool to remote client", async () => {
      const server = createProxyServer(mockClient as never, { name: "test", version: "0.0.0" });

      // First list tools to register schemas
      await invokeHandler(server, "tools/list");

      const result = await invokeHandler(server, "tools/call", {
        name: "test-tool",
        arguments: { name: "doc.pdf" },
      });

      expect(mockClient.callTool).toHaveBeenCalledWith({
        name: "test-tool",
        arguments: { name: "doc.pdf" },
      });
      expect(result).toEqual({
        content: [{ type: "text", text: "result" }],
      });
    });

    it("passes through undefined arguments", async () => {
      const server = createProxyServer(mockClient as never, { name: "test", version: "0.0.0" });

      await invokeHandler(server, "tools/call", {
        name: "test-tool",
      });

      expect(mockClient.callTool).toHaveBeenCalledWith({
        name: "test-tool",
        arguments: undefined,
      });
    });
  });

  describe("resources/list forwarding", () => {
    it("forwards listResources to remote client", async () => {
      const server = createProxyServer(mockClient as never, { name: "test", version: "0.0.0" });
      const result = await invokeHandler(server, "resources/list");

      expect(mockClient.listResources).toHaveBeenCalled();
      expect(result).toEqual({
        resources: [{ uri: "res://test", name: "Test Resource" }],
      });
    });
  });

  describe("resources/templates/list forwarding", () => {
    it("forwards listResourceTemplates to remote client", async () => {
      const server = createProxyServer(mockClient as never, { name: "test", version: "0.0.0" });
      const result = await invokeHandler(server, "resources/templates/list");

      expect(mockClient.listResourceTemplates).toHaveBeenCalled();
      expect(result).toEqual({ resourceTemplates: [] });
    });
  });

  describe("resources/read forwarding", () => {
    it("forwards readResource to remote client", async () => {
      const server = createProxyServer(mockClient as never, { name: "test", version: "0.0.0" });
      const result = await invokeHandler(server, "resources/read", {
        uri: "res://test",
      });

      expect(mockClient.readResource).toHaveBeenCalledWith({ uri: "res://test" });
      expect(result).toEqual({
        contents: [{ uri: "res://test", text: "content" }],
      });
    });
  });

  describe("prompts/list forwarding", () => {
    it("forwards listPrompts to remote client", async () => {
      const server = createProxyServer(mockClient as never, { name: "test", version: "0.0.0" });
      const result = await invokeHandler(server, "prompts/list");

      expect(mockClient.listPrompts).toHaveBeenCalled();
      expect(result).toEqual({
        prompts: [{ name: "test-prompt", description: "A test prompt" }],
      });
    });
  });

  describe("prompts/get forwarding", () => {
    it("forwards getPrompt to remote client", async () => {
      const server = createProxyServer(mockClient as never, { name: "test", version: "0.0.0" });
      const result = await invokeHandler(server, "prompts/get", {
        name: "test-prompt",
      });

      expect(mockClient.getPrompt).toHaveBeenCalledWith({ name: "test-prompt" });
      expect(result).toEqual({
        messages: [{ role: "user", content: { type: "text", text: "hello" } }],
      });
    });
  });
});
