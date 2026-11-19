#!/bin/bash
# /custom-cont-init.d 钩子（03）：清掉上次没正常退出留下的 X 显示锁。
# 宿主断电、NAS 强制重启、Docker 被强杀时，Xvnc 来不及删 /tmp/.X1-lock；容器原样再起时文件还在（/tmp 在容器
# 可写层里，docker restart 不清）。Xvnc 按锁里记的进程号判断显示是否被占用，新容器里这个号若恰好被别的进程
# 用上了（实测是 nginx、s6 的服务脚本），它就认定 :1 已有 X 服务器而退出，s6 反复拉起反复失败，桌面永远停在
# 「连接中」，只有在面板里重启实例（重建容器）才好。本地实测强杀 Docker 后 11 个实例里有 2 个这样起不来。
# 这里在任何服务启动之前执行，容器里此刻不可能有 X 服务器，直接删掉即可。
for f in /tmp/.X[0-9]*-lock; do
  [ -e "$f" ] || continue
  rm -f "$f" "/tmp/.X11-unix/X$(basename "$f" -lock | tr -dc 0-9)"
  echo "[woc-xlock] 清掉上次残留的 X 显示锁 ${f}"
done
exit 0
