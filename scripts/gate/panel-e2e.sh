#!/usr/bin/env bash
# 面板端到端回归（doc/dev/发布门禁.md §4 与历次修复的可执行版本，本地与 CI 共用）。
# 用一个临时面板 + 一个 Chromium 实例，经面板 HTTP 接口走用户会走的路径，验证：
#   部署约束（日志上限、实例网络隔离）、桌面反代（含 #179 大 cookie）、上传、取回图片、
#   重启时应用正常退出、WOC_DATA_ROOT 填错时明确报错（#133）、删除实例清理数据卷。
# 用法：scripts/gate/panel-e2e.sh <面板镜像> <实例镜像>
# 不会碰已有的面板和实例：容器、网络、数据卷都用 woc-e2e 前缀，结束时清掉。
set -u
PANEL_IMG="${1:?用法：$0 <面板镜像> <实例镜像>}"
INST_IMG="${2:?用法：$0 <面板镜像> <实例镜像>}"
PORT="${WOC_E2E_PORT:-36199}"
U="http://127.0.0.1:$PORT"
NAME=woc-e2e-panel
NET=woc-e2e-instances
WORK="$(mktemp -d "${TMPDIR:-/tmp}/woc-e2e.XXXXXX")"
JAR="$WORK/jar"
FAILED=0
IDS=()

note() { echo "  ✓ $*"; }
bad() {
  echo "  ✗ $*"
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error::$*"
  FAILED=1
}
api() { curl -s -b "$JAR" -H 'content-type: application/json' "$@"; }       # 带 JSON 请求体
act() { curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$@"; }            # 不带请求体（带 JSON 头会被 Fastify 400）

cleanup() {
  # 先经接口删（顺带清 WOC_DATA_ROOT 的宿主目录），再停掉面板（它可能还在后台建实例），最后强制清残留
  for id in "${IDS[@]}"; do act -X DELETE "$U/api/admin/instances/$id?purge=1" >/dev/null 2>&1 || true; done
  docker container rm -f "$NAME" >/dev/null 2>&1 || true
  for id in "${IDS[@]}"; do
    docker container rm -f "woc-wx-$id" >/dev/null 2>&1 || true
    docker volume rm "woc-data-$id" >/dev/null 2>&1 || true
  done
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

start_panel() { # start_panel [额外 -e 参数...]
  docker container rm -f "$NAME" >/dev/null 2>&1 || true
  mkdir -p "$WORK/data"
  docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8080" \
    -e PORT=8080 -e WOC_WECHAT_IMAGE="$INST_IMG" -e WOC_INSTANCE_NETWORK="$NET" \
    -e PANEL_ADMIN_USER=admin -e PANEL_ADMIN_PASSWORD=e2e-pass -e PANEL_DATA=/data/accounts.json \
    "$@" -v "$WORK/data:/data" -v /var/run/docker.sock:/var/run/docker.sock "$PANEL_IMG" >/dev/null
  for _ in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$U/api/auth/me")" = 401 ] && break
    sleep 1
  done
  curl -s -c "$JAR" -H 'content-type: application/json' -d '{"username":"admin","password":"e2e-pass"}' \
    "$U/api/auth/login" | grep -q '"username":"admin"'
}

create_instance() { # create_instance <名字> → 打印实例 id（在 $(...) 里调用，登记进 IDS 由调用方做）
  api -d "{\"name\":\"$1\",\"appType\":\"chromium\"}" "$U/api/admin/instances" | sed -n 's/.*"instance":{"id":"\([0-9a-f]*\)".*/\1/p'
}

wait_running() { # wait_running <id> <秒>
  for _ in $(seq 1 "$2"); do
    [ "$(docker inspect -f '{{.State.Running}}' "woc-wx-$1" 2>/dev/null)" = true ] && return 0
    sleep 1
  done
  return 1
}

prefs_exit_type() { # 读数据卷里 Chromium 的 exit_type（运行中 = Crashed，正常退出 = Normal / SessionEnded）
  docker run --rm --network none -v "woc-data-$1:/c:ro" --entrypoint sh "$INST_IMG" -c \
    "grep -o '\"exit_type\":\"[A-Za-z]*\"' /c/chromium/Default/Preferences 2>/dev/null | head -1 | cut -d'\"' -f4"
}

echo "面板端到端：面板 $PANEL_IMG · 实例 $INST_IMG"
if start_panel; then note "面板启动并登录"; else bad "面板没起来或登录失败"; docker logs "$NAME" 2>&1 | tail -30; exit 1; fi

ID=$(create_instance e2e)
[ -n "$ID" ] && IDS+=("$ID")
if [ -n "$ID" ] && wait_running "$ID" 120; then note "新建 Chromium 实例 $ID 并运行"; else
  bad "新建实例失败"; api "$U/api/instances" | head -c 600; echo; exit 1
fi
C="woc-wx-$ID"

# --- 部署约束（R3 日志上限、实例网络隔离） ---
logcfg=$(docker inspect -f '{{.HostConfig.LogConfig.Config}}' "$C")
case "$logcfg" in *max-size*) note "实例日志有上限 $logcfg" ;; *) bad "实例容器没有日志上限（R3）" ;; esac
nets=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$C" | xargs)
[ "$nets" = "$NET" ] && note "实例只接入 $NET" || bad "实例网络应只有 $NET，实际：$nets"
code=$(docker exec "$C" curl -s -o /dev/null -m 5 -w '%{http_code}' "http://$NAME:8080/" 2>/dev/null)
[ "$code" = 403 ] && note "实例访问面板被拒（403）" || bad "实例访问面板应得 403，实际：$code"

# --- 桌面反代：页面能出来；同一地址下别的服务种了大 cookie 也不 400（#179） ---
SID=$(awk '$6 ~ /^woc/ {print $6"="$7}' "$JAR" | head -1)
code=000
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $SID" "$U/desktop/$ID/vnc/index.html")
  [ "$code" = 200 ] && break
  sleep 2
done
[ "$code" = 200 ] && note "桌面页面 200" || bad "桌面页面应为 200，实际：$code"
BIG=$(head -c 6800 /dev/urandom | base64 -w0)
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $SID; other_nas_app=$BIG" "$U/desktop/$ID/vnc/index.html")
[ "$code" = 200 ] && note "带 9KB 别家 cookie 的桌面页面 200（#179）" || bad "带大 cookie 时桌面页面应为 200，实际：$code（#179 回归）"
code=$(curl -s -o /dev/null -w '%{http_code}' "$U/desktop/$ID/vnc/index.html")
[ "$code" = 302 ] || [ "$code" = 401 ] && note "未登录访问桌面被拦（$code）" || bad "未登录访问桌面应被拦，实际：$code"

# --- 上传：流式写进实例桌面，内容一致、归应用用户所有 ---
head -c $((64 * 1024 * 1024)) /dev/urandom > "$WORK/up.bin"
code=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -H 'content-type: application/octet-stream' \
  --data-binary @"$WORK/up.bin" "$U/api/instances/$ID/upload?name=e2e-up.bin")
src=$(md5sum < "$WORK/up.bin" | cut -c1-32)
dst=$(docker exec "$C" sh -c 'md5sum < /config/Desktop/e2e-up.bin' 2>/dev/null | cut -c1-32)
owner=$(docker exec "$C" stat -c %U /config/Desktop/e2e-up.bin 2>/dev/null)
[ "$code" = 200 ] && [ "$src" = "$dst" ] && note "上传 64MB，md5 一致" || bad "上传失败或内容不一致（HTTP $code）"
[ "$owner" = abc ] && note "上传的文件归应用用户 abc" || bad "上传的文件属主应为 abc，实际：$owner"

# --- 应用里复制的图片取回本机（#162） ---
code=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$U/api/instances/$ID/clipboard-image")
[ "$code" = 422 ] && note "剪贴板没图片时取回图片返回 422" || bad "剪贴板没图片时应返回 422，实际：$code"
PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
echo "$PNG" | base64 -d > "$WORK/t.png"
docker cp -q "$WORK/t.png" "$C:/tmp/e2e.png"
docker exec -u abc "$C" sh -c 'DISPLAY=:1 xclip -selection clipboard -t image/png -i /tmp/e2e.png >/dev/null 2>&1 &'
sleep 1
curl -s -b "$JAR" -o "$WORK/got.png" "$U/api/instances/$ID/clipboard-image"
cmp -s "$WORK/t.png" "$WORK/got.png" && note "取回的图片与原图逐字节一致" || bad "取回的图片与原图不一致"

# --- 重启实例：旧容器里的应用正常退出，而不是被 SIGKILL 或随 Xvnc 消失而崩溃 ---
# 应用退出得快时，「先停 Xvnc 再等应用」这种错也可能碰巧不出事。为了让检查是确定的：发重启前先冻结 Chromium，
# 等面板写下上一容器的日志快照（紧接着就停容器）后再过 1.5 秒才放开，模拟它退出得慢。正确的实现会等它退完
# 再停 Xvnc；错误的实现在它醒来前就把显示停掉了，必然崩溃。
for _ in $(seq 1 60); do docker exec "$C" test -f /config/chromium/Default/Preferences 2>/dev/null && break; sleep 1; done
sleep 5
LOG="$WORK/data/logs/$ID.log"
snaps() { grep -c '保留上一容器最后日志' "$LOG" 2>/dev/null || true; }
n0=$(snaps)
CPID=$(docker exec "$C" pgrep -o -x chromium)
docker exec "$C" kill -STOP "$CPID"
act -X POST "$U/api/admin/instances/$ID/restart" > "$WORK/restart.code" &
RSPID=$!
froze=0
for _ in $(seq 1 300); do # 最多 30 秒：等面板开始重建
  if [ "$(snaps)" != "$n0" ]; then froze=1; break; fi
  sleep 0.1
done
sleep 1.5
docker exec "$C" kill -CONT "$CPID" 2>/dev/null
[ "$froze" = 1 ] && note "停容器时 Chromium 处于冻结（模拟退出慢）" || bad "没等到面板开始重建，重启检查不可信"
seen=""
t0=$(date +%s)
while [ $(( $(date +%s) - t0 )) -lt 30 ]; do
  v=$(prefs_exit_type "$ID")
  case " $seen " in *" $v "*) ;; *) seen="$seen $v" ;; esac
  case "$v" in Normal|SessionEnded) break ;; esac
  # 重启接口已返回（新容器已启动，新 Chromium 还要几秒才起来）：这一次读到的仍是旧进程留下的状态，可以停了
  kill -0 "$RSPID" 2>/dev/null || break
done
wait
code=$(cat "$WORK/restart.code")
[ "$code" = 200 ] && note "重启接口 200" || bad "重启接口应为 200，实际：$code"
case "$seen" in *Normal*|*SessionEnded*) note "重启时 Chromium 正常退出（$seen）" ;; *) bad "重启时 Chromium 没有正常退出（exit_type:$seen）" ;; esac
if wait_running "$ID" 90; then note "重启后实例重新运行"; else bad "重启后实例没有运行"; fi
docker exec "$C" test -f /config/Desktop/e2e-up.bin && note "重启后数据还在" || bad "重启后数据丢了"

# --- 删除实例并清除数据：容器和数据卷都清掉 ---
code=$(act -X DELETE "$U/api/admin/instances/$ID?purge=1")
[ "$code" = 200 ] || bad "删除实例接口应为 200，实际：$code"
sleep 2
if docker inspect "$C" >/dev/null 2>&1 || docker volume inspect "woc-data-$ID" >/dev/null 2>&1; then
  bad "删除实例后容器或数据卷还在"
else note "删除实例后容器和数据卷都已清掉"; fi

# --- WOC_DATA_ROOT 填错：新建实例明确失败，而不是悄悄改用 Docker 卷（#133） ---
start_panel -e WOC_DATA_ROOT=E:/e2e-not-docker-desktop || bad "带 WOC_DATA_ROOT 的面板没起来"
ID2=$(create_instance e2e-dataroot)
[ -n "$ID2" ] && IDS+=("$ID2")
prov=""
for _ in $(seq 1 30); do
  prov=$(api "$U/api/instances" | grep -o '"provision":{[^}]*}' | head -1)
  case "$prov" in *failed*) break ;; esac
  sleep 1
done
case "$prov" in
  *failed*WOC_DATA_ROOT*) note "WOC_DATA_ROOT 填成非 Docker Desktop 上的 Windows 路径：创建失败并说明原因" ;;
  *) bad "WOC_DATA_ROOT 填错时应创建失败并说明原因，实际：${prov:-无 provision 信息}" ;;
esac
docker volume inspect "woc-data-$ID2" >/dev/null 2>&1 && bad "WOC_DATA_ROOT 填错时不应建出 Docker 卷" || note "没有悄悄建出 Docker 卷"

if [ "$FAILED" != 0 ]; then
  echo "--- 面板日志（尾部）"; docker logs "$NAME" 2>&1 | grep -v '"level":30' | tail -30
  echo "面板端到端：失败"; exit 1
fi
echo "面板端到端：全部通过"
