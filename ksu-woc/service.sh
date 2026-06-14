#!/system/bin/sh
# service.sh — 开机后执行（系统启动完成后）
# 职责：启动 Docker 守护进程，等待就绪后部署 WechatOnCloud

MODDIR=${0%/*}
WOC_DIR="/data/woc"

# 等待系统完全启动
sleep 10

# ── 日志函数 ──
log() {
    echo "[WOC-Docker] $1" >> /data/woc/service.log
}

log "========== 服务启动 =========="
log "时间: $(date)"

# ── 1. 检查 Docker 二进制文件 ──
DOCKER_BIN="${MODDIR}/system/bin/docker"
DOCKERD_BIN="${MODDIR}/system/bin/dockerd"
COMPOSE_BIN="${MODDIR}/system/bin/docker-compose"

if [ ! -f "${DOCKERD_BIN}" ]; then
    log "错误: docker 二进制文件未找到，请确认模块安装正确"
    exit 1
fi

# 确保可执行
chmod 755 "${MODDIR}/system/bin/docker" 2>/dev/null
chmod 755 "${MODDIR}/system/bin/dockerd" 2>/dev/null
chmod 755 "${MODDIR}/system/bin/docker-compose" 2>/dev/null
chmod 755 "${MODDIR}/system/bin/iptables" 2>/dev/null
chmod 755 "${MODDIR}/system/bin/ip6tables" 2>/dev/null
chmod 755 "${MODDIR}/system/bin/iptables-save" 2>/dev/null
chmod 755 "${MODDIR}/system/bin/iptables-restore" 2>/dev/null
chmod 755 "${MODDIR}/system/bin/cgpt" 2>/dev/null
chmod 755 "${MODDIR}/system/bin/runc" 2>/dev/null
chmod 755 "${MODDIR}/system/bin/containerd" 2>/dev/null
chmod 755 "${MODDIR}/system/bin/containerd-shim-runc-v2" 2>/dev/null
chmod 755 "${MODDIR}/system/bin/ctr" 2>/dev/null
chmod 755 "${MODDIR}/system/bin/docker-proxy" 2>/dev/null
chmod 755 "${MODDIR}/system/bin/docker-init" 2>/dev/null
chmod 755 "${MODDIR}/system/bin/dockerd-rootless-setuptool.sh" 2>/dev/null
chmod 755 "${MODDIR}/system/bin/dockerd-rootless.sh" 2>/dev/null

# ── 2. 确保 cgroup 已挂载 ──
if ! mountpoint -q /sys/fs/cgroup/memory 2>/dev/null; then
    mkdir -p /sys/fs/cgroup/memory 2>/dev/null
    mount -t cgroup -o memory cgroup_memory /sys/fs/cgroup/memory 2>/dev/null
fi
if ! mountpoint -q /sys/fs/cgroup/cpuset 2>/dev/null; then
    mkdir -p /sys/fs/cgroup/cpuset 2>/dev/null
    mount -t cgroup -o cpuset cgroup_cpuset /sys/fs/cgroup/cpuset 2>/dev/null
fi
if ! mountpoint -q /sys/fs/cgroup/devices 2>/dev/null; then
    mkdir -p /sys/fs/cgroup/devices 2>/dev/null
    mount -t cgroup -o devices cgroup_devices /sys/fs/cgroup/devices 2>/dev/null
fi
if ! mountpoint -q /sys/fs/cgroup/freezer 2>/dev/null; then
    mkdir -p /sys/fs/cgroup/freezer 2>/dev/null
    mount -t cgroup -o freezer cgroup_freezer /sys/fs/cgroup/freezer 2>/dev/null
fi
if ! mountpoint -q /sys/fs/cgroup/pids 2>/dev/null; then
    mkdir -p /sys/fs/cgroup/pids 2>/dev/null
    mount -t cgroup -o pids cgroup_pids /sys/fs/cgroup/pids 2>/dev/null
fi

# ── 3. 启动 containerd ──
log "启动 containerd..."
if ! pgrep -x containerd > /dev/null 2>&1; then
    "${MODDIR}/system/bin/containerd" >> /data/woc/containerd.log 2>&1 &
    sleep 3
fi

# ── 4. 启动 Docker 守护进程 ──
log "启动 Docker 守护进程..."
if ! pgrep -x dockerd > /dev/null 2>&1; then
    "${DOCKERD_BIN}" \
        --data-root /data/docker \
        --storage-driver overlay2 \
        --iptables=true \
        --host unix:///var/run/docker.sock \
        >> /data/woc/dockerd.log 2>&1 &
fi

# ── 5. 等待 Docker 就绪 ──
log "等待 Docker 就绪..."
MAX_WAIT=60
WAITED=0
while [ ${WAITED} -lt ${MAX_WAIT} ]; do
    if "${DOCKER_BIN}" info > /dev/null 2>&1; then
        log "Docker 已就绪"
        break
    fi
    sleep 2
    WAITED=$((WAITED + 2))
done

if [ ${WAITED} -ge ${MAX_WAIT} ]; then
    log "错误: Docker 启动超时，请查看 /data/woc/dockerd.log"
    exit 1
fi

# ── 6. 创建 Docker 网络（如果不存在） ──
if ! "${DOCKER_BIN}" network ls 2>/dev/null | grep -q "woc-network"; then
    "${DOCKER_BIN}" network create woc-network 2>/dev/null
    log "已创建 woc-network"
fi

# ── 7. 部署 WechatOnCloud ──
log "部署 WechatOnCloud..."
mkdir -p "${WOC_DIR}/data-panel"

# 复制 docker-compose.yml（如果不存在）
if [ ! -f "${WOC_DIR}/docker-compose.yml" ]; then
    cp "${MODDIR}/woc/docker-compose.yml" "${WOC_DIR}/docker-compose.yml"
    log "已复制 docker-compose.yml"
fi

# 复制 .env（如果不存在）
if [ ! -f "${WOC_DIR}/.env" ]; then
    cp "${MODDIR}/woc/.env" "${WOC_DIR}/.env"
    log "已复制 .env 配置文件（请修改默认密码！）"
fi

# 拉起面板
cd "${WOC_DIR}"
"${DOCKER_BIN}" compose up -d 2>/dev/null || \
    "${COMPOSE_BIN}" up -d 2>/dev/null

if [ $? -eq 0 ]; then
    log "WechatOnCloud 部署成功！"
    log "访问地址: http://$(ip addr show wlan0 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1):36080"
else
    log "WechatOnCloud 部署失败，请手动执行: cd ${WOC_DIR} && docker compose up -d"
fi

log "========== 服务启动完成 =========="
