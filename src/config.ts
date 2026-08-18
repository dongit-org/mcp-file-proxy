export interface TlsConfig {
  /** Path to the PEM-encoded client certificate presented for mutual TLS. */
  certPath?: string;
  /** Path to the PEM-encoded private key matching the client certificate. */
  keyPath?: string;
  /** Passphrase for the private key, when the key file is encrypted. */
  keyPassphrase?: string;
  /** Path to a PEM CA bundle used to verify the server certificate. */
  caPath?: string;
}

export interface ProxyConfig {
  url: string;
  headers: Record<string, string>;
  acceptInsecureCerts: boolean;
  tls?: TlsConfig;
}

/**
 * Loads the proxy configuration from environment variables and CLI arguments.
 *
 * @param env - Environment variables to read from. Defaults to `process.env`.
 * @param argv - CLI argument list. Defaults to `process.argv`.
 * @returns The parsed {@link ProxyConfig}.
 * @throws If `MCP_URL` is missing or invalid, if `MCP_HEADERS` is malformed,
 *   or if the mutual-TLS variables are set inconsistently.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
): ProxyConfig {
  const url = env.MCP_URL;
  if (!url) {
    throw new Error("MCP_URL environment variable is required");
  }

  if (!URL.canParse(url)) {
    throw new Error(`MCP_URL is not a valid URL: ${url}`);
  }

  let headers: Record<string, string> = {};
  const headersRaw = env.MCP_HEADERS;
  if (headersRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(headersRaw);
    } catch (_: unknown) {
      throw new TypeError(`MCP_HEADERS is not valid JSON`);
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError("MCP_HEADERS must be a JSON object");
    }

    headers = parsed as Record<string, string>;
  }

  const acceptInsecureCerts = argv.includes("--accept-insecure-certs");

  const certPath = env.MCP_CLIENT_CERT;
  const keyPath = env.MCP_CLIENT_KEY;
  const keyPassphrase = env.MCP_CLIENT_KEY_PASSPHRASE;
  const caPath = env.MCP_CA_CERT;

  if (Boolean(certPath) !== Boolean(keyPath)) {
    throw new Error("MCP_CLIENT_CERT and MCP_CLIENT_KEY must be set together");
  }

  if (keyPassphrase && !keyPath) {
    throw new Error("MCP_CLIENT_KEY_PASSPHRASE requires MCP_CLIENT_KEY");
  }

  const tls: TlsConfig | undefined = certPath || caPath
    ? { certPath, keyPath, keyPassphrase, caPath }
    : undefined;

  return {
    url,
    headers,
    acceptInsecureCerts,
    tls,
  };
}
