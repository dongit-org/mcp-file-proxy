import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  registerToolSchema,
  interceptFileArguments,
  clearSchemaCache,
  getCachedFileParams,
} from "../src/file-interceptor.js";

const TEST_DIR = join(tmpdir(), "mcp-file-proxy-test");

beforeEach(() => {
  clearSchemaCache();
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("registerToolSchema", () => {
  it("caches parameters with format binary", () => {
    registerToolSchema({
      name: "upload-doc",
      inputSchema: {
        properties: {
          file: { format: "binary", description: "The raw document data" },
          name: { description: "The file name" },
        },
      },
    });

    const params = getCachedFileParams("upload-doc");
    expect(params).toBeDefined();
    expect(params!.has("file")).toBe(true);
    expect(params!.has("name")).toBe(false);
  });

  it("does not detect params without format binary", () => {
    registerToolSchema({
      name: "no-binary",
      inputSchema: {
        properties: {
          file: { description: "A regular string field" },
          data: { format: "date-time", description: "A timestamp" },
        },
      },
    });

    expect(getCachedFileParams("no-binary")).toBeUndefined();
  });

  it("ignores tools without file parameters", () => {
    registerToolSchema({
      name: "get-status",
      inputSchema: {
        properties: {
          id: { description: "The resource ID" },
        },
      },
    });

    expect(getCachedFileParams("get-status")).toBeUndefined();
  });

  it("handles tools with no inputSchema", () => {
    registerToolSchema({ name: "no-schema" });
    expect(getCachedFileParams("no-schema")).toBeUndefined();
  });

  it("handles tools with empty properties", () => {
    registerToolSchema({
      name: "empty-props",
      inputSchema: { properties: {} },
    });

    expect(getCachedFileParams("empty-props")).toBeUndefined();
  });
});

describe("interceptFileArguments", () => {
  it("replaces file paths with base64-encoded content", () => {
    const filePath = join(TEST_DIR, "test.txt");
    writeFileSync(filePath, "hello world");

    registerToolSchema({
      name: "upload",
      inputSchema: {
        properties: {
          file: { format: "binary" },
        },
      },
    });

    const result = interceptFileArguments("upload", { file: filePath });
    const decoded = Buffer.from(result.file as string, "base64").toString();

    expect(decoded).toBe("hello world");
  });

  it("passes through base64-encoded values unchanged", () => {
    const base64 = Buffer.from("hello world").toString("base64");

    registerToolSchema({
      name: "upload",
      inputSchema: {
        properties: {
          file: { format: "binary" },
          name: { description: "Display name" },
        },
      },
    });

    const result = interceptFileArguments("upload", {
      file: base64,
      name: "my-doc",
    });

    expect(result.file).toBe(base64);
    expect(result.name).toBe("my-doc");
  });

  it("throws for invalid file paths", () => {
    registerToolSchema({
      name: "upload",
      inputSchema: {
        properties: {
          file: { format: "binary" },
        },
      },
    });

    expect(() =>
      interceptFileArguments("upload", { file: "/nonexistent/path.txt" }),
    ).toThrow("is not a valid file path or base64-encoded string");
  });

  it("passes through when tool has no cached file params", () => {
    const args = { foo: "bar" };
    const result = interceptFileArguments("unknown-tool", args);

    expect(result).toEqual(args);
  });

  it("passes through non-string values", () => {
    registerToolSchema({
      name: "upload",
      inputSchema: {
        properties: {
          file: { format: "binary" },
        },
      },
    });

    const result = interceptFileArguments("upload", { file: 12345 });
    expect(result.file).toBe(12345);
  });

  it("passes through empty strings", () => {
    registerToolSchema({
      name: "upload",
      inputSchema: {
        properties: {
          file: { format: "binary" },
        },
      },
    });

    const result = interceptFileArguments("upload", { file: "" });
    expect(result.file).toBe("");
  });

  it("handles binary files", () => {
    const filePath = join(TEST_DIR, "binary.bin");
    const buffer = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x89, 0x50]);
    writeFileSync(filePath, buffer);

    registerToolSchema({
      name: "upload",
      inputSchema: {
        properties: {
          file: { format: "binary" },
        },
      },
    });

    const result = interceptFileArguments("upload", { file: filePath });
    const decoded = Buffer.from(result.file as string, "base64");

    expect(decoded).toEqual(buffer);
  });

  it("does not mutate the original args object", () => {
    const filePath = join(TEST_DIR, "test.txt");
    writeFileSync(filePath, "content");

    registerToolSchema({
      name: "upload",
      inputSchema: {
        properties: {
          file: { format: "binary" },
        },
      },
    });

    const original = { file: filePath };
    interceptFileArguments("upload", original);

    expect(original.file).toBe(filePath);
  });
});

