# WechatOnCloud —— 在浏览器里访问服务端微信
# 基于 linuxserver 的 KasmVNC 基础镜像（多架构 amd64/arm64）：
# 自带 Xvfb + openbox + KasmVNC + web 客户端(3000/3001)
FROM lscr.io/linuxserver/baseimage-kasmvnc:debianbookworm

# 微信本体不再在构建时下载/安装，改为运行时由面板点击下载、解压到数据卷 /config
#（见 wechat-ctl.sh）。构建时只装：中文字体、语言环境、下载工具，以及微信运行所
# 需的全部系统库（这些需 root/apt，必须 bake 进镜像）。
ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    # 中文字体（否则界面/消息显示方块）+ 语言环境 + 下载/解压工具
    apt-get update; \
    apt-get install -y --no-install-recommends \
        curl ca-certificates locales dpkg \
        fonts-wqy-zenhei fonts-wqy-microhei fonts-noto-cjk fonts-noto-color-emoji \
        libnss3 libgbm1 libasound2 libxss1 \
        xdotool xclip; \
    sed -i 's/# zh_CN.UTF-8 UTF-8/zh_CN.UTF-8 UTF-8/' /etc/locale.gen; \
    locale-gen; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# 微信运行时需要、但官方 deb 未声明的额外库（单独成层，避免动到上面缓存的安装层）。
# 微信原生版是 Qt 程序，依赖一组 xcb 平台库；libxcb-cursor0 由 Qt 动态 dlopen，ldd 查不到，需主动装。
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        libatomic1 \
        libxdamage1 \
        libxkbcommon-x11-0 \
        libxcb-icccm4 \
        libxcb-image0 \
        libxcb-keysyms1 \
        libxcb-render-util0 \
        libxcb-xkb1 \
        libxcb-cursor0 \
        # WeChatAppEx 是 Chromium 内核，需 GTK3 全家桶 + 一组 X 扩展 + cups
        libgtk-3-0 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libatspi2.0-0 \
        libcups2 \
        libxcomposite1 \
        libxrandr2 \
        libxfixes3 \
        libxtst6 \
        libxshmfence1 \
        libdrm2; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

ENV LANG=zh_CN.UTF-8 \
    LC_ALL=zh_CN.UTF-8 \
    LIBGL_ALWAYS_SOFTWARE=1

# 改 KasmVNC web 客户端的 webpack 产物 dist/*.bundle.js：
#  (1) 保持 KasmVNC IME 模式默认关闭：面板使用透明输入代理承接本机输入法，上屏后经
#      剪贴板 + Ctrl+V 送进微信，避免 noVNC 差分输入损坏混合文本。
#  (2) 修复 noVNC 中文 IME 输入：原实现靠隐藏 textarea 差分逐字符重发 keysym，会泄漏中间拼音、
#      累积不 reset、退格风暴，导致大量丢字 / ~21 字卡住 / 跨浏览器不稳。改为只在 compositionend
#      用 e.data 直发成品字符串（详见 woc-www-patch.sh / woc-ime.pl）。
# 注意：实际加载的是 webpack 产物 dist/main.bundle.js（app/ui.js 是未打包源码、运行时不加载），故必须改 bundle。
COPY woc-www-patch.sh woc-ime.pl /woc/
RUN chmod 755 /woc/woc-www-patch.sh && chmod 644 /woc/woc-ime.pl && /woc/woc-www-patch.sh

# 微信下载/解压控制脚本（运行时由面板经 docker exec 触发，状态写入数据卷 /config/.woc-state）
COPY wechat-ctl.sh /woc/wechat-ctl.sh
RUN chmod 755 /woc/wechat-ctl.sh

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

# 3000 = HTTP web 客户端, 3001 = HTTPS
EXPOSE 3000 3001
