#!/usr/bin/env bash
# 实例镜像探针（doc/dev/发布门禁.md §2 的可执行版本，本地与 CI 共用）。
# 用法：scripts/gate/instance-probes.sh <实例镜像>
# 全部通过退出 0；任一失败打印原因和容器日志尾部，退出 1。
set -u
IMG="${1:?用法：$0 <实例镜像>}"
P=woc-gate-probe
W=woc-gate-probe-wx
FAILED=0

note() { echo "  ✓ $*"; }
bad() {
  echo "  ✗ $*"
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error::$*"
  FAILED=1
}
cleanup() { docker container rm -f "$P" "$W" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

run() { # run <名字> <应用类型>
  docker run -d --name "$1" --security-opt seccomp=unconfined --shm-size=1g \
    -e PUID=1000 -e PGID=1000 -e WOC_APP_TYPE="$2" "$IMG" >/dev/null
}

echo "实例镜像探针：$IMG"
run "$P" chromium
for _ in $(seq 1 40); do docker exec "$P" pgrep xsettingsd >/dev/null 2>&1 && break; sleep 2; done

# ① XSETTINGS 的 DPI 单位是 DPI×1024：96 DPI 必须是 98304（写成 96 = 史上最大 P0）
if docker exec "$P" bash -c 'DISPLAY=:1 dump_xsettings | grep -q "Xft/DPI 98304"'; then note "① DPI 98304"; else bad "① DPI 不是 98304"; fi

# ② 微信 CEF 的等价探针：裸 chromium、不带 scale flag、连跑两次（第 2 次 = 非首次启动路径）各存活 7 秒
if docker exec "$P" bash -c '
  for round in 1 2; do
    DISPLAY=:1 timeout 8 chromium --no-sandbox --disable-gpu --user-data-dir=/tmp/probe-gate about:blank >/dev/null 2>&1 &
    p=$!; sleep 7
    kill -0 $p 2>/dev/null || exit $round
    kill -9 $p 2>/dev/null; pkill -9 chromium 2>/dev/null; sleep 1
  done'; then note "② CEF 探针两次启动存活"; else bad "② CEF 探针启动后崩溃"; fi

# ③ 干净的 30 秒窗口里应用退出次数为 0（崩溃循环检测）
sleep 30
exits=$(docker logs --since 30s "$P" 2>&1 | grep -c '已退出' || true)
if [ "$exits" -eq 0 ]; then note "③ 30 秒内应用退出 0 次"; else bad "③ 30 秒内应用退出 $exits 次（崩溃循环）"; fi

# ⑤ KasmVNC：官方包、单连接、不取 PNG 剪贴板、web 客户端补丁都在
kv=$(docker exec "$P" sh -c 'dpkg-query -W -f "\${Version}" kasmvncserver 2>/dev/null')
[ -n "$kv" ] && note "⑤ KasmVNC $kv" || bad "⑤ 没装官方 kasmvncserver 包"
args=$(docker exec "$P" sh -c 'tr "\0" " " < /proc/$(pgrep -x Xvnc | head -1)/cmdline' 2>/dev/null)
case "$args" in *"-NeverShared"*) note "⑤ Xvnc -NeverShared" ;; *) bad "⑤ Xvnc 缺 -NeverShared（单连接）" ;; esac
case "$args" in *"-DLP_ClipTypes text/html"*) note "⑤ Xvnc -DLP_ClipTypes text/html" ;; *) bad "⑤ Xvnc 缺 -DLP_ClipTypes text/html（大图粘贴会卡死）" ;; esac
if docker exec "$P" sh -c 'grep -q "WOC-IME" /usr/share/kasmvnc/www/assets/ui-*.js'; then note "⑤ web 客户端补丁"; else bad "⑤ web 客户端补丁缺失"; fi

# 本项目的启动钩子与桌面规则
if docker exec "$P" test -x /custom-cont-init.d/03-woc-xlock; then note "X 显示锁清理钩子"; else bad "缺 X 显示锁清理钩子 03-woc-xlock"; fi
if docker exec "$P" grep -q 'application class="" type="normal"' /etc/xdg/openbox/rc.xml; then note "小程序窗口不强制最大化"; else bad "openbox 缺小程序窗口规则"; fi
if docker exec "$P" /woc/app-ctl.sh chromium status | grep -q '"installed":true'; then note "Chromium 状态：已就绪"; else bad "Chromium 状态不是已就绪"; fi

# ④ 微信模式走到「等待安装」
run "$W" wechat
ok=0
for _ in $(seq 1 30); do docker logs "$W" 2>&1 | grep -q "尚未安装" && ok=1 && break; sleep 2; done
[ "$ok" = 1 ] && note "④ 微信模式走到「尚未安装」" || bad "④ 微信模式没走到「尚未安装」"

if [ "$FAILED" != 0 ]; then
  echo "--- chromium 容器日志（尾部）"; docker logs "$P" 2>&1 | tail -30
  echo "实例镜像探针：失败"; exit 1
fi
echo "实例镜像探针：全部通过"
