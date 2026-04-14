# 小懿code · MCP Server

> **小懿code** 项目的 MCP 后端服务。

基于 **Model Context Protocol (MCP)** 的文件操作 / 代码编辑服务器，同时支持 **stdio** 和 **HTTP (streamable-http)** 两种传输。提供 13 个工具，一键接入移动端AI聊天软件。

---

## 功能（13 个工具）

| 类别 | 工具 | 说明 |
|---|---|---|
| 读写 | `read_file` | 读文件，带行号（`cat -n` 风格），支持 `offset` / `limit` 分块读 |
| 读写 | `write_file` | 覆盖写入 |
| 读写 | `append_file` | 追加 |
| 读写 | `edit` | 精确替换（`old_string` → `new_string`，默认要求唯一匹配） |
| 目录 | `list_dir` | 列目录（含类型/大小/修改时间） |
| 目录 | `create_dir` | 递归创建目录 |
| 元数据 | `stat` | 文件信息（能识别符号链接） |
| 搜索 | `search` | 按文件名模糊匹配 |
| 搜索 | `grep` | 按内容正则搜索（基于 `ripgrep`） |
| 搜索 | `glob` | 路径模式匹配（`**/*.js`，基于 `fs.globSync`） |
| 操作 | `copy` · `move` · `delete` | 复制 / 移动（跨文件系统自动 fallback）/ 删除 |
| 执行 | `exec` | Shell 命令（cwd / 超时 / stdout / stderr） |

---

## 环境要求（Termux on Android）

| 依赖 | 最低版本 | 测试环境 |
|---|---|---|
| Termux | 最新 | Android aarch64, Linux kernel 6.6 |
| **Node.js** | **>= 22**（需 `fs.globSync` 原生支持） | v25.8.2 |
| ripgrep | 任意 | v15.1.0 |
| bash | 任意 | v5.3.9 |
| curl | 任意（仅用于健康检查） | v8.19.0 |

一键安装：

```bash
pkg update && pkg install nodejs ripgrep bash curl
```

---

## 安装

```bash
# 1. 解压到家目录
cd ~
tar xzf mcp-file-server-src.tar.gz

# 2. 安装 npm 依赖
cd ~/mcp-file-server
npm install

# 3. 赋予脚本可执行权限
chmod +x start.sh stop.sh scripts/mcp9100-*

# 4. 部署快捷命令（可选）
mkdir -p ~/bin
cp scripts/mcp9100-* ~/bin/
grep -q 'HOME/bin' ~/.bashrc 2>/dev/null || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

---

## 使用

### 模式一：stdio（Claude Code 等本地宿主自动拉起进程）

在 Claude Code 的 `~/.claude/settings.json` 里添加：

```json
{
  "mcpServers": {
    "file-manager": {
      "command": "node",
      "args": ["/data/data/com.termux/files/home/mcp-file-server/index.js"]
    }
  }
}
```

重启 Claude Code 生效。

### 模式二：HTTP（第三方 AI 软件通过 URL 导入）

启停服务（端口默认 9100）：

```bash
mcp9100-start    # 后台启动
mcp9100-stop     # 停止
```

健康检查：

```bash
curl http://127.0.0.1:9100/health
# {"status":"ok","service":"file-manager-mcp","port":"9100"}
```

**一键导入 JSON**（粘贴给第三方 AI 软件）：

```json
{
  "mcpServers": {
    "file-manager": {
      "url": "http://localhost:9100/mcp",
      "transport": "streamable-http"
    }
  }
}
```

---

## 快捷命令

| 命令 | 作用 |
|---|---|
| `mcp9100-start` | 启动 HTTP MCP（端口 9100） |
| `mcp9100-stop` | 停止 HTTP MCP |

底层等价于 `MCP_PORT=9100 ~/mcp-file-server/start.sh`。自定义端口：

```bash
MCP_PORT=8080 ~/mcp-file-server/start.sh
```

---

## 安全说明

- **路径黑名单**：`/proc`、`/sys`、`/dev`（禁止访问）
- **根目录保护**：禁止删除 `/` 和 `$HOME`
- **`exec` 防御**：默认超时 120 秒，stdout / stderr 各限制 30,000 字符
- **网络绑定**：HTTP 模式仅监听 `127.0.0.1`（本机），**切勿暴露到公网**

---

## 目录结构

```
mcp-file-server/
├── README.md            # 本文档
├── index.js             # stdio MCP server
├── server-http.js       # HTTP MCP server (port 9100)
├── package.json
├── package-lock.json
├── start.sh             # HTTP 启动脚本
├── stop.sh              # HTTP 停止脚本
└── scripts/
    ├── mcp9100-start    # 复制到 ~/bin/
    └── mcp9100-stop
```
