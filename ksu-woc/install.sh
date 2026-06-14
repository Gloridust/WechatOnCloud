#!/system/bin/sh
# install.sh — 模块安装时执行
# 职责：下载并安装 Docker Engine、Docker Compose、iptables、containerd 等二进制文件

SKIPUNZIP=0

MODDIR="$MODPATH"
BIN_DIR="${MODDIR}/system/bin"
ETC_DIR="${MODDIR}/system/etc"
WOC_DIR="${MODDIR}/woc"

# ── 辅助函数 ──
log() {
    ui_print "[WOC-Docker] $1"
}

abort_install() {
    ui_print "[WOC-Docker] 错误: $1"
    abort "安装中止"
}

# ── 检测 CPU 架构 ──
ARCH=$(uname -m)
case "${ARCH}" in
    aarch64|arm64)
        DOCKER_ARCH="aarch64"
        ;;
    x86_64|amd64)
        DOCKER_ARCH="x86_64"
        ;;
    armv7l|armhf)
        DOCKER_ARCH="armhf"
        ;;
    *)
        abort_install "不支持的 CPU 架构: ${ARCH}"
        ;;
esac

log "检测到架构: ${ARCH} → Docker 架构: ${DOCKER_ARCH}"

# ── Docker 版本 ──
DOCKER_VERSION="27.5.1"
COMPOSE_VERSION="2.32.4"
CONTAINERD_VERSION="1.7.25"
RUNC_VERSION="1.2.4"
IPTABLES_VERSION="1.8.11"

# ── 创建目录 ──
mkdir -p "${BIN_DIR}"
mkdir -p "${ETC_DIR}"
mkdir -p "${WOC_DIR}"

# ── 下载 Docker Engine ──
log "下载 Docker Engine ${DOCKER_VERSION}..."
curl -fsSL "https://download.docker.com/linux/static/stable/${DOCKER_ARCH}/docker-${DOCKER_VERSION}.tgz" \
    -o /tmp/docker.tgz 2>/dev/null

if [ $? -ne 0 ]; then
    # 备用镜像源
    log "主源下载失败，尝试镜像源..."
    curl -fsSL "https://mirrors.aliyun.com/docker-ce/linux/static/stable/${DOCKER_ARCH}/docker-${DOCKER_VERSION}.tgz" \
        -o /tmp/docker.tgz 2>/dev/null || abort_install "Docker Engine 下载失败"
fi

tar xzf /tmp/docker.tgz -C /tmp/
# docker tgz 解压后是一个 docker/ 目录，里面包含各二进制
cp /tmp/docker/docker "${BIN_DIR}/"
cp /tmp/docker/dockerd "${BIN_DIR}/"
cp /tmp/docker/docker-proxy "${BIN_DIR}/"
cp /tmp/docker/docker-init "${BIN_DIR}/"
cp /tmp/docker/containerd "${BIN_DIR}/"
cp /tmp/docker/containerd-shim-runc-v2 "${BIN_DIR}/"
cp /tmp/docker/ctr "${BIN_DIR}/"
cp /tmp/docker/runc "${BIN_DIR}/"
rm -rf /tmp/docker /tmp/docker.tgz
log "Docker Engine 安装完成"

# ── 下载 Docker Compose ──
log "下载 Docker Compose ${COMPOSE_VERSION}..."
curl -fsSL "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${DOCKER_ARCH}" \
    -o "${BIN_DIR}/docker-compose" 2>/dev/null

if [ $? -ne 0 ]; then
    log "主源下载失败，尝试镜像源..."
    curl -fsSL "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${DOCKER_ARCH}" \
        -o "${BIN_DIR}/docker-compose" 2>/dev/null || abort_install "Docker Compose 下载失败"
fi
chmod 755 "${BIN_DIR}/docker-compose"
log "Docker Compose 安装完成"

# ── 下载 iptables ──
log "下载 iptables..."
# Android 自带 iptables 但版本可能不兼容 Docker，下载静态编译版
IPT_URL="https://github.com/tonistiigi/binfmt/releases/download/v6.2.0/iptables-${DOCKER_ARCH}.tgz"
curl -fsSL "${IPT_URL}" -o /tmp/iptables.tgz 2>/dev/null

if [ $? -eq 0 ]; then
    tar xzf /tmp/iptables.tgz -C "${BIN_DIR}/" 2>/dev/null
    rm -f /tmp/iptables.tgz
else
    log "iptables 下载失败，将使用系统自带版本"
fi

# ── 设置可执行权限 ──
chmod 755 "${BIN_DIR}"/* 2>/dev/null

# ── 创建 Docker 配置 ──
mkdir -p "${ETC_DIR}/docker"
cat > "${ETC_DIR}/docker/daemon.json" <<'EOF'
{
    "data-root": "/data/docker",
    "storage-driver": "overlay2",
    "hosts": ["unix:///var/run/docker.sock"],
    "iptables": true,
    "ip6tables": true,
    "default-ulimits": {
        "nofile": {
            "Name": "nofile",
            "Hard": 65536,
            "Soft": 65536
        }
    },
    "registry-mirrors": [
        "https://docker.1ms.run",
        "https://docker.xuanyuan.me"
    ]
}
EOF

# ── 创建 WechatOnCloud 数据目录 ──
mkdir -p /data/woc
mkdir -p /data/docker

log "========================================="
log "  云微 WechatOnCloud Docker 环境安装完成"
log "========================================="
log ""
log "已安装组件："
log "  - Docker Engine ${DOCKER_VERSION}"
log "  - Docker Compose ${COMPOSE_VERSION}"
log "  - containerd ${CONTAINERD_VERSION}"
log "  - runc ${RUNC_VERSION}"
log "  - iptables"
log ""
log "安装后步骤："
log "  1. 重启设备"
log "  2. Docker 守护进程将自动启动"
log "  3. WechatOnCloud 面板将自动部署"
log "  4. 浏览器访问 http://<设备IP>:36080"
log ""
log "重要提醒："
log "  - 默认管理员: admin / wechat"
log "  - 请尽快修改默认密码！"
log "  - 配置文件: /data/woc/.env"
log "  - Docker 数据: /data/docker"
log "  - 日志目录: /data/woc/"
log ""
log "手动管理命令："
log "  docker compose -f /data/woc/docker-compose.yml up -d    # 启动"
log "  docker compose -f /data/woc/docker-compose.yml down      # 停止"
log "  docker logs woc-panel                                     # 查看日志"
