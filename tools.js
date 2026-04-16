"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

// ─── 常量 ───────────────────────────────────────────────────────────────────
// Android 系统敏感分区——访问/修改前需用户明确授权
const SENSITIVE_PREFIXES = [
  "/data",     // 应用私有数据、数据库等
  "/system",   // Android 系统核心
  "/vendor",   // 厂商定制
  "/product",
  "/apex",
  "/boot",
  "/odm",
  "/oem",
  "/mnt/vendor",
  "/proc",     // 内核接口
  "/sys",      // 内核接口
  "/dev",      // 设备节点
];
// Termux 自己在 /data/data/com.termux 下，这是用户的家目录分区——不算敏感
const SENSITIVE_EXEMPT_PREFIXES = [
  "/data/data/com.termux",
];

// AI 必须原样传入这个 token 才能访问敏感路径——相当于一份"已向用户告知并获得授权"的声明
const CONFIRM_TOKEN = "已告知用户并获得授权";

// 主人专用暗号：输入后永久解除敏感路径限制，不再反复提醒
const UNLOCK_PHRASE = "我是网懿云";
const UNLOCK_FILE = path.join(__dirname, ".unlock");
function isUnlocked() {
  try { return fs.existsSync(UNLOCK_FILE); } catch { return false; }
}

const SHELL_IDLE_TIMEOUT_MS = Number(process.env.MCP_SHELL_IDLE_TIMEOUT_MS || 30 * 60 * 1000);
const SHELL_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const UPLOAD_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

// ─── 通用工具函数 ───────────────────────────────────────────────────────────
function getSensitivity(p) {
  const resolved = path.resolve(p);
  for (const ex of SENSITIVE_EXEMPT_PREFIXES) {
    if (resolved === ex || resolved.startsWith(ex + "/")) return "safe";
  }
  for (const prefix of SENSITIVE_PREFIXES) {
    if (resolved === prefix || resolved.startsWith(prefix + "/")) return "sensitive";
  }
  return "safe";
}

// 每个工具在访问路径前调用；传入 args.confirm，命中敏感区且未授权则抛错
function checkPathAccess(p, confirm, opName) {
  if (getSensitivity(p) !== "sensitive") return;
  if (isUnlocked()) return;
  if (confirm === CONFIRM_TOKEN) return;
  throw new Error(
    `⚠️ 敏感路径需要用户明确授权：${path.resolve(p)}（操作：${opName}）\n\n` +
    `此路径位于 Android 系统敏感分区（/data、/system、/vendor、/proc、/sys、/dev 等）。\n` +
    `在继续之前，你（AI）必须先停下来，用自然语言告诉用户：\n` +
    `  1) 具体要对哪个路径做什么操作（读 / 写 / 删除 / 执行等）；\n` +
    `  2) 可能的严重后果，至少包括：\n` +
    `     · 设备系统崩溃、开机循环或变砖，可能需要刷机恢复\n` +
    `     · 应用数据丢失、账号登录失效\n` +
    `     · 破坏 Android 安全机制，导致安全风险\n` +
    `     · 对 /data 的修改可能让整个手机无法正常使用\n` +
    `  3) 该操作一般不可撤销。\n\n` +
    `只有在用户明确回复同意之后，重新调用本工具时额外传参 confirm="${CONFIRM_TOKEN}"（原样复制这个字符串）。\n` +
    `不要自己替用户做决定，不要把确认流程省略。`
  );
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

function shq(s) {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

function truncate(s, max) {
  if (!s) return "";
  if (s.length > max) return s.slice(0, max) + `\n...[截断，原长 ${s.length} 字符]`;
  return s;
}

// ─── 持久 shell 会话池 ────────────────────────────────────────────────────
const shellSessions = new Map();

function createShellSession(shellCmd) {
  const cmd = shellCmd || "bash";
  const proc = spawn("sh", ["-c", `exec ${cmd}`], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PS1: "", TERM: "dumb" },
  });
  const session = {
    id: crypto.randomBytes(6).toString("hex"),
    proc,
    shellCmd: shellCmd || "bash",
    stdoutBuf: "",
    stderrBuf: "",
    busy: false,
    dead: false,
    exitInfo: null,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (d) => { session.stdoutBuf += d; });
  proc.stderr.on("data", (d) => { session.stderrBuf += d; });
  proc.on("exit", (code, signal) => {
    session.dead = true;
    session.exitInfo = { code, signal };
    shellSessions.delete(session.id);
  });
  proc.on("error", (err) => {
    session.dead = true;
    session.exitInfo = { error: err.message };
    shellSessions.delete(session.id);
  });
  shellSessions.set(session.id, session);
  return session;
}

async function shellSessionExec(sessionId, command, timeoutMs) {
  const s = shellSessions.get(sessionId);
  if (!s) throw new Error(`会话不存在: ${sessionId}`);
  if (s.dead) throw new Error(`会话已终止`);
  if (s.busy) throw new Error(`会话忙，正在执行其他命令`);
  s.busy = true;
  s.lastActivity = Date.now();
  try {
    const nonce = crypto.randomBytes(8).toString("hex");
    const sentinel = `__MCP_END_${nonce}__`;
    const re = new RegExp(sentinel + "(\\d+)__");
    const startStdout = s.stdoutBuf.length;
    const startStderr = s.stderrBuf.length;
    s.proc.stdin.write(`${command}\nprintf '%s%d__\\n' '${sentinel}' "$?"\n`);

    const deadline = Date.now() + (timeoutMs || 120000);
    while (true) {
      const tail = s.stdoutBuf.slice(startStdout);
      const m = tail.match(re);
      if (m) {
        const stdout = tail.slice(0, m.index);
        await new Promise((r) => setTimeout(r, 20));
        const stderr = s.stderrBuf.slice(startStderr);
        // 回收已消费的 buffer，避免大下载时内存泄漏
        s.stdoutBuf = "";
        s.stderrBuf = "";
        return { exitCode: parseInt(m[1], 10), stdout, stderr, timedOut: false };
      }
      if (s.dead) {
        const stdout = s.stdoutBuf.slice(startStdout);
        const stderr = s.stderrBuf.slice(startStderr);
        throw new Error(`会话意外终止。stdout: ${stdout.slice(-500)} stderr: ${stderr.slice(-500)}`);
      }
      if (Date.now() > deadline) {
        s.proc.kill("SIGKILL");
        s.dead = true;
        const stdout = s.stdoutBuf.slice(startStdout);
        const stderr = s.stderrBuf.slice(startStderr);
        return { exitCode: -1, stdout, stderr, timedOut: true };
      }
      await new Promise((r) => setTimeout(r, 40));
    }
  } finally {
    s.busy = false;
    s.lastActivity = Date.now();
  }
}

function closeShellSession(sessionId) {
  const s = shellSessions.get(sessionId);
  if (!s) return false;
  if (!s.dead) {
    try { s.proc.stdin.end("exit\n"); } catch (_) {}
    setTimeout(() => { try { s.proc.kill("SIGKILL"); } catch (_) {} }, 500);
  }
  shellSessions.delete(sessionId);
  return true;
}

function listShellSessions() {
  const now = Date.now();
  return Array.from(shellSessions.values()).map((s) => ({
    id: s.id,
    shell: s.shellCmd,
    busy: s.busy,
    dead: s.dead,
    ageSec: Math.round((now - s.createdAt) / 1000),
    idleSec: Math.round((now - s.lastActivity) / 1000),
    createdAt: new Date(s.createdAt).toISOString().replace("T", " ").slice(0, 19),
  }));
}

// 空闲会话后台清扫
(function startIdleSweep() {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of shellSessions) {
      if (s.busy || s.dead) continue;
      if (now - s.lastActivity > SHELL_IDLE_TIMEOUT_MS) {
        closeShellSession(id);
      }
    }
  }, SHELL_SWEEP_INTERVAL_MS);
  timer.unref();
})();

// ─── shell_upload / shell_download ────────────────────────────────────────
async function shellUpload(args) {
  if (!args.session_id) throw new Error("session_id 不能为空");
  if (!args.local_path) throw new Error("local_path 不能为空");
  if (!args.remote_path) throw new Error("remote_path 不能为空");
  const lp = resolvePath(args.local_path);
  checkPathAccess(lp, args.confirm, "上传（读本地源）");
  if (!fs.existsSync(lp)) throw new Error(`本地路径不存在: ${lp}`);
  const st = fs.statSync(lp);

  const delim = `MCP_UPLOAD_${crypto.randomBytes(8).toString("hex")}`;
  const rp = shq(args.remote_path);
  let command, desc, payloadSize;

  if (st.isDirectory()) {
    const r = spawnSync("tar", ["-czf", "-", "-C", lp, "."], {
      maxBuffer: UPLOAD_DOWNLOAD_MAX_BYTES + 32 * 1024 * 1024,
    });
    if (r.status !== 0) {
      const errTxt = r.stderr ? r.stderr.toString() : `exit ${r.status}`;
      throw new Error(`本地 tar 失败: ${errTxt}`);
    }
    const tgz = r.stdout;
    if (tgz.length > UPLOAD_DOWNLOAD_MAX_BYTES) {
      throw new Error(`压缩后仍超过 ${formatSize(UPLOAD_DOWNLOAD_MAX_BYTES)}（实际 ${formatSize(tgz.length)}）——请改用 rsync`);
    }
    const b64 = tgz.toString("base64");
    const check = args.overwrite
      ? ""
      : `if [ -e ${rp} ]; then echo "远端目标已存在: ${args.remote_path}（设 overwrite=true 可覆盖合并）" >&2; exit 17; fi; `;
    command = `( ${check}mkdir -p ${rp} && base64 -d <<'${delim}' | tar -xzf - -C ${rp}\n${b64}\n${delim}\n)`;
    payloadSize = tgz.length;
    desc = `目录 ${lp} → ${args.remote_path}（gzip 后 ${formatSize(tgz.length)}）`;
  } else if (st.isFile()) {
    if (st.size > UPLOAD_DOWNLOAD_MAX_BYTES) {
      throw new Error(`文件超过 ${formatSize(UPLOAD_DOWNLOAD_MAX_BYTES)}（实际 ${formatSize(st.size)}）——请改用 rsync`);
    }
    const b64 = fs.readFileSync(lp).toString("base64");
    const check = args.overwrite
      ? ""
      : `if [ -e ${rp} ]; then echo "远端目标已存在: ${args.remote_path}（设 overwrite=true 可覆盖）" >&2; exit 17; fi; `;
    command = `( ${check}mkdir -p "$(dirname ${rp})" && base64 -d > ${rp} <<'${delim}'\n${b64}\n${delim}\n)`;
    payloadSize = st.size;
    desc = `文件 ${lp} → ${args.remote_path}（${formatSize(st.size)}）`;
  } else {
    throw new Error(`不支持的本地文件类型: ${lp}`);
  }

  const result = await shellSessionExec(args.session_id, command, args.timeout || 300000);
  return { ...result, desc, payloadSize };
}

async function shellDownload(args) {
  if (!args.session_id) throw new Error("session_id 不能为空");
  if (!args.remote_path) throw new Error("remote_path 不能为空");
  if (!args.local_path) throw new Error("local_path 不能为空");
  const lp = resolvePath(args.local_path);
  checkPathAccess(lp, args.confirm, "下载（写本地目标）");

  const rp = shq(args.remote_path);
  const nonce = crypto.randomBytes(6).toString("hex");
  const startMark = `__MCP_DL_S_${nonce}__`;
  const endMark = `__MCP_DL_E_${nonce}__`;

  // 1) 探测远端类型和大小
  const probeCmd = `if [ ! -e ${rp} ]; then echo "NOTFOUND"; elif [ -d ${rp} ]; then echo "DIR"; elif [ -f ${rp} ]; then echo "FILE:$(wc -c < ${rp} | tr -d ' ')"; else echo "OTHER"; fi`;
  const probe = await shellSessionExec(args.session_id, probeCmd, 30000);
  if (probe.exitCode !== 0) {
    throw new Error(`远端探测失败: ${probe.stderr || probe.stdout}`);
  }
  const typeLine = probe.stdout.trim().split("\n").pop();
  if (typeLine === "NOTFOUND") throw new Error(`远端路径不存在: ${args.remote_path}`);
  if (typeLine === "OTHER") throw new Error(`不支持的远端文件类型: ${args.remote_path}`);

  const isDir = typeLine === "DIR";
  if (!isDir) {
    const size = parseInt(typeLine.slice(5), 10);
    if (isNaN(size)) throw new Error(`无法解析远端文件大小: ${typeLine}`);
    if (size > UPLOAD_DOWNLOAD_MAX_BYTES) {
      throw new Error(`远端文件超过 ${formatSize(UPLOAD_DOWNLOAD_MAX_BYTES)}（实际 ${formatSize(size)}）——请改用 rsync`);
    }
  }

  // 2) 预检本地路径
  if (isDir) {
    if (fs.existsSync(lp)) {
      if (!args.overwrite) throw new Error(`本地目标已存在: ${lp}（设 overwrite=true 可覆盖合并）`);
      if (!fs.statSync(lp).isDirectory()) throw new Error(`本地目标已存在且不是目录: ${lp}`);
    }
  } else {
    if (fs.existsSync(lp) && !args.overwrite) {
      throw new Error(`本地目标已存在: ${lp}（设 overwrite=true 可覆盖）`);
    }
  }

  // 3) 远端打包并 base64，带起止标记
  const innerCmd = isDir
    ? `tar -czf - -C ${rp} .`
    : `cat ${rp}`;
  const streamCmd = `printf '%s\\n' '${startMark}'; ${innerCmd} | base64; printf '%s\\n' '${endMark}'`;
  const result = await shellSessionExec(args.session_id, streamCmd, args.timeout || 600000);
  if (result.exitCode !== 0 || result.timedOut) {
    return { ...result, desc: `下载失败: ${args.remote_path}` };
  }

  // 4) 提取 base64 段
  const out = result.stdout;
  const si = out.indexOf(startMark);
  const ei = out.indexOf(endMark);
  if (si === -1 || ei === -1 || ei <= si) {
    throw new Error(`未在输出中找到标记（可能对端没有 base64/tar 命令）`);
  }
  const b64 = out.slice(si + startMark.length, ei).trim();
  let buf;
  try { buf = Buffer.from(b64, "base64"); }
  catch (e) { throw new Error(`base64 解码失败: ${e.message}`); }
  if (buf.length > UPLOAD_DOWNLOAD_MAX_BYTES) {
    throw new Error(`解码后超过 ${formatSize(UPLOAD_DOWNLOAD_MAX_BYTES)}（实际 ${formatSize(buf.length)}）`);
  }

  // 5) 落盘
  let desc;
  if (isDir) {
    fs.mkdirSync(lp, { recursive: true });
    const tar = spawnSync("tar", ["-xzf", "-", "-C", lp], { input: buf, maxBuffer: UPLOAD_DOWNLOAD_MAX_BYTES + 32 * 1024 * 1024 });
    if (tar.status !== 0) {
      const errTxt = tar.stderr ? tar.stderr.toString() : `exit ${tar.status}`;
      throw new Error(`本地 tar 解包失败: ${errTxt}`);
    }
    desc = `目录 ${args.remote_path} → ${lp}（gzip 后 ${formatSize(buf.length)}）`;
  } else {
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    fs.writeFileSync(lp, buf);
    desc = `文件 ${args.remote_path} → ${lp}（${formatSize(buf.length)}）`;
  }
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false, desc, payloadSize: buf.length };
}

// ─── 工具定义 ───────────────────────────────────────────────────────────────
// 所有涉及路径的工具共享这个参数，用于敏感分区二次授权
const CONFIRM_PARAM = {
  type: "string",
  description: `【敏感路径授权】目标路径如果位于 Android 系统分区（/data、/system、/vendor、/proc、/sys、/dev 等），必须传入固定值 "${CONFIRM_TOKEN}"。首次遇到敏感路径时，工具会返回授权说明——你必须先把具体路径、操作、风险（系统崩溃、变砖、数据丢失等）用自然语言告诉用户，获得用户明确同意后，再次调用时加上这个参数。不要替用户做决定，也不要用其他字符串。非敏感路径（家目录、/tmp、外部存储等）不需要这个参数。`,
};

const TOOLS = [
  {
    name: "list_dir",
    description: "列出目录内容（文件名、类型、大小、修改时间）",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "目录路径，支持 ~ 表示家目录" },
        confirm: CONFIRM_PARAM,
      },
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
        confirm: CONFIRM_PARAM,
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
        confirm: CONFIRM_PARAM,
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
        confirm: CONFIRM_PARAM,
      },
      required: ["path", "content"],
    },
  },
  {
    name: "create_dir",
    description: "创建目录（支持递归创建多级目录）",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "目录路径" },
        confirm: CONFIRM_PARAM,
      },
      required: ["path"],
    },
  },
  {
    name: "delete",
    description: "删除文件或目录（目录会递归删除）",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "要删除的路径" },
        confirm: CONFIRM_PARAM,
      },
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
        confirm: CONFIRM_PARAM,
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
        confirm: CONFIRM_PARAM,
      },
      required: ["src", "dest"],
    },
  },
  {
    name: "stat",
    description: "获取文件或目录的详细信息（大小、权限、时间等）",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "路径" },
        confirm: CONFIRM_PARAM,
      },
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
        confirm: CONFIRM_PARAM,
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
        confirm: CONFIRM_PARAM,
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "multi_edit",
    description: "一次性对同一个文件做多处编辑（原子性：要么全部成功，要么全部不动）。edits 数组按顺序应用，每一处的匹配要求与 edit 相同（默认唯一，可设 replace_all）。\n\n适合改配置文件、批量同步重命名等场景，比多次调用 edit 更高效也更安全（中途失败不会留下半改状态）。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        edits: {
          type: "array",
          description: "按顺序应用的编辑列表",
          items: {
            type: "object",
            properties: {
              old_string: { type: "string", description: "要替换的原文" },
              new_string: { type: "string", description: "替换后的新内容" },
              replace_all: { type: "boolean", description: "是否替换所有匹配，默认 false", default: false },
            },
            required: ["old_string", "new_string"],
          },
        },
        confirm: CONFIRM_PARAM,
      },
      required: ["path", "edits"],
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
        confirm: CONFIRM_PARAM,
      },
      required: ["pattern"],
    },
  },
  {
    name: "exec",
    description: "【仅用于本地一次性命令】执行一条 shell 命令，无状态，每次调用都是全新 shell。⚠️ 不要用它来 ssh 远程服务器！每次 ssh 都重新握手+认证，延迟高且 cd/变量不保留。连接远程或需要多步操作时，请改用 shell_open + shell_exec。返回 退出码/stdout/stderr，默认超时 120 秒",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "shell 命令" },
        cwd: { type: "string", description: "工作目录，默认家目录" },
        timeout: { type: "number", description: "超时毫秒，默认 120000", default: 120000 },
        confirm: CONFIRM_PARAM,
      },
      required: ["command"],
    },
  },
  {
    name: "shell_open",
    description: "【首选：连接远程服务器 / 多步操作必用】打开一个持久 shell 会话，返回 session_id。后续所有 shell_exec 共享同一个 shell 进程，cwd/环境变量/shell 变量完全保留。\n\n典型场景：\n1) 连接远程服务器：shell=\"ssh root@HOST\"（强烈建议先配好 ~/.ssh/config 和公钥免密，或用 ssh -o 参数；避免 sshpass）。只需建立一次连接，之后每条命令几乎零延迟。\n2) 本地多步操作：shell=\"bash\"（默认），比如先 cd 再 make 再查日志。\n\n⚠️ 不要用 exec + sshpass 反复连同一台机器——那是错误用法。\n\n会话空闲超过 30 分钟会自动回收，用完记得 shell_close。",
    inputSchema: {
      type: "object",
      properties: {
        shell: { type: "string", description: "要启动的 shell 命令，默认 bash。示例: \"ssh vps1\" 或 \"bash\"" },
      },
    },
  },
  {
    name: "shell_exec",
    description: "在 shell_open 创建的会话里执行命令，完整保留 cwd/环境变量/shell 变量。对同一台远程主机的所有操作，都应在同一个 session 里跑，不要每步都重新 ssh。\n\n不支持 TTY 交互程序（vim/top/sudo 交互密码等）；sudo 请用 NOPASSWD 或 -S 读 stdin。\n\n用完记得 shell_close。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "shell_open 返回的会话 id" },
        command: { type: "string", description: "要执行的命令，可含多行" },
        timeout: { type: "number", description: "超时毫秒，默认 120000。超时会终止会话", default: 120000 },
      },
      required: ["session_id", "command"],
    },
  },
  {
    name: "shell_close",
    description: "关闭一个持久 shell 会话，释放资源",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "shell_open 返回的会话 id" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "shell_list",
    description: "列出所有活跃的 shell 会话（id / shell 命令 / 是否忙 / 存在时长 / 空闲时长）。用来检查有没有忘关的会话。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "shell_upload",
    description: "在已打开的 shell 会话里上传本地文件/文件夹到对端（对端可以是 ssh 远程主机，也可以是本地 bash）。复用现有会话的 ssh 握手，对端只需有 base64 + tar（绝大多数 Linux 默认就有），不需要 scp/rsync/sshpass。\n\n单次上限 100MB（文件夹指 gzip 压缩后的大小），更大的请用 rsync。默认超时 300 秒。\n\n路径语义：\n- 上传文件：remote_path 是对端的完整文件路径（包含文件名），父目录会自动创建。\n- 上传文件夹：remote_path 是对端的目标目录（会自动创建），本地目录的\"内容\"展开到该目录下。例如 local_path=/a/foo, remote_path=/srv/foo → /srv/foo 内部等同于 /a/foo 内部。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "shell_open 返回的会话 id" },
        local_path: { type: "string", description: "本地文件或文件夹路径，支持 ~" },
        remote_path: { type: "string", description: "对端目标路径（文件为最终文件名，文件夹为目标目录）" },
        overwrite: { type: "boolean", description: "目标已存在时是否覆盖，默认 false；文件夹模式下为覆盖合并", default: false },
        timeout: { type: "number", description: "超时毫秒，默认 300000", default: 300000 },
        confirm: CONFIRM_PARAM,
      },
      required: ["session_id", "local_path", "remote_path"],
    },
  },
  {
    name: "shell_download",
    description: "从已打开的 shell 会话下载对端文件/文件夹到本地，与 shell_upload 对称。对端通过 base64+tar 打包输出，本地解码落盘。单次 ≤100MB（文件按实际大小判断，文件夹按 gzip 后判断），默认超时 600 秒。\n\n路径语义：\n- 下载文件：remote_path 是对端文件的完整路径，local_path 是本地落地文件路径。\n- 下载文件夹：remote_path 是对端目录，local_path 是本地目标目录，对端内容展开到本地目录下。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "shell_open 返回的会话 id" },
        remote_path: { type: "string", description: "对端源路径" },
        local_path: { type: "string", description: "本地目标路径，支持 ~" },
        overwrite: { type: "boolean", description: "本地目标存在时是否覆盖，默认 false", default: false },
        timeout: { type: "number", description: "超时毫秒，默认 600000", default: 600000 },
        confirm: CONFIRM_PARAM,
      },
      required: ["session_id", "remote_path", "local_path"],
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
        confirm: CONFIRM_PARAM,
      },
      required: ["pattern"],
    },
  },
  {
    name: "unlock",
    description: `【主人暗号】当用户输入暗号"${UNLOCK_PHRASE}"时（且仅当时），立即调用本工具并原样传入 phrase 参数。调用成功后，本服务会永久记忆解锁状态（落盘到 .unlock 文件），后续所有敏感路径操作不再需要 confirm 授权，也不再反复提醒。用户未输入暗号时，绝不能自行调用。action="status" 可查询当前状态，action="lock" 可重新上锁。`,
    inputSchema: {
      type: "object",
      properties: {
        phrase: { type: "string", description: `解锁暗号，必须与用户原话一致；解锁时必填` },
        action: { type: "string", description: `unlock（默认）/ status / lock`, enum: ["unlock", "status", "lock"] },
      },
    },
  },
];

// ─── 分派 ───────────────────────────────────────────────────────────────────
async function callTool(name, args) {
  try {
    if (name === "list_dir") {
      const dir = resolvePath(args.path);
      checkPathAccess(dir, args.confirm, "列目录");
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
      checkPathAccess(fp, args.confirm, "读文件");
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
      checkPathAccess(fp, args.confirm, "写文件");
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, args.content, args.encoding || "utf8");
      return { content: [{ type: "text", text: `已写入: ${fp}` }] };
    }

    if (name === "append_file") {
      const fp = resolvePath(args.path);
      checkPathAccess(fp, args.confirm, "追加写");
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.appendFileSync(fp, args.content, "utf8");
      return { content: [{ type: "text", text: `已追加到: ${fp}` }] };
    }

    if (name === "create_dir") {
      const dp = resolvePath(args.path);
      checkPathAccess(dp, args.confirm, "创建目录");
      fs.mkdirSync(dp, { recursive: true });
      return { content: [{ type: "text", text: `目录已创建: ${dp}` }] };
    }

    if (name === "delete") {
      const target = resolvePath(args.path);
      if (target === "/" || target === os.homedir()) throw new Error("拒绝删除根目录或家目录（硬保护，无法通过 confirm 绕过）");
      checkPathAccess(target, args.confirm, "删除");
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
      checkPathAccess(src, args.confirm, "复制（源）");
      checkPathAccess(dest, args.confirm, "复制（目标）");
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
      checkPathAccess(src, args.confirm, "移动（源）");
      checkPathAccess(dest, args.confirm, "移动（目标）");
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
      checkPathAccess(target, args.confirm, "查看文件信息");
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
      checkPathAccess(dir, args.confirm, "搜索文件名");
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
      checkPathAccess(fp, args.confirm, "编辑文件");
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

    if (name === "multi_edit") {
      const fp = resolvePath(args.path);
      checkPathAccess(fp, args.confirm, "批量编辑文件");
      if (!fs.existsSync(fp)) throw new Error(`文件不存在: ${fp}`);
      if (!Array.isArray(args.edits) || args.edits.length === 0) throw new Error("edits 不能为空");
      let content = fs.readFileSync(fp, "utf8");
      let total = 0;
      const lines = [];
      for (let i = 0; i < args.edits.length; i++) {
        const e = args.edits[i];
        if (!e || typeof e.old_string !== "string" || typeof e.new_string !== "string") {
          throw new Error(`#${i + 1}: 缺少 old_string / new_string`);
        }
        if (e.old_string === e.new_string) throw new Error(`#${i + 1}: old_string 与 new_string 相同`);
        if (e.replace_all) {
          const parts = content.split(e.old_string);
          if (parts.length === 1) throw new Error(`#${i + 1}: old_string 未在文件中找到`);
          content = parts.join(e.new_string);
          total += parts.length - 1;
          lines.push(`#${i + 1}: 替换 ${parts.length - 1} 处（replace_all）`);
        } else {
          const idx = content.indexOf(e.old_string);
          if (idx === -1) throw new Error(`#${i + 1}: old_string 未在文件中找到`);
          if (content.indexOf(e.old_string, idx + 1) !== -1) {
            throw new Error(`#${i + 1}: old_string 在当前版本中出现多次，请提供更多上下文或 replace_all=true`);
          }
          content = content.slice(0, idx) + e.new_string + content.slice(idx + e.old_string.length);
          total += 1;
          lines.push(`#${i + 1}: 替换 1 处`);
        }
      }
      fs.writeFileSync(fp, content, "utf8");
      return { content: [{ type: "text", text: `已编辑: ${fp}（共 ${total} 处，${args.edits.length} 条编辑）\n${lines.join("\n")}` }] };
    }

    if (name === "grep") {
      const dir = args.path ? resolvePath(args.path) : os.homedir();
      checkPathAccess(dir, args.confirm, "内容搜索");
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
      checkPathAccess(cwd, args.confirm, "glob 模式匹配");
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
      if (!args.command) throw new Error("command 不能为空");
      if (/(^|[\s;&|`$(])(ssh|sshpass|scp|sftp|rsync)(\s|$)/.test(args.command)) {
        throw new Error(
          "exec 不允许包含 ssh/sshpass/scp/sftp/rsync。" +
          "连接远程主机请改用 shell_open({shell:\"ssh HOST\"}) 创建持久会话，" +
          "之后所有远端命令通过 shell_exec({session_id, command}) 在同一会话里执行——" +
          "只握手一次，cwd/环境变量全保留，速度快几十倍。" +
          "强烈建议配 ~/.ssh/config + 公钥免密，不要用 sshpass。"
        );
      }
      const cwd = args.cwd ? resolvePath(args.cwd) : os.homedir();
      checkPathAccess(cwd, args.confirm, "exec 工作目录");
      const timeout = args.timeout || 120000;
      const r = spawnSync(args.command, {
        cwd,
        shell: true,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf8",
      });
      const timedOut = r.signal === "SIGTERM" && r.status === null;
      const parts = [`[exit=${r.status ?? "?"}] cwd=${cwd}${timedOut ? " (超时)" : ""}`];
      if (r.stdout) parts.push(`---stdout---\n${truncate(r.stdout, 30000)}`);
      if (r.stderr) parts.push(`---stderr---\n${truncate(r.stderr, 30000)}`);
      if (r.error && r.error.code !== "ETIMEDOUT") parts.push(`错误: ${r.error.message}`);
      return {
        content: [{ type: "text", text: parts.join("\n") }],
        isError: r.status !== 0,
      };
    }

    if (name === "shell_open") {
      const session = createShellSession(args.shell);
      return {
        content: [{
          type: "text",
          text: `会话已打开\nsession_id: ${session.id}\nshell: ${session.shellCmd}\n当前活跃会话数: ${shellSessions.size}`,
        }],
      };
    }

    if (name === "shell_exec") {
      if (!args.session_id) throw new Error("session_id 不能为空");
      if (!args.command) throw new Error("command 不能为空");
      const r = await shellSessionExec(args.session_id, args.command, args.timeout);
      const parts = [`[exit=${r.exitCode}] session=${args.session_id}${r.timedOut ? " (超时，会话已终止)" : ""}`];
      if (r.stdout) parts.push(`---stdout---\n${truncate(r.stdout, 30000)}`);
      if (r.stderr) parts.push(`---stderr---\n${truncate(r.stderr, 30000)}`);
      return {
        content: [{ type: "text", text: parts.join("\n") }],
        isError: r.exitCode !== 0,
      };
    }

    if (name === "shell_close") {
      if (!args.session_id) throw new Error("session_id 不能为空");
      const ok = closeShellSession(args.session_id);
      return {
        content: [{
          type: "text",
          text: ok ? `会话 ${args.session_id} 已关闭。剩余活跃会话: ${shellSessions.size}` : `会话不存在: ${args.session_id}`,
        }],
      };
    }

    if (name === "shell_list") {
      const sessions = listShellSessions();
      if (sessions.length === 0) {
        return { content: [{ type: "text", text: "当前没有活跃的 shell 会话" }] };
      }
      const rows = sessions.map((s) =>
        `${s.id}  ${s.busy ? "[busy]" : "[idle]"}  shell=${s.shell}  age=${s.ageSec}s  idle=${s.idleSec}s  创建=${s.createdAt}`
      );
      return {
        content: [{
          type: "text",
          text: `活跃会话数: ${sessions.length}（空闲 ${Math.round(SHELL_IDLE_TIMEOUT_MS / 60000)} 分钟自动回收）\n\n${rows.join("\n")}`,
        }],
      };
    }

    if (name === "shell_upload") {
      const r = await shellUpload(args);
      const parts = [`[exit=${r.exitCode}] ${r.desc}${r.timedOut ? " (超时，会话已终止)" : ""}`];
      if (r.stdout) parts.push(`---stdout---\n${truncate(r.stdout, 5000)}`);
      if (r.stderr) parts.push(`---stderr---\n${truncate(r.stderr, 5000)}`);
      if (r.exitCode === 0) parts.push(`✓ 上传完成`);
      return {
        content: [{ type: "text", text: parts.join("\n") }],
        isError: r.exitCode !== 0,
      };
    }

    if (name === "shell_download") {
      const r = await shellDownload(args);
      const parts = [`[exit=${r.exitCode}] ${r.desc}${r.timedOut ? " (超时，会话已终止)" : ""}`];
      if (r.stderr) parts.push(`---stderr---\n${truncate(r.stderr, 5000)}`);
      if (r.exitCode === 0) parts.push(`✓ 下载完成`);
      return {
        content: [{ type: "text", text: parts.join("\n") }],
        isError: r.exitCode !== 0,
      };
    }

    if (name === "unlock") {
      const action = args.action || "unlock";
      if (action === "status") {
        const on = isUnlocked();
        return { content: [{ type: "text", text: on ? `🔓 已解锁（文件: ${UNLOCK_FILE}）` : `🔒 未解锁，敏感路径仍需授权` }] };
      }
      if (action === "lock") {
        try { fs.unlinkSync(UNLOCK_FILE); } catch {}
        return { content: [{ type: "text", text: `🔒 已重新上锁，后续敏感路径需要授权` }] };
      }
      if (args.phrase !== UNLOCK_PHRASE) {
        return { content: [{ type: "text", text: `暗号不匹配，拒绝解锁。` }], isError: true };
      }
      fs.writeFileSync(UNLOCK_FILE, new Date().toISOString());
      return { content: [{ type: "text", text: `🔓 解锁成功。后续所有敏感路径操作不再需要 confirm 授权，也不会再反复提醒。需要恢复限制时，调用 unlock(action="lock")。` }] };
    }

    throw new Error(`未知工具: ${name}`);
  } catch (err) {
    return { content: [{ type: "text", text: `错误: ${err.message}` }], isError: true };
  }
}

module.exports = { TOOLS, callTool, shellSessions };
