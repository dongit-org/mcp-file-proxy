import { describe, it, expect, vi, beforeEach } from "vitest";
import { clearSchemaCache } from "../src/file-interceptor.js";

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockClient = {
  connect: mockConnect,
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

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => mockClient),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

import { createProxyServer } from "../src/proxy.js";
import type { ProxyConfig } from "../src/config.js";

const testConfig: ProxyConfig = {
  url: "https://example.com/mcp",
  headers: {},
  acceptInsecureCerts: false,
};

const testPkg = { name: "test", version: "0.0.0" };

/**
 * Invokes a request handler on the server by simulating the JSON-RPC flow.
 */
async function invokeHandler(
  server: unknown,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const handlers = (server as { _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>> })._requestHandlers;
  const handler = handlers.get(method);

  if (!handler) {
    throw new Error(`No handler registered for method: ${method}`);
  }

  return handler({ method, params }, {});
}

describe("createProxyServer", () => {
  beforeEach(() => {
    clearSchemaCache();
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
  });

  it("creates a server instance and connects to the remote", async () => {
    const { server, remoteClient } = await createProxyServer(testConfig, testPkg);
    expect(server).toBeDefined();
    expect(remoteClient).toBeDefined();
    expect(mockConnect).toHaveBeenCalled();
  });

  it("throws a descriptive error for TLS certificate failures", async () => {
    const tlsError = new TypeError("fetch failed", {
      cause: new Error("self-signed certificate", {
        cause: Object.assign(new Error("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
      }),
    });
    mockConnect.mockRejectedValueOnce(tlsError);

    await expect(createProxyServer(testConfig, testPkg)).rejects.toThrow(
      /TLS certificate error.*DEPTH_ZERO_SELF_SIGNED_CERT.*--accept-insecure-certs/,
    );
  });

  it("throws a descriptive error for generic connection failures", async () => {
    mockConnect.mockRejectedValueOnce(new Error("Connection refused"));

    await expect(createProxyServer(testConfig, testPkg)).rejects.toThrow(
      /Failed to connect to.*Connection refused/,
    );
  });

  describe("tools/list forwarding", () => {
    it("forwards listTools to remote client", async () => {
      const { server } = await createProxyServer(testConfig, testPkg);
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
      const { server } = await createProxyServer(testConfig, testPkg);

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
      const { server } = await createProxyServer(testConfig, testPkg);

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
      const { server } = await createProxyServer(testConfig, testPkg);
      const result = await invokeHandler(server, "resources/list");

      expect(mockClient.listResources).toHaveBeenCalled();
      expect(result).toEqual({
        resources: [{ uri: "res://test", name: "Test Resource" }],
      });
    });
  });

  describe("resources/templates/list forwarding", () => {
    it("forwards listResourceTemplates to remote client", async () => {
      const { server } = await createProxyServer(testConfig, testPkg);
      const result = await invokeHandler(server, "resources/templates/list");

      expect(mockClient.listResourceTemplates).toHaveBeenCalled();
      expect(result).toEqual({ resourceTemplates: [] });
    });
  });

  describe("resources/read forwarding", () => {
    it("forwards readResource to remote client", async () => {
      const { server } = await createProxyServer(testConfig, testPkg);
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
      const { server } = await createProxyServer(testConfig, testPkg);
      const result = await invokeHandler(server, "prompts/list");

      expect(mockClient.listPrompts).toHaveBeenCalled();
      expect(result).toEqual({
        prompts: [{ name: "test-prompt", description: "A test prompt" }],
      });
    });
  });

  describe("prompts/get forwarding", () => {
    it("forwards getPrompt to remote client", async () => {
      const { server } = await createProxyServer(testConfig, testPkg);
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
