import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:https";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import { readFileSync, writeFileSync } from "node:fs";
import { TLSSocket } from "node:tls";
import { createTlsFetch } from "../src/tls.js";
import type { ProxyConfig } from "../src/config.js";
import { join } from "node:path";
import { generateTestPki, removeTestPki, type TestPki } from "./helpers/certs.js";

let pki: TestPki | undefined;
let server: Server | undefined;
let plainServer: HttpServer | undefined;
let baseUrl: string;
let plainUrl: string;
let proxyServer: HttpServer | undefined;
let proxyUrl: string;
let tunnelled = 0;
const tunnelSockets: Duplex[] = [];
const savedProxyEnv: Record<string, string | undefined> = {};
let savedRejectUnauthorized: string | undefined;

function makeConfig(overrides: Partial<ProxyConfig>): ProxyConfig {
  return {
    url: baseUrl,
    headers: {},
    acceptInsecureCerts: false,
    ...overrides,
  };
}

/** Returns the TCP port a listening server is bound to. */
function listeningPort(server: { address(): { port: number } | string | null }): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected the server to be listening on a TCP port");
  }
  return address.port;
}

/** Walks the cause chain and returns the deepest error's code. */
function rootCode(error: unknown): unknown {
  let current = error;
  while (current instanceof Error && current.cause instanceof Error) {
    current = current.cause;
  }
  return current instanceof Error && "code" in current ? current.code : undefined;
}

beforeAll(async () => {
  // Keep server certificate verification deterministic regardless of the
  // developer's shell environment.
  savedRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
    savedProxyEnv[name] = process.env[name];
    delete process.env[name];
  }

  pki = generateTestPki();

  const httpsServer = createServer(
    {
      key: readFileSync(pki.serverKey),
      cert: readFileSync(pki.serverCert),
      ca: readFileSync(pki.caCert),
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "https://elsewhere.invalid/" });
        res.end();
        return;
      }
      if (req.url === "/mcp") {
        res.writeHead(302, { location: "/mcp/" });
        res.end();
        return;
      }
      if (req.url === "/loop") {
        res.writeHead(302, { location: "/loop" });
        res.end();
        return;
      }

      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        const peer = req.socket instanceof TLSSocket ? req.socket.getPeerCertificate() : undefined;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          clientCN: peer?.subject?.CN ?? null,
          method: req.method,
          path: req.url,
          body,
        }));
      });
    },
  );
  server = httpsServer;

  await new Promise<void>((resolve) => httpsServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `https://localhost:${listeningPort(httpsServer)}/`;

  // A server that needs no TLS settings at all, to prove the redirect policy
  // does not depend on MCP_CA_CERT or MCP_CLIENT_CERT being configured.
  const httpServer = createHttpServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "https://elsewhere.invalid/" });
      res.end();
      return;
    }
    if (req.url === "/mcp") {
      res.writeHead(302, { location: "/mcp/" });
      res.end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ method: req.method, path: req.url, body }));
    });
  });
  plainServer = httpServer;

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  plainUrl = `http://127.0.0.1:${listeningPort(httpServer)}/`;

  // A CONNECT proxy, to prove requests are tunnelled rather than sent direct.
  const tunnelServer = createHttpServer((_req, res) => { res.writeHead(405); res.end(); });
  tunnelServer.on("connect", (req, clientSocket, head) => {
    tunnelled += 1;
    tunnelSockets.push(clientSocket);
    const [, port] = (req.url ?? "").split(":");
    const upstream = netConnect(Number(port), "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    tunnelSockets.push(upstream);
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  proxyServer = tunnelServer;

  await new Promise<void>((resolve) => tunnelServer.listen(0, "127.0.0.1", resolve));
  proxyUrl = `http://127.0.0.1:${listeningPort(tunnelServer)}`;
});

afterAll(async () => {
  const runningServer = server;
  if (runningServer) {
    runningServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      runningServer.close((err) => (err ? reject(err) : resolve())),
    );
  }
  const runningPlainServer = plainServer;
  if (runningPlainServer) {
    runningPlainServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      runningPlainServer.close((err) => (err ? reject(err) : resolve())),
    );
  }
  for (const socket of tunnelSockets) {
    socket.destroy();
  }
  const runningProxy = proxyServer;
  if (runningProxy) {
    runningProxy.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      runningProxy.close((err) => (err ? reject(err) : resolve())),
    );
  }
  if (pki) {
    removeTestPki(pki);
  }

  for (const [name, value] of Object.entries(savedProxyEnv)) {
    if (value !== undefined) {
      process.env[name] = value;
    }
  }

  if (savedRejectUnauthorized !== undefined) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedRejectUnauthorized;
  }
});

describe("createTlsFetch", () => {
  it("returns a fetch even when no TLS settings are configured", () => {
    expect(typeof createTlsFetch(makeConfig({}))).toBe("function");
  });

  it("presents the client certificate to a server requiring mTLS", async () => {
    const fetch = createTlsFetch(makeConfig({
      tls: { certPath: pki!.clientCert, keyPath: pki!.clientKey, caPath: pki!.caCert },
    }));

    const response = await fetch(baseUrl);

    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({ clientCN: "test-client" });
  });

  it("supports a passphrase-encrypted client key", async () => {
    const fetch = createTlsFetch(makeConfig({
      tls: {
        certPath: pki!.clientCert,
        keyPath: pki!.clientKeyEncrypted,
        keyPassphrase: pki!.clientKeyPassphrase,
        caPath: pki!.caCert,
      },
    }));

    const response = await fetch(baseUrl);

    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({ clientCN: "test-client" });
  });

  it("fails against an mTLS server when no client certificate is configured", async () => {
    const fetch = createTlsFetch(makeConfig({
      tls: { caPath: pki!.caCert },
    }));

    const error = await fetch(baseUrl).then(
      () => { throw new Error("expected the fetch to reject"); },
      (e: unknown) => e,
    );

    // The server aborts the handshake when no certificate is presented; the
    // exact code varies by platform and TLS version.
    expect([
      "UND_ERR_SOCKET",
      "ECONNRESET",
      "EPIPE",
      "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED",
      "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
      "ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE",
    ]).toContain(rootCode(error));
  });

  it("rejects a server signed by an unknown CA when no CA bundle is configured", async () => {
    const fetch = createTlsFetch(makeConfig({
      tls: { certPath: pki!.clientCert, keyPath: pki!.clientKey },
    }));

    const error = await fetch(baseUrl).then(
      () => { throw new Error("expected the fetch to reject"); },
      (e: unknown) => e,
    );

    expect([
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
    ]).toContain(rootCode(error));
  });

  it("skips server certificate verification with acceptInsecureCerts", async () => {
    const fetch = createTlsFetch(makeConfig({
      acceptInsecureCerts: true,
      tls: { certPath: pki!.clientCert, keyPath: pki!.clientKey },
    }));

    const response = await fetch(baseUrl);

    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({ clientCN: "test-client" });
  });

  it("refuses a redirect that leaves the configured origin", async () => {
    const fetch = createTlsFetch(makeConfig({
      tls: { certPath: pki!.clientCert, keyPath: pki!.clientKey, caPath: pki!.caCert },
    }));

    await expect(fetch(`${baseUrl}redirect`)).rejects.toThrow(
      /Refusing to follow the redirect from .*redirect to https:\/\/elsewhere\.invalid\/: it leaves https:\/\/localhost:\d+/,
    );
  });

  it("follows a same-origin redirect, keeping the method and body", async () => {
    const fetch = createTlsFetch(makeConfig({
      tls: { certPath: pki!.clientCert, keyPath: pki!.clientKey, caPath: pki!.caCert },
    }));

    const response = await fetch(`${baseUrl}mcp`, {
      method: "POST",
      body: '{"jsonrpc":"2.0"}',
      headers: { "content-type": "application/json" },
    });

    expect(response.ok).toBe(true);
    // A reverse proxy redirecting /mcp to /mcp/ must not turn the message
    // POST into a bodyless GET, which is what fetch does with a 302.
    expect(await response.json()).toMatchObject({
      method: "POST",
      path: "/mcp/",
      body: '{"jsonrpc":"2.0"}',
    });
  });

  it("gives up on a redirect loop instead of spinning", async () => {
    const fetch = createTlsFetch(makeConfig({
      tls: { certPath: pki!.clientCert, keyPath: pki!.clientKey, caPath: pki!.caCert },
    }));

    await expect(fetch(`${baseUrl}loop`)).rejects.toThrow(/Stopped after 5 redirects/);
  });

  it("applies the redirect policy when no TLS is configured", async () => {
    const fetch = createTlsFetch(makeConfig({ url: plainUrl }));

    await expect(fetch(`${plainUrl}redirect`)).rejects.toThrow(
      /Refusing to follow the redirect/,
    );
  });

  it("follows a same-origin redirect when no TLS is configured", async () => {
    const fetch = createTlsFetch(makeConfig({ url: plainUrl }));

    const response = await fetch(`${plainUrl}mcp`, { method: "POST", body: '{"jsonrpc":"2.0"}' });

    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({
      method: "POST",
      path: "/mcp/",
      body: '{"jsonrpc":"2.0"}',
    });
  });

  it("fails at startup when a PEM file cannot be read", () => {
    expect(() => createTlsFetch(makeConfig({
      tls: { certPath: "/nonexistent/client.crt", keyPath: pki!.clientKey },
    }))).toThrow(/Cannot read the MCP_CLIENT_CERT file at \/nonexistent\/client\.crt/);
  });

  it("fails at startup when the key passphrase is wrong", () => {
    expect(() => createTlsFetch(makeConfig({
      tls: {
        certPath: pki!.clientCert,
        keyPath: pki!.clientKeyEncrypted,
        keyPassphrase: "not-the-passphrase",
        caPath: pki!.caCert,
      },
    }))).toThrow("MCP_CLIENT_KEY_PASSPHRASE does not decrypt MCP_CLIENT_KEY");
  });

  /** Writes a bad CA bundle into the throwaway PKI directory. */
  function writeCaFile(name: string, contents: string): string {
    const path = join(pki!.dir, name);
    writeFileSync(path, contents);
    return path;
  }

  it("fails at startup when the CA bundle holds no certificate", () => {
    const caPath = writeCaFile("garbage.crt", "not a pem at all\n");

    expect(() => createTlsFetch(makeConfig({ tls: { caPath } })))
      .toThrow("MCP_CA_CERT contains no PEM certificate");
  });

  it("fails at startup when the CA bundle is a private key", () => {
    // Pointing MCP_CA_CERT at the wrong PEM file is the easy mistake, and it
    // would otherwise make every connection fail verification instead.
    const caPath = writeCaFile("key-as-ca.crt", readFileSync(pki!.clientKey, "utf8"));

    expect(() => createTlsFetch(makeConfig({ tls: { caPath } })))
      .toThrow("MCP_CA_CERT contains no PEM certificate");
  });

  it("fails at startup when a certificate in the CA bundle is corrupt", () => {
    const corrupted = readFileSync(pki!.caCert, "utf8").replace(/^(.{40})/m, "!!!!not-base64!!!!");
    const caPath = writeCaFile("corrupt.crt", corrupted);

    expect(() => createTlsFetch(makeConfig({ tls: { caPath } })))
      .toThrow(/MCP_CA_CERT contains a certificate that cannot be parsed/);
  });

  it("accepts a CA bundle holding more than one certificate", async () => {
    const bundle = readFileSync(pki!.caCert, "utf8");
    const caPath = writeCaFile("bundle.crt", `${bundle}${bundle}`);

    const fetch = createTlsFetch(makeConfig({
      tls: { certPath: pki!.clientCert, keyPath: pki!.clientKey, caPath },
    }));
    const response = await fetch(baseUrl);

    expect(response.ok).toBe(true);
  });

  /** Runs `body` with HTTPS_PROXY (and optionally NO_PROXY) set. */
  async function withProxyEnv(env: Record<string, string>, body: () => Promise<void>): Promise<void> {
    Object.assign(process.env, env);
    tunnelled = 0;
    try {
      await body();
    } finally {
      for (const name of Object.keys(env)) {
        delete process.env[name];
      }
    }
  }

  it("tunnels through HTTPS_PROXY instead of connecting direct", async () => {
    await withProxyEnv({ HTTPS_PROXY: proxyUrl }, async () => {
      // The dispatcher is built here, after the variable is set, because a
      // per-request dispatcher overrides whatever Node configured globally.
      const fetch = createTlsFetch(makeConfig({
        tls: { certPath: pki!.clientCert, keyPath: pki!.clientKey, caPath: pki!.caCert },
      }));

      const response = await fetch(baseUrl);

      expect(response.ok).toBe(true);
      // The client certificate must survive the tunnel, not just the proxy.
      expect(await response.json()).toMatchObject({ clientCN: "test-client" });
      expect(tunnelled).toBe(1);
    });
  });

  it("honours NO_PROXY and connects direct", async () => {
    await withProxyEnv({ HTTPS_PROXY: "http://127.0.0.1:1", NO_PROXY: "localhost" }, async () => {
      const fetch = createTlsFetch(makeConfig({
        tls: { certPath: pki!.clientCert, keyPath: pki!.clientKey, caPath: pki!.caCert },
      }));

      const response = await fetch(baseUrl);

      expect(response.ok).toBe(true);
      expect(tunnelled).toBe(0);
    });
  });

  it("fails at startup when the certificate and key do not match", () => {
    expect(() => createTlsFetch(makeConfig({
      tls: { certPath: pki!.clientCert, keyPath: pki!.serverKey },
    }))).toThrow("MCP_CLIENT_CERT and MCP_CLIENT_KEY do not match");
  });
});
