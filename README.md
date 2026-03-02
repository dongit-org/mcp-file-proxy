# mcp-file-proxy

A stdio-to-HTTP MCP proxy that intercepts file parameters, reading local files and base64-encoding them before forwarding to the remote server.

## Configuration

Add to your MCP client config:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["mcp-file-proxy"],
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
