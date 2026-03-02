import { createReadStream, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { text } from "node:stream/consumers";
import { Base64Encode } from "base64-stream";

interface ToolSchema {
  name: string;
  inputSchema?: {
    properties?: Record<string, { description?: string; format?: string }>;
  };
}

const fileParamCache = new Map<string, Set<string>>();

/**
 * Registers a tool's schema and caches the names of any parameters with
 * `format: "binary"`. The description of those parameters is also prefixed with a
 * "Provide a file path." string.
 * @param tool - The tool schema to inspect and register.
 */
export function registerToolSchema(tool: ToolSchema): void {
  const fileParams = new Set<string>();
  const properties = tool.inputSchema?.properties;

  if (properties) {
    for (const [paramName, paramSchema] of Object.entries(properties)) {
      if (paramSchema.format === "binary") {
        fileParams.add(paramName);
        paramSchema.description = paramSchema.description
          ? `Provide a file path. ${paramSchema.description}`
          : "Provide a file path.";
      }
    }
  }

  if (fileParams.size > 0) {
    fileParamCache.set(tool.name, fileParams);
  }
}

export function clearSchemaCache(): void {
  fileParamCache.clear();
}

export function getCachedFileParams(toolName: string): Set<string> | undefined {
  return fileParamCache.get(toolName);
}

function isBase64(value: string): boolean {
  return /^[A-Za-z0-9+/\n\r]+=*$/.test(value);
}

/**
 * Streams a file and returns its contents as a base64-encoded string.
 * Reads in chunks to avoid holding the entire raw buffer in memory.
 * @param filePath - Path to the file to read.
 * @returns The base64-encoded file contents.
 */
async function streamFileAsBase64(filePath: string): Promise<string> {
  const encoder = new Base64Encode();
  const [result] = await Promise.all([
    text(encoder),
    pipeline(createReadStream(filePath), encoder),
  ]);
  return result;
}

/**
 * Intercepts a tool call's arguments, replacing file-path strings with their
 * base64-encoded file contents for any parameters previously identified as
 * binary. Values that are already valid base64 are passed through unchanged.
 * @param toolName - The name of the tool being called.
 * @param args - The original argument map from the tool call.
 * @returns A new argument map with file paths resolved to base64 content.
 * @throws If a binary parameter's value is neither a valid file path nor valid base64.
 */
export async function interceptFileArguments(
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fileParams = fileParamCache.get(toolName);

  if (!fileParams) {
    return args;
  }

  const result = { ...args };

  for (const paramName of fileParams) {
    const value = result[paramName];

    if (typeof value !== "string" || value.length === 0) {
      continue;
    }

    if (statSync(value, { throwIfNoEntry: false })?.isFile()) {
      result[paramName] = await streamFileAsBase64(value);
    } else if (!isBase64(value)) {
      throw new Error(`Tool "${toolName}", param "${paramName}": "${value}" is not a valid file path or base64-encoded string`);
    }
  }

  return result;
}
