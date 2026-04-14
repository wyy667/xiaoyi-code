#!/data/data/com.termux/files/usr/bin/bash
# ─── MCP File Manager — 启动脚本 ─────────────────────────────────────────────
DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/.pid"
LOG_FILE="$DIR/server.log"
PORT="${MCP_PORT:-9000}"

if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[file-manager-mcp] 已在运行中 (PID $OLD_PID, 端口 $PORT)"
    exit 0
  else
    rm -f "$PID_FILE"
  fi
fi

echo "[file-manager-mcp] 正在启动..."
MCP_PORT=$PORT nohup node "$DIR/server-http.js" >> "$LOG_FILE" 2>&1 &
BG_PID=$!

# 等待服务就绪（最多 5 秒）
for i in $(seq 1 10); do
  sleep 0.5
  if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
    echo "[file-manager-mcp] 启动成功! PID=$BG_PID 端口=$PORT"
    echo "MCP 地址: http://127.0.0.1:$PORT/mcp"
    exit 0
  fi
done

echo "[file-manager-mcp] 启动超时，请查看日志: $LOG_FILE"
exit 1
