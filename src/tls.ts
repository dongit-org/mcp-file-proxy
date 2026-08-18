import { readFileSync } from "node:fs";
import { createSecureContext, type ConnectionOptions } from "node:tls";
import { Agent } from "undici";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ProxyConfig } from "./config.js";

function readPemFile(path: string, variableName: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read the ${variableName} file at ${path}: ${detail}`);
  }
}

/**
 * Builds a throwaway secure context from the loaded TLS material so that a
 * wrong passphrase, a mismatched certificate/key pair, or a non-PEM file
 * fails at startup with an actionable message instead of as an opaque
 * OpenSSL error on the first request.
 */
function validateTlsMaterial(options: ConnectionOptions): void {
  try {
    createSecureContext(options);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    const code = error instanceof Error && "code" in error
      ? String((error as { code: unknown }).code)
      : "";

    if (code.includes("BAD_DECRYPT")) {
      throw new Error("MCP_CLIENT_KEY_PASSPHRASE does not decrypt MCP_CLIENT_KEY", { cause: error });
    }
    if (code.includes("KEY_VALUES_MISMATCH")) {
      throw new Error("MCP_CLIENT_CERT and MCP_CLIENT_KEY do not match", { cause: error });
    }
    if (code.includes("NO_START_LINE")) {
      throw new Error(`A configured TLS file is not PEM-encoded: ${detail}`, { cause: error });
    }
    throw new Error(`Invalid TLS configuration: ${detail}`, { cause: error });
  }
}

/**
 * Creates a fetch implementation that applies the TLS settings from the
 * config: a client certificate for mutual TLS and/or a custom CA bundle.
 * PEM files are read and validated eagerly so misconfiguration fails at
 * startup. Redirects are never followed: the client certificate is a
 * connection-level credential, and following a redirect would present it
 * to whatever host the redirect points at.
 *
 * @param config - Proxy configuration; only `tls` and `acceptInsecureCerts`
 *   are used.
 * @returns A {@link FetchLike} that routes requests through a TLS-configured
 *   undici agent, or `undefined` when no TLS settings are present so the
 *   transport keeps using the default fetch.
 * @throws If a configured PEM file cannot be read or the TLS material is
 *   invalid (wrong passphrase, mismatched cert/key, non-PEM file).
 */
export function createTlsFetch(config: ProxyConfig): FetchLike | undefined {
  const tls = config.tls;
  if (!tls) {
    return undefined;
  }

  const connect: ConnectionOptions = {};

  if (tls.certPath) {
    connect.cert = readPemFile(tls.certPath, "MCP_CLIENT_CERT");
  }
  if (tls.keyPath) {
    connect.key = readPemFile(tls.keyPath, "MCP_CLIENT_KEY");
  }
  if (tls.keyPassphrase) {
    connect.passphrase = tls.keyPassphrase;
  }
  if (tls.caPath) {
    connect.ca = readPemFile(tls.caPath, "MCP_CA_CERT");
  }

  validateTlsMaterial(connect);

  if (config.acceptInsecureCerts) {
    connect.rejectUnauthorized = false;
  }

  const dispatcher = new Agent({ connect });

  // The built-in fetch is used (not undici's own) because the MCP SDK
  // brand-checks Response instances, and Node's fetch accepts a dispatcher
  // from the npm undici package.
  return (url, init) =>
    fetch(url, {
      ...init,
      redirect: "manual",
      dispatcher,
    } as RequestInit);
}
