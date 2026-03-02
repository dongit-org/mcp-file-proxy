import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { registerToolSchema, interceptFileArguments } from "./file-interceptor.js";
import type { ProxyConfig } from "./config.js";

export interface PackageInfo {
  name: string;
  version: string;
}

export interface ProxyServer {
  server: Server;
  remoteClient: Client;
}

/**
 * Connects to the remote MCP server and creates a local proxy server that
 * forwards all requests to it. Tool calls are intercepted via
 * {@link interceptFileArguments} to map local file paths
 * into base64-encoded content before forwarding.
 * @param config - Proxy configuration containing the remote URL and headers.
 * @param pkg - Package metadata used to identify this proxy.
 * @returns The local MCP {@link Server} and the connected remote {@link Client}.
 */
export async function createProxyServer(config: ProxyConfig, pkg: PackageInfo): Promise<ProxyServer> {
  const remoteClient = new Client(
    { name: pkg.name, version: pkg.version },
    { capabilities: {} },
  );

  const url = new URL(config.url);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: config.headers },
  });

  await remoteClient.connect(transport);

  const server = new Server(
    { name: pkg.name, version: pkg.version },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const result = await remoteClient.listTools(request.params);

    for (const tool of result.tools) {
      registerToolSchema(tool);
    }

    return result;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const interceptedArgs = args
      ? await interceptFileArguments(name, args)
      : args;

    return await remoteClient.callTool({
      name,
      arguments: interceptedArgs,
    });
  });

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    return await remoteClient.listResources(request.params);
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    return await remoteClient.listResourceTemplates(request.params);
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return await remoteClient.readResource(request.params);
  });

  server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    return await remoteClient.listPrompts(request.params);
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    return await remoteClient.getPrompt(request.params);
  });

  return { server, remoteClient };
}
