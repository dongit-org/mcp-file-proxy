import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ProxyConfig } from "./config.js";

export interface PackageInfo {
  name: string;
  version: string;
}

export async function createRemoteClient(config: ProxyConfig, pkg: PackageInfo): Promise<Client> {
  const client = new Client(
    { name: pkg.name, version: pkg.version },
    { capabilities: {} },
  );

  const url = new URL(config.url);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: config.headers },
  });

  await client.connect(transport);

  return client;
}
