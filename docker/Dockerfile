# WechatOnCloud —— 在浏览器里访问服务端微信
# 基于 linuxserver 的 KasmVNC 基础镜像（多架构 amd64/arm64）：
# 自带 Xvfb + openbox + KasmVNC + web 客户端(3000/3001)
FROM lscr.io/linuxserver/baseimage-kasmvnc:debianbookworm

# 微信本体不再在构建时下载/安装，改为运行时由面板点击下载、解压到数据卷 /config
#（见 wechat-ctl.sh）。构建时只装：中文字体、语言环境、下载工具，以及微信运行所
# 需的全部系统库（这些需 root/apt，必须 bake 进镜像）。
ENV DEBIAN_FRONTEND=noninteractive

# ⚠️ Chromium 版本锚定（架构守则 R1）——绝不跟随 Debian 滚动：
# Debian 源只保留最新版 chromium，而新版本在本容器栈（KasmVNC/Xvnc + 软件渲染）上反复引入致命崩溃：
#   · 149 收紧变换矩阵断言（叠加 DPI bug 全面崩溃，v1.4.0 已修 DPI）；
#   · 150 「非首次启动」路径与 --start-maximized 直接 SIGTRAP → 浏览器实例必黑屏（无任何 flag 可绕）。
# 故从 snapshot.debian.org 的固定快照安装验证过的版本。升级 chromium = 改下面两行（快照时间戳 + 版本号），
# 并跑通 doc/dev/发布门禁.md 的全部探针、实际打开 Chromium 实例并重启一次看画面后才允许合并。
# 两行不用手查：scripts/bump-chromium.py 会找 bookworm 最新构建、定出 amd64/arm64 都齐的快照并核对后改好。
# 154.0.8037.57：门禁三项探针、同一 profile 反复重启（--start-maximized 正式参数）、容器重启后画面均正常。
ARG CHROMIUM_SNAPSHOT=20260925T171425Z
ARG CHROMIUM_VERSION=154.0.8037.57-1~deb12u1
# ⚠️ CI 的 QEMU arm64 模拟下 apt-get update OOM（"Cannot allocate memory"，触发点是解析
# download.docker.com InRelease）导致实例镜像发不出去。根因是 apt 要解析一大堆【构建根本用不到】
# 的源（deb-src 源码索引、backports、docker、nodesource），内存峰值在模拟环境里爆掉。
# 对策：构建期把 apt 源精简到只剩「debian main/updates/security（仅二进制）+ chromium 锚定快照」，
# 装完再原样恢复；合并为单次 update+install；Languages=none 跳翻译、Retries 抗抖动。三管齐下从根上消除 OOM。
RUN set -eux; \
    mkdir -p /woc-apt-bak; \
    cp -a /etc/apt/sources.list /woc-apt-bak/; \
    mv /etc/apt/sources.list.d/docker.list /etc/apt/sources.list.d/nodesource.list /woc-apt-bak/ 2>/dev/null || true; \
    { \
      echo "deb http://deb.debian.org/debian bookworm main contrib non-free non-free-firmware"; \
      echo "deb http://deb.debian.org/debian bookworm-updates main contrib non-free non-free-firmware"; \
      echo "deb http://security.debian.org/debian-security/ bookworm-security main contrib non-free non-free-firmware"; \
    } > /etc/apt/sources.list; \
    echo "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/${CHROMIUM_SNAPSHOT}/ bookworm-security main" \
      > /etc/apt/sources.list.d/woc-chromium-pin.list; \
    printf 'Package: chromium*\nPin: version %s\nPin-Priority: 1001\n' "${CHROMIUM_VERSION}" \
      > /etc/apt/preferences.d/woc-chromium-pin; \
    apt-get -o Acquire::Languages=none -o Acquire::Retries=3 update; \
    apt-get install -y --no-install-recommends \
        curl ca-certificates locales dpkg \
        fonts-wqy-zenhei fonts-wqy-microhei fonts-noto-cjk fonts-noto-color-emoji \
        libnss3 libgbm1 libasound2 libxss1 \
        xz-utils \
        chromium="${CHROMIUM_VERSION}" \
        xdotool xclip \
        xwallpaper xsettingsd \
        # 微信原生版是 Qt 程序，依赖一组 xcb 平台库；libxcb-cursor0 由 Qt 动态 dlopen，ldd 查不到，需主动装。
        libatomic1 libxdamage1 libxkbcommon-x11-0 \
        libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-render-util0 libxcb-xkb1 libxcb-cursor0 \
        # WeChatAppEx 是 Chromium 内核，需 GTK3 全家桶 + 一组 X 扩展 + cups
        libgtk-3-0 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 \
        libxcomposite1 libxrandr2 libxfixes3 libxtst6 libxshmfence1 libdrm2; \
    chromium --version; \
    rm -f /etc/apt/sources.list.d/woc-chromium-pin.list /etc/apt/preferences.d/woc-chromium-pin; \
    mv /woc-apt-bak/sources.list /etc/apt/sources.list; \
    mv /woc-apt-bak/docker.list /woc-apt-bak/nodesource.list /etc/apt/sources.list.d/ 2>/dev/null || true; \
    rm -rf /woc-apt-bak; \
    sed -i 's/# zh_CN.UTF-8 UTF-8/zh_CN.UTF-8 UTF-8/' /etc/locale.gen; \
    locale-gen; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# 字体/字体配置目录都在会话 HOME=/config 下（数据卷，运行时才挂载），故不在此预建；
# 由 autostart 在启动时按需 mkdir + 建 ~/.local/share/fonts → /config/.fonts 软链（见 docker/autostart）。

ENV LANG=zh_CN.UTF-8 \
    LC_ALL=zh_CN.UTF-8 \
    LIBGL_ALWAYS_SOFTWARE=1

# 改 KasmVNC web 客户端的 webpack 产物 dist/*.bundle.js：
#  (1) 默认开启 IME 输入模式：本地（客户端）输入法打中文，拼音联想在本地完成、只把成品汉字
#      发进容器，无需容器内装 IME。默认值仅在浏览器未存过该设置时生效，不覆盖用户手动改过的偏好。
#  (2) 修复 noVNC 中文 IME 输入：原实现靠隐藏 textarea 差分逐字符重发 keysym，会泄漏中间拼音、
#      累积不 reset、退格风暴，导致大量丢字 / ~21 字卡住 / 跨浏览器不稳。改为只在 compositionend
#      用 e.data 直发成品字符串（详见 woc-www-patch.sh / woc-ime.pl）。
# 注意：实际加载的是 webpack 产物 dist/main.bundle.js（app/ui.js 是未打包源码、运行时不加载），故必须改 bundle。
COPY woc-www-patch.sh woc-ime.pl /woc/
RUN chmod 755 /woc/woc-www-patch.sh && chmod 644 /woc/woc-ime.pl && /woc/woc-www-patch.sh

# 微信下载/解压控制脚本（运行时由面板经 docker exec 触发，状态写入数据卷 /config/.woc-state）
COPY wechat-ctl.sh /woc/wechat-ctl.sh
RUN chmod 755 /woc/wechat-ctl.sh

# v1.2.0 多应用：应用定义（app-defs.sh，被 autostart/app-ctl 引用）+ 通用安装/状态控制（app-ctl.sh，
# 微信委托回 wechat-ctl.sh、其它应用各自实现）。app-defs.sh 是被 source 的、不需可执行位。
COPY app-defs.sh app-ctl.sh /woc/
RUN chmod 644 /woc/app-defs.sh && chmod 755 /woc/app-ctl.sh

# openbox 会话启动时执行此脚本：等待微信就绪 + 常驻拉起微信 + 最小化自动复原看守
COPY autostart /defaults/autostart
RUN chmod 755 /defaults/autostart

# 启动钩子（00）：给每个实例唯一且持久的 machine-id，避免所有实例共用镜像里烤死的同一个，
# 触发腾讯"设备农场"风控导致登录即被强制退出。须在 autostart（拉起微信）之前执行，故用 00 前缀。
COPY woc-identity.sh /custom-cont-init.d/00-woc-identity
RUN chmod 755 /custom-cont-init.d/00-woc-identity

# 启动钩子（01）：每次启动用镜像内最新 autostart 覆盖数据卷旧副本（否则旧实例升级后用不上新逻辑）
COPY woc-update-autostart /custom-cont-init.d/01-woc-autostart
RUN chmod 755 /custom-cont-init.d/01-woc-autostart

# 启动钩子（02）：把容器环境 WOC_APP_TYPE 写入 /config/.woc-app，供 autostart 选择启动哪个应用。
# 须在 autostart 之前执行；缺 WOC_APP_TYPE 则不写 → autostart 回退微信（向后兼容）。
COPY woc-app-init.sh /custom-cont-init.d/02-woc-app
RUN chmod 755 /custom-cont-init.d/02-woc-app

# 启动钩子（03）：清掉非正常退出（断电 / 强杀）残留的 X 显示锁，否则 Xvnc 可能误判显示被占用而起不来。
COPY woc-xlock.sh /custom-cont-init.d/03-woc-xlock
RUN chmod 755 /custom-cont-init.d/03-woc-xlock

# 3000 = HTTP web 客户端, 3001 = HTTPS
EXPOSE 3000 3001
