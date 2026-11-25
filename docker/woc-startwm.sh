#!/usr/bin/env bash
# 桌面会话（s6 服务 svc-de 的入口，覆盖 base 镜像的 /defaults/startwm.sh）。
#
# 为什么要自己收尾：容器停止时 s6 按依赖倒序停服务——先 svc-de（桌面会话），再 nginx、kclient，最后 Xvnc。
# base 镜像的 startwm.sh 只是前台跑 openbox-session 的 bash：收到 SIGTERM 立刻退出，s6 就认为桌面会话停了，
# 接着去停 Xvnc；而 openbox、autostart 拉起的应用（Chromium / 微信 / QQ）还在跑。应用能不能在 Xvnc 消失之前
# 收到 SIGTERM、正常退出全凭运气，输了就因为显示连接断开而直接崩掉：实测 Chromium 一半的停止都被记为崩溃
# （exit_type=Crashed，下次打开弹「Restore pages?」），微信也同样来不及正常退出。
#
# 现在：openbox-session 放后台、自己 wait；收到 SIGTERM 时给整个会话进程组发 SIGTERM（autostart 的看守循环
# 随之结束，不会再把应用重新拉起来），等会话里的进程都退出（最多 STOP_WAIT 秒）再退出。s6 要等这个服务真正
# 停下，才会去停 Xvnc，所以应用退出时显示还在。S6_SERVICES_GRACETIME（Dockerfile）给这一步留足时间。

# Nvidia GPU（保留 base 镜像原有逻辑）
if which nvidia-smi >/dev/null 2>&1; then
  export LIBGL_KOPPER_DRI2=1
  export MESA_LOADER_DRIVER_OVERRIDE=zink
  export GALLIUM_DRIVER=zink
fi

STOP_WAIT=8

graceful_stop() {
  trap '' TERM INT HUP
  # 先记下会话里现有的进程（不含自己），再整组发 SIGTERM（自己已忽略 TERM）
  local pids p alive
  pids=$(pgrep -g $$ | grep -vx "$$")
  kill -TERM -- "-$$" 2>/dev/null
  for _ in $(seq 1 $((STOP_WAIT * 5))); do
    alive=0
    for p in $pids; do kill -0 "$p" 2>/dev/null && alive=1 && break; done
    [ "$alive" = 0 ] && break
    sleep 0.2
  done
  [ "$alive" = 1 ] && echo "[woc-startwm] 桌面会话里的进程 ${STOP_WAIT}s 内没有全部退出，交给 s6 收尾"
  exit 0
}
trap graceful_stop TERM INT HUP

/usr/bin/openbox-session &
wait $!
