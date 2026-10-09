// 面板注入容器剪贴板的文本登记：剪贴板历史（#138）防「回显入册」的共用信号。
// 「发送到剪贴板」按钮（pushClipboardToRemote）与 #139 双向互通的本机文字直粘（onLocalText 分段
// typeInInstance）都会把文本写进容器 X 剪贴板，KasmVNC 随之把变化以 ServerCutText 回推给客户端——
// 这些是本机/面板已有的内容（本机剪贴板里本就有），不应再进容器剪贴板历史，避免重复记录扩大
// 敏感文本的暴露面。#139 的写回桥另有自己的逐段 lastInjectedText 信号，与本文件互不依赖。
// 滑动窗口容量 64 段（typeInInstance 每段 500 字，≈3.2 万字），盖住超长文的分段回显。
const injected = new Set<string>();

export function markClipInjected(text: string): void {
  if (!text) return;
  injected.add(text);
  if (injected.size > 64) {
    const oldest = injected.values().next();
    if (!oldest.done) injected.delete(oldest.value);
  }
}

export function isClipInjected(text: string): boolean {
  return injected.has(text);
}
