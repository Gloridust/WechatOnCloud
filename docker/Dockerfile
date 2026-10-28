# WechatOnCloud —— 在浏览器里访问服务端微信
# 基于 linuxserver 的 KasmVNC 基础镜像（多架构 amd64/arm64）：
# 自带 openbox + nginx(3000/3001) + kclient(音频/文件) + s6 服务编排；KasmVNC 本身换成官方发布包（见下方版本锚定）
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

# ⚠️ KasmVNC 版本锚定：用 Kasm 官方发布的 bookworm 包，替换 base 镜像里自编译、冻结在 2024 年底的旧版。
# linuxserver 已全面转向 Selkies，baseimage-kasmvnc 自 2025-07 起不再更新，里面是 v1.3.3 之后 4 个提交（e047318，
# 2024-12）+ 2024-11 的 web 客户端，之后的修复一个都没有：lastActiveAt 致命错误（1.4.0 修）、非正常断线不自动重连
# （1.5.1 修）、WebSocket 握手解析溢出（1.5.2 修）、编码大幅省 CPU（1.4.0）。官方包两个架构都有、自带配套的 web 客户端。
# 升级 = 改下面三行（版本 + 两个架构包的 sha256，取自 GitHub release 资源的 digest），重写 woc-www-patch.sh 里
# 失配的补丁（构建会直接失败提示），并跑通 doc/dev/发布门禁.md 的全部探针后才允许合并。
ARG KASMVNC_VERSION=1.5.2
ARG KASMVNC_SHA256_AMD64=5f4bfda43e89178782eac37ae463b1d95d16ac5e45da8b7989ec75404e764993
ARG KASMVNC_SHA256_ARM64=b847429cbcf95736fdd5c3be682eea38cae4d689f012eec9c2d5f221b175d1c2
ARG TARGETARCH
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) sha="${KASMVNC_SHA256_AMD64}" ;; \
      arm64) sha="${KASMVNC_SHA256_ARM64}" ;; \
      *) echo "不支持的架构：$arch" >&2; exit 1 ;; \
    esac; \
    deb="/tmp/kasmvncserver_${KASMVNC_VERSION}_${arch}.deb"; \
    curl -fsSL --retry 3 -o "$deb" \
      "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_debian_bookworm_${KASMVNC_VERSION}_${arch}.deb"; \
    echo "${sha}  ${deb}" | sha256sum -c -; \
    # 先拆掉旧版：它装在 /usr/local，再用软链把 /usr/share/kasmvnc、/etc/kasmvnc 等指过去；不拆的话 dpkg 会顺着
    # 软链把新文件写进旧目录，新旧 web 客户端混在一起
    rm -f /usr/share/kasmvnc /etc/kasmvnc /usr/lib/kasmvncserver; \
    rm -rf /usr/local/share/kasmvnc /usr/local/lib/kasmvnc /usr/local/bin/KasmVNC; \
    rm -f /usr/local/bin/Xvnc /usr/local/bin/vncserver /usr/local/bin/vncconfig /usr/local/bin/vncpasswd \
          /usr/local/bin/kasmvncpasswd /usr/local/bin/kasmxproxy; \
    mv /etc/apt/sources.list.d/docker.list /etc/apt/sources.list.d/nodesource.list /tmp/ 2>/dev/null || true; \
    apt-get -o Acquire::Languages=none -o Acquire::Retries=3 update; \
    apt-get install -y --no-install-recommends "$deb"; \
    mv /tmp/docker.list /tmp/nodesource.list /etc/apt/sources.list.d/ 2>/dev/null || true; \
    rm -f "$deb"; \
    # s6 启动脚本、面板的进程探测都认 /usr/local/bin/Xvnc：软链过去，进程名仍叫 Xvnc
    ln -s /usr/bin/Xkasmvnc /usr/local/bin/Xvnc; \
    # Xkasmvnc 编译进去的默认 web 目录是 /usr/local/share/kasmvnc/www，官方包装在 /usr/share/kasmvnc/www
    ln -s /usr/share/kasmvnc /usr/local/share/kasmvnc; \
    # kclient 的文件下载目录（base 镜像原来建在旧 web 目录里）
    mkdir -p /usr/share/kasmvnc/www/Downloads; \
    chown 1000:1000 /usr/share/kasmvnc/www/Downloads; \
    dpkg-query -W kasmvncserver; \
    test -x /usr/local/bin/Xvnc && test -f /usr/share/kasmvnc/www/index.html; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# 字体/字体配置目录都在会话 HOME=/config 下（数据卷，运行时才挂载），故不在此预建；
# 由 autostart 在启动时按需 mkdir + 建 ~/.local/share/fonts → /config/.fonts 软链（见 docker/autostart）。

ENV LANG=zh_CN.UTF-8 \
    LC_ALL=zh_CN.UTF-8 \
    LIBGL_ALWAYS_SOFTWARE=1

# 改 KasmVNC web 客户端（1.5.x 是 Vite 打包的 assets/ui-*.js，压缩过）：
#  (1) 默认开启 IME 输入模式（面板加载前会按输入模式写好 enable_ime，这只管直接打开桌面页的情况）。
#  (2) IME 模式下合成中的文字不再按 keysym 实时发给远端：1.5.x 在 compositionupdate 里边打边发拼音、再用退格
#      改成汉字，与面板的无感输入（compositionend 后经 xdotool 转发成品）重复上屏，还会撞上 keysym 容量上限。
#  (3) 读浏览器剪贴板时个别条目 getType() 抛错（kasmtech/KasmVNC#373）不再变成未处理的 Promise 拒绝、弹致命浮层。
# 补丁按特征串匹配，客户端换了实现就直接构建失败，不会悄悄失效（详见 woc-www-patch.sh）。
COPY woc-www-patch.sh /woc/
RUN chmod 755 /woc/woc-www-patch.sh && /woc/woc-www-patch.sh

# KasmVNC 不再去取 image/png 剪贴板（#165「大于 1M 的图片粘贴卡死」、#159「QQ Ctrl+V 黑屏、重启才恢复」）。
# Xvnc 在 CLIPBOARD 一换主人就按 DLP_ClipTypes（默认 text/html,image/png）去取内容、准备同步给浏览器，
# 但超过 ~1MB 的数据要走 INCR 分段，它从不把 INCR 收完。面板用 xclip 把粘贴的图片放进剪贴板，xclip 一次只服务一个
# INCR 请求者、且不超时，于是卡死在 Xvnc 身上，此后谁来读剪贴板都没有应答：应用按 Ctrl+V 跟着挂住（Chromium 内核的
# 浏览器实例 / QQ 页面无响应，且要重启应用才恢复），换了新内容旧 xclip 也不退出、越积越多。
# 实测（KasmVNC 1.3.3，有无 VNC 客户端连着都一样）：1,040,000 字节的 PNG 正常、1,060,000 字节必卡；
# 去掉 image/png 后 3MB 的 PNG 立刻可读；SendCutText=0 或 DLP_ClipSendMax 限额都无效（照样先去取）；
# 这几个参数只能在 Xvnc 启动时给（运行中 vncconfig -set 被拒），所以改 base 镜像的启动脚本。
# 1.5.2 的 Xvnc 照旧不收 INCR（源码里仍是 "Incremental clipboard transfer denied, too large"），默认类型还多了
# chromium/x-web-custom-data，这里一并只留 text/html。
# 代价：KasmVNC 自带的「图片剪贴板同步」不再处理 PNG（应用里复制的图片不再自动进 https 访问时的本机剪贴板）；
# 本机图片粘进应用走面板的粘贴桥（Desktop.tsx installPasteBridge），不受影响；文字剪贴板同步照旧。
# 旧镜像上面板会先把图片压到 1MB 以内（web/src/pasteImage.ts），这里是从根上不让它再卡。
#
# -NeverShared 代替 base 镜像的 -AlwaysShared：同一实例同一时间只保留一条桌面连接，新连接一到就断开旧的。
# KasmVNC 的编码缓存（EncCache）只在 ≥2 条连接同时在线时启用，而它会泄漏内存（kasmtech/KasmVNC#371：两条连接、
# 画面滚动 1 分钟 88→260 MiB；修复截至 1.5.2 仍只在 master）；历史上「两条 ws 并存把 Xvnc 卡死」也出在多连接。
# 被断开的旧页面由面板挡住它的自动重连、提示「在这里继续使用」（panel/server/src/index.ts「单连接」），不会两边互踢。
# 启动脚本来自 base 镜像：改完必须能 grep 到，否则构建直接失败，免得悄悄失效。
RUN f=/etc/s6-overlay/s6-rc.d/svc-kasmvnc/run; \
    grep -q -- '-DLP_ClipTypes' "$f" || sed -i 's|/usr/local/bin/Xvnc \$DISPLAY \\|/usr/local/bin/Xvnc $DISPLAY -DLP_ClipTypes text/html \\|' "$f"; \
    sed -i 's/-AlwaysShared/-NeverShared/' "$f"; \
    grep -q -- '/usr/local/bin/Xvnc \$DISPLAY -DLP_ClipTypes text/html \\' "$f"; \
    grep -q -- '-NeverShared \\' "$f"; \
    ! grep -q -- '-AlwaysShared' "$f"

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

# 3000 = HTTP web 客户端, 3001 = HTTPS
EXPOSE 3000 3001
