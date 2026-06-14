#!/system/bin/sh
# check-env.sh — 检查 Docker 运行环境是否就绪
# 用于排查问题

echo "╔══════════════════════════════════════╗"
echo "║   WechatOnCloud 环境检查             ║"
echo "╚══════════════════════════════════════╝"
echo ""

# 1. CPU 架构
echo "── CPU 架构 ──"
echo "架构: $(uname -m)"
echo ""

# 2. 内核版本
echo "── 内核 ──"
echo "版本: $(uname -r)"
echo ""

# 3. 内核模块
echo "── 内核模块 ──"
for mod in overlay br_netfilter veth nf_nat nf_conntrack xt_conntrack ip_tables; do
    if lsmod | grep -q "^${mod}"; then
        echo "  [OK] ${mod}"
    else
        echo "  [!!] ${mod} (未加载)"
    fi
done
echo ""

# 4. cgroup
echo "── cgroup ──"
for sub in cpuset cpu cpuacct memory devices freezer pids; do
    if mountpoint -q "/sys/fs/cgroup/${sub}" 2>/dev/null; then
        echo "  [OK] ${sub}"
    else
        echo "  [!!] ${sub} (未挂载)"
    fi
done
echo ""

# 5. 网络参数
echo "── 网络参数 ──"
echo "ip_forward: $(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null || echo 'N/A')"
echo "bridge-nf-call-iptables: $(cat /proc/sys/net/bridge/bridge-nf-call-iptables 2>/dev/null || echo 'N/A')"
echo ""

# 6. Docker
echo "── Docker ──"
DOCKER="$(which docker 2>/dev/null || echo /data/adb/modules/woc-docker/system/bin/docker)"
if [ -x "${DOCKER}" ]; then
    echo "  路径: ${DOCKER}"
    if "${DOCKER}" info > /dev/null 2>&1; then
        echo "  状态: 运行中"
        "${DOCKER}" info 2>/dev/null | grep -E "Server Version|Storage Driver|Kernel Version|Operating System|Architecture|CPUs|Total Memory" | sed 's/^/  /'
    else
        echo "  状态: 未运行"
    fi
else
    echo "  [!!] Docker 未安装"
fi
echo ""

# 7. Docker Compose
echo "── Docker Compose ──"
COMPOSE="$(which docker-compose 2>/dev/null || echo /data/adb/modules/woc-docker/system/bin/docker-compose)"
if [ -x "${COMPOSE}" ]; then
    echo "  路径: ${COMPOSE}"
    "${COMPOSE}" version 2>/dev/null | sed 's/^/  /'
else
    echo "  [!!] Docker Compose 未安装"
fi
echo ""

# 8. WechatOnCloud
echo "── WechatOnCloud ──"
if [ -f /data/woc/docker-compose.yml ]; then
    echo "  配置: /data/woc/docker-compose.yml"
    if "${DOCKER}" ps --filter "name=woc-panel" --format "{{.Status}}" 2>/dev/null | grep -q "Up"; then
        echo "  面板: 运行中"
    else
        echo "  面板: 未运行"
    fi
    INST_COUNT=$("${DOCKER}" ps --filter "name=woc-wx" --format "{{.Names}}" 2>/dev/null | wc -l)
    echo "  微信实例数: ${INST_COUNT}"
else
    echo "  [!!] 未部署"
fi
echo ""

# 9. 磁盘空间
echo "── 磁盘空间 ──"
df -h /data 2>/dev/null | tail -1 | awk '{print "  /data: 总计 "$2" 已用 "$3" 可用 "$4}'
echo ""

# 10. 内存
echo "── 内存 ──"
free -h 2>/dev/null | grep "Mem:" | awk '{print "  总计: "$2" 已用: "$3" 可用: "$7}'
echo ""
