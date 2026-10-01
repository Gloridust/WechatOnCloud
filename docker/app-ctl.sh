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
  # 浏览器随镜像装好，没有下载安装这回事。版本就是镜像里 chromium 包的版本，每次现查：面板卡片上显示出来，
  # 升级实例后有没有真的换版本一眼可见（群里问过「Chrome 是不是没更新」，只能进浏览器的「关于」页才查得到）。
  if [ "$APP" = chromium ] && is_installed; then
    local v; v="$(dpkg-query -W -f='${Version}' chromium 2>/dev/null)"; v="${v%%-*}"
    echo "{\"phase\":\"done\",\"percent\":100,\"installed\":true,\"version\":\"$v\",\"message\":\"Chromium 随镜像就绪\",\"updatedAt\":$(date +%s)}"
    return
  fi
  if [ -f "$STATUS_FILE" ]; then
    local s; s="$(cat "$STATUS_FILE")"
    if printf '%s' "$s" | grep -Eq '"phase":"(downloading|extracting|installing)"' && ! installer_running; then
      # 读状态和查进程不在同一刻：安装恰好在这两步之间结束（先写完 done / error 才退出），会被误判成中断。
      # 查不到进程时再读一次：真被打断的停在进行中，正常结束的已经是终态
      s="$(cat "$STATUS_FILE")"
      if printf '%s' "$s" | grep -Eq '"phase":"(downloading|extracting|installing)"'; then
        local inst=false; is_installed && inst=true
        echo "{\"phase\":\"error\",\"percent\":0,\"installed\":$inst,\"version\":\"\",\"message\":\"上次安装被中断（容器重启或升级），请重新点击安装\",\"updatedAt\":$(date +%s)}"
        return
      fi
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
# 安装包来源，依次尝试：
#   ① 面板卡片「上传安装包」传进来的包（$QQ_UPLOAD）：腾讯拒绝下载时，用户在电脑浏览器下好官方 .deb 传进来。
#      核对是 QQ、架构对得上就装，不比版本（用户点名要装这个），装完或装不了都删掉；
#   ② 腾讯官网 Linux QQ 页面自己用的配置（linuxConfig.js）里的地址，按浏览器的方式请求；
#   ③ ② 被拒（HTTP 403 / 404）或取不到地址时，用 AUR linuxqq 包记录的地址（只认同一个腾讯 CDN qqdl.gtimg.cn），
#      下完按 AUR 记录的 sha512 校验。
# 实测（2026-10，#153）：官网配置给的 QQNTV2/…/release/ 地址对脚本下载一律 403，境外和中国大陆都一样，
# 并不是此前以为的「只对大陆开放」；同一 CDN 上 QQNT/…/beta/ 路径的包境内外都能下（AUR、NapCat 都用它）。
# 解压到数据卷 /config/qq（升级镜像不丢；更新 = 重新下载覆盖）。下载流程同 wechat-ctl.sh：断点续传、
# 60 秒没速度即中断重试、连不上快速失败、解压前校验包完整。每一步记进 install.log（诊断包会带上）。
QQ_CONFIG_URL="${QQ_CONFIG_URL:-https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js}"
QQ_AUR_SRCINFO="${QQ_AUR_SRCINFO:-https://aur.archlinux.org/cgit/aur.git/plain/.SRCINFO?h=linuxqq}"
QQ_AUR_URL_RE="${QQ_AUR_URL_RE:-^https://qqdl\.gtimg\.cn/[A-Za-z0-9._/-]+\.deb$}"
QQ_UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"
QQ_HDR=(-A "$QQ_UA" -e "https://im.qq.com/" -H "Accept: */*" -H "Accept-Language: zh-CN,zh;q=0.9")
QQ_WORK=/config/.woc-dl
QQ_TMP="$QQ_WORK/qq.deb"
QQ_UPLOAD="$QQ_WORK/qq-upload.deb" # 面板「上传安装包」写到这里（panel docker.ts uploadAppPackage）
QQ_CODE="" # 最近一次被拒的 HTTP 状态码

qlog() { echo "[$(date '+%F %T')] [qq] $*" >> "$STATE_DIR/install.log" 2>/dev/null; }

# 已装 QQ 的版本（完整的 deb 版本号，如 3.2.34-53644）；1.5.1 装的没记，退而读状态文件里的
qq_installed_version() {
  [ -x /config/qq/opt/QQ/qq ] || return 0
  cat /config/qq/.woc-version 2>/dev/null ||
    sed -n 's/.*"version":"\([^"]*\)".*/\1/p' "$STATUS_FILE" 2>/dev/null
}

# deb 控制信息里的一个字段；含包名、版本号里不该有的字符时给「?」（要写进状态 JSON，上传的包里什么都可能有）
deb_field() {
  local v
  v="$(dpkg-deb -f "$1" "$2" 2>/dev/null | head -1)"
  case "$v" in *[!A-Za-z0-9.+:~_-]*) echo "?" ;; *) printf '%s\n' "${v:0:64}" ;; esac
}

# ① 面板上传的安装包：核对包名和架构后安装，结束后删掉（留着的话下次点「更新」还会装它）
qq_install_upload() {
  local arch="$1" label="$2" pkg debarch ver
  pkg="$(deb_field "$QQ_UPLOAD" Package)"
  debarch="$(deb_field "$QQ_UPLOAD" Architecture)"
  ver="$(deb_field "$QQ_UPLOAD" Version)"
  qlog "使用上传的安装包：包名 ${pkg:-?}，架构 ${debarch:-?}，版本 ${ver:-?}（$(stat -c%s "$QQ_UPLOAD" 2>/dev/null) 字节）"
  if [ -z "$pkg" ]; then
    write_status error 0 "上传的文件不是有效的 .deb 安装包（可能没下载完或已损坏），请重新下载后再上传"
  elif [ "$pkg" != linuxqq ]; then
    write_status error 0 "上传的不是 QQ 的安装包（包名 $pkg），请在 im.qq.com/linuxqq 下载 Linux ${label} 版的 .deb"
  elif [ "$debarch" != "$arch" ]; then
    write_status error 0 "上传的是 ${debarch} 版的 QQ，这台机器要用 Linux ${label} 版，请在 im.qq.com/linuxqq 重新下载"
  else
    qq_install_deb "$QQ_UPLOAD" upload
  fi
  rm -f "$QQ_UPLOAD"
}

# 探路请求的输出（响应头 + WOC_CODE=状态码）→「状态码 总大小」；没拿到响应时状态码为 -，大小不明为 0
qq_probe_parse() {
  awk '/^HTTP\//{cl = ""; cr = ""; next}
       tolower($1) == "content-length:" {cl = $2}
       tolower($1) == "content-range:" {n = split($0, a, "/"); cr = a[n]}
       /^WOC_CODE=/ {c = substr($0, 10)}
       END {t = cr; if (t == "" && c == "200") t = cl; if (c == "" || c == "000") c = "-"; if (t !~ /^[0-9]+$/) t = 0; print c, t}'
}

# 下载到 $QQ_TMP。返回 0 成功；10 = 服务器拒绝（403 / 404 等，换来源）；其它 = 失败（状态已写好）
qq_download() {
  local url="$1" ver="$2" head code total cur pct pid rc=1 attempt=0
  [ "$(cat "$QQ_WORK/qq.url" 2>/dev/null)" = "$url" ] || rm -f "$QQ_TMP"
  echo "$url" > "$QQ_WORK/qq.url"
  # 先取 1 个字节探路：被拒就直接换来源，不用等六轮重试；顺便从 Content-Range 拿到总大小。
  # --max-filesize 1：服务器不认 Range、回整个文件时只收响应头，不把 180MB 白下一遍。
  # 状态码用 %{http_code}（最终响应的），大小只看最后一个响应的头：走 HTTP 代理时前面还有一段代理的
  # 「200 Connection established」，隧道断了的话只剩它，按它判断会把没连上当成 200
  read -r code total < <(curl -sS -D - -o /dev/null -w 'WOC_CODE=%{http_code}\n' -r 0-0 --max-filesize 1 \
      --connect-timeout 15 --max-time 30 "${QQ_HDR[@]}" "$url" 2>/dev/null | tr -d '\r' | qq_probe_parse)
  [ "$code" = - ] && code=""
  qlog "探测 $url → HTTP ${code:-无响应}，大小 $total"
  case "$code" in 401 | 403 | 404 | 410 | 451) QQ_CODE="$code"; return 10 ;; esac
  # 磁盘预检：deb 约 180MB，解压后约 600MB，更新时新旧并存 → 按 deb 的 4 倍、不低于 900MB
  local need_kb avail_kb
  need_kb=$(( ( total > 0 ? total : 200000000 ) / 1024 * 4 )); [ "$need_kb" -lt 921600 ] && need_kb=921600
  avail_kb="$(df -Pk "$QQ_WORK" 2>/dev/null | awk 'NR==2{print $4}')"
  if [ -n "${avail_kb:-}" ] && [ "$avail_kb" -lt "$need_kb" ] 2>/dev/null; then
    write_status error 0 "磁盘空间不足：约需 $((need_kb/1024))MB 空闲，当前仅 $((avail_kb/1024))MB。请在宿主清理磁盘后重试"
    return 1
  fi
  while [ "$attempt" -lt 6 ]; do
    attempt=$((attempt+1))
    curl -fSL -C - --connect-timeout 20 --speed-limit 1024 --speed-time 60 \
         "${QQ_HDR[@]}" -o "$QQ_TMP" "$url" 2>"$QQ_WORK/qq-curl.err" & pid=$!
    while kill -0 "$pid" 2>/dev/null; do
      if [ "$total" -gt 0 ] 2>/dev/null; then
        cur="$(stat -c%s "$QQ_TMP" 2>/dev/null || echo 0)"
        pct=$(( cur * 90 / total )); [ "$pct" -gt 90 ] && pct=90
        write_status downloading "$pct" "正在下载 QQ ${ver}"
      else
        write_status downloading -1 "正在下载 QQ ${ver}"
      fi
      sleep 1
    done
    wait "$pid"; rc=$?
    cur="$(stat -c%s "$QQ_TMP" 2>/dev/null || echo 0)"
    [ "$rc" -eq 0 ] && break
    if [ "$total" -gt 0 ] && [ "$cur" -ge "$total" ]; then rc=0; break; fi
    qlog "curl 退出码 $rc（第 $attempt 轮），已下 $cur 字节：$(tail -c 200 "$QQ_WORK/qq-curl.err" 2>/dev/null | tr '\n' ' ')"
    code="$(grep -o 'error: [0-9][0-9][0-9]' "$QQ_WORK/qq-curl.err" 2>/dev/null | tail -1 | cut -d' ' -f2)"
    case "$code" in 401 | 403 | 404 | 410 | 451) QQ_CODE="$code"; return 10 ;; esac
    # 连不上（DNS / 拒绝 / 超时 / TLS）且一个字节没拿到：再试也没用，两轮后直接说清楚
    if [ "$attempt" -ge 2 ] && [ "$cur" -eq 0 ]; then
      case "$rc" in
        6 | 7 | 28 | 35) write_status error 0 "连不上腾讯 QQ 下载服务器（curl 退出码 $rc），请检查 DNS、防火墙或代理后重试"; return 1 ;;
      esac
    fi
    write_status downloading -1 "下载中断，正在续传重试（$attempt/6）"
    sleep 2
  done
  if [ "$rc" -ne 0 ]; then
    write_status error 0 "下载失败（多次续传仍未完成，请检查网络后重试）"
    return 1
  fi
  qlog "下载完成：$cur 字节"
  return 0
}

# 解压安装一个 deb。src=download：下载来的，装完或包坏了都清掉（下次重新下载）；src=upload：上传的，由调用方删
qq_install_deb() {
  local deb="$1" src="$2" debver newdir="$QQ_WORK/qqx" retry
  if [ "$src" = download ]; then retry="已清理，请再次点击安装（将重新下载）"; else retry="请重新下载后再上传"; fi
  write_status extracting 92 "正在解压安装"
  debver="$(deb_field "$deb" Version)"
  if [ -z "$debver" ]; then
    [ "$src" = download ] && rm -f "$deb" "$QQ_WORK/qq.url"
    qlog "$deb 不是完整的 deb 包"
    write_status error 0 "安装包不完整或损坏，$retry"
    return 1
  fi
  rm -rf "$newdir"; mkdir -p "$newdir"
  if ! dpkg-deb -x "$deb" "$newdir" 2>/dev/null || [ ! -x "$newdir/opt/QQ/qq" ]; then
    rm -rf "$newdir"
    [ "$src" = download ] && rm -f "$deb" "$QQ_WORK/qq.url"
    qlog "解压 $deb 失败或包里没有 opt/QQ/qq"
    write_status error 0 "解压失败或安装包里没有 QQ 程序，$retry"
    return 1
  fi
  write_status installing 96 "正在安装"
  echo "$debver" > "$newdir/.woc-version"
  rm -rf /config/qq.old
  [ -e /config/qq ] && mv /config/qq /config/qq.old
  mv "$newdir" /config/qq
  rm -rf /config/qq.old "$QQ_WORK/qq-curl.err"
  [ "$src" = download ] && rm -f "$deb" "$QQ_WORK/qq.url"
  qlog "安装完成：$debver"
  write_status done 100 "安装完成" "${debver%%-*}"
  pkill -f "/config/qq/opt/QQ/qq" 2>/dev/null || true # 正在运行的旧版退出后，autostart 会拉起新版
}

install_qq() {
  local arch key aurkey label
  arch="$(dpkg --print-architecture 2>/dev/null)"
  case "$arch" in
    amd64) key=x64DownloadUrl; aurkey=x86_64; label="x64" ;;
    arm64) key=armDownloadUrl; aurkey=aarch64; label="ARM" ;;
    *) write_status error 0 "QQ 官方只提供 x86_64 / arm64 版本，当前架构（$arch）不支持"; return ;;
  esac
  local manual="可以在电脑浏览器打开 im.qq.com/linuxqq 下载 Linux ${label} 版的 .deb 安装包，再回面板点这个实例的「上传安装包」"
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
  mkdir -p "$QQ_WORK"
  qlog "开始安装（$ACTION，架构 $arch，已装版本 $(qq_installed_version || true)）"

  # ① 面板上传的安装包
  if [ -f "$QQ_UPLOAD" ]; then
    qq_install_upload "$arch" "$label"
    return
  fi

  # ② 官网配置里的地址
  local cfg url ver rc why=""
  write_status downloading -1 "正在获取 QQ 最新版本信息"
  cfg="$(curl -fsSL --connect-timeout 20 --max-time 60 "${QQ_HDR[@]}" "$QQ_CONFIG_URL" 2>/dev/null | tr -d '\r\n')"
  url="$(printf '%s' "$cfg" | grep -o "\"$key\":{[^}]*}" | grep -o '"deb":"[^"]*"' | head -1 | cut -d'"' -f4)"
  ver="$(printf '%s' "$cfg" | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4)"
  case "$url" in
    http://*.deb | https://*.deb)
      qlog "官网配置：版本 $ver，$url"
      qq_download "$url" "$ver"; rc=$?
      if [ "$rc" -eq 0 ]; then qq_install_deb "$QQ_TMP" download; return; fi
      [ "$rc" -eq 10 ] || return
      why="官网下载地址被腾讯拒绝（HTTP $QQ_CODE）" ;;
    *)
      qlog "官网配置取不到 $key 的下载地址（${#cfg} 字节）"
      why="取不到官网的下载地址" ;;
  esac

  # ③ AUR linuxqq 包记录的地址（同一个腾讯 CDN），按它记录的 sha512 校验
  local si url2 ver2 sum
  write_status downloading -1 "${why}，改用 AUR linuxqq 包记录的下载地址"
  si="$(curl -fsSL --connect-timeout 20 --max-time 60 "$QQ_AUR_SRCINFO" 2>/dev/null | tr -d '\r')"
  url2="$(printf '%s\n' "$si" | awk -F' = ' -v k="source_$aurkey" '{sub(/^[ \t]+/, "", $1)} $1==k {print $2; exit}')"
  sum="$(printf '%s\n' "$si" | awk -F' = ' -v k="sha512sums_$aurkey" '{sub(/^[ \t]+/, "", $1)} $1==k {print $2; exit}')"
  ver2="$(printf '%s\n' "$si" | awk -F' = ' '{sub(/^[ \t]+/, "", $1)} $1=="pkgver" {print $2; exit}' | tr '_' '-')"
  if ! printf '%s' "$url2" | grep -Eq "$QQ_AUR_URL_RE"; then
    qlog "AUR 记录里没有可用的 $aurkey 地址（${url2:-空}）"
    write_status error 0 "${why}，备用下载地址也取不到。$manual"
    return
  fi
  qlog "AUR 记录：版本 $ver2，$url2"
  qq_download "$url2" "$ver2"; rc=$?
  if [ "$rc" -eq 10 ]; then
    write_status error 0 "腾讯下载服务器拒绝了请求（HTTP $QQ_CODE），官网地址和备用地址都下不了。$manual"
    return
  fi
  [ "$rc" -eq 0 ] || return
  if [ -n "$sum" ]; then
    if [ "$(sha512sum "$QQ_TMP" | cut -d' ' -f1)" != "$sum" ]; then
      qlog "sha512 校验不通过，已删除下载的文件"
      rm -f "$QQ_TMP" "$QQ_WORK/qq.url"
      write_status error 0 "下载的安装包校验不通过（和 AUR 记录的不一致），已删除，请稍后重试"
      return
    fi
    qlog "sha512 校验通过"
  fi
  qq_install_deb "$QQ_TMP" download
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
