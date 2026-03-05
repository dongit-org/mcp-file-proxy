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

const TLS_ERROR_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_NOT_YET_VALID",
]);

function getRootCause(error: unknown): Error | undefined {
  let current = error;
  while (current instanceof Error && current.cause instanceof Error) {
    current = current.cause;
  }
  return current instanceof Error ? current : undefined;
}

function formatConnectionError(error: unknown, url: string): string {
  const root = getRootCause(error);
  const code = root && "code" in root ? (root as { code: string }).code : undefined;

  if (code && TLS_ERROR_CODES.has(code)) {
    return `TLS certificate error connecting to ${url}: ${root!.message} (${code}). Use --accept-insecure-certs to bypass certificate verification.`;
  }

  const detail = root?.message || (error instanceof Error ? error.message : String(error));
  return `Failed to connect to ${url}: ${detail}`;
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

  try {
    await remoteClient.connect(transport);
  } catch (error: unknown) {
    const message = formatConnectionError(error, config.url);
    throw new Error(message, { cause: error });
  }

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
