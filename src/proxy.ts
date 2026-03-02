import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
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
import type { PackageInfo } from "./remote-client.js";

export function createProxyServer(remoteClient: Client, pkg: PackageInfo): Server {
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
      ? interceptFileArguments(name, args)
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

  return server;
}
