# 小懿出品 · MCP Server

> **小懿出品** 为AI提供Android/termux的本地操作能力，包括文件读、写、新建、删除等能力以及为AI提供命令行执行能力，节省更多人力投入，稳定的多对话ssh同时操作单个或多个Linux服务器，项目免部署在服务器，对极限的低配服务器友好，仿人类式操作服务器与多机协同管理，优化文件上传至服务器

基于 **Model Context Protocol (MCP)** 的文件操作 / 代码编辑 / Shell 会话服务器，同时支持 **stdio** 和 **HTTP (streamable-http)** 两种传输。提供 **22 个工具**，适合在 Termux / Android 环境下接入移动端 AI 聊天软件。

---

## 功能（22 个工具）

| 类别 | 工具 | 说明 |
|---|---|---|
| 读写 | `read_file` | 读文件，带行号（`cat -n` 风格），支持 `offset` / `limit` 分块读 |
| 读写 | `write_file` | 覆盖写入 |
| 读写 | `append_file` | 追加 |
| 编辑 | `edit` | 精确替换（`old_string` → `new_string`，默认要求唯一匹配） |
| 编辑 | `multi_edit` | 同一文件多处原子编辑，要么全成要么全不动 |
| 目录 | `list_dir` | 列目录（含类型 / 大小 / 修改时间） |
| 目录 | `create_dir` | 递归创建目录 |
| 元数据 | `stat` | 文件 / 目录详细信息 |
| 搜索 | `search` | 按文件名模糊匹配 |
| 搜索 | `grep` | 按内容正则搜索（基于 `ripgrep`） |
| 搜索 | `glob` | 路径模式匹配（如 `**/*.js`） |
| 操作 | `copy` | 复制文件 / 目录 |
| 操作 | `move` | 移动 / 重命名文件或目录 |
| 操作 | `delete` | 删除文件 / 目录 |
| 执行 | `exec` | 执行一次性本地 shell 命令 |
| Shell | `shell_open` | 打开持久 shell 会话 |
| Shell | `shell_exec` | 在持久会话内执行命令 |
| Shell | `shell_close` | 关闭持久会话 |
| Shell | `shell_list` | 查看当前活跃 shell 会话 |
| 传输 | `shell_upload` | 通过持久 shell 会话上传文件 / 文件夹 |
| 传输 | `shell_download` | 通过持久 shell 会话下载文件 / 文件夹 |
| 安全 | `unlock` | 主人暗号解锁敏感路径，后续免重复确认 |

---

## 环境要求（Termux on Android）

| 依赖 | 最低版本 | 测试 / 说明 |
|---|---|---|
| Termux | 最新 | Android 环境 |
| **Node.js** | **>= 22** | 依赖 `fs.globSync` 原生支持 |
| ripgrep | 任意 | `grep` 工具依赖 |
| bash | 任意 | 启动 / 停止脚本、shell 能力 |
| curl | 任意 | 健康检查 |
| tar / base64 | 任意 | `shell_upload` / `shell_download` 依赖 |

一键安装：

```bash
pkg update && pkg install nodejs ripgrep bash curl tar coreutils
```

---

## 安装

```bash
# 1. 进入项目目录
cd ~/mcp-file-server

# 2. 安装 npm 依赖
npm install

# 3. 赋予脚本可执行权限
chmod +x start.sh stop.sh scripts/*

# 4. 部署快捷命令（可选）
mkdir -p ~/bin
cp scripts/* ~/bin/ 2>/dev/null || true
grep -q 'HOME/bin' ~/.bashrc 2>/dev/null || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

---

## 使用

**一键导入 JSON**（粘贴给第三方 AI 软件）：

```json
{
  "mcpServers": {
    "file-manager": {
      "url": "http://localhost:9000/mcp",
      "transport": "streamable-http"
    }
  }
}
```

如果走 stdio，也可直接运行：

```bash
node index.js
```

---

## 快捷命令

| 命令 | 作用 |
|---|---|
| `bash start.sh` | 启动 HTTP MCP（默认端口 9000） |
| `bash stop.sh` | 停止 HTTP MCP |
| `node index.js` | 启动 stdio 模式 |

自定义端口：

```bash
MCP_PORT=8080 bash start.sh
```

---

## 健康检查

```bash
curl http://127.0.0.1:9000/health
```

默认 MCP 地址：

```text
http://127.0.0.1:9000/mcp
```

---

## 重要能力说明

### 1. 一次性命令 vs 持久会话

- `exec`：适合单条本地命令；每次都是全新 shell，无状态
- `shell_open + shell_exec`：适合多步操作、保留 cwd / 环境变量 / ssh 连接

### 2. 文件上传 / 下载

- `shell_upload`：把本地文件 / 文件夹传到已打开的 shell 会话对端
- `shell_download`：从会话对端拉回本地
- 适合远程 SSH 主机，也适合本地 bash 会话

### 3. 敏感路径保护

- Android 系统敏感路径默认要求额外确认
- `unlock` 工具支持通过主人暗号永久解锁
- 解锁状态会落盘保存，后续无需重复 confirm

---

## 安全说明

- 支持敏感路径二次授权，默认拦截高风险路径操作
- `unlock` 仅限用户明确说出暗号时调用
- `exec` 默认超时 120 秒
- `shell_exec` 超时会终止对应会话
- `shell_upload` / `shell_download` 单次上限 100MB
- HTTP 模式默认监听 `127.0.0.1`，**不要直接暴露到公网**

---

## 目录结构

```text
mcp-file-server/
├── README.md            # 本文档
├── index.js             # stdio MCP server
├── server-http.js       # HTTP MCP server (port 9000)
├── tools.js             # 工具定义与实现
├── package.json
├── package-lock.json
├── start.sh             # HTTP 启动脚本
├── stop.sh              # HTTP 停止脚本
└── scripts/             # 可选快捷命令脚本
```

---

## 工具清单（完整）

```text
list_dir
read_file
write_file
append_file
create_dir
delete
copy
move
stat
search
edit
multi_edit
grep
exec
shell_open
shell_exec
shell_close
shell_list
shell_upload
shell_download
glob
unlock
```

---

## 备注

- 本项目已经不只是“文件管理”，还包含持久 Shell、远程传输、敏感路径授权等增强能力
- 如果你准备开源到 GitHub，建议同时提供 `.gitignore`、`.env.example`、LICENSE 和示例配置
- 若后续工具数量继续增加，请同步更新本文档中的“功能表”和“完整工具清单”
