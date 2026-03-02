import { readFileSync, statSync } from "node:fs";

interface ToolSchema {
  name: string;
  inputSchema?: {
    properties?: Record<string, { description?: string; format?: string }>;
  };
}

const fileParamCache = new Map<string, Set<string>>();

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

export function interceptFileArguments(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
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
      const fileBuffer = readFileSync(value);
      result[paramName] = fileBuffer.toString("base64");
    } else if (!isBase64(value)) {
      throw new Error(`Tool "${toolName}", param "${paramName}": "${value}" is not a valid file path or base64-encoded string`);
    }
  }

  return result;
}
