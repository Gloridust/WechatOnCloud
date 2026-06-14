#!/system/bin/sh
# woc-setup.sh — WechatOnCloud 管理脚本
# 用法: woc-setup.sh [命令]
# 命令:
#   start     启动面板
#   stop      停止面板
#   restart   重启面板
#   status    查看状态
#   logs      查看面板日志
#   update    更新镜像
#   reset     重置管理员密码
#   info      显示访问信息

WOC_DIR="/data/woc"
COMPOSE_FILE="${WOC_DIR}/docker-compose.yml"

# 查找 docker 和 docker-compose
DOCKER="$(which docker 2>/dev/null || echo /data/adb/modules/woc-docker/system/bin/docker)"
COMPOSE="$(which docker-compose 2>/dev/null || echo /data/adb/modules/woc-docker/system/bin/docker-compose)"

compose_cmd() {
    "${DOCKER}" compose -f "${COMPOSE_FILE}" "$@" 2>/dev/null || \
        "${COMPOSE}" -f "${COMPOSE_FILE}" "$@"
}

case "${1:-info}" in
    start)
        echo "启动 WechatOnCloud..."
        cd "${WOC_DIR}"
        compose_cmd up -d
        echo "完成。访问 http://<设备IP>:$(grep WOC_HTTP_PORT .env 2>/dev/null | cut -d= -f2 || echo 36080)"
        ;;
    stop)
        echo "停止 WechatOnCloud..."
        cd "${WOC_DIR}"
        compose_cmd down
        echo "已停止"
        ;;
    restart)
        echo "重启 WechatOnCloud..."
        cd "${WOC_DIR}"
        compose_cmd down
        sleep 2
        compose_cmd up -d
        echo "完成"
        ;;
    status)
        echo "=== WechatOnCloud 状态 ==="
        "${DOCKER}" ps --filter "name=woc" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null
        echo ""
        echo "=== 微信实例 ==="
        "${DOCKER}" ps --filter "name=woc-wx" --format "table {{.Names}}\t{{.Status}}" 2>/dev/null
        ;;
    logs)
        "${DOCKER}" logs -f --tail 100 woc-panel 2>/dev/null
        ;;
    update)
        echo "更新 WechatOnCloud 镜像..."
        cd "${WOC_DIR}"
        compose_cmd pull
        compose_cmd up -d
        echo "更新完成"
        ;;
    reset)
        echo "重置管理员密码..."
        cd "${WOC_DIR}"
        compose_cmd stop panel
        sleep 2
        # 在 accounts.json 中添加 resetPassword 标记
        if [ -f "${WOC_DIR}/data-panel/accounts.json" ]; then
            # 使用简单的 sed 方式添加标记
            sed -i 's/"role": "admin"/"role": "admin", "resetPassword": true/' "${WOC_DIR}/data-panel/accounts.json" 2>/dev/null
            echo "密码将在下次启动时重置为 .env 中的 WOC_PASSWORD 值"
        else
            echo "未找到账号文件，首次启动将使用 .env 中的默认账号"
        fi
        compose_cmd up -d
        ;;
    info)
        IP=$(ip addr show wlan0 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1)
        PORT=$(grep WOC_HTTP_PORT "${WOC_DIR}/.env" 2>/dev/null | cut -d= -f2 || echo 36080)
        echo "╔══════════════════════════════════════╗"
        echo "║   云微 WechatOnCloud                 ║"
        echo "╠══════════════════════════════════════╣"
        echo "║ 访问地址: http://${IP}:${PORT}"
        echo "║ 默认账号: admin / wechat"
        echo "║ 配置文件: ${WOC_DIR}/.env"
        echo "║ 数据目录: ${WOC_DIR}/data-panel"
        echo "║ Docker:   ${WOC_DIR}/docker-compose.yml"
        echo "╚══════════════════════════════════════╝"
        ;;
    *)
        echo "用法: woc-setup.sh {start|stop|restart|status|logs|update|reset|info}"
        ;;
esac
