import { readFileSync } from "node:fs";
import { createSecureContext, type ConnectionOptions } from "node:tls";
import { X509Certificate } from "node:crypto";
import { EnvHttpProxyAgent } from "undici";
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


function validateCaBundle(ca: string): void {
  const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);

  if (certificates === null) {
    throw new Error("MCP_CA_CERT contains no PEM certificate");
  }

  for (const certificate of certificates) {
    try {
      new X509Certificate(certificate);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`MCP_CA_CERT contains a certificate that cannot be parsed: ${detail}`, { cause: error });
    }
  }
}


/**
 * Builds a throwaway secure context from the loaded TLS material so that a
 * missing or wrong passphrase, a mismatched certificate/key pair, or a
 * non-PEM file fails at startup with an actionable message instead of as an
 * opaque OpenSSL error on the first request.
 */
function validateTlsMaterial(options: ConnectionOptions): void {
  try {
    createSecureContext(options);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    const code = error instanceof Error && "code" in error
      ? String(error.code)
      : "";

    if (code.includes("BAD_DECRYPT")) {
      if (options.passphrase === undefined) {
        throw new Error("MCP_CLIENT_KEY is encrypted but MCP_CLIENT_KEY_PASSPHRASE is not set", { cause: error });
      }
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

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/**
 * Builds the undici agent carrying the configured TLS material, reading and
 * validating the PEM files eagerly so misconfiguration fails at startup.
 */
function createTlsDispatcher(config: ProxyConfig): EnvHttpProxyAgent | undefined {
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
    const ca = readPemFile(tls.caPath, "MCP_CA_CERT");
    validateCaBundle(ca);
    connect.ca = ca;
  }

  validateTlsMaterial(connect);

  if (config.acceptInsecureCerts) {
    connect.rejectUnauthorized = false;
  }

  return new EnvHttpProxyAgent({ connect, requestTls: connect });
}

/**
 * Creates the fetch used for every request to the remote, with or without
 * TLS configured. Redirects are followed only within the origin of the
 * configured URL, keeping the client certificate and MCP_HEADERS off other
 * hosts, and are re-issued with the original method and body instead of
 * being downgraded to GET the way fetch treats 301, 302 and 303.
 *
 * @throws If a configured PEM file cannot be read or the TLS material is
 *   invalid (wrong passphrase, mismatched cert/key, non-PEM file).
 */
export function createTlsFetch(config: ProxyConfig): FetchLike {
  const dispatcher = createTlsDispatcher(config);

  return async (url, init) => {
    const origin = new URL(url).origin;
    let target = new URL(url);

    for (let followed = 0; ; followed++) {
      // The built-in fetch is used (not undici's own) because the MCP SDK
      // brand-checks Response instances, and Node's fetch accepts a
      // dispatcher from the npm undici package. `dispatcher` is an undici
      // extension that RequestInit does not declare, so the init is widened
      // rather than asserted.
      const requestInit: RequestInit & { dispatcher?: EnvHttpProxyAgent } = {
        ...init,
        redirect: "manual",
      };
      if (dispatcher) {
        requestInit.dispatcher = dispatcher;
      }

      const response = await fetch(target, requestInit);

      const location = REDIRECT_STATUSES.has(response.status)
        ? response.headers.get("location")
        : null;
      if (location === null) {
        return response;
      }

      const next = new URL(location, target);
      if (next.origin !== origin) {
        throw new Error(
          `Refusing to follow the redirect from ${target.href} to ${next.href}: it leaves ${origin}`,
        );
      }
      if (followed >= MAX_REDIRECTS) {
        throw new Error(`Stopped after ${MAX_REDIRECTS} redirects, last was ${next.href}`);
      }

      target = next;
    }
  };
}
