#!/usr/bin/env bash
# 构建期补丁：改 KasmVNC 1.5.x 的 web 客户端（Vite 打包、压缩过的 assets/ui-*.js，见 Dockerfile）
#   (1) 默认开启 IME 输入模式（本地输入法打中文，成品汉字发进容器，容器内不装 IME）
#   (2) IME 模式下合成中的文字不再按 keysym 实时发给远端：1.5.x 在 compositionupdate 里边打边发拼音、
#       再按差分退格改成汉字。成品由面板在 compositionend 后经 xclip/xdotool 转发（Desktop.tsx
#       installSeamlessIme），客户端再发一遍就会重复上屏，大量汉字还会撞上 KasmVNC 的 keysym 容量上限。
#       Safari 提交时会补一个 inputType=insertFromComposition 的 input（不在合成中），也一并不发。
#   (3) 读浏览器剪贴板时个别条目 getType() 抛错（kasmtech/KasmVNC#373）不再变成未处理的 Promise 拒绝——
#       KasmVNC 的全局错误处理器会把它当致命错误弹浮层，面板随即整页重连。条目取不到就跳过，与它取到空值同样处理。
# 压缩代码里的局部变量名每次构建都可能不同，故只按方法名 / 属性名这类稳定特征匹配，参数名从原文里抓出来复用。
# 每处补丁都必须恰好命中一次，否则构建失败：客户端换了实现时宁可停下来重写，也不要悄悄失效。
set -euo pipefail

WWW="${WOC_WWW_DIR:-/usr/share/kasmvnc/www}" # 允许指向解包出来的目录，在宿主机上先试补丁
shopt -s nullglob
files=("$WWW"/assets/ui-*.js)
[ "${#files[@]}" -eq 1 ] || { echo "FATAL: 期望恰好一个 $WWW/assets/ui-*.js，实际 ${#files[@]} 个" >&2; exit 1; }
f="${files[0]}"
grep -q 'WOC-IME' "$f" && { echo "woc-www-patch: $f 已打过补丁，跳过"; exit 0; }

perl -0777 -i -pe '
  my $ime = s#initSetting\("enable_ime",!1\)#initSetting("enable_ime",!0)#g;
  my $upd = s#(_handleCompositionUpdate\((\w+)\)\{)#$1if(this._enableIME){/*WOC-IME*/this._lastKeyboardInput=$2.data;this._imeStarted=!1;return}#g;
  my $inp = s#(_handleInput\((\w+)\)\{)#$1if(this._enableIME&&($2.isComposing||/Composition/.test($2.inputType||""))){/*WOC-IME*/return}#g;
  my $clip = s#(await \w+\[\w+\]\.getType\(\w+\))#$1.catch(()=>null)/*WOC-CLIP*/#g;
  die "FATAL: 补丁命中次数不对（enable_ime=$ime compositionupdate=$upd input=$inp getType=$clip，均应为 1）\n"
    unless $ime == 1 && $upd == 1 && $inp == 1 && $clip == 1;
' "$f"

echo "woc-www-patch: patched $f"
