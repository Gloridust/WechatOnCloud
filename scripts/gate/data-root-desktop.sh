#!/usr/bin/env bash
# WOC_DATA_ROOT 填 Windows 路径（#133）的回归：模拟 Docker Desktop，经面板接口走一遍新建实例。
#   面板：预加载 sim/docker-desktop.cjs，docker.info() 报 Docker Desktop；
#   宿主：临时建出 Docker Desktop 虚拟机里各盘的挂载点（WSL2 后端 /run/desktop/mnt/host/<盘>，Hyper-V 后端 /host_mnt/<盘>）。
# 验证：两种后端都换算对、数据真落在该目录、清除数据时一并删除；盘没共享时创建失败并提示 File sharing、不建卷、
# 探测时不在虚拟机里顺手建出空目录。
# 没覆盖：真正的 Windows 文件共享（权限映射、性能），这只能在 Windows 上测。
# 用法：scripts/gate/data-root-desktop.sh <面板镜像> <实例镜像>
# 会临时在宿主建 /run/desktop 和 /host_mnt（结束即删）；宿主上已有这两个路径时拒绝运行。
set -u
PANEL_IMG="${1:?用法：$0 <面板镜像> <实例镜像>}"
INST_IMG="${2:?用法：$0 <面板镜像> <实例镜像>}"
SIM="$(cd "$(dirname "$0")" && pwd)/sim/docker-desktop.cjs"
PORT="${WOC_E2E_PORT:-36198}"
U="http://127.0.0.1:$PORT"
NAME=woc-e2e-ddsim
NET=woc-e2e-ddsim-net
DATA=woc-e2e-ddsim-data # 面板 /data 用 Docker 卷，免得留下 root 拥有的临时文件
JAR="$(mktemp "${TMPDIR:-/tmp}/woc-ddsim.XXXXXX")"
FAILED=0
IDS=()

note() { echo "  ✓ $*"; }
bad() {
  echo "  ✗ $*"
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error::$*"
  FAILED=1
}
api() { curl -s -b "$JAR" -H 'content-type: application/json' "$@"; }
act() { curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$@"; }
hostsh() { docker run --rm --network none -v /:/h --entrypoint sh "$INST_IMG" -c "$1"; } # 以 root 查看 / 改动宿主

if [ -e /run/desktop ] || [ -e /host_mnt ]; then
  echo "宿主上已有 /run/desktop 或 /host_mnt（真的 Docker Desktop？），不在这里跑"
  exit 1
fi

cleanup() {
  for id in "${IDS[@]}"; do act -X DELETE "$U/api/admin/instances/$id?purge=1" >/dev/null 2>&1 || true; done
  docker container rm -f "$NAME" >/dev/null 2>&1 || true
  for id in "${IDS[@]}"; do
    docker container rm -f "woc-wx-$id" >/dev/null 2>&1 || true
    docker volume rm "woc-data-$id" >/dev/null 2>&1 || true
  done
  docker volume rm "$DATA" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  hostsh 'rm -rf /h/run/desktop /h/host_mnt' >/dev/null 2>&1 || true
  rm -f "$JAR"
}
trap cleanup EXIT

start_panel() { # start_panel <WOC_DATA_ROOT>
  docker container rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8080" \
    -e PORT=8080 -e WOC_WECHAT_IMAGE="$INST_IMG" -e WOC_INSTANCE_NETWORK="$NET" \
    -e PANEL_ADMIN_USER=admin -e PANEL_ADMIN_PASSWORD=e2e-pass -e PANEL_DATA=/data/accounts.json \
    -e "WOC_DATA_ROOT=$1" -e NODE_OPTIONS=--require=/sim/docker-desktop.cjs -v "$SIM:/sim/docker-desktop.cjs:ro" \
    -v "$DATA:/data" -v /var/run/docker.sock:/var/run/docker.sock "$PANEL_IMG" >/dev/null
  for _ in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$U/api/auth/me")" = 401 ] && break
    sleep 1
  done
  curl -s -c "$JAR" -H 'content-type: application/json' -d '{"username":"admin","password":"e2e-pass"}' \
    "$U/api/auth/login" | grep -q '"username":"admin"'
}

create_instance() { # 打印实例 id；登记进 IDS 由调用方做
  api -d "{\"name\":\"$1\",\"appType\":\"chromium\"}" "$U/api/admin/instances" | sed -n 's/.*"instance":{"id":"\([0-9a-f]*\)".*/\1/p'
}

wait_running() { # wait_running <id> <秒>
  for _ in $(seq 1 "$2"); do
    [ "$(docker inspect -f '{{.State.Running}}' "woc-wx-$1" 2>/dev/null)" = true ] && return 0
    sleep 1
  done
  return 1
}

provision() { # 等到 provision 失败（最多 30 秒），打印 provision 信息
  local p=""
  for _ in $(seq 1 30); do
    p=$(api "$U/api/instances" | grep -o '"provision":{[^}]*}' | head -1)
    case "$p" in *failed*) break ;; esac
    sleep 1
  done
  echo "${p:-无 provision 信息}"
}

volume_device() { docker volume inspect -f '{{index .Options "device"}}' "woc-data-$1" 2>/dev/null; }

echo "WOC_DATA_ROOT 模拟 Docker Desktop：面板 $PANEL_IMG · 实例 $INST_IMG"

# --- WSL2 后端：E:/wechatkevin → /run/desktop/mnt/host/e/wechatkevin ---
hostsh 'mkdir -p /h/run/desktop/mnt/host/e'
start_panel 'E:/wechatkevin' || { bad "面板没起来或登录失败"; docker logs "$NAME" 2>&1 | tail -30; exit 1; }
ID=$(create_instance ddsim-wsl2)
[ -n "$ID" ] && IDS+=("$ID")
DIR="/run/desktop/mnt/host/e/wechatkevin/woc-data-$ID"
if [ -n "$ID" ] && wait_running "$ID" 120; then note "WSL2 后端：E:/wechatkevin 新建实例并运行"; else bad "WSL2 后端：实例没跑起来（$(provision)）"; fi
dev=$(volume_device "$ID")
[ "$dev" = "$DIR" ] && note "数据卷指向 $DIR" || bad "数据卷应指向 $DIR，实际：${dev:-不是绑定到宿主目录的卷}"
n=0
for _ in $(seq 1 20); do
  n=$(hostsh "find /h$DIR -type f 2>/dev/null | wc -l")
  [ "${n:-0}" -gt 0 ] && break
  sleep 1
done
[ "${n:-0}" -gt 0 ] && note "实例数据确实写在该目录（$n 个文件）" || bad "实例运行了，但 $DIR 里没有数据"
docker logs "$NAME" 2>&1 | grep -q "Docker Desktop 虚拟机里的 /run/desktop/mnt/host/e/wechatkevin" &&
  note "面板日志记下了换算结果" || bad "面板日志里没有换算结果"
code=$(act -X DELETE "$U/api/admin/instances/$ID?purge=1")
sleep 3
if [ "$code" = 200 ] && ! hostsh "test -e /h$DIR"; then note "删除实例并清除数据：宿主目录一并删除"; else
  bad "清除数据后宿主目录还在（接口 $code）"; fi
hostsh 'rm -rf /h/run/desktop'

# --- Hyper-V 后端，反斜杠写法：E:\woc → /host_mnt/e/woc ---
hostsh 'mkdir -p /h/host_mnt/e'
start_panel 'E:\woc' || bad "面板没起来或登录失败"
ID=$(create_instance ddsim-hyperv)
[ -n "$ID" ] && IDS+=("$ID")
if [ -n "$ID" ] && wait_running "$ID" 120; then note "Hyper-V 后端：E:\\woc 新建实例并运行"; else bad "Hyper-V 后端：实例没跑起来（$(provision)）"; fi
dev=$(volume_device "$ID")
[ "$dev" = "/host_mnt/e/woc/woc-data-$ID" ] && note "数据卷指向 $dev" || bad "数据卷应指向 /host_mnt/e/woc/woc-data-$ID，实际：${dev:-不是绑定到宿主目录的卷}"
hostsh 'test -e /h/run/desktop' && bad "探测 WSL2 挂载点时在虚拟机里建出了 /run/desktop" || note "探测时没有顺手建出空目录"
act -X DELETE "$U/api/admin/instances/$ID?purge=1" >/dev/null
sleep 3
hostsh 'rm -rf /h/host_mnt'

# --- 盘没在 Docker Desktop 里共享：F:/x ---
start_panel 'F:/x' || bad "面板没起来或登录失败"
ID=$(create_instance ddsim-noshare)
[ -n "$ID" ] && IDS+=("$ID")
prov=$(provision)
case "$prov" in
  *failed*F*File\ sharing*) note "盘没共享：创建失败并提示去 File sharing 共享 F 盘" ;;
  *) bad "盘没共享时应创建失败并提示 File sharing，实际：$prov" ;;
esac
docker volume inspect "woc-data-$ID" >/dev/null 2>&1 && bad "盘没共享时不应建出数据卷" || note "没有建出数据卷"
hostsh 'test -e /h/run/desktop || test -e /h/host_mnt' && bad "探测时在虚拟机里建出了目录" || note "探测时没有建出目录"

if [ "$FAILED" != 0 ]; then
  echo "--- 面板日志（尾部）"; docker logs "$NAME" 2>&1 | grep -v '"level":30' | tail -30
  echo "WOC_DATA_ROOT 模拟 Docker Desktop：失败"; exit 1
fi
echo "WOC_DATA_ROOT 模拟 Docker Desktop：全部通过"
