#!/usr/bin/env node

import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createRemoteClient } from "./remote-client.js";
import { createProxyServer } from "./proxy.js";

const require = createRequire(import.meta.url);
const { name, version } = require("../package.json") as { name: string; version: string };

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.acceptInsecureCerts) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    console.warn("TLS certificate verification disabled (--accept-insecure-certs)");
  }

  const remoteClient = await createRemoteClient(config, { name, version });
  const server = createProxyServer(remoteClient, { name, version });
  const transport = new StdioServerTransport();

  await server.connect(transport);

  const shutdown = async (): Promise<void> => {
    try {
      await server.close();
    } catch (_: unknown) { /* shutting down */ }

    try {
      await remoteClient.close();
    } catch (_: unknown) { /* shutting down */ }

    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(`Fatal: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
