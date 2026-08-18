import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server as HttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createProxyServer } from "../src/proxy.js";
import type { ProxyConfig } from "../src/config.js";
import { generateTestPki, removeTestPki, type TestPki } from "./helpers/certs.js";

let pki: TestPki | undefined;
let httpsServer: HttpsServer | undefined;
let mcpUrl: string;
let savedRejectUnauthorized: string | undefined;
let lastAuthorization: string | undefined;

const testPkg = { name: "test-proxy", version: "0.0.0" };

/**
 * Serves a minimal MCP server over HTTPS with a required client certificate,
 * using a stateless streamable HTTP transport per request.
 */
beforeAll(async () => {
  savedRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  pki = generateTestPki();

  httpsServer = createServer(
    {
      key: readFileSync(pki.serverKey),
      cert: readFileSync(pki.serverCert),
      ca: readFileSync(pki.caCert),
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      lastAuthorization = req.headers.authorization;
      void (async () => {
        const mcpServer = new Server(
          { name: "test-remote", version: "1.0.0" },
          { capabilities: { tools: {} } },
        );
        mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [
            {
              name: "remote-tool",
              description: "A tool on the mTLS-protected remote",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        }));

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          void transport.close();
          void mcpServer.close();
        });

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
      })().catch(() => {
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end();
      });
    },
  );

  const listeningServer = httpsServer;
  await new Promise<void>((resolve) => listeningServer.listen(0, "127.0.0.1", resolve));
  const { port } = listeningServer.address() as AddressInfo;
  mcpUrl = `https://localhost:${port}/mcp`;
});

afterAll(async () => {
  const runningServer = httpsServer;
  if (runningServer) {
    runningServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      runningServer.close((err) => (err ? reject(err) : resolve())),
    );
  }
  if (pki) {
    removeTestPki(pki);
  }

  if (savedRejectUnauthorized !== undefined) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedRejectUnauthorized;
  }
});

describe("createProxyServer against an mTLS remote", () => {
  it("connects and forwards tool listings when a client certificate is configured", async () => {
    const config: ProxyConfig = {
      url: mcpUrl,
      headers: {},
      acceptInsecureCerts: false,
      tls: {
        certPath: pki!.clientCert,
        keyPath: pki!.clientKey,
        caPath: pki!.caCert,
      },
    };

    const { remoteClient } = await createProxyServer(config, testPkg);
    try {
      const result = await remoteClient.listTools();
      expect(result.tools).toEqual([
        expect.objectContaining({ name: "remote-tool" }),
      ]);
    } finally {
      await remoteClient.close();
    }
  });

  it("forwards MCP_HEADERS through the mTLS fetch", async () => {
    lastAuthorization = undefined;
    const config: ProxyConfig = {
      url: mcpUrl,
      headers: { Authorization: "Bearer test-token" },
      acceptInsecureCerts: false,
      tls: {
        certPath: pki!.clientCert,
        keyPath: pki!.clientKey,
        caPath: pki!.caCert,
      },
    };

    const { remoteClient } = await createProxyServer(config, testPkg);
    try {
      await remoteClient.listTools();
      expect(lastAuthorization).toBe("Bearer test-token");
    } finally {
      await remoteClient.close();
    }
  });

  it("fails with an mTLS hint when no client certificate is configured", async () => {
    const config: ProxyConfig = {
      url: mcpUrl,
      headers: {},
      acceptInsecureCerts: false,
      tls: { caPath: pki!.caCert },
    };

    await expect(createProxyServer(config, testPkg)).rejects.toThrow(
      /set MCP_CLIENT_CERT and MCP_CLIENT_KEY/,
    );
  });
});
