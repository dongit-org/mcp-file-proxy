import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:https";
import { readFileSync } from "node:fs";
import type { TLSSocket } from "node:tls";
import type { AddressInfo } from "node:net";
import { createTlsFetch } from "../src/tls.js";
import type { ProxyConfig } from "../src/config.js";
import { generateTestPki, removeTestPki, type TestPki } from "./helpers/certs.js";

let pki: TestPki | undefined;
let server: Server | undefined;
let baseUrl: string;
let savedRejectUnauthorized: string | undefined;

function makeConfig(overrides: Partial<ProxyConfig>): ProxyConfig {
  return {
    url: baseUrl,
    headers: {},
    acceptInsecureCerts: false,
    ...overrides,
  };
}

/** Walks the cause chain and returns the deepest error's code. */
function rootCode(error: unknown): string | undefined {
  let current = error;
  while (current instanceof Error && current.cause instanceof Error) {
    current = current.cause;
  }
  return current instanceof Error && "code" in current
    ? (current as { code: string }).code
    : undefined;
}

beforeAll(async () => {
  // Keep server certificate verification deterministic regardless of the
  // developer's shell environment.
  savedRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

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
      const peer = (req.socket as TLSSocket).getPeerCertificate();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ clientCN: peer?.subject?.CN ?? null }));
    },
  );
  server = httpsServer;

  await new Promise<void>((resolve) => httpsServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpsServer.address() as AddressInfo;
  baseUrl = `https://localhost:${port}/`;
});

afterAll(async () => {
  const runningServer = server;
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

describe("createTlsFetch", () => {
  it("returns undefined when no TLS settings are configured", () => {
    expect(createTlsFetch(makeConfig({}))).toBeUndefined();
  });

  it("presents the client certificate to a server requiring mTLS", async () => {
    const fetch = createTlsFetch(makeConfig({
      tls: { certPath: pki!.clientCert, keyPath: pki!.clientKey, caPath: pki!.caCert },
    }))!;

    const response = await fetch(baseUrl);

    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ clientCN: "test-client" });
  });

  it("supports a passphrase-encrypted client key", async () => {
    const fetch = createTlsFetch(makeConfig({
      tls: {
        certPath: pki!.clientCert,
        keyPath: pki!.clientKeyEncrypted,
        keyPassphrase: pki!.clientKeyPassphrase,
        caPath: pki!.caCert,
      },
    }))!;

    const response = await fetch(baseUrl);

    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ clientCN: "test-client" });
  });

  it("fails against an mTLS server when no client certificate is configured", async () => {
    const fetch = createTlsFetch(makeConfig({
      tls: { caPath: pki!.caCert },
    }))!;

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
    }))!;

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
    }))!;

    const response = await fetch(baseUrl);

    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ clientCN: "test-client" });
  });

  it("does not follow redirects, keeping the client certificate on the configured host", async () => {
    const fetch = createTlsFetch(makeConfig({
      tls: { certPath: pki!.clientCert, keyPath: pki!.clientKey, caPath: pki!.caCert },
    }))!;

    const response = await fetch(`${baseUrl}redirect`);

    // With redirect: "manual" the 302 comes back as-is (or as a status-0
    // opaque redirect, depending on the fetch implementation) instead of
    // being followed to the Location target.
    expect(response.ok).toBe(false);
    expect([0, 302]).toContain(response.status);
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

  it("fails at startup when the certificate and key do not match", () => {
    expect(() => createTlsFetch(makeConfig({
      tls: { certPath: pki!.clientCert, keyPath: pki!.serverKey },
    }))).toThrow("MCP_CLIENT_CERT and MCP_CLIENT_KEY do not match");
  });
});
