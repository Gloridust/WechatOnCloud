#!/system/bin/sh
# post-fs-data.sh — 开机早期执行（挂载后、系统启动前）
# 职责：加载 Docker 所需内核模块、准备 cgroup 环境

MODDIR=${0%/*}

# 等待系统分区就绪
sleep 2

# ── 1. 加载 Docker 所需内核模块 ──
# overlay 是 Docker 的核心存储驱动
# br_netfilter 让 bridge 流量可被 iptables 过滤
# veth 用于容器虚拟网卡
# nf_nat / nf_conntrack 用于 NAT 和连接跟踪
# xt_conntrack / xt_nat / xt_addrtype 用于 iptables 规则匹配
# tun 用于 VPN/隧道（可选）
KERNEL_MODULES="overlay br_netfilter veth nf_nat nf_conntrack xt_conntrack xt_nat xt_addrtype tun ip_tables ip6_tables x_tables nf_tables nfnetlink"

for mod in $KERNEL_MODULES; do
    if ! lsmod | grep -q "^${mod}"; then
        modprobe "$mod" 2>/dev/null || insmod "/system/lib/modules/${mod}.ko" 2>/dev/null
    fi
done

# ── 2. 内核网络参数 ──
# Docker 网络需要这些参数
sysctl -w net.ipv4.ip_forward=1 2>/dev/null
sysctl -w net.ipv6.conf.all.forwarding=1 2>/dev/null
sysctl -w net.bridge.bridge-nf-call-iptables=1 2>/dev/null
sysctl -w net.bridge.bridge-nf-call-ip6tables=1 2>/dev/null
sysctl -w net.ipv4.conf.all.rp_filter=0 2>/dev/null

# ── 3. cgroup 准备 ──
# 确保 cgroup 文件系统挂载
if ! mountpoint -q /sys/fs/cgroup 2>/dev/null; then
    mount -t tmpfs cgroup_root /sys/fs/cgroup 2>/dev/null
fi

# 挂载各 cgroup 子系统（Docker 需要这些）
CGROUP_SUBSYSTEMS="cpuset cpu cpuacct blkio memory devices freezer net_cls perf_event pids"
for sub in $CGROUP_SUBSYSTEMS; do
    if [ -d "/sys/fs/cgroup/${sub}" ] && ! mountpoint -q "/sys/fs/cgroup/${sub}" 2>/dev/null; then
        mkdir -p "/sys/fs/cgroup/${sub}" 2>/dev/null
        mount -t cgroup -o "${sub}" "cgroup_${sub}" "/sys/fs/cgroup/${sub}" 2>/dev/null
    fi
done

# 尝试 cgroup v2 统一层
if [ -f /proc/cgroups ] && grep -q '^cpuset' /proc/cgroups; then
    if ! mountpoint -q /sys/fs/cgroup/cpuset 2>/dev/null; then
        mkdir -p /sys/fs/cgroup/cpuset 2>/dev/null
        mount -t cgroup -o cpuset cpuset /sys/fs/cgroup/cpuset 2>/dev/null
    fi
fi

# ── 4. 创建 Docker 运行所需目录 ──
DOCKER_ROOT="/data/docker"
mkdir -p "${DOCKER_ROOT}"
mkdir -p /var/run
mkdir -p /etc/docker

# ── 5. Docker daemon 配置 ──
# 镜像加速 + 存储驱动 + 数据目录
if [ ! -f /etc/docker/daemon.json ]; then
    cat > /etc/docker/daemon.json <<'DAEMONJSON'
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
DAEMONJSON
fi

# ── 6. 设置 /var/run/docker.sock 路径 ──
# 确保 docker.sock 可被面板容器挂载
ln -sf "${DOCKER_ROOT}/docker.sock" /var/run/docker.sock 2>/dev/null
