#!/usr/bin/env bash
# 构建期补丁：改 KasmVNC web 客户端的 webpack 产物 dist/*.bundle.js
#   (1) 保持 KasmVNC IME 输入模式默认关闭：面板使用透明输入代理 + 剪贴板粘贴路径，
#       避免 noVNC 隐藏 textarea 差分逻辑损坏中英文数字标点混合输入。
#   (2) 若用户手动开启 KasmVNC IME，仍修复 noVNC 的中文 IME 输入：原实现靠"隐藏 textarea 差分→逐字符重发 keysym"，
#       会在合成过程中把中间拼音也发给远端、且永不 reset 导致累积+退格风暴；
#       改为合成期间和提交时都只同步内部 textarea 状态，不再发送中文 keysym。
#       最终成品文本由面板前端捕获后通过 xclip/xdotool 粘贴，绕过 KasmVNC XKB keysym 限制。
# 末尾断言：若 base 镜像换了打包结构、一个文件都没改到，则构建失败而非静默放过。
set -euo pipefail

PATCH_PL="$(dirname "$0")/woc-ime.pl"
patched=0

for f in /usr/share/kasmvnc/www/dist/*.bundle.js /usr/local/share/kasmvnc/www/dist/*.bundle.js; do
    [ -f "$f" ] || continue
    changed=0

    # IME 差分逻辑修复（仅含 noVNC 键盘逻辑的 bundle）
    # 幂等：/usr/share/kasmvnc 是 /usr/local/share/kasmvnc 的软链，两个 glob 会命中同一 inode，
    # 故已含 _imeJustCommitted 的文件直接跳过，避免重复注入守卫块。
    if grep -q "IME input change, sending differential" "$f" && ! grep -q "WOC-IME" "$f"; then
        perl -0777 -i -pe "$(cat "$PATCH_PL")" "$f"
        after="$(grep -c "WOC-IME" "$f" || true)"
        # 断言两处替换都命中（compositionend 标记 1 + _handleInput 守卫标记 1 = 2 行）
        if [ "$after" -ne 2 ]; then
            echo "FATAL: IME patch mismatch on $f (markers=$after, expect 2)" >&2
            exit 1
        fi
        changed=1
    fi

    [ "$changed" = "1" ] && { echo "woc-www-patch: patched $f"; patched=1; }
done

[ "$patched" = "1" ] || { echo "FATAL: no bundle patched" >&2; exit 1; }
echo "woc-www-patch: done"
