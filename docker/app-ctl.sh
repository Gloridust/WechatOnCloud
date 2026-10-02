#!/bin/bash
# 多应用安装/状态控制（面板经 docker exec --user abc 调用）：
#   app-ctl.sh <appType> <install|update|status>
# 设计：微信完全委托给原 wechat-ctl.sh（逻辑零改动）；其它应用各自实现，状态 JSON 复用同一格式与文件，
# 故面板的轮询逻辑无需区分应用类型。状态文件：/config/.woc-state/status.json。
set -u

APP="${1:-wechat}"
ACTION="${2:-status}"

# 微信：原样委托，保持既有行为不变（向后兼容老实例与旧面板调用路径）
if [ "$APP" = "wechat" ]; then exec /woc/wechat-ctl.sh "$ACTION"; fi

# shellcheck source=/dev/null
. /woc/app-defs.sh
woc_app_def "$APP"

STATE_DIR="${WOC_STATE_DIR:-/config/.woc-state}"
STATUS_FILE="$STATE_DIR/status.json"

is_installed() { [ -n "${APP_BIN:-}" ] && [ -x "$APP_BIN" ]; }

write_status() {
  local phase="$1" percent="$2" message="$3" version="${4:-}" installed=false
  is_installed && installed=true
  mkdir -p "$STATE_DIR"
  cat > "$STATUS_FILE.tmp" <<EOF
{"phase":"$phase","percent":$percent,"installed":$installed,"version":"$version","message":"$message","updatedAt":$(date +%s)}
EOF
  mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}

# 同 wechat-ctl.sh：状态在持久卷上，安装中途容器被重启/升级，状态会永远停在「进行中」且面板禁用按钮
#（issue #144）。进行中却没有安装进程 → 纠正为 error 放开重试。无 pgrep 时不纠正。
installer_running() {
  command -v pgrep >/dev/null 2>&1 || return 0
  pgrep -f 'ctl\.sh .*(install|update)' >/dev/null 2>&1
}

print_status() {
  if [ -f "$STATUS_FILE" ]; then
    local s; s="$(cat "$STATUS_FILE")"
    if printf '%s' "$s" | grep -Eq '"phase":"(downloading|extracting|installing)"' && ! installer_running; then
      local inst=false; is_installed && inst=true
      echo "{\"phase\":\"error\",\"percent\":0,\"installed\":$inst,\"version\":\"\",\"message\":\"上次安装被中断（容器重启或升级），请重新点击安装\",\"updatedAt\":$(date +%s)}"
      return
    fi
    printf '%s\n' "$s"
  elif is_installed; then
    echo "{\"phase\":\"done\",\"percent\":100,\"installed\":true,\"version\":\"\",\"message\":\"已就绪\",\"updatedAt\":$(date +%s)}"
  else
    echo "{\"phase\":\"idle\",\"percent\":0,\"installed\":false,\"version\":\"\",\"message\":\"未安装\",\"updatedAt\":$(date +%s)}"
  fi
}

install_telegram() {
  case "$(dpkg --print-architecture 2>/dev/null)" in
    amd64) ;;
    *) write_status error 0 "Telegram 官方仅提供 x86_64 版本，当前架构（$(dpkg --print-architecture 2>/dev/null)）不支持"; return ;;
  esac
  local work=/config/.woc-dl tmp
  tmp="$work/tg.tar.xz"
  rm -rf "$work"; mkdir -p "$work"
  write_status downloading -1 "正在下载 Telegram"
  # 60 秒内平均不到 1KB/s 即中断（同 wechat-ctl.sh，#99）：否则连接僵住时永远停在「下载中」、卡片按钮全被收起
  if ! curl -fSL --retry 3 --connect-timeout 20 --speed-limit 1024 --speed-time 60 \
       -A "Mozilla/5.0" -o "$tmp" "https://telegram.org/dl/desktop/linux"; then
    write_status error 0 "下载失败，请检查网络后重试"; rm -rf "$work"; return
  fi
  write_status extracting 92 "正在解压安装"
  local newdir="$work/x"; mkdir -p "$newdir"
  # 官方包内顶层是 Telegram/ 目录，strip 掉一层 → newdir 下直接是 Telegram + Updater
  if ! tar -xJf "$tmp" -C "$newdir" --strip-components=1 2>/dev/null; then
    write_status error 0 "解压失败，安装包可能损坏"; rm -rf "$work"; return
  fi
  if [ ! -x "$newdir/Telegram" ]; then
    write_status error 0 "解压后未找到 Telegram 可执行文件"; rm -rf "$work"; return
  fi
  write_status installing 96 "正在安装"
  rm -rf /config/telegram.old
  [ -e /config/telegram ] && mv /config/telegram /config/telegram.old
  mv "$newdir" /config/telegram
  rm -rf /config/telegram.old "$work"
  write_status done 100 "安装完成"
  pkill -f "/config/telegram/Telegram" 2>/dev/null || true
}

# ---------- QQ（Linux 官方版 QQNT）----------
# 安装包地址取自腾讯官网 Linux QQ 页面自己用的配置（linuxConfig.js，随新版本更新），按架构选 deb，
# 解压到数据卷 /config/qq（升级镜像不丢；更新 = 重新下载覆盖）。下载流程同 wechat-ctl.sh：断点续传、
# 60 秒没速度即中断重试、连不上快速失败、解压前校验包完整。
# 注意：linuxConfig.js 里给的是【裸链】，腾讯已对它加了实时签名校验——不带签名一律 403，且与出口地区
# 无关（大陆网络同样 403，issue #153）。官网 Linux 页面自己也是先调签名接口换成带 sign & t 的临时链再
# 下载，这里复刻同一行为。签名的 t 有时效，故每次下载（含每次重试）都现签，不复用、不落盘。
QQ_CONFIG_URL="${QQ_CONFIG_URL:-https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js}"
QQ_SIGN_URL="${QQ_SIGN_URL:-https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign}"
QQ_UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"

# 原始 deb 地址 → 带签名的可用地址；接口变更 / 网络不通时输出空串（调用方据此报错，不静默降级成裸链）。
# x-oidb 是服务路由标识，Origin / Referer 是来源校验，三者缺一不可。
qq_sign_url() {
  local resp
  resp="$(curl -fsS --connect-timeout 20 --max-time 40 -X POST "$QQ_SIGN_URL" \
    -H 'Content-Type: application/json' \
    -H 'x-oidb: {"uint32_command":"0x9b8e","uint32_service_type":1}' \
    -H 'Origin: https://im.qq.com' -H 'Referer: https://im.qq.com/new/' \
    -A "$QQ_UA" -d "{\"url\":\"$1\"}" 2>/dev/null)" || return 0
  printf '%s' "$resp" | grep -q '"retcode":0' || return 0
  # 注意：接口返回的 JSON 把 / 转义成 \/（"url":"https:\/\/qqdl..."），提取后必须还原，
  # 否则 curl 报 (3) URL using bad/illegal format——踩过。
  printf '%s' "$resp" | grep -o '"url":"[^"]*"' | head -1 | cut -d'"' -f4 | sed 's|\\/|/|g'
}

install_qq() {
  local key arch
  arch="$(dpkg --print-architecture 2>/dev/null)"
  case "$arch" in
    amd64) key=x64DownloadUrl ;;
    arm64) key=armDownloadUrl ;;
    *) write_status error 0 "QQ 官方只提供 x86_64 / arm64 版本，当前架构（$arch）不支持"; return ;;
  esac
  # 同一时间只跑一个安装（面板重复触发时后来的直接跳过）；锁里的进程已不在（容器重启遗留）则接管
  local lock="$STATE_DIR/.qq-install.lock" lpid
  mkdir -p "$STATE_DIR"
  if ! mkdir "$lock" 2>/dev/null; then
    lpid="$(cat "$lock/pid" 2>/dev/null || echo)"
    if [ -n "$lpid" ] && kill -0 "$lpid" 2>/dev/null && grep -q "app-ctl" "/proc/$lpid/cmdline" 2>/dev/null; then return; fi
    rm -rf "$lock"; mkdir "$lock" 2>/dev/null || return
  fi
  echo "$$" > "$lock/pid"
  trap 'rm -rf "'"$lock"'" 2>/dev/null' EXIT

  local work=/config/.woc-dl cfg url dl ver tmp total cur pct pid rc=1 attempt=0
  mkdir -p "$work"; tmp="$work/qq.deb"
  write_status downloading -1 "正在获取 QQ 最新版本信息"
  cfg="$(curl -fsSL --connect-timeout 20 --max-time 60 -A "$QQ_UA" "$QQ_CONFIG_URL" 2>/dev/null | tr -d '\r\n')"
  url="$(printf '%s' "$cfg" | grep -o "\"$key\":{[^}]*}" | grep -o '"deb":"[^"]*"' | head -1 | cut -d'"' -f4)"
  ver="$(printf '%s' "$cfg" | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4)"
  case "$url" in
    http://*.deb | https://*.deb) ;;
    *) write_status error 0 "获取 QQ 下载地址失败（连不上腾讯官网或页面改版），请检查网络后重试"; return ;;
  esac
  # 上次没下完的是同一个安装包才续传，版本变了就重下（比较裸链；签名链每次都不一样，不能拿来比）
  [ "$(cat "$work/qq.url" 2>/dev/null)" = "$url" ] || rm -f "$tmp"
  echo "$url" > "$work/qq.url"
  dl="$(qq_sign_url "$url")"
  if [ -z "$dl" ]; then
    write_status error 0 "获取 QQ 下载授权失败（腾讯签名接口无响应或已变更），请稍后重试；持续失败请把面板日志发给我们"
    return
  fi
  total="$(curl -fsSLI --connect-timeout 10 --max-time 20 -A "$QQ_UA" "$dl" 2>/dev/null | tr -d '\r' \
          | awk 'tolower($1)=="content-length:"{v=$2} END{print v}')"
  : "${total:=0}"
  # 磁盘预检：deb 约 180MB，解压后约 600MB，更新时新旧并存 → 按 deb 的 4 倍、不低于 900MB
  local need_kb avail_kb
  need_kb=$(( ( total > 0 ? total : 200000000 ) / 1024 * 4 )); [ "$need_kb" -lt 921600 ] && need_kb=921600
  avail_kb="$(df -Pk "$work" 2>/dev/null | awk 'NR==2{print $4}')"
  if [ -n "${avail_kb:-}" ] && [ "$avail_kb" -lt "$need_kb" ] 2>/dev/null; then
    write_status error 0 "磁盘空间不足：约需 $((need_kb/1024))MB 空闲，当前仅 $((avail_kb/1024))MB。请在宿主清理磁盘后重试"
    return
  fi

  while [ "$attempt" -lt 6 ]; do
    attempt=$((attempt+1))
    # 每次重试都重签：签名带时效，续传时换了 query 不影响（同一个文件，仍按字节偏移取）
    if [ "$attempt" -gt 1 ]; then
      dl="$(qq_sign_url "$url")"
      if [ -z "$dl" ]; then
        write_status error 0 "获取 QQ 下载授权失败（腾讯签名接口无响应或已变更），请稍后重试"
        return
      fi
    fi
    curl -fSL -C - --connect-timeout 20 --speed-limit 1024 --speed-time 60 \
         -A "$QQ_UA" -o "$tmp" "$dl" 2>"$work/qq-curl.err" & pid=$!
    while kill -0 "$pid" 2>/dev/null; do
      if [ "$total" -gt 0 ] 2>/dev/null; then
        cur="$(stat -c%s "$tmp" 2>/dev/null || echo 0)"
        pct=$(( cur * 90 / total )); [ "$pct" -gt 90 ] && pct=90
        write_status downloading "$pct" "正在下载 QQ ${ver}"
      else
        write_status downloading -1 "正在下载 QQ ${ver}"
      fi
      sleep 1
    done
    wait "$pid"; rc=$?
    [ "$rc" -eq 0 ] && break
    cur="$(stat -c%s "$tmp" 2>/dev/null || echo 0)"
    if [ "$total" -gt 0 ] && [ "$cur" -ge "$total" ]; then rc=0; break; fi
    if grep -q "error: 403" "$work/qq-curl.err" 2>/dev/null; then
      write_status error 0 "腾讯 QQ 下载服务器拒绝了请求（HTTP 403）：签名已失效或腾讯又改了下载校验，请再次点击安装（会重新签名）；持续失败请把面板日志发给我们"
      return
    fi
    # 连不上（DNS / 拒绝 / 超时 / TLS）且一个字节没拿到：再试也没用，两轮后直接说清楚
    if [ "$attempt" -ge 2 ] && [ "$cur" -eq 0 ]; then
      case "$rc" in
        6 | 7 | 28 | 35) write_status error 0 "连不上腾讯 QQ 下载服务器（curl 退出码 $rc），请检查 DNS、防火墙或代理后重试"; return ;;
      esac
    fi
    write_status downloading -1 "下载中断，正在续传重试（$attempt/6）"
    sleep 2
  done
  if [ "$rc" -ne 0 ]; then
    write_status error 0 "下载失败（多次续传仍未完成，请检查网络后重试）"
    return
  fi

  write_status extracting 92 "正在解压安装"
  local debver newdir="$work/qqx"
  if ! debver="$(dpkg-deb -f "$tmp" Version 2>/dev/null)"; then
    rm -f "$tmp" "$work/qq.url"
    write_status error 0 "安装包不完整或损坏，已清理，请再次点击安装（将重新下载）"
    return
  fi
  rm -rf "$newdir"; mkdir -p "$newdir"
  if ! dpkg-deb -x "$tmp" "$newdir" 2>/dev/null || [ ! -x "$newdir/opt/QQ/qq" ]; then
    rm -rf "$newdir" "$tmp" "$work/qq.url"
    write_status error 0 "解压失败或安装包里没有 QQ 程序，请重试"
    return
  fi
  write_status installing 96 "正在安装"
  rm -rf /config/qq.old
  [ -e /config/qq ] && mv /config/qq /config/qq.old
  mv "$newdir" /config/qq
  rm -rf /config/qq.old "$tmp" "$work/qq.url" "$work/qq-curl.err"
  write_status done 100 "安装完成" "${debver%%-*}"
  pkill -f "/config/qq/opt/QQ/qq" 2>/dev/null || true # 正在运行的旧版退出后，autostart 会拉起新版
}

case "$ACTION" in
  status) print_status ;;
  install | update)
    case "$APP" in
      telegram) install_telegram ;;
      qq) install_qq ;;
      chromium) write_status done 100 "Chromium 随镜像就绪" ;; # 后续：apt 烤进镜像后即就绪
      custom)
        if is_installed; then write_status done 100 "就绪"; else write_status error 0 "请先在「数据卷」上传并配置自定义应用"; fi ;;
      *) echo "未知应用: $APP" >&2; exit 1 ;;
    esac ;;
  *) echo "用法: $0 <appType> {install|update|status}" >&2; exit 1 ;;
esac
