#!/usr/bin/env node
"use strict";

// 通过 JSON-RPC 对 MCP server 做集成测试
const { spawn } = require("child_process");
const path = require("path");

const server = spawn("node", [path.join(__dirname, "..", "index.js")], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map();
let nextId = 1;

server.stdout.setEncoding("utf8");
server.stdout.on("data", (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch (e) {
      console.error("parse err:", e.message, line);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); }
    }, 10000);
  });
}

function call(name, args) {
  return rpc("tools/call", { name, arguments: args });
}

function text(resp) {
  return resp.result?.content?.[0]?.text ?? JSON.stringify(resp);
}

async function main() {
  // init
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });

  console.log("[1] shell_open");
  const open = await call("shell_open", {});
  const t1 = text(open);
  console.log(t1);
  const sid = t1.match(/session_id:\s*(\w+)/)[1];

  console.log("\n[2] exec: cd /tmp && pwd");
  console.log(text(await call("shell_exec", { session_id: sid, command: "cd /tmp && pwd" })));

  console.log("\n[3] exec: pwd (should still be /tmp, 验证 cwd 保留)");
  console.log(text(await call("shell_exec", { session_id: sid, command: "pwd" })));

  console.log("\n[4] exec: set var and echo");
  console.log(text(await call("shell_exec", { session_id: sid, command: "MYVAR=hello" })));
  console.log(text(await call("shell_exec", { session_id: sid, command: "echo $MYVAR" })));

  console.log("\n[5] exec: exit code (false -> 1)");
  console.log(text(await call("shell_exec", { session_id: sid, command: "false" })));

  console.log("\n[6] exec: stderr test");
  console.log(text(await call("shell_exec", { session_id: sid, command: "echo normal; echo err 1>&2" })));

  console.log("\n[7] exec: timeout (sleep 3 with timeout 500ms)");
  console.log(text(await call("shell_exec", { session_id: sid, command: "sleep 3", timeout: 500 })));

  console.log("\n[8] exec on dead session (应报错)");
  console.log(text(await call("shell_exec", { session_id: sid, command: "echo alive" })));

  console.log("\n[9] shell_open 新会话");
  const open2 = await call("shell_open", {});
  const t9 = text(open2);
  console.log(t9);
  const sid2 = t9.match(/session_id:\s*(\w+)/)[1];

  console.log("\n[10] shell_close");
  console.log(text(await call("shell_close", { session_id: sid2 })));

  server.kill();
  process.exit(0);
}

main().catch((e) => { console.error("TEST FAIL:", e); server.kill(); process.exit(1); });
