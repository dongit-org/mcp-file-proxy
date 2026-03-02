export interface ProxyConfig {
  url: string;
  headers: Record<string, string>;
  acceptInsecureCerts: boolean;
}

/**
 * Loads the proxy configuration from environment variables and CLI arguments.
 *
 * @param env - Environment variables to read from. Defaults to `process.env`.
 * @param argv - CLI argument list. Defaults to `process.argv`.
 * @returns The parsed {@link ProxyConfig}.
 * @throws If `MCP_URL` is missing or invalid, or if `MCP_HEADERS` is malformed.
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

  return {
    url,
    headers,
    acceptInsecureCerts,
  };
}
