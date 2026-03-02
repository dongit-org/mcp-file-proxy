import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  const validEnv = {
    MCP_URL: "https://example.com/mcp",
    MCP_HEADERS: JSON.stringify({ Authorization: "Bearer test-token-123", "X-Custom": "value" }),
  };

  it("loads valid config with defaults", () => {
    const config = loadConfig(validEnv);

    expect(config.url).toBe("https://example.com/mcp");
    expect(config.headers).toEqual({ Authorization: "Bearer test-token-123", "X-Custom": "value" });
    expect(config.acceptInsecureCerts).toBe(false);
  });

  it("throws when MCP_URL is missing", () => {
    expect(() => loadConfig({})).toThrow(
      "MCP_URL environment variable is required",
    );
  });

  it("throws when MCP_URL is invalid", () => {
    expect(() =>
      loadConfig({ MCP_URL: "not-a-url" }),
    ).toThrow("MCP_URL is not a valid URL");
  });

  it("throws when MCP_HEADERS is not valid JSON", () => {
    expect(() =>
      loadConfig({ MCP_URL: "https://example.com/mcp", MCP_HEADERS: "not-json" }),
    ).toThrow("MCP_HEADERS is not valid JSON");
  });

  it("throws when MCP_HEADERS is a JSON array", () => {
    expect(() =>
      loadConfig({ MCP_URL: "https://example.com/mcp", MCP_HEADERS: "[]" }),
    ).toThrow("MCP_HEADERS must be a JSON object");
  });

  it("sets acceptInsecureCerts when --accept-insecure-certs flag is present", () => {
    const config = loadConfig(validEnv, ["node", "index.js", "--accept-insecure-certs"]);

    expect(config.acceptInsecureCerts).toBe(true);
  });

  it("defaults acceptInsecureCerts to false when flag is absent", () => {
    const config = loadConfig(validEnv, ["node", "index.js"]);

    expect(config.acceptInsecureCerts).toBe(false);
  });
});
