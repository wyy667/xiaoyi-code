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
const os = require("os");

const PORT = process.env.MCP_PORT || 9000;

// ─── 安全 ───────────────────────────────────────────────────────────────────
const BLOCKED_PATHS = ["/proc", "/sys", "/dev"];

function isSafePath(p) {
  const resolved = path.resolve(p);
  return !BLOCKED_PATHS.some((b) => resolved.startsWith(b));
}

function resolvePath(p) {
  if (!p) throw new Error("路径不能为空");
  if (p.startsWith("~/") || p === "~") p = p.replace("~", os.homedir());
  return path.resolve(p);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function copyRecursive(src, dest, overwrite) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src))
      copyRecursive(path.join(src, e), path.join(dest, e), overwrite);
  } else {
    if (!overwrite && fs.existsSync(dest)) throw new Error(`目标已存在: ${dest}`);
    fs.copyFileSync(src, dest);
  }
}

function searchFiles(dir, pattern, maxDepth, depth, results) {
  if (depth > maxDepth || results.length >= 200) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.toLowerCase().includes(pattern.toLowerCase()))
      results.push(path.join(dir, e.name));
    if (e.isDirectory())
      searchFiles(path.join(dir, e.name), pattern, maxDepth, depth + 1, results);
  }
}

// ─── MCP Server 工厂（每个连接独立实例）──────────────────────────────────────
function createMcpServer() {
  const server = new Server(
    { name: "file-manager", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_dir",
        description: "列出目录内容（文件名、类型、大小、修改时间）",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "目录路径，支持 ~ 表示家目录" } },
          required: ["path"],
        },
      },
      {
        name: "read_file",
        description: "读取文件内容（带行号，cat -n 风格）。大文件可用 offset/limit 分块读",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径" },
            offset: { type: "number", description: "起始行号（从 1 开始），默认 1" },
            limit: { type: "number", description: "读取行数，默认全部（建议大文件 <=2000）" },
            encoding: { type: "string", description: "编码，默认 utf8", default: "utf8" },
          },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "写入内容到文件（覆盖或新建）",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径" },
            content: { type: "string", description: "要写入的内容" },
            encoding: { type: "string", description: "编码，默认 utf8", default: "utf8" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "append_file",
        description: "追加内容到文件末尾",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径" },
            content: { type: "string", description: "要追加的内容" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "create_dir",
        description: "创建目录（支持递归创建多级目录）",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "目录路径" } },
          required: ["path"],
        },
      },
      {
        name: "delete",
        description: "删除文件或目录（目录会递归删除）",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "要删除的路径" } },
          required: ["path"],
        },
      },
      {
        name: "copy",
        description: "复制文件或目录到目标路径",
        inputSchema: {
          type: "object",
          properties: {
            src: { type: "string", description: "源路径" },
            dest: { type: "string", description: "目标路径" },
            overwrite: { type: "boolean", description: "目标存在时是否覆盖，默认 false", default: false },
          },
          required: ["src", "dest"],
        },
      },
      {
        name: "move",
        description: "移动或重命名文件/目录",
        inputSchema: {
          type: "object",
          properties: {
            src: { type: "string", description: "源路径" },
            dest: { type: "string", description: "目标路径" },
          },
          required: ["src", "dest"],
        },
      },
      {
        name: "stat",
        description: "获取文件或目录的详细信息（大小、权限、时间等）",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "路径" } },
          required: ["path"],
        },
      },
      {
        name: "search",
        description: "在目录中搜索文件（按文件名模糊匹配）",
        inputSchema: {
          type: "object",
          properties: {
            dir: { type: "string", description: "搜索根目录" },
            pattern: { type: "string", description: "文件名关键词（不区分大小写）" },
            max_depth: { type: "number", description: "最大递归深度，默认 5", default: 5 },
          },
          required: ["dir", "pattern"],
        },
      },
      {
        name: "edit",
        description: "精确编辑文件：把 old_string 替换为 new_string。默认要求 old_string 在文件中唯一出现（避免误替换）；设置 replace_all=true 可替换全部匹配",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径" },
            old_string: { type: "string", description: "要替换的原文（必须与文件内容精确匹配，包括空格和缩进）" },
            new_string: { type: "string", description: "替换后的新内容" },
            replace_all: { type: "boolean", description: "是否替换所有匹配，默认 false（要求唯一）", default: false },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
      {
        name: "grep",
        description: "在文件内容中用正则搜索（基于 ripgrep，需先 pkg install ripgrep）。返回 文件:行号:内容",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "正则表达式" },
            path: { type: "string", description: "搜索根目录，默认家目录" },
            glob: { type: "string", description: "文件名过滤模式（如 *.js, *.{ts,tsx}）" },
            case_insensitive: { type: "boolean", description: "不区分大小写", default: false },
            max_results: { type: "number", description: "最大返回行数，默认 100", default: 100 },
          },
          required: ["pattern"],
        },
      },
      {
        name: "exec",
        description: "执行 shell 命令。返回 退出码/stdout/stderr。默认超时 120 秒",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "shell 命令" },
            cwd: { type: "string", description: "工作目录，默认家目录" },
            timeout: { type: "number", description: "超时毫秒，默认 120000", default: 120000 },
          },
          required: ["command"],
        },
      },
      {
        name: "glob",
        description: "按 glob 模式匹配文件路径（如 **/*.js, src/**/*.{ts,tsx}）",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "glob 模式" },
            cwd: { type: "string", description: "起始目录，默认家目录" },
            max_results: { type: "number", description: "最大返回数，默认 200", default: 200 },
          },
          required: ["pattern"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (name === "list_dir") {
        const dir = resolvePath(args.path);
        if (!isSafePath(dir)) throw new Error("禁止访问该路径");
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const rows = entries.map((e) => {
          const full = path.join(dir, e.name);
          let size = "-", mtime = "-", type = e.isDirectory() ? "目录" : "文件";
          try {
            const st = fs.statSync(full);
            size = e.isDirectory() ? "-" : formatSize(st.size);
            mtime = st.mtime.toISOString().replace("T", " ").slice(0, 19);
          } catch {}
          return `${type.padEnd(4)} ${size.padStart(10)}  ${mtime}  ${e.name}`;
        });
        return { content: [{ type: "text", text: `目录: ${dir}\n共 ${entries.length} 项\n\n${"─".repeat(60)}\n${rows.join("\n")}` }] };
      }

      if (name === "read_file") {
        const fp = resolvePath(args.path);
        if (!isSafePath(fp)) throw new Error("禁止访问该路径");
        const content = fs.readFileSync(fp, args.encoding || "utf8");
        const st = fs.statSync(fp);
        const lines = content.split("\n");
        const total = lines.length;
        const hasRange = args.offset != null || args.limit != null;
        const offset = Math.max(1, args.offset || 1);
        const endLine = Math.min(total, args.limit ? offset + args.limit - 1 : total);
        const selected = lines.slice(offset - 1, endLine);
        const width = String(endLine).length;
        const numbered = selected.map((l, i) => `${String(offset + i).padStart(width)}\t${l}`).join("\n");
        const range = hasRange ? `\n...[显示 ${offset}-${endLine} 行 / 共 ${total} 行]` : "";
        return { content: [{ type: "text", text: `文件: ${fp}\n大小: ${formatSize(st.size)} · ${total} 行\n${"─".repeat(40)}\n${numbered}${range}` }] };
      }

      if (name === "write_file") {
        const fp = resolvePath(args.path);
        if (!isSafePath(fp)) throw new Error("禁止访问该路径");
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, args.content, args.encoding || "utf8");
        return { content: [{ type: "text", text: `已写入: ${fp}` }] };
      }

      if (name === "append_file") {
        const fp = resolvePath(args.path);
        if (!isSafePath(fp)) throw new Error("禁止访问该路径");
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.appendFileSync(fp, args.content, "utf8");
        return { content: [{ type: "text", text: `已追加到: ${fp}` }] };
      }

      if (name === "create_dir") {
        const dp = resolvePath(args.path);
        if (!isSafePath(dp)) throw new Error("禁止访问该路径");
        fs.mkdirSync(dp, { recursive: true });
        return { content: [{ type: "text", text: `目录已创建: ${dp}` }] };
      }

      if (name === "delete") {
        const target = resolvePath(args.path);
        if (!isSafePath(target)) throw new Error("禁止访问该路径");
        if (target === "/" || target === os.homedir()) throw new Error("拒绝删除根目录或家目录");
        if (!fs.existsSync(target)) throw new Error(`路径不存在: ${target}`);
        const st = fs.lstatSync(target);
        (st.isDirectory() && !st.isSymbolicLink())
          ? fs.rmSync(target, { recursive: true, force: true })
          : fs.unlinkSync(target);
        return { content: [{ type: "text", text: `已删除: ${target}` }] };
      }

      if (name === "copy") {
        const src = resolvePath(args.src);
        const dest = resolvePath(args.dest);
        if (!isSafePath(src) || !isSafePath(dest)) throw new Error("禁止访问该路径");
        if (!fs.existsSync(src)) throw new Error(`源不存在: ${src}`);
        let fd = dest;
        if (fs.existsSync(dest) && fs.statSync(dest).isDirectory())
          fd = path.join(dest, path.basename(src));
        copyRecursive(src, fd, args.overwrite || false);
        return { content: [{ type: "text", text: `已复制: ${src} → ${fd}` }] };
      }

      if (name === "move") {
        const src = resolvePath(args.src);
        const dest = resolvePath(args.dest);
        if (!isSafePath(src) || !isSafePath(dest)) throw new Error("禁止访问该路径");
        if (!fs.existsSync(src)) throw new Error(`源不存在: ${src}`);
        let fd = dest;
        if (fs.existsSync(dest) && fs.statSync(dest).isDirectory())
          fd = path.join(dest, path.basename(src));
        fs.mkdirSync(path.dirname(fd), { recursive: true });
        try {
          fs.renameSync(src, fd);
        } catch (e) {
          if (e.code === "EXDEV") {
            copyRecursive(src, fd, true);
            fs.rmSync(src, { recursive: true, force: true });
          } else throw e;
        }
        return { content: [{ type: "text", text: `已移动: ${src} → ${fd}` }] };
      }

      if (name === "stat") {
        const target = resolvePath(args.path);
        if (!isSafePath(target)) throw new Error("禁止访问该路径");
        const st = fs.lstatSync(target);
        return {
          content: [{
            type: "text",
            text: [
              `路径: ${target}`,
              `类型: ${st.isSymbolicLink() ? "符号链接" : st.isDirectory() ? "目录" : "文件"}`,
              `大小: ${formatSize(st.size)} (${st.size} 字节)`,
              `权限: ${(st.mode & 0o777).toString(8)}`,
              `创建时间: ${st.birthtime.toISOString().replace("T", " ").slice(0, 19)}`,
              `修改时间: ${st.mtime.toISOString().replace("T", " ").slice(0, 19)}`,
              `访问时间: ${st.atime.toISOString().replace("T", " ").slice(0, 19)}`,
            ].join("\n"),
          }],
        };
      }

      if (name === "search") {
        const dir = resolvePath(args.dir);
        if (!isSafePath(dir)) throw new Error("禁止访问该路径");
        const results = [];
        searchFiles(dir, args.pattern, args.max_depth || 5, 0, results);
        return {
          content: [{
            type: "text",
            text: results.length === 0
              ? `未找到匹配 "${args.pattern}" 的文件`
              : `在 ${dir} 中找到 ${results.length} 个匹配项:\n\n${results.join("\n")}`,
          }],
        };
      }

      if (name === "edit") {
        const fp = resolvePath(args.path);
        if (!isSafePath(fp)) throw new Error("禁止访问该路径");
        if (!fs.existsSync(fp)) throw new Error(`文件不存在: ${fp}`);
        if (args.old_string === args.new_string) throw new Error("old_string 与 new_string 相同");
        const content = fs.readFileSync(fp, "utf8");
        if (args.replace_all) {
          const parts = content.split(args.old_string);
          if (parts.length === 1) throw new Error("old_string 未在文件中找到");
          fs.writeFileSync(fp, parts.join(args.new_string), "utf8");
          return { content: [{ type: "text", text: `已编辑: ${fp}（替换 ${parts.length - 1} 处）` }] };
        }
        const idx = content.indexOf(args.old_string);
        if (idx === -1) throw new Error("old_string 未在文件中找到");
        if (content.indexOf(args.old_string, idx + 1) !== -1) {
          throw new Error("old_string 在文件中出现多次，请提供更多上下文，或设置 replace_all=true");
        }
        fs.writeFileSync(fp, content.slice(0, idx) + args.new_string + content.slice(idx + args.old_string.length), "utf8");
        return { content: [{ type: "text", text: `已编辑: ${fp}（替换 1 处）` }] };
      }

      if (name === "grep") {
        const { spawnSync } = require("child_process");
        const dir = args.path ? resolvePath(args.path) : os.homedir();
        if (!isSafePath(dir)) throw new Error("禁止访问该路径");
        const rgArgs = ["-n", "--color=never", "--no-heading"];
        if (args.case_insensitive) rgArgs.push("-i");
        if (args.glob) rgArgs.push("--glob", args.glob);
        rgArgs.push("--", args.pattern, dir);
        const r = spawnSync("rg", rgArgs, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
        if (r.error && r.error.code === "ENOENT") {
          throw new Error("未安装 ripgrep，请执行: pkg install ripgrep");
        }
        const lines = (r.stdout || "").split("\n").filter(Boolean);
        const max = args.max_results || 100;
        const head = lines.slice(0, max);
        const trail = lines.length > max ? `\n...[共 ${lines.length} 行，截断显示前 ${max} 行]` : "";
        return {
          content: [{
            type: "text",
            text: head.length === 0 ? `未找到匹配 "${args.pattern}"` : head.join("\n") + trail,
          }],
        };
      }

      if (name === "glob") {
        const cwd = args.cwd ? resolvePath(args.cwd) : os.homedir();
        if (!isSafePath(cwd)) throw new Error("禁止访问该路径");
        const results = [];
        const max = args.max_results || 200;
        for (const entry of fs.globSync(args.pattern, { cwd })) {
          results.push(path.join(cwd, entry));
          if (results.length >= max) break;
        }
        return {
          content: [{
            type: "text",
            text: results.length === 0
              ? `未找到匹配 "${args.pattern}" 的文件`
              : `在 ${cwd} 中找到 ${results.length} 项${results.length >= max ? "（已截断）" : ""}:\n\n${results.join("\n")}`,
          }],
        };
      }

      if (name === "exec") {
        const { spawnSync } = require("child_process");
        if (!args.command) throw new Error("command 不能为空");
        const cwd = args.cwd ? resolvePath(args.cwd) : os.homedir();
        if (!isSafePath(cwd)) throw new Error("禁止访问该工作目录");
        const timeout = args.timeout || 120000;
        const r = spawnSync(args.command, {
          cwd,
          shell: true,
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          encoding: "utf8",
        });
        const truncate = (s) => {
          if (!s) return "";
          if (s.length > 30000) return s.slice(0, 30000) + `\n...[截断，原长 ${s.length} 字符]`;
          return s;
        };
        const timedOut = r.signal === "SIGTERM" && r.status === null;
        const parts = [`[exit=${r.status ?? "?"}] cwd=${cwd}${timedOut ? " (超时)" : ""}`];
        if (r.stdout) parts.push(`---stdout---\n${truncate(r.stdout)}`);
        if (r.stderr) parts.push(`---stderr---\n${truncate(r.stderr)}`);
        if (r.error && r.error.code !== "ETIMEDOUT") parts.push(`错误: ${r.error.message}`);
        return {
          content: [{ type: "text", text: parts.join("\n") }],
          isError: r.status !== 0,
        };
      }

      throw new Error(`未知工具: ${name}`);
    } catch (err) {
      return { content: [{ type: "text", text: `错误: ${err.message}` }], isError: true };
    }
  });

  return server;
}

// ─── Express + StreamableHTTP ─────────────────────────────────────────────
const app = express();
app.use(express.json());

// ─── 健康检查（放在 MCP 路由前）─────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "file-manager-mcp", port: PORT });
});

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // 无状态模式
  });
  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  res.on("finish", () => server.close().catch(() => {}));
});

app.get("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
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
  // 将 PID 写入文件，供 stop 脚本使用
  const pidFile = path.join(__dirname, ".pid");
  fs.writeFileSync(pidFile, String(process.pid));
});

process.on("SIGTERM", () => {
  const pidFile = path.join(__dirname, ".pid");
  try { fs.unlinkSync(pidFile); } catch {}
  process.exit(0);
});
