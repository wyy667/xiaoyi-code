#!/usr/bin/env node
"use strict";

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const express = require("express");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const fs = require("fs");
const path = require("path");

const { TOOLS, callTool } = require("./tools.js");

const PORT = process.env.MCP_PORT || 9000;

function createMcpServer() {
  const server = new Server(
    { name: "file-manager", version: "1.1.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return callTool(name, args || {});
  });
  return server;
}

const app = express();
app.use(express.json({ limit: "200mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "file-manager-mcp", port: PORT });
});

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  res.on("finish", () => server.close().catch(() => {}));
});

app.get("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res);
  res.on("finish", () => server.close().catch(() => {}));
});

app.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "不支持 DELETE" });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[file-manager-mcp] 服务已启动 http://127.0.0.1:${PORT}/mcp`);
  console.log(`[file-manager-mcp] PID: ${process.pid}`);
  const pidFile = path.join(__dirname, ".pid");
  fs.writeFileSync(pidFile, String(process.pid));
});

process.on("SIGTERM", () => {
  const pidFile = path.join(__dirname, ".pid");
  try { fs.unlinkSync(pidFile); } catch {}
  process.exit(0);
});
