#!/data/data/com.termux/files/usr/bin/bash
# ─── MCP File Manager — 停止脚本 ─────────────────────────────────────────────
DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/.pid"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    sleep 0.5
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
    rm -f "$PID_FILE"
    echo "[file-manager-mcp] 已停止 (PID $PID)"
  else
    rm -f "$PID_FILE"
    echo "[file-manager-mcp] 进程已不存在，清理完毕"
  fi
else
  # 没有 PID 文件时，查找 server-http.js 进程
  PID=$(ps aux 2>/dev/null | grep "server-http.js" | grep -v grep | awk '{print $1}' | head -1)
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null
    echo "[file-manager-mcp] 已停止 (PID $PID)"
  else
    echo "[file-manager-mcp] 服务未运行"
  fi
fi
