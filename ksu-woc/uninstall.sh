#!/system/bin/sh
# uninstall.sh — 模块卸载时执行
# 职责：停止 Docker 服务、清理容器和数据

MODDIR=${0%/*}

log() {
    echo "[WOC-Docker] $1"
}

# ── 1. 停止 WechatOnCloud ──
log "停止 WechatOnCloud..."
if [ -f /data/woc/docker-compose.yml ]; then
    cd /data/woc
    docker compose down 2>/dev/null || docker-compose down 2>/dev/null
fi

# ── 2. 停止 Docker 守护进程 ──
log "停止 Docker 守护进程..."
dockerd_pid=$(pgrep -x dockerd 2>/dev/null)
if [ -n "${dockerd_pid}" ]; then
    kill "${dockerd_pid}" 2>/dev/null
    sleep 2
    kill -9 "${dockerd_pid}" 2>/dev/null
fi

# ── 3. 停止 containerd ──
log "停止 containerd..."
containerd_pid=$(pgrep -x containerd 2>/dev/null)
if [ -n "${containerd_pid}" ]; then
    kill "${containerd_pid}" 2>/dev/null
    sleep 1
    kill -9 "${containerd_pid}" 2>/dev/null
fi

# ── 4. 清理 Docker 网络 ──
if command -v docker > /dev/null 2>&1; then
    docker network rm woc-network 2>/dev/null
fi

# ── 5. 注意：不删除数据目录 ──
log "注意: 以下数据目录已保留（如需彻底删除请手动操作）："
log "  - /data/woc/          (WechatOnCloud 配置与数据)"
log "  - /data/docker/       (Docker 镜像与容器数据)"
log ""
log "手动清理命令："
log "  rm -rf /data/woc"
log "  rm -rf /data/docker"
