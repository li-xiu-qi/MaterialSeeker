#!/usr/bin/env bash
# 在 dgx-spark 上一键启动两个推理服务。setsid + nohup 脱离会话，
# 日志落 logs/。已在跑的服务会先按端口反查 PID 停掉再起（重启语义）。
#
# 注意：停服务必须从端口反查 PID（ss -ltnp | grep ':<port>'），
# 不要按进程名 pgrep/pkill 匹配 next/python 这类字样——会把执行本脚本的
# ssh 命令行一并匹配上，命令自杀且端口可能已释放、服务没起。

set -u
cd "$(dirname "$0")"

stop_service() {
  local name="$1" port="$2" old
  old=$(ss -ltnp 2>/dev/null | grep ":${port}" | grep -oP 'pid=\K[0-9]+' | sort -u)
  if [ -n "$old" ]; then
    echo "stopping ${name} (pid: $(echo "$old" | tr '\n' ' '))"
    # shellcheck disable=SC2086
    kill $old 2>/dev/null || true
  fi
}

start_service() {
  local name="$1" script="$2" port="$3" python_bin="$4"
  local log="logs/${name}-${port}.log"

  # 端口反查停旧进程（模式串里不含进程名，不会自匹配）
  local old
  old=$(ss -ltnp 2>/dev/null | grep ":${port}" | grep -oP 'pid=\K[0-9]+' | sort -u)
  if [ -n "$old" ]; then
    echo "stopping old ${name} (pid: $(echo "$old" | tr '\n' ' '))"
    # shellcheck disable=SC2086
    kill $old 2>/dev/null || true
    sleep 2
  fi

  echo "starting ${name} on :${port} (${python_bin})"
  HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
    setsid nohup "$python_bin" "$script" --port "$port" \
    > "$log" 2>&1 < /dev/null &
}

mkdir -p logs
# shellcheck disable=SC1091
if [ -f .env ]; then set -a; . ./.env; set +a; fi
PROFILE=${MATERIALSEEKER_PROFILE:-standard}
if [ "$PROFILE" = "light" ]; then
  # 轻量版共用无模型环境。可用 MATERIALSEEKER_LIGHT_PYTHON 指向自己的 venv。
  LIGHT_PYTHON=${MATERIALSEEKER_LIGHT_PYTHON:-python3}
  export MATERIALSEEKER_PROFILE=light
  # 业务侧轻量检索不请求 8280，默认只起 8281，少一个进程。
  stop_service embedding 8280
  start_service video video_server.py 8281 "$LIGHT_PYTHON"
  echo "light mode: embedding service :8280 not started"
elif [ "$PROFILE" = "standard" ]; then
  # 标准版沿用两个独立模型环境，embedding 与 FunASR 不合并。
  # MATERIALSEEKER_EMBEDDING_PYTHON 可指向 LiteRT-LM 环境（例如 ke-1 上的
  # litert-env），默认仍是 dgx-spark 的 eg2-env。
  export MATERIALSEEKER_PROFILE=standard
  EMBEDDING_PYTHON=${MATERIALSEEKER_EMBEDDING_PYTHON:-$HOME/eg2-env/bin/python}
  start_service embedding embedding_server.py 8280 "$EMBEDDING_PYTHON"
  start_service video     video_server.py     8281 "$HOME/hearsight-env/bin/python"
else
  echo "unknown MATERIALSEEKER_PROFILE: $PROFILE (expected light or standard)" >&2
  exit 2
fi
echo "logs: $(pwd)/logs/"
