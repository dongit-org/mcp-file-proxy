# mcp-file-proxy

A stdio-to-HTTP MCP proxy that lets MCP clients send local files to remote MCP servers.

MCP clients like Claude Desktop run locally but connect to remote servers over HTTP. When a tool expects binary file data,
the client has no way to read a local file and send it. This proxy sits in between: it detects file parameters, reads the
files from disk, streams them as base64, and forwards the encoded data to the remote server. All other requests
(resources, prompts, non-file tool calls) are forwarded as-is.

## How file detection works

The proxy inspects each tool's `inputSchema` when it receives a `tools/list` response from the remote server. Any parameter
with `"format": "binary"` is treated as a file parameter. When that tool is called, the proxy checks if the argument value
is a local file path, and if that's the case, it reads and base64-encodes the file before forwarding. Values that are already
base64-encoded are passed through unchanged.

To mark a parameter as binary on your server, set `format` to `"binary"` in the tool's input schema:

```json
{
  "name": "upload-document",
  "inputSchema": {
    "type": "object",
    "properties": {
      "file": {
        "type": "string",
        "format": "binary",
        "description": "The document to upload"
      }
    }
  }
}
```

The proxy will prepend "Provide a file path." to the description of binary parameters so the client knows to supply a path.

## Configuration

Add to your MCP client config:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["@dongit/mcp-file-proxy"],
      "env": {
        "MCP_URL": "https://example.com/mcp",
        "MCP_HEADERS": "{\"Authorization\": \"Bearer your-token\"}"
      }
    }
  }
}
```

### Environment variables

| Variable      | Required | Description                                  |
|---------------|----------|----------------------------------------------|
| `MCP_URL`     | Yes      | URL of the remote MCP server                 |
| `MCP_HEADERS` | No       | JSON object of headers to send with requests |

### Flags

| Flag                      | Description                                                         |
|---------------------------|---------------------------------------------------------------------|
| `--accept-insecure-certs` | Disable TLS certificate verification (for self-signed certs in dev) |
