#!/usr/bin/env node
"use strict";
// 快速验证 exec 是否拦截 ssh/sshpass/scp，并且不误伤正常命令
const http = require("http");

function call(name, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: "2.0", id: Math.random().toString(36).slice(2),
      method: "tools/call", params: { name, arguments: args },
    });
    const req = http.request({
      host: "127.0.0.1", port: 9000, path: "/mcp", method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json, text/event-stream" },
    }, (res) => {
      let buf = "";
      res.on("data", (d) => (buf += d));
      res.on("end", () => {
        const line = buf.split("\n").find((l) => l.startsWith("data:"));
        const json = line ? line.slice(5).trim() : buf;
        try { resolve(JSON.parse(json)); } catch (e) { reject(new Error("parse: " + buf)); }
      });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

(async () => {
  const cases = [
    ["sshpass -p x ssh root@h 'ls'",                 true,  "sshpass"],
    ["ssh root@host 'ls'",                           true,  "裸 ssh"],
    ["scp a.txt root@h:/tmp/",                       true,  "scp"],
    ["rsync -av a/ root@h:/b/",                      true,  "rsync"],
    ["echo hi && ssh h whoami",                      true,  "内嵌 ssh"],
    ["echo 'ssh is a tool'",                         false, "只是字符串"],
    ["ls /tmp",                                      false, "普通命令"],
    ["cat ~/.ssh/config",                            false, ".ssh 路径不拦"],
  ];
  for (const [cmd, shouldBlock, label] of cases) {
    const r = await call("exec", { command: cmd });
    const txt = r.result?.content?.[0]?.text ?? JSON.stringify(r);
    const blocked = txt.includes("不允许包含");
    const ok = blocked === shouldBlock;
    console.log(`${ok ? "✓" : "✗"} [${label}] ${shouldBlock ? "应拦截" : "应放行"}: ${blocked ? "拦截" : "放行"}`);
    if (!ok) console.log("   cmd:", cmd, "\n   resp:", txt.slice(0, 200));
  }
})();
