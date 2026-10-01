import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, appProfile, type InstanceWithStatus } from '../api';
import { useUI, MenuButton, Spinner, useDocTitle, type MenuEntry } from '../ui';
import { useAuth } from '../auth';
import { useInstances, statusOf } from '../AppShell';
import { VncAudio } from '../vncAudio';
import { Icon, type IconName } from '../icons';
import { InstanceIcon } from '../AppIcon';

// KasmVNC noVNC 页面；反代按实例隔离：/desktop/<id>/* → 对应容器，注入凭据。
function desktopUrl(id: string) {
  return (
    `/desktop/${id}/vnc/index.html?autoconnect=1&path=desktop/${id}/websockify&resize=remote` +
    '&reconnect=true&reconnect_delay=2000&clipboard_up=true&clipboard_down=true&clipboard_seamless=true'
  );
}

// 「无感输入」钩子：装进同源 iframe，让用户直接在微信里打中文。
// - compositionend（中文提交）→ 经 xclip+xdotool 转发（绕开 VNC keysym 容量上限）。
// - 转发未完成期间（队列活跃），把后续可见字符 + 回车/退格也串进同一队列按序送出 →
//   彻底消除"中文走异步、数字走 keysym 抢跑"导致的"你好123→23"丢字。
// - 队列空闲时不干预：英文/数字仍走原生 keysym，零延迟。
// 返回清理函数（切回转发模式 / 重连 / 卸载时移除监听）。
function installSeamlessIme(
  win: Window,
  doc: Document,
  instId: string,
  onTyped: (text: string) => void,
  onFail: (err: any) => void,
): () => void {
  type Job = { kind: 'text'; data: string } | { kind: 'key'; data: string };
  const queue: Job[] = [];
  let draining = false;
  const active = () => draining || queue.length > 0;
  // /type 单次上限 500 字（语音输入、长句提交可能超过），按段入队，免得整段被拒后丢失
  const pushText = (data: string) => {
    for (let i = 0; i < data.length; i += 500) queue.push({ kind: 'text', data: data.slice(i, i + 500) });
  };

  const drain = async () => {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const job = queue[0];
      try {
        if (job.kind === 'text') {
          onTyped(job.data);
          await api.typeInInstance(instId, job.data);
        }
        else await api.keyInInstance(instId, job.data);
      } catch (e) {
        onFail(e); // 单条失败丢弃、继续后续，避免卡住队列；但要让用户知道刚打的字没发出去
      }
      queue.shift();
    }
    draining = false;
  };

  // 隐藏输入框瘦身：IME 模式下 noVNC 从不清空 noVNC_keyboardinput，每次上屏的字都追加在里面，用得越久越长；
  // 实测 5 千字时每次合成 ~30ms、8 万字 ~100ms，打字越来越卡（「用着用着」）。noVNC 自己只在「非合成的输入且超过
  // 200 字」时重置（_keyboardInputReset，连同内部差分基准一起清）。上屏后若已超长，补发一个内容不变的 input 事件
  // 走它这条路：内容与基准相同、差分为空，不会给应用发任何按键，只触发重置。
  let composing = false;
  const trimKeyboardInput = () => {
    const ki = doc.getElementById('noVNC_keyboardinput') as HTMLTextAreaElement | null;
    if (composing || !ki || ki.value.length <= 200) return;
    ki.dispatchEvent(new (win as any).Event('input', { bubbles: true }));
  };
  const onCompositionStart = () => {
    composing = true;
  };

  const onCompositionEnd = (e: Event) => {
    composing = false;
    win.setTimeout(trimKeyboardInput, 0); // 等 noVNC 同步完差分基准（它在目标阶段处理 compositionend）
    const txt = (e as CompositionEvent).data;
    if (!txt) return;
    pushText(txt);
    drain();
  };

  // 捕获阶段（iframe window 最外层）抢先拦截，赶在 noVNC 之前 → stopImmediatePropagation 阻止它发 keysym。
  // 关键：队列活跃（有中文正在转发）时，只接管【数字】和回车/退格——它们不参与拼音合成、且是原"混数字丢字"的祸首；
  // 字母绝不接管，否则会把下一个词的拼音首字母（如"呀"的 y）当成字面字符抢走，造成"你好y呀"。字母交给输入法合成。
  const onKeyDownCapture = (ev: Event) => {
    const e = ev as KeyboardEvent;
    if (e.isComposing) return; // 拼音合成中，交给输入法（候选数字选词也在此放行）
    if (e.ctrlKey || e.altKey || e.metaKey) return; // 快捷键放行
    if (!active()) return; // 没有中文在转发 → 不接管（英文/数字走原生 keysym，零延迟）
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      queue.push({ kind: 'text', data: e.key });
      drain();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopImmediatePropagation();
      queue.push({ kind: 'key', data: 'Return' });
      drain();
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      e.stopImmediatePropagation();
      queue.push({ kind: 'key', data: 'BackSpace' });
      drain();
    }
    // 其它非可见键（方向键/功能键等）放行
  };

  // 不经合成、直接插进输入框的文字：不少输入法的全角标点（，。？）、系统表情面板、语音输入都这样进来。
  // noVNC 对它们走「输入框差分 → 逐字 keysym」：非 ASCII 字符要临时映射键码，实测会丢；keysym 又经 websocket 直达，
  // 会抢在走 HTTP 转发的中文前面（实测依次输入「你好」「，」「世界」「。」，远端收到「。你好世界」）。
  // 在插入前截下，与中文走同一个有序队列。ASCII 只在队列忙时接管（保证顺序），空闲时照旧走 keysym，零延迟。
  const onBeforeInput = (ev: Event) => {
    const e = ev as InputEvent;
    if (e.isComposing || composing) return; // 合成中的文字在 compositionend 统一转发
    if (e.inputType !== 'insertText' && e.inputType !== 'insertReplacementText') return;
    if (e.target !== doc.getElementById('noVNC_keyboardinput')) return;
    const data = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
    if (!data || (/^[\x20-\x7e]*$/.test(data) && !active())) return;
    e.preventDefault(); // 不插入输入框：noVNC 不会再按 keysym 发一遍，它的差分基准也保持一致
    pushText(data);
    drain();
  };

  // 焦点守卫：本机输入法只在焦点落在可编辑元素上时才启用，无感模式靠的是 KasmVNC 的隐藏输入框 noVNC_keyboardinput。
  // KasmVNC 在 iframe 里不拦 canvas 上 mousedown 的默认聚焦（它只在顶层页面才 preventDefault），平时靠「输入框正有焦点时
  // 拦下 mousedown」保住焦点；可输入框一旦因任何原因失焦，下一次点画面焦点就会落到 canvas 上——canvas 不可编辑，
  // 浏览器随即停用输入法（候选框消失、只能打英文），而且之后每次点击都会重演、再也回不到输入框，只能刷新页面。
  // 故焦点一落到 canvas 就交还给输入框（IME 模式下 noVNC 自己聚焦的也正是它，键盘监听两处都挂着，不影响按键）。
  // 只在 KasmVNC 的 IME 模式确实开着时这么做：万一它没开（enable_ime 与本页模式不一致），输入框上的中文会被
  // noVNC 按 keysym 再发一遍，与这里的转发重复。
  const onFocusIn = (ev: Event) => {
    if ((ev.target as Element | null)?.tagName !== 'CANVAS') return;
    const imeSetting = doc.getElementById('noVNC_setting_enable_ime') as HTMLInputElement | null;
    if (imeSetting && !imeSetting.checked) return;
    const ki = doc.getElementById('noVNC_keyboardinput') as HTMLTextAreaElement | null;
    if (ki && doc.activeElement !== ki) ki.focus({ preventScroll: true });
  };

  // 候选框跟着点击位置走（issue #131「中文输入法显示框在对话中间」）：本机输入法的候选框贴着隐藏输入框的光标弹出，
  // 而 KasmVNC 把它固定在画面 35%/40% 处，无论点的是哪儿，候选框都飘在对话中间。点画面时把它挪到点击处——
  // 用户点的通常就是应用的输入框，候选框随之出现在输入框旁边。1×1 透明、在画面下层，挪动不影响显示与点击。
  const onMouseDown = (ev: MouseEvent) => {
    if ((ev.target as Element | null)?.tagName !== 'CANVAS') return;
    const ki = doc.getElementById('noVNC_keyboardinput') as HTMLTextAreaElement | null;
    const box = ki?.offsetParent?.getBoundingClientRect();
    if (!ki || !box || !box.width || !box.height) return;
    const x = Math.min(Math.max(ev.clientX - box.left, 0), box.width - 2);
    const y = Math.min(Math.max(ev.clientY - box.top, 0), box.height - 2);
    ki.style.left = `${Math.round(x)}px`;
    ki.style.top = `${Math.round(y)}px`;
  };

  doc.addEventListener('compositionstart', onCompositionStart, true);
  doc.addEventListener('compositionend', onCompositionEnd, true);
  doc.addEventListener('beforeinput', onBeforeInput, true);
  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('mousedown', onMouseDown, true);
  win.addEventListener('keydown', onKeyDownCapture, true);
  return () => {
    doc.removeEventListener('compositionstart', onCompositionStart, true);
    doc.removeEventListener('compositionend', onCompositionEnd, true);
    doc.removeEventListener('beforeinput', onBeforeInput, true);
    doc.removeEventListener('focusin', onFocusIn, true);
    doc.removeEventListener('mousedown', onMouseDown, true);
    win.removeEventListener('keydown', onKeyDownCapture, true);
  };
}

// 本机截图 / 图片直接粘进应用（issue #91，多人反馈）。
// 背景：noVNC 在 keydown 里 preventDefault，浏览器的粘贴动作连同 paste 事件都被压掉，本机的图片永远到不了容器。
// 做法：抢在 noVNC 之前截下 Ctrl/Cmd+V（只 stopImmediatePropagation，不 preventDefault），让浏览器照常派发
// 带剪贴板数据的 paste 事件——它不依赖异步剪贴板 API，内网 http 访问下同样可用。实测 paste 在按键后同一任务内
// 到达（约 4ms），早于 setTimeout(0)，所以在定时器里决定走哪条路：
//   - 本机剪贴板有图片、且它比容器剪贴板「新」→ 上传写入容器 X 剪贴板并在容器里按 Ctrl+V（onImage）
//   - 其余情况 → 在容器里按一次 Ctrl+V（onPlainPaste），粘贴的仍是容器剪贴板，与以前完全一致
//     （例如在微信里复制一条消息再粘到别处——这条最常用的路径不能被改变）
// 不能把截下的按键「合成事件」还给 noVNC：实测按键松开得快时，重放时修饰键已抬起，远端只收到一个 v。
// 改由服务端 xdotool 按 Ctrl+V（先松开它自己按住的修饰键，见 docker.ts xdoKey），与用户按多久无关。
//
// 「谁更新」：本机剪贴板里可能躺着很久以前的截图，而用户刚在微信里复制了一张图——此时应粘容器的。
// 回到页面（focus）视为可能刚在外面复制/截图 → 本机为新；在桌面里 Ctrl/Cmd+C、X 或右键（微信里复制）→ 容器为新。
// 但有些截图方式不让浏览器失焦（如 macOS 自带截图），只靠 focus 会把新截图误判为旧的——所以再看图片本身：
// 和上次见过的不是同一张（类型+字节数不同）就一定是本机新产生的，照粘本机；同一张且其后在应用里复制过，才改粘容器。
//
// 文字同理（onLocalText）：本机剪贴板的文字比容器的新（在别处复制后回来直接 Ctrl+V，或局域网 http 下浏览器
// 根本不同步剪贴板），就把本机文字贴进去；否则按原样在容器里 Ctrl+V，应用内复制粘贴保留应用自己的格式。
function installPasteBridge(
  win: Window,
  doc: Document,
  topWin: Window,
  handlers: {
    onImage: (file: File) => void;
    onPlainPaste: () => void;
    onLocalText: (text: string, localIsFresh: boolean) => boolean;
  },
): () => void {
  type Pending = { handled: boolean; text: string };
  let pending: Pending | null = null;
  let localIsFresh = true;
  let lastLocalImage = ''; // 上次在 paste 里见到的本机图片签名
  const isKey = (e: KeyboardEvent, code: string, key: string) =>
    (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.code === code || e.key.toLowerCase() === key);

  const onKeyDown = (e: KeyboardEvent) => {
    if (!e.isTrusted || e.isComposing) return;
    if (isKey(e, 'KeyC', 'c') || isKey(e, 'KeyX', 'x')) {
      localIsFresh = false; // 在应用里复制/剪切 → 容器剪贴板更新（按键照常交给 noVNC）
      return;
    }
    if (e.repeat || !isKey(e, 'KeyV', 'v')) return;
    e.stopImmediatePropagation();
    const p: Pending = { handled: false, text: '' };
    pending = p;
    win.setTimeout(() => {
      if (pending === p) pending = null;
      if (p.handled) return;
      if (p.text && handlers.onLocalText(p.text, localIsFresh)) return;
      handlers.onPlainPaste();
    }, 0);
  };

  const onPaste = (e: ClipboardEvent) => {
    // 由我们截下的 Ctrl/Cmd+V 引起的粘贴：一律阻止浏览器默认插入，粘什么只由我们决定。
    // 否则无感模式下焦点在 KasmVNC 的输入框（noVNC_keyboardinput），浏览器会把本机剪贴板文字原样插进去，
    // KasmVNC 再把它当键入发给远端——既改变了粘贴语义，还会把本机剪贴板里的敏感内容打进应用（实测发生过）。
    if (pending) e.preventDefault();
    const item = Array.from(e.clipboardData?.items || []).find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (!file) {
      if (pending) pending.text = e.clipboardData?.getData('text/plain') || ''; // 交给定时器判断本机 / 容器谁新
      return;
    }
    const sig = `${file.type}:${file.size}`;
    const isNewImage = sig !== lastLocalImage;
    lastLocalImage = sig;
    if (!localIsFresh && !isNewImage) return; // 同一张旧图、之后在应用里复制过 → 让定时器粘容器剪贴板
    localIsFresh = true;
    e.preventDefault();
    if (pending) pending.handled = true;
    handlers.onImage(file);
  };

  const onFocus = () => {
    localIsFresh = true;
  };
  const onMouseDown = (e: MouseEvent) => {
    if (e.button === 2) localIsFresh = false; // 右键菜单多半是在应用里「复制」
  };

  win.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('paste', onPaste, true);
  win.addEventListener('mousedown', onMouseDown, true);
  topWin.addEventListener('focus', onFocus);
  win.addEventListener('focus', onFocus);
  return () => {
    win.removeEventListener('keydown', onKeyDown, true);
    doc.removeEventListener('paste', onPaste, true);
    win.removeEventListener('mousedown', onMouseDown, true);
    topWin.removeEventListener('focus', onFocus);
    win.removeEventListener('focus', onFocus);
  };
}

// ---------- 剪贴板协调 ----------
// KasmVNC 的无缝剪贴板是双向的：容器剪贴板一变就写本机剪贴板；本机的内容在「窗口重新获得焦点后第一次点画面」时推上去。
// 两处与之冲突：① 打字（/type）靠借用容器剪贴板把字贴进应用，借用期间的临时内容会被同步到本机，覆盖用户复制的东西
// （服务端打完约 1 秒会归还，归还时的内容再同步一次，本机若已有更新的复制也会被盖掉）；② 切到别处复制后回来直接
// Ctrl+V（没点画面），本机内容还没推上去，粘到的是容器里的旧内容。
// 这里记下容器剪贴板里「用户自己的」内容：打字借用的临时内容与归还时的原内容不写本机剪贴板；Ctrl+V 时本机内容比它新
// 就直接贴本机的。浏览器剪贴板 API 不可用（局域网 http）时 KasmVNC 本就不同步，改用它收到的容器剪贴板文本 + 本机
// 是否有过新复制来判断。
interface ClipState {
  guarded: boolean; // 已接管 KasmVNC 对浏览器剪贴板的读写
  remoteText: string | null; // 容器剪贴板里用户自己的内容（null = 未知 / 是图片）
  remoteNewer: boolean; // 容器有更新的内容但没能写进本机（如当时页面没焦点）
  typed: { text: string; at: number }[]; // 近几秒借用剪贴板打的字
  lastLocal: string | null; // 上次粘贴时见到的本机剪贴板文字
}
const TYPED_WINDOW_MS = 5000;
function noteTyped(st: ClipState, text: string) {
  const now = Date.now();
  st.typed = st.typed.filter((x) => now - x.at < TYPED_WINDOW_MS);
  st.typed.push({ text, at: now });
}
// 打字借用剪贴板引起的容器 → 本机同步：临时内容本身，或打字后归还的原内容（= 已知的容器内容）
function isTransientClip(st: ClipState, text: string): boolean {
  const now = Date.now();
  const recent = st.typed.filter((x) => now - x.at < TYPED_WINDOW_MS);
  return recent.some((x) => x.text === text) || (recent.length > 0 && text === st.remoteText);
}
async function clipItemsText(items: ClipboardItems | ClipboardItem[] | undefined): Promise<string | null> {
  try {
    const it = items?.[0];
    if (it && it.types.includes('text/plain')) return await (await it.getType('text/plain')).text();
  } catch {
    /* 读不到文字部分 */
  }
  return null;
}
function installClipboardGuard(win: Window, st: ClipState): () => void {
  const clip = (win.navigator as any).clipboard as Clipboard | undefined;
  if (!clip || typeof clip.write !== 'function') {
    st.guarded = false;
    return () => {};
  }
  const orig = { write: clip.write, writeText: clip.writeText, read: clip.read, readText: clip.readText };
  // 容器 → 本机
  const guardWrite = async (text: string | null, doWrite: () => Promise<void>) => {
    if (text !== null && isTransientClip(st, text)) return;
    st.remoteText = text;
    try {
      await doWrite();
      st.remoteNewer = false;
    } catch (e) {
      st.remoteNewer = true;
      throw e;
    }
  };
  const c = clip as any;
  c.write = (items: ClipboardItems) => clipItemsText(items).then((t) => guardWrite(t, () => orig.write.call(clip, items)));
  c.writeText = (t: string) => guardWrite(t, () => orig.writeText.call(clip, t));
  // 本机 → 容器：KasmVNC 读本机剪贴板就是要推上去
  const noteLocal = (t: string | null) => {
    if (t === null) return;
    st.remoteText = t;
    st.remoteNewer = false;
  };
  c.read = () =>
    orig.read.call(clip).then(async (items: ClipboardItems) => {
      noteLocal(await clipItemsText(items));
      return items;
    });
  c.readText = () =>
    orig.readText.call(clip).then((t: string) => {
      noteLocal(t);
      return t;
    });
  st.guarded = true;
  return () => {
    for (const k of ['write', 'writeText', 'read', 'readText']) delete c[k];
  };
}
// Ctrl+V 时本机剪贴板里的文字是否比容器的新（是则贴本机的）
function shouldPasteLocal(st: ClipState, text: string, localIsFresh: boolean, doc: Document | null | undefined): boolean {
  let local: boolean;
  if (st.guarded) {
    local = !st.remoteNewer && text !== st.remoteText;
  } else {
    // 没有剪贴板 API：本机内容推不上去，容器内容也下不来。本机自回到页面后有过新复制（与上次粘贴时见到的不同）、
    // 且与 KasmVNC 收到的容器剪贴板文字不同，才算本机新；在应用里复制过（Ctrl+C / 右键）则以容器为准。
    const remote = (doc?.getElementById('noVNC_clipboard_text') as HTMLTextAreaElement | null)?.value ?? null;
    local = localIsFresh && text !== st.lastLocal && text !== remote;
  }
  st.lastLocal = text;
  if (local) {
    st.remoteText = text;
    st.remoteNewer = false;
  }
  return local;
}

interface TFile {
  name: string;
  size: number;
}
function humanSize(n: number) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// KasmVNC/noVNC 客户端 bundle 偶发未捕获异常（如断线后报 "Cannot read properties of undefined
// (reading 'lastActiveAt')"），会弹出其致命错误浮层（#noVNC_fallback_error 加 .noVNC_open）盖住桌面。
// 非干净断开时底层 ws 已死、noVNC 也不会再自己重连，只能整页重连；干净断开时 noVNC 自带重连仍在进行，
// 这条报错无害（见 isReconnectGapError）。返回错误文案以便记日志；无致命错误则返回 null。
//
// ⚠️ 浏览器扩展误报：KasmVNC 的全局 error / unhandledrejection 处理器会把页面上【任何】未捕获错误都当致命错误
// 弹浮层——包括浏览器扩展注入到页面主世界的脚本抛的错（MetaMask 等钱包扩展会往每个页面注入 inpage.js，
// 连不上时抛 "Failed to connect to MetaMask"）。这类错误与远程桌面无关（此时 VNC 仍是 connected），若据此重载，
// 装了这类扩展的用户桌面会每十几秒被我们自己的自愈逻辑重载一次（实测 MetaMask：约 13s 一次，#122 同型）。
// 浮层里带完整堆栈，据扩展协议地址即可区分：扩展错误只关掉浮层、不重载；KasmVNC 自身的崩溃照旧自愈。
//
// 两个细节：
//   - 浮层内容是「消息 / 出错位置 / 堆栈」几个相邻 div，直接取 textContent 会粘成 "…MetaMaskchrome-extension://…"，
//     \b 在两个字母之间不成立 → 没带堆栈的扩展报错被当成致命错误、整页重载。故逐段取文字再用空格拼。
//   - KasmVNC 的错误处理器只展示第一条错误：浮层内容非空就直接 return、不再打开浮层。关掉扩展误报时若不清空内容，
//     之后 KasmVNC 自己真的崩了（如断线重连时的 lastActiveAt）浮层也不会再弹，这里就再也检测不到，自愈整页失效，
//     桌面停在断开状态，只能手动刷新 / 重启实例。
const EXTENSION_SRC = /\b(?:chrome|moz|safari(?:-web)?|ms-browser)-extension:\/\//i;
function fatalErrorMsg(doc: Document | null | undefined, onExtensionError?: (msg: string) => void): string | null {
  try {
    const el = doc?.getElementById('noVNC_fallback_error');
    if (el && el.classList.contains('noVNC_open')) {
      const box = doc?.getElementById('noVNC_fallback_errormsg');
      const parts = Array.from(box?.children || []).map((c) => c.textContent?.trim()).filter(Boolean);
      const msg = parts.join(' ') || box?.textContent?.trim() || 'KasmVNC 致命错误';
      if (EXTENSION_SRC.test(msg)) {
        el.classList.remove('noVNC_open'); // 关掉误报浮层，桌面照常用
        box?.replaceChildren(); // 清空，让 KasmVNC 之后的真错误还能弹出浮层（见上）
        onExtensionError?.(msg);
        return null;
      }
      if (isReconnectGapError(msg, doc)) {
        el.classList.remove('noVNC_open'); // noVNC 自带重连正在进行 / 已连回，关掉浮层即可（见 isReconnectGapError）
        box?.replaceChildren();
        return null;
      }
      return msg;
    }
  } catch {
    /* 同源正常不会到这 */
  }
  return null;
}

// KasmVNC 在 iframe 里有个每 5s 的保活定时器，直接读 UI.rfb.lastActiveAt；断线后 UI.rfb 被置空，在 noVNC
// 自带重连接上之前的空档里它就抛 "Cannot read properties of undefined (reading 'lastActiveAt')" 并弹致命浮层
// （每次重连还会多叠一个定时器，越往后越容易撞上）。干净断开（服务端关闭、反代超时断开、网络抖一下）后 noVNC
// 已排好 2s 后自己重连，这条报错无害：若照致命错误整页重载，每次抖动都多一次整页重连，还白白消耗「5 分钟
// 4 次」的自愈额度，额度用完就只能手动恢复。只有停在 disconnected（非干净断开，noVNC 不会再自己重连）时，
// 才交给致命自愈整页重连。
function isReconnectGapError(msg: string, doc: Document | null | undefined): boolean {
  if (!msg.includes('lastActiveAt')) return false;
  const c = doc?.documentElement?.classList;
  return !!c && !c.contains('noVNC_disconnected');
}

// 错误事件是否来自浏览器扩展注入的脚本（出错文件 / 堆栈里带扩展协议地址）。
// 用于在 KasmVNC 的全局错误处理器之前截下它，连浮层都不让弹（否则 MetaMask 这类每十几秒报一次的扩展会让浮层反复闪）。
function isExtensionError(ev: Event): boolean {
  const e = ev as Partial<ErrorEvent> & Partial<PromiseRejectionEvent>;
  const src = [e.filename, e.error?.stack, e.reason?.stack].filter(Boolean).join(' ');
  return EXTENSION_SRC.test(src);
}

// 致命崩溃自愈限频：同一实例 5 分钟内最多自动重连 4 次，超限改走手动恢复，杜绝"崩溃→重载→又崩"的死循环。
function allowAutoRecover(iid: string): boolean {
  const key = `woc_fatal_${iid}`;
  let n = 0;
  let last = 0;
  try {
    const o = JSON.parse(sessionStorage.getItem(key) || '{}');
    n = Number(o.n) || 0;
    last = Number(o.t) || 0;
  } catch {
    /* ignore */
  }
  const now = Date.now();
  if (now - last > 5 * 60 * 1000) n = 0; // 距上次自愈超 5min → 计数清零（视作长时间稳定后的新一轮崩溃）
  if (n >= 4) return false;
  try {
    sessionStorage.setItem(key, JSON.stringify({ n: n + 1, t: now }));
  } catch {
    /* ignore */
  }
  return true;
}

// 转发输入条上的功能键（issue #125）。键名走 xdotool，须匹配服务端白名单 /^[A-Za-z_]{1,20}$/，
// 故只放单键、不放组合键（ctrl+a 这类含 "+" 会被拒）。
// 方向键 / 回车用 SVG 而非 ↵ ← ↑ ↓ → 字符：字符的大小与基线随系统字体变化，安卓上 ↵ 小到几乎看不见、
// 整排也会上下错位（issue #125 追评截图）。线条风格与侧栏图标一致（lucide 同款，MIT）。
const KeyIcon = ({ d }: { d: string[] }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d.map((p) => (
      <path key={p} d={p} />
    ))}
  </svg>
);
const ICON_ENTER = ['M9 10 4 15l5 5', 'M20 4v7a4 4 0 0 1-4 4H4'];
const FUNC_KEYS: { key: string; label: ReactNode; title: string }[] = [
  { key: 'Escape', label: 'Esc', title: 'Escape（关弹窗/退出全屏输入）' },
  { key: 'Tab', label: 'Tab', title: 'Tab（切换焦点）' },
  // 用中文字面而非 ⌫（U+232B）：容器/部分系统缺字形会渲染成豆腐块，实测就是方框
  { key: 'BackSpace', label: '退格', title: '退格（删除前一个字符）' },
  { key: 'Delete', label: 'Del', title: 'Delete（删除后一个字符）' },
  { key: 'Return', label: <KeyIcon d={ICON_ENTER} />, title: '回车（发送/换行）' },
  { key: 'Left', label: <KeyIcon d={['m12 19-7-7 7-7', 'M19 12H5']} />, title: '左方向键' },
  { key: 'Up', label: <KeyIcon d={['m5 12 7-7 7 7', 'M12 19V5']} />, title: '上方向键' },
  { key: 'Down', label: <KeyIcon d={['M12 5v14', 'm19 12-7 7-7-7']} />, title: '下方向键' },
  { key: 'Right', label: <KeyIcon d={['M5 12h14', 'm12 5 7 7-7 7']} />, title: '右方向键' },
];

export default function InstanceView({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { user } = useAuth();
  const { toast, confirm } = useUI();
  const { instances, loaded, reload } = useInstances();
  const isAdmin = user?.role === 'admin';

  const [frameLoaded, setFrameLoaded] = useState(false);
  // iframe 每载入一个新文档就 +1。iframe 会在页内自行换文档：实例短暂不可用时反代先回「自动重连」页，它 3s 后
  // location.reload() 进 noVNC（重启 / 升级 / 自愈 / 断线后的整页重连都可能碰上）。这时 frameLoaded 早已是 true，
  // setFrameLoaded(true) 不触发重渲染——所以凡是往 iframe 的 window / document 挂监听的 effect 都必须依赖 frameGen，
  // 否则监听还挂在已销毁的旧文档上：无感输入的中文转发（打的中文被吞、只剩英文）、粘贴桥、控制权心跳全部静默失效。
  const [frameGen, setFrameGen] = useState(0);
  const clip = useRef<ClipState>({ guarded: false, remoteText: null, remoteNewer: false, typed: [], lastLocal: null }); // 见 installClipboardGuard
  const [loadStuck, setLoadStuck] = useState(false); // iframe 久未加载出来（疑似实例无响应）
  const [dragging, setDragging] = useState(false);
  // 右上角的浮动面板（文件 / 剪贴板 / 桌面设置）：同一时间只开一个，此前三个能同时开、叠在同一个位置
  const [panel, setPanel] = useState<null | 'files' | 'clip' | 'settings'>(null);
  const [files, setFiles] = useState<TFile[]>([]);
  const [clipText, setClipText] = useState('');
  // 中文输入模式：'forward'=底部输入条转发（默认，最稳）；'seamless'=无感（直接在微信里打，提交后转发）。
  const [inputMode, setInputMode] = useState<'forward' | 'seamless'>(() => {
    try {
      return window.localStorage.getItem('woc_input_mode') === 'seamless' ? 'seamless' : 'forward';
    } catch {
      return 'forward';
    }
  });
  const setMode = (m: 'forward' | 'seamless') => {
    try {
      window.localStorage.setItem('woc_input_mode', m);
      // 同步写好 enable_ime，重载后新页面的 noVNC 连接时即读到
      window.localStorage.setItem('enable_ime', m === 'seamless' ? 'true' : 'false');
    } catch {
      /* 隐私模式禁用 localStorage：忽略 */
    }
    // 整页重载切换：先卸载旧页面（彻底关闭旧 VNC ws），再以新 enable_ime 干净重连。
    // 不能在页内重挂 iframe 重连——新旧两条 ws 短暂并存会概率性把实例的 Xvnc 卡死（需重启容器才恢复、
    // 面板重启无效），且新连接常读不到新模式（仍是英文）。整页重载是实测唯一可靠的方式；
    // 「重新连接」按钮与「重启实例」后的重连同样走整页重载（见 restartInstance / 桌面无响应面板）。
    window.location.reload();
  };
  // 声音（扬声器）开关：每次打开实例都默认【关】，不持久化 on 状态（用户要求）。音频桥是额外一条到 kclient
  // 的 socket.io，蓝牙外放(AirPods)等场景交互较敏感，默认关最稳、最可预期；想听声音手动开即可（开→建立音频桥，
  // 关→断开）。开了之后在桌面上点一下即可解挂起出声（见下方 resumePlayback 的 iframe 手势监听）。
  const [soundOn, setSoundOn] = useState(false);
  const toggleSound = () => {
    const v = !soundOn;
    setSoundOn(v);
    try {
      window.localStorage.setItem('woc_sound_on', v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  const [showKeys, setShowKeys] = useState(false);
  // 转发输入条「发送后自动回车」开关（默认开，保持 issue #81 起的既有行为）。
  // 关掉的场景（issue #125）：想先把长文/多行填进微信输入框里再自己斟酌、编辑后手动发；
  // 自动回车会让文本一进框就被发出去，也让 Shift+回车换行之外的编辑很别扭。
  const [autoEnter, setAutoEnter] = useState(() => {
    try {
      return window.localStorage.getItem('woc_ime_auto_enter') !== '0';
    } catch {
      return true;
    }
  });
  const toggleAutoEnter = () => {
    const v = !autoEnter;
    setAutoEnter(v);
    try {
      window.localStorage.setItem('woc_ime_auto_enter', v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  // 麦克风开关（默认关）：仅在「声音」开启时有意义；默认不抢占麦克风，避免把 AirPods 切到低质通话模式。
  const [micOn, setMicOn] = useState(() => {
    try {
      return window.localStorage.getItem('woc_mic_enabled') === '1';
    } catch {
      return false;
    }
  });
  const toggleMic = () => {
    const v = !micOn;
    setMicOn(v);
    try {
      window.localStorage.setItem('woc_mic_enabled', v ? '1' : '0');
    } catch {
      /* ignore */
    }
    audioRef.current?.setMicEnabled(v);
  };
  const [imeText, setImeText] = useState('');
  const [imeSending, setImeSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(''); // 进行中的上传进度文案（「37%」「(2/5) 80%」）
  const uploadQueue = useRef<File[]>([]);
  const uploadBusy = useRef(false);
  const [starting, setStarting] = useState(false);
  const [control, setControl] = useState<{ free: boolean; mine: boolean; holder: string | null } | null>(null);
  const [settingsTab, setSettingsTab] = useState<'bg' | 'font'>('bg');
  const [bgList, setBgList] = useState<string[]>([]);
  const [fontList, setFontList] = useState<string[]>([]);
  const [bgUploading, setBgUploading] = useState(false);
  const [fontUploading, setFontUploading] = useState(false);
  const [currentBg, setCurrentBg] = useState('');
  const [currentFont, setCurrentFont] = useState('');
  const bgInput = useRef<HTMLInputElement>(null);
  const fontInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const dragDepth = useRef(0);
  const lastBeat = useRef(0);
  const audioRef = useRef<VncAudio | null>(null);
  const recovering = useRef(false); // 致命崩溃自愈进行中（防错误浮层轮询与 error 事件重复触发重载）
  // 浏览器扩展注入脚本的报错（见 fatalErrorMsg）：只关浮层不重连；每次页面加载只记一条，避免 3s 轮询刷日志
  const extErrLogged = useRef(false);
  const gapLogged = useRef(false); // 断线重连空档的 lastActiveAt 报错：每次页面加载只记一条
  const onExtensionError = (msg: string) => {
    if (extErrLogged.current || !id) return;
    extErrLogged.current = true;
    api.clientLog(id, `忽略浏览器扩展注入脚本的报错（非桌面故障，不重连）：${msg.slice(0, 160)}`);
  };

  const inst = instances.find((i) => i.id === id);
  useDocTitle(inst?.name || '');
  const profile = appProfile(inst?.appType); // 按应用类型显示正确文案（微信/Chromium…）
  const appLabel = profile.label;
  // 进入实例时，共享列表可能尚未同步（管理页新建/安装后），先按"探测中"显示加载态，
  // 等列表刷新到该实例或超时后再判定是否真的不存在，避免从管理页跳转时误报"实例不存在"。
  const [probing, setProbing] = useState(true);
  const offline = inst ? inst.runtime !== 'running' : false;
  const installed = !!inst && inst.wechat.installed && inst.wechat.phase !== 'downloading';
  const showVnc = !!inst && !offline && installed;
  const busy = !!inst && ['downloading', 'extracting', 'installing'].includes(inst.wechat.phase);
  const errored = !!inst && !busy && inst.wechat.phase === 'error';

  // 在本页直接安装 / 上传安装包（管理员）：点了之后到状态真正推进（进入安装中 / 出错 / 装好）之前，
  // 先显示「正在准备…」，免得按钮还在、看着像没点上。记下点击时的阶段，阶段变了才算推进。
  const [acting, setActing] = useState<{ text: string; pct?: number } | null>(null);
  const actFrom = useRef<string | null>(null);
  const pkgInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!acting || actFrom.current === null) return;
    if (installed || (inst && inst.wechat.phase !== actFrom.current)) {
      actFrom.current = null;
      setActing(null);
    }
  }, [acting, installed, inst?.wechat.phase]);
  useEffect(() => {
    if (!acting || actFrom.current === null) return; // 上传途中不算（大文件慢网可能传很久）
    const t = window.setTimeout(() => setActing(null), 20000); // 兜底：状态迟迟不变也别一直挂着
    return () => window.clearTimeout(t);
  }, [acting]);
  useEffect(() => {
    setActing(null);
    actFrom.current = null;
  }, [id]);

  // Esc 关掉右上角的浮动面板（弹着确认框时让给确认框）
  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.modal-mask')) setPanel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel]);

  // 切换实例时重置内嵌态
  useEffect(() => {
    setFrameLoaded(false);
    setLoadStuck(false);
    setPanel(null);
    setFiles([]);
    setClipText('');
    setImeText('');
    setProbing(true);
    recovering.current = false;
  }, [id]);

  // 桌面久未加载出来 → 判为"无响应"，把无限转圈换成可操作的重试/重启，不让用户干等。
  // （实测容器跑久了会 I/O/服务 stall，进程没死、显示在线，但读不出 VNC 文件而永远连接中。）
  useEffect(() => {
    setLoadStuck(false);
    if (!showVnc || frameLoaded) return;
    const t = window.setTimeout(() => setLoadStuck(true), 12000);
    return () => window.clearTimeout(t);
  }, [showVnc, frameLoaded, id]);

  // 探测态收敛：找到实例即结束；否则给共享列表一点刷新时间（AppShell 已在导航时拉取），超时仍无则判定不存在。
  useEffect(() => {
    if (inst) {
      setProbing(false);
      return;
    }
    if (!probing) return;
    const t = window.setTimeout(() => setProbing(false), 2500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inst, probing, id]);

  // 实例未就绪（启动中 / 安装中 / 上下文状态未刷新）时，每 3s 拉取最新状态：
  // 就绪后自动进入桌面，无需手动刷新（修复"安装完进度 100% 仍提示无实例"）。
  useEffect(() => {
    if (showVnc || !id) return;
    const t = window.setInterval(() => {
      if (!document.hidden) reload();
    }, 3000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showVnc, id]);

  // 文件拖到窗口 → 弹出落区（覆盖 iframe 接住 drop）
  useEffect(() => {
    if (!showVnc) return;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDropWin = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDropWin);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDropWin);
    };
  }, [showVnc]);

  // 粘贴图片 → 上传到桌面（issue #91）：截图不能经 VNC 剪贴板送进容器（RFB 剪贴板仅文本），故把粘贴的
  // 图片存成桌面文件，用户在应用里「+/文件」取用即可。焦点在输入框/文本域时不拦截（让原生粘贴文字生效）。
  useEffect(() => {
    if (!showVnc) return;
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const imgs: File[] = [];
      for (const it of Array.from(items)) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) {
            const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
            imgs.push(new File([f], `粘贴图片-${Date.now()}.${ext}`, { type: f.type }));
          }
        }
      }
      if (imgs.length) {
        e.preventDefault();
        uploadFiles(imgs); // 内部会 toast 上传结果
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showVnc]);

  // 控制权（交互驱动的心跳软锁）：每 3s 只读轮询当前操作者；超 TTL 自动释放。
  useEffect(() => {
    if (!showVnc || !id) {
      setControl(null);
      return;
    }
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const r = await api.controlStatus(id);
        if (!alive) return;
        setControl(r);
        if (!r.free && !r.mine) frameRef.current?.blur(); // 只读：移开键盘焦点
      } catch {
        /* ignore */
      }
    };
    poll();
    const t = window.setInterval(poll, 3000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [showVnc, id]);

  // 续约控制权，节流 2.5s。桌面画面里的真实操作、底部输入条里打字都算（输入条不经过画面，此前不续约，
  // 连着打一会儿字控制权就被别人拿走）。空闲不操作则超时自动释放。
  const beat = useCallback(async () => {
    if (!id) return;
    const now = Date.now();
    if (now - lastBeat.current < 2500) return;
    lastBeat.current = now;
    try {
      const r = await api.controlBeat(id);
      setControl({ free: false, mine: r.mine, holder: r.holder });
    } catch {
      /* ignore */
    }
  }, [id]);
  const readOnly = !!control && !control.free && !control.mine; // 别人在操作：只读

  // 用户在 VNC 内真实操作（鼠标/键盘/滚轮）时续约控制权（同源 iframe 可监听）。
  // 只读用户的操作已被遮罩拦截/失焦，不会误续约。
  useEffect(() => {
    if (!showVnc || !id || !frameLoaded) return;
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    const onInteract = () => void beat();
    const evs = ['mousedown', 'keydown', 'wheel'] as const;
    try {
      evs.forEach((e) => win.addEventListener(e, onInteract, { capture: true, passive: true }));
    } catch {
      return;
    }
    return () => {
      try {
        evs.forEach((e) => win.removeEventListener(e, onInteract, { capture: true } as any));
      } catch {
        /* ignore */
      }
    };
  }, [showVnc, id, frameLoaded, frameGen, beat]);

  // 进入/重连桌面前，按输入模式设 KasmVNC 的 enable_ime（iframe 同源共享 localStorage，加载前设好即生效）。
  //   无感（seamless）：enable_ime=true，启用 noVNC 合成 textarea；中文 keysym 已被容器补丁抑制，
  //     成品由「无感输入」钩子经 xdotool 转发（见 installSeamlessIme）。
  //   转发（forward）：enable_ime=false，VNC 直接打字纯 keysym（英文/数字正常）；中文走底部输入条。
  useEffect(() => {
    try {
      window.localStorage.setItem('enable_ime', inputMode === 'seamless' ? 'true' : 'false');
    } catch {
      /* 隐私模式等禁用 localStorage：忽略 */
    }
  }, [id, inputMode]);

  // 本机图片粘贴桥（issue #91）：两种输入模式都生效
  const pastingImage = useRef(false);
  useEffect(() => {
    if (!showVnc || !frameLoaded || !id) return;
    const win = frameRef.current?.contentWindow;
    const doc = frameRef.current?.contentDocument;
    if (!win || !doc) return;
    return installPasteBridge(win, doc, window, {
      onImage: async (file) => {
        if (pastingImage.current) return;
        pastingImage.current = true;
        toast('正在粘贴本机图片…', 'ok');
        try {
          await api.pasteImage(id, file);
        } catch (e: any) {
          toast(e?.message || '粘贴图片失败：请确认实例已「升级实例」', 'error');
        } finally {
          pastingImage.current = false;
        }
      },
      // 粘贴容器剪贴板：失败时静默（与以前按键直通 noVNC 一样，不额外打扰）
      onPlainPaste: () => void api.keyInInstance(id, 'ctrl+v').catch(() => {}),
      // 本机剪贴板的文字比容器的新：直接贴本机的
      onLocalText: (text, localIsFresh) => {
        if (!shouldPasteLocal(clip.current, text, localIsFresh, frameRef.current?.contentDocument)) return false;
        void api.pasteText(id, text).catch((e: any) => toast(e?.message || '粘贴失败', 'error'));
        return true;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showVnc, frameLoaded, frameGen, id]);

  // 剪贴板协调（见 installClipboardGuard）：两种输入模式都生效
  useEffect(() => {
    if (!showVnc || !frameLoaded || !id) return;
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    try {
      return installClipboardGuard(win, clip.current);
    } catch {
      return;
    }
  }, [showVnc, frameLoaded, frameGen, id]);

  // 无感模式：往同源 iframe 装「中文转发 + 有序队列」钩子；切回转发/重连/卸载时自动移除。
  useEffect(() => {
    if (inputMode !== 'seamless' || !showVnc || !frameLoaded || !id) return;
    const win = frameRef.current?.contentWindow;
    const doc = frameRef.current?.contentDocument;
    if (!win || !doc) return;
    let lastFailToast = 0;
    const cleanup = installSeamlessIme(
      win,
      doc,
      id,
      (t) => noteTyped(clip.current, t),
      (e) => {
        if (Date.now() - lastFailToast < 5000) return;
        lastFailToast = Date.now();
        const msg = e?.message || '';
        // 别人持有控制权（409）时直接说清楚；其余是网络 / 实例问题
        toast(/正在操作/.test(msg) ? msg : `刚输入的文字没能发送到桌面：${msg || '网络或实例暂时不可用'}，请重试`, 'error');
      },
    );
    return cleanup;
  }, [inputMode, showVnc, frameLoaded, frameGen, id]);

  // 音频/麦克风桥接：实例就绪即自动连接 kclient 的音频流（扬声器恒开，无需手动找工具条）；
  // 仅当本实例处于焦点（标签页可见且窗口聚焦）时出声/收音，失焦立即断开，避免多实例多端串音。
  useEffect(() => {
    if (!showVnc || !id || !soundOn) return; // 声音默认关：未开则完全不连音频桥（回到 1.1.7 无音频的连接行为）
    const audio = new VncAudio(id, micOn);
    audioRef.current = audio;
    audio.connect().catch(() => {}); // 加载 socket.io 失败：本次无声，再开一次「声音」会重新加载
    const isFocused = () => !document.hidden && document.hasFocus();
    const sync = () => audio.setActive(isFocused());
    sync(); // 初始：若当前已聚焦则立即开声
    // 关窗/关标签页时彻底断开音频桥（issue #82）：React effect 的清理在直接关闭窗口时不一定执行，
    // 残留的 audio socket.io（开了麦克风时还占着 getUserMedia）会留在实例上，下次再进与新连接并存，
    // 把实例顶到"需重启"。pagehide 在页面真正被丢弃（非进 bfcache）时同步断开，避免该残留。
    const onPageHide = (e: PageTransitionEvent) => {
      if (!e.persisted) audio.destroy();
    };
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      window.removeEventListener('pagehide', onPageHide);
      audio.destroy();
      audioRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showVnc, id, soundOn]);

  // 让「点桌面画面」也能解挂起音频出声：浏览器自动播放策略会挂起 AudioContext，需用户手势恢复；但音频桥
  // 的手势监听绑在父窗口上，而用户点的是同源 iframe 内的桌面，事件不冒泡到父窗口 → 故"点画面没用、得重开声音
  // 开关"。这里在 iframe 内补一个手势监听，点桌面/按键即转调 resumePlayback() 恢复播放。
  useEffect(() => {
    if (!showVnc || !id || !soundOn || !frameLoaded) return;
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    const onGesture = () => audioRef.current?.resumePlayback();
    try {
      win.addEventListener('pointerdown', onGesture, true);
      win.addEventListener('keydown', onGesture, true);
    } catch {
      return;
    }
    return () => {
      try {
        win.removeEventListener('pointerdown', onGesture, true);
        win.removeEventListener('keydown', onGesture, true);
      } catch {
        /* ignore */
      }
    };
  }, [showVnc, id, soundOn, frameLoaded, frameGen]);

  // 致命崩溃自愈：仅在 KasmVNC 真的弹出致命错误浮层时触发——整页重载是干净重连的唯一可靠路径
  // （旧 ws 已死，重载后干净重连；与 setMode/restartInstance 同理，不会引发新旧 ws 并存卡死 Xvnc）。
  // 与本会话曾撤掉的"激进自动重连"本质不同：那是连接态一抖就重连导致 churn；这里只在【确认致命崩溃】
  // 时重载一次，且 5min 内限 4 次、超限转手动恢复浮层，绝不死循环。
  const recoverFromFatal = (msg: string) => {
    if (recovering.current || !id) return;
    recovering.current = true;
    if (allowAutoRecover(id)) {
      api.clientLog(id, `KasmVNC 致命错误，自动重连：${msg}`);
      toast('桌面连接异常，正在自动重连…', 'error');
      window.setTimeout(() => window.location.reload(), 800);
    } else {
      api.clientLog(id, `KasmVNC 反复致命错误，停止自动重连、转手动恢复：${msg}`);
      setFrameLoaded(false);
      setLoadStuck(true); // 露出"桌面无响应"浮层，由用户「重新连接/重启实例」
      recovering.current = false;
    }
  };

  // VNC 连接态监测 + 致命崩溃检测。
  // 连接态：把 kasmweb 在 iframe <html> 上的连接态 class 变化回传 [client] 日志，用于排查（仅记录、不因抖动重连）。
  // 致命崩溃：每 3s 检查 KasmVNC 致命错误浮层是否弹出（如长时间空闲后的 'lastActiveAt' 崩溃），弹出即自愈重连。
  useEffect(() => {
    if (!showVnc || !frameLoaded || !id) return;
    let lastState = '';
    const t = window.setInterval(() => {
      const doc = frameRef.current?.contentDocument;
      const fatal = fatalErrorMsg(doc, onExtensionError);
      if (fatal) {
        recoverFromFatal(fatal);
        return;
      }
      let state = '';
      try {
        const c = doc?.documentElement?.classList;
        if (!c) return;
        state = c.contains('noVNC_connected')
          ? 'connected'
          : c.contains('noVNC_reconnecting')
            ? 'reconnecting'
            : c.contains('noVNC_connecting')
              ? 'connecting'
              : c.contains('noVNC_disconnected')
                ? 'disconnected'
                : 'other';
      } catch {
        return; // 理论上同源；偶发不可读则跳过本次
      }
      if (state && state !== lastState) {
        lastState = state;
        api.clientLog(id, `VNC状态→${state}`);
      }
    }, 3000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showVnc, frameLoaded, id]);

  // 更快的致命崩溃捕获：直接监听同源 iframe window 的 'error'（KasmVNC 报 Uncaught 时同步触发，比 3s 轮询快），
  // 但仅在延迟复核确认致命错误浮层真的弹出后才重连——排除良性报错，杜绝误重载。
  // 用捕获阶段注册：事件的目标就是 window，捕获监听先于 KasmVNC 的错误处理器执行，扩展报错在这里就截下，不弹浮层。
  useEffect(() => {
    if (!showVnc || !frameLoaded || !id) return;
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    const onErr = (ev: Event) => {
      if (ev.type === 'error' && ev.target !== win) return; // 捕获阶段也会收到 img 等资源加载失败，与崩溃无关
      const e = ev as Partial<ErrorEvent> & Partial<PromiseRejectionEvent>;
      if (isExtensionError(ev)) {
        ev.stopImmediatePropagation();
        onExtensionError(String(e.message || e.reason?.message || e.reason || ''));
        return;
      }
      if (isReconnectGapError(String(e.message || e.error?.message || ''), frameRef.current?.contentDocument)) {
        ev.stopImmediatePropagation(); // 断线重连空档的已知报错：不弹浮层，让 noVNC 自己连回
        if (!gapLogged.current) {
          gapLogged.current = true;
          api.clientLog(id, 'VNC 断线，noVNC 自带重连中（忽略 KasmVNC 重连空档的 lastActiveAt 报错，不整页重载）');
        }
        return;
      }
      window.setTimeout(() => {
        const msg = fatalErrorMsg(frameRef.current?.contentDocument, onExtensionError);
        if (msg) recoverFromFatal(msg);
      }, 400);
    };
    try {
      win.addEventListener('error', onErr, true);
      // KasmVNC 对 Promise 未处理拒绝也会弹同一个浮层（扩展报错多走这条），一并快速处理，免得浮层挂满 3s 轮询间隔
      win.addEventListener('unhandledrejection', onErr, true);
    } catch {
      return;
    }
    return () => {
      try {
        win.removeEventListener('error', onErr, true);
        win.removeEventListener('unhandledrejection', onErr, true);
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showVnc, frameLoaded, frameGen, id]);

  if (!id) {
    nav('/', { replace: true });
    return null;
  }

  const refreshFiles = async () => {
    try {
      const { files } = await api.listFiles(id);
      setFiles(files);
    } catch {
      /* ignore */
    }
  };

  // 逐个上传；上传途中再拖进 / 粘贴 / 选择的文件排进队列，由正在跑的这一轮接着传（此前会另起一轮并发上传）
  const uploadFiles = async (list: FileList | File[]) => {
    uploadQueue.current.push(...Array.from(list));
    if (uploadBusy.current || !uploadQueue.current.length) return;
    uploadBusy.current = true;
    setUploading(true);
    let ok = 0;
    let done = 0;
    try {
      while (uploadQueue.current.length) {
        const f = uploadQueue.current.shift()!;
        const total = done + 1 + uploadQueue.current.length;
        const prefix = total > 1 ? `(${done + 1}/${total}) ` : '';
        setUploadPct(`${prefix}0%`);
        try {
          await api.uploadFile(id, f, (loaded, size) =>
            setUploadPct(loaded < size ? `${prefix}${Math.floor((loaded / size) * 100)}%` : `${prefix}写入中`),
          );
          ok++;
        } catch (e: any) {
          toast(`${f.name}: ${e.message || '上传失败'}`, 'error');
        }
        done++;
      }
    } finally {
      uploadBusy.current = false;
      setUploading(false);
      setUploadPct('');
    }
    if (ok) {
      toast(`已上传 ${ok} 个文件到桌面，应用里可直接取用`, 'ok');
      refreshFiles();
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    dragDepth.current = 0;
    if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files);
  };

  const delFile = async (name: string) => {
    if (!(await confirm({ title: `删除「${name}」？`, body: '将从桌面（~/Desktop）移除该文件。', danger: true, confirmText: '删除' }))) return;
    try {
      await api.deleteFile(id, name);
      toast('已删除', 'ok');
      refreshFiles();
    } catch (e: any) {
      toast(e.message || '删除失败', 'error');
    }
  };

  // ---------- 桌面壁纸 ----------
  const refreshBgList = async () => {
    if (!id) return;
    try { const r = await api.listBackgrounds(id); setBgList(r.backgrounds); } catch { /* ignore */ }
    try { const r = await api.getCurrentBackground(id); setCurrentBg(r.background); } catch { /* ignore */ }
  };

  const uploadBg = async () => {
    const input = bgInput.current;
    if (!input?.files?.length) return;
    setBgUploading(true);
    for (const f of Array.from(input.files)) {
      try {
        await api.uploadBackground(id, f.name, f);
        toast(`壁纸「${f.name}」已上传`, 'ok');
      } catch (e: any) { toast(e.message || '上传失败', 'error'); }
    }
    setBgUploading(false);
    input.value = '';
    refreshBgList();
  };

  const applyBg = async (name: string) => {
    try {
      await api.applyBackground(id, name);
      setCurrentBg(name);
      toast('壁纸已应用', 'ok');
    } catch (e: any) { toast(e.message || '应用失败', 'error'); }
  };

  const clearBg = async () => {
    try {
      await api.clearBackground(id);
      setCurrentBg('');
      toast('已恢复默认黑屏', 'ok');
    } catch (e: any) { toast(e.message || '清除失败', 'error'); }
  };

  const deleteBg = async (name: string) => {
    if (!(await confirm({ title: `删除壁纸「${name}」？`, danger: true, confirmText: '删除' }))) return;
    try {
      await api.deleteBackground(id, name);
      toast('已删除', 'ok');
      refreshBgList();
    } catch (e: any) { toast(e.message || '删除失败', 'error'); }
  };

  // ---------- 字体管理 ----------
  const refreshFontList = async () => {
    if (!id) return;
    try { const r = await api.listFonts(id); setFontList(r.fonts); } catch { /* ignore */ }
    try { const r = await api.getCurrentFont(id); setCurrentFont(r.fontFile); } catch { /* ignore */ }
  };

  const uploadFont = async () => {
    const input = fontInput.current;
    if (!input?.files?.length) return;
    setFontUploading(true);
    for (const f of Array.from(input.files)) {
      try {
        await api.uploadFont(id, f.name, f);
        toast(`字体「${f.name}」已安装`, 'ok');
      } catch (e: any) { toast(e.message || '上传失败', 'error'); }
    }
    setFontUploading(false);
    input.value = '';
    refreshFontList();
  };

  const deleteFont = async (name: string) => {
    if (!(await confirm({ title: `删除字体「${name}」？`, danger: true, confirmText: '删除' }))) return;
    try {
      await api.deleteFont(id, name);
      toast('已删除，字体缓存已刷新', 'ok');
      refreshFontList();
    } catch (e: any) { toast(e.message || '删除失败', 'error'); }
  };

  const applyUserFont = async (name: string) => {
    try {
      await api.applyFont(id, name);
      setCurrentFont(name);
      toast('字体已应用，重启微信后完全生效', 'ok');
    } catch (e: any) { toast(e.message || '应用失败', 'error'); }
  };

  const resetFontDefault = async () => {
    try {
      await api.resetFontDefault(id);
      setCurrentFont('');
      toast('已恢复系统默认字体（文泉驿），重启微信后生效', 'ok');
    } catch (e: any) { toast(e.message || '重置失败', 'error'); }
  };

  // 同源 iframe：把键盘焦点交给 VNC，帮助宿主机输入法把合成的字送进去
  const focusFrame = () => {
    try {
      frameRef.current?.focus();
      frameRef.current?.contentWindow?.focus();
      const ki = frameRef.current?.contentDocument?.getElementById('noVNC_keyboardinput') as HTMLElement | null;
      ki?.focus();
    } catch {
      /* 跨域兜底（正常同源不会到这） */
    }
  };

  // 桌面加载后给 noVNC 原生控制条注入"实心可见"样式：原生背景近纯黑半透明，叠在深色/黑屏上看不见。
  // 注入后，用 KasmVNC 自带的左侧边缘手柄拉出控制条（音频/剪贴板/键盘/全屏等）时即可见。iframe 同源可直接访问。
  const injectVncStyle = () => {
    try {
      const doc = frameRef.current?.contentDocument;
      if (!doc || doc.getElementById('woc-vnc-style')) return;
      const st = doc.createElement('style');
      st.id = 'woc-vnc-style';
      st.textContent =
        '#noVNC_control_bar_anchor{z-index:2147483647!important;}' +
        '#noVNC_control_bar{background:rgba(18,22,30,.96)!important;border:1px solid rgba(255,255,255,.55)!important;box-shadow:0 0 24px rgba(0,0,0,.55)!important;}' +
        '#noVNC_control_bar_handle{opacity:1!important;background:rgba(18,22,30,.96)!important;border:1px solid rgba(255,255,255,.5)!important;}' +
        // macOS 中文输入法需要目标元素有非零尺寸才能激活；KasmVNC 默认 0x0 导致无法切换输入法
        '#noVNC_keyboardinput{width:1px!important;height:1px!important;opacity:0!important;overflow:hidden!important;}';
      (doc.head || doc.documentElement).appendChild(st);
    } catch {
      /* 同源正常不会到这 */
    }
  };

  // 跨设备剪贴板（文本）：通过同源 iframe 直接喂给 KasmVNC 自带的剪贴板 textarea 并触发其发送逻辑
  // （内部走 RFB.clipboardPasteFrom → clientCutText）。不依赖浏览器异步剪贴板 API，故 http/局域网 IP 下也可用，
  // 规避了"非安全上下文禁用 navigator.clipboard 导致粘贴失败"的问题。文本会进入容器系统剪贴板，
  // 在微信输入框按 Ctrl+V 即可粘贴。
  const pushClipboardToRemote = (text: string): boolean => {
    try {
      const doc = frameRef.current?.contentDocument;
      const ta = doc?.getElementById('noVNC_clipboard_text') as HTMLTextAreaElement | null;
      if (!doc || !ta) return false;
      ta.value = text;
      ta.dispatchEvent(new (frameRef.current!.contentWindow as any).Event('change', { bubbles: true }));
      clip.current.remoteText = text;
      clip.current.remoteNewer = false;
      return true;
    } catch {
      return false;
    }
  };

  const sendClip = () => {
    const t = clipText;
    if (!t) {
      toast('请先输入要发送的文本', 'error');
      return;
    }
    if (pushClipboardToRemote(t)) {
      toast('已发送到容器剪贴板，请在应用输入框按 Ctrl+V 粘贴', 'ok');
    } else {
      toast('发送失败：桌面尚未连接', 'error');
    }
  };

  // 中文输入条发送：把本框文本经 xclip+xdotool 直接粘进微信当前聚焦的输入框（绕开 VNC IME）。
  // 在面板的真实 textarea 里用原生输入法打字，100% 可靠，不依赖 VNC 的 enable_ime / 合成事件。
  const pressKey = async (key: string) => {
    if (!id) return;
    try {
      await api.keyInInstance(id, key);
    } catch (e: any) {
      toast(e?.message || '按键失败：请确认实例已「升级实例」（镜像含 xdotool）', 'error');
    }
  };

  const sendImeText = async () => {
    const t = imeText;
    if (!t.trim() || !id) return;
    setImeSending(true);
    try {
      noteTyped(clip.current, t);
      await api.typeInInstance(id, t);
      // 打完补一个回车把消息发出去（issue #81）；可由「自动回车」开关关掉（issue #125），
      // 关掉时只把文字填进应用输入框，发不发由用户自己按。焦点【始终留在本输入条】。
      // 切勿在转发模式把焦点切回虚拟机——那等于开了"无感输入"，用户接着打的拼音会以原始 keysym 直灌微信
      // 输入框（出现 "nniih'h你好啊" 这种串码）。下一条仍在本条用本机输入法安全地打。
      if (autoEnter) await api.keyInInstance(id, 'Return');
      setImeText('');
    } catch (e: any) {
      toast(e?.message || '发送失败：请确认实例已「升级实例」（镜像含 xclip/xdotool）', 'error');
    } finally {
      setImeSending(false);
    }
  };

  // 读取容器（微信侧）当前剪贴板内容到本框，便于把容器内复制的文字带回本地
  const pullClipboardFromRemote = () => {
    try {
      const doc = frameRef.current?.contentDocument;
      const ta = doc?.getElementById('noVNC_clipboard_text') as HTMLTextAreaElement | null;
      if (ta) {
        setClipText(ta.value || '');
        toast('已读取容器剪贴板', 'ok');
      } else {
        toast('读取失败：桌面尚未连接', 'error');
      }
    } catch {
      toast('读取失败', 'error');
    }
  };

  const restartInstance = async () => {
    const ok = await confirm({
      title: '重启该实例？',
      body: `会重建容器（数据保留），${appLabel}重新启动，约十几秒；用于修复卡死/最小化丢失等。`,
      confirmText: '重启',
    });
    if (!ok) return;
    try {
      await api.instanceRestart(id);
      toast('已重启，正在重连…', 'ok');
      // 整页重载干净重连：旧 ws 指向已销毁的旧容器，重载后连到全新容器。
      // 不能页内 bump iframe 重挂——新旧 ws 并存会概率性把 Xvnc 卡死（与 setMode 同理，见上方注释）。
      // 稍等让新容器的 KasmVNC 起来；noVNC autoconnect+reconnect 会在就绪后自动连上。
      setTimeout(() => window.location.reload(), 1200);
    } catch (e: any) {
      toast(e.message || '重启失败', 'error');
    }
  };

  const takeControl = async () => {
    try {
      const r = await api.controlTake(id);
      setControl({ free: false, mine: r.mine, holder: r.holder });
      lastBeat.current = Date.now();
      focusFrame();
    } catch (e: any) {
      toast(e.message || '接管失败', 'error');
    }
  };

  const start = async () => {
    setStarting(true);
    try {
      await api.instanceStart(id);
      toast('实例已启动', 'ok');
      await reload();
    } catch (e: any) {
      toast(e.message || '启动失败', 'error');
    } finally {
      setStarting(false);
    }
  };

  const togglePanel = (p: 'files' | 'clip' | 'settings') => {
    if (panel === p) {
      setPanel(null);
      return;
    }
    setPanel(p);
    if (p === 'files') refreshFiles();
    if (p === 'settings') {
      refreshBgList();
      refreshFontList();
    }
  };

  const installApp = async () => {
    actFrom.current = inst?.wechat.phase ?? null;
    setActing({ text: '正在准备…' });
    try {
      await api.instanceWechatInstall(id);
      toast(`已开始下载${appLabel}`, 'ok');
      await reload();
    } catch (e: any) {
      toast(e.message || '操作失败', 'error');
      actFrom.current = null;
      setActing(null);
    }
  };

  // 上传安装包（QQ，#153）：腾讯拒绝下载时，传自己在电脑上下好的 .deb，传完服务端直接安装
  const uploadPackage = async (file: File) => {
    actFrom.current = null; // 上传期间不随阶段变化清掉进度
    setActing({ text: '正在上传安装包', pct: 0 });
    try {
      await api.uploadAppPackage(id, file, (loaded, size) =>
        setActing(loaded < size ? { text: '正在上传安装包', pct: Math.floor((loaded / size) * 100) } : { text: '安装包写入中…' }),
      );
      toast('安装包已上传，正在安装', 'ok');
      actFrom.current = inst?.wechat.phase ?? null;
      setActing({ text: '正在准备安装…' });
      await reload();
    } catch (e: any) {
      toast(e.message || '上传失败', 'error');
      setActing(null);
    }
  };

  const title = inst?.name || '实例';
  const st = inst ? statusOf(inst) : null;
  // 安装进度：本页刚点了安装 / 正在上传安装包时用本地的，否则用实例上报的
  const progText = acting ? acting.text : inst?.wechat.message || '请稍候…';
  const progPct = acting ? (acting.pct ?? -1) : (inst?.wechat.percent ?? -1);
  const openLogs = () => window.open(api.instanceLogsUrl(id), '_blank');

  // 右上角的更多菜单：重新连接人人可用；桌面设置 / 重启 / 日志只给管理员
  const moreItems: MenuEntry[] = [
    { label: '重新连接', icon: 'refresh', onClick: () => window.location.reload(), hint: '画面卡住、不刷新时用：整页重新连接桌面' },
    isAdmin && 'sep',
    isAdmin && { label: '桌面设置', icon: 'palette', onClick: () => togglePanel('settings'), hint: '壁纸、字体' },
    isAdmin && { label: '重启实例', icon: 'restart', onClick: restartInstance, hint: '修复卡死、窗口丢失，聊天记录保留' },
    isAdmin && { label: '查看日志', icon: 'logs', onClick: openLogs },
  ];

  return (
    <div className="ws-page">
      <header className={'ws-head' + (showVnc ? ' has-actions' : '')}>
        <button className="icon-btn ws-menu" onClick={onOpenMenu} aria-label="打开菜单">
          <Icon name="menu" size={21} />
        </button>
        <span className="ws-title">
          {inst && (
            <span className="ws-title-icon">
              <InstanceIcon icon={inst.icon} appType={inst.appType} size={26} radius={8} />
            </span>
          )}
          <span className="ws-title-text">{title}</span>
          {inst && !showVnc && st && <span className={'tag ' + st.tag}>{st.text}</span>}
        </span>
        {showVnc && (
          // 操作按钮收进可横向滑动的容器：手机宽度放不下时在容器内滑动，而不是整排挤出屏幕。
          // 宽屏显示「图标 + 短标签」，窄屏只留图标；开关类（声音 / 麦克风）开着时是绿底
          <div className="ws-actions">
            <button
              className={'ws-action' + (panel === 'files' ? ' open' : '')}
              title="文件传输：上传到桌面、从桌面下载"
              aria-pressed={panel === 'files'}
              onClick={() => togglePanel('files')}
            >
              <Icon name="folder" size={18} />
              <span className="ws-action-label">文件</span>
              {uploading && <span className="ws-action-badge">{uploadPct}</span>}
            </button>
            <button
              className={'ws-action' + (panel === 'clip' ? ' open' : '')}
              title="文本剪贴板：在本机和桌面之间传文字"
              aria-pressed={panel === 'clip'}
              onClick={() => togglePanel('clip')}
            >
              <Icon name="clipboard" size={18} />
              <span className="ws-action-label">剪贴板</span>
            </button>
            <span className="ws-sep" />
            <MenuButton
              className="ws-action"
              icon={inputMode === 'seamless' ? 'typing' : 'keyboard'}
              text={inputMode === 'seamless' ? '无感输入' : '转发输入'}
              textClassName="ws-action-label"
              label={`中文输入方式：${inputMode === 'seamless' ? '无感' : '转发'}`}
              items={[
                { section: '中文输入方式（切换会重新连接桌面）' },
                {
                  label: '转发输入',
                  desc: '在底部输入条打中文，回车送进应用。最稳，推荐',
                  icon: 'keyboard',
                  checked: inputMode === 'forward',
                  onClick: () => inputMode !== 'forward' && setMode('forward'),
                },
                {
                  label: '无感输入',
                  desc: '直接在应用的输入框里打中文，和本机一样',
                  icon: 'typing',
                  checked: inputMode === 'seamless',
                  onClick: () => inputMode !== 'seamless' && setMode('seamless'),
                },
              ]}
            />
            <button
              className={'ws-action' + (soundOn ? ' on' : '')}
              aria-pressed={soundOn}
              title={soundOn ? '声音已开。点击关闭（关掉能少一条到实例的连接，更稳）' : '声音已关。点击开启，再在画面上点一下就能出声'}
              onClick={toggleSound}
            >
              <Icon name={soundOn ? 'volume' : 'volumeOff'} size={18} />
              <span className="ws-action-label">声音</span>
            </button>
            {soundOn && (
              <button
                className={'ws-action' + (micOn ? ' on' : '')}
                aria-pressed={micOn}
                title={
                  micOn
                    ? '麦克风已开：占用本机麦克风（AirPods 等可能被切到低音质通话模式）。点击关闭'
                    : '麦克风已关：不占用麦克风，AirPods 保持高音质。需要语音通话时点此开启'
                }
                onClick={toggleMic}
              >
                <Icon name={micOn ? 'mic' : 'micOff'} size={18} />
                <span className="ws-action-label">麦克风</span>
              </button>
            )}
            <span className="ws-sep" />
            <MenuButton className="ws-action" label="更多操作" items={moreItems} />
          </div>
        )}
      </header>

      {/* —— 各种态 —— */}
      {!loaded || (probing && !inst) ? (
        <div className="iv-stage iv-center">
          <Spinner />
        </div>
      ) : !inst ? (
        <div className="iv-stage iv-center">
          <div className="card iv-notice">
            <div className="iv-notice-glyph">
              <Icon name="lock" size={26} />
            </div>
            <div className="iv-notice-title">打不开这个实例</div>
            <div className="iv-notice-sub">实例不存在，或者你没有访问它的权限。</div>
            <div className="iv-notice-actions">
              <button className="btn btn-primary iv-notice-btn" onClick={() => nav('/')}>
                <Icon name="home" size={17} />
                返回主页
              </button>
            </div>
          </div>
        </div>
      ) : offline ? (
        <StateCard inst={inst} tone="off" title={inst.runtime === 'missing' ? '容器还没创建' : '实例已停止'}>
          <div className="iv-notice-sub">
            {!isAdmin
              ? '需要管理员先在「管理」里启动它。'
              : inst.runtime === 'missing'
                ? '点下面的按钮创建容器并启动，数据卷里的聊天记录会接着用。'
                : '启动后就能接着用，聊天记录和登录状态都还在。'}
          </div>
          {isAdmin && (
            <>
              <div className="iv-notice-actions">
                <button className="btn btn-primary iv-notice-btn" disabled={starting} onClick={start}>
                  {starting ? <Spinner size="sm" /> : <Icon name="power" size={17} />}
                  {starting ? '启动中…' : inst.runtime === 'missing' ? '创建并启动' : '启动实例'}
                </button>
              </div>
              <button className="btn-text iv-notice-foot" onClick={openLogs}>
                <Icon name="logs" size={15} />
                查看日志
              </button>
            </>
          )}
        </StateCard>
      ) : busy || acting ? (
        <StateCard inst={inst} tone="busy" title={`正在安装${appLabel}`}>
          <div className="iv-notice-sub">装好后会自动进入桌面，不用刷新页面。</div>
          <div className="iv-notice-progress" aria-live="polite">
            <div className="iv-notice-progress-text">
              <span>{progText}</span>
              {progPct >= 0 && <span>{progPct}%</span>}
            </div>
            <div className="wx-progress">
              <div className={'wx-progress-bar' + (progPct < 0 ? ' indeterminate' : '')} style={progPct >= 0 ? { width: `${progPct}%` } : undefined} />
            </div>
          </div>
          {isAdmin && (
            <button className="btn-text iv-notice-foot" onClick={openLogs}>
              <Icon name="logs" size={15} />
              查看日志
            </button>
          )}
        </StateCard>
      ) : !installed ? (
        <StateCard inst={inst} tone={errored ? 'err' : 'warn'} title={errored ? `${appLabel}安装失败` : `${appLabel}还没安装`}>
          {errored ? (
            <div className="iv-notice-err">{inst.wechat.message || '安装失败，可以重试'}</div>
          ) : (
            <div className="iv-notice-sub">
              {isAdmin ? `实例已经就绪，下载安装${appLabel}后就能使用。` : `需要管理员先在「管理」里安装${appLabel}。`}
            </div>
          )}
          {isAdmin ? (
            <>
              <div className="iv-notice-actions">
                <button className="btn btn-primary iv-notice-btn" onClick={installApp}>
                  <Icon name={errored ? 'refresh' : 'download'} size={17} />
                  {errored ? '重试安装' : `下载安装${appLabel}`}
                </button>
                {profile.packageUpload && (
                  <button className="btn iv-notice-btn" onClick={() => pkgInput.current?.click()}>
                    <Icon name="package" size={17} />
                    上传安装包
                  </button>
                )}
              </div>
              {profile.packageUpload && !errored && (
                <div className="iv-notice-hint">下载被腾讯拒绝时，可以在电脑浏览器打开 im.qq.com/linuxqq 下载 Linux 版的 .deb，再点「上传安装包」。</div>
              )}
              <button className="btn-text iv-notice-foot" onClick={openLogs}>
                <Icon name="logs" size={15} />
                查看日志
              </button>
              <input
                ref={pkgInput}
                type="file"
                accept=".deb"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) uploadPackage(f);
                }}
              />
            </>
          ) : (
            errored && <div className="iv-notice-sub">请联系管理员重试安装。</div>
          )}
        </StateCard>
      ) : (
        <div className="iv-stage iv-stage--vnc">
          <div className="iv-canvas">
          {/* 切勿给本 iframe 加 key（如 key={id}）：那会让切换实例时 React 重挂 iframe（先删旧元素再建新元素），
              旧元素被删时 ws 未必干净关闭 → 实例服务端残留半开连接 → 回到该实例再开新 ws 时新旧并存把 Xvnc 卡死
              （刷新都救不了、要重启容器）。无 key 时切实例只改 src，浏览器会“导航”iframe：旧文档 unload 干净关闭旧 ws，
              再加载新实例。重连仍走整页重载（见 setMode / 重新连接 / restartInstance）。 */}
          <iframe
            ref={frameRef}
            className="iv-frame"
            src={desktopUrl(id)}
            title={`${appLabel} · 实例桌面`}
            allow="clipboard-read; clipboard-write; microphone; camera; autoplay"
            onLoad={() => {
              setFrameLoaded(true);
              setFrameGen((g) => g + 1); // iframe 页内换文档时也要重挂监听（见 frameGen 定义处）
              if (id) api.clientLog(id, 'iframe 已加载（noVNC 页面就绪，开始连 VNC）');
              setTimeout(() => {
                focusFrame(); // 加载完把键盘焦点交给 VNC
                injectVncStyle(); // 让原生控制条在深色背景下可见
                // 无感输入模式的键盘钩子由单独的 effect（依赖 inputMode/frameLoaded）安装，不在此处；
                // 转发模式则 enable_ime=false，直接打字走纯 keysym（英文/数字正常），中文用底部输入条。
              }, 500);
            }}
          />

          {!frameLoaded && !loadStuck && (
            <div className="iv-loading">
              <Spinner />
              <div className="iv-loading-text">正在连接桌面…</div>
              <div className="iv-loading-sub">{profile.enterHint}</div>
              <div className="iv-loading-tip">文件可以直接拖进画面上传；要听声音，点顶部「声音」再点一下画面</div>
              {!window.isSecureContext && (
                <div className="iv-loading-warn">
                  <Icon name="info" size={14} />
                  当前不是 HTTPS 访问，浏览器会禁用麦克风和摄像头（声音播放不受影响）
                </div>
              )}
            </div>
          )}

          {!frameLoaded && loadStuck && (
            <div className="iv-loading">
              <div className="iv-loading-glyph">
                <Icon name="alert" size={24} />
              </div>
              <div className="iv-loading-text">桌面无响应</div>
              {/* 子用户无「重启实例」权限（按钮下方已按 isAdmin 隐藏），文案也要跟着变，
                  否则会让人照着找一个根本不存在的按钮（issue #125）。 */}
              <div className="iv-loading-sub">
                {isAdmin
                  ? '连接超时了，可能是实例临时卡住。先试试「重新连接」，还不行就「重启实例」，聊天记录不受影响。'
                  : '连接超时了，可能是实例临时卡住。先试试「重新连接」；反复不行的话，请联系管理员重启实例。'}
              </div>
              <div className="iv-stuck-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => window.location.reload()}
                  title="整页重载干净重连（避免页内重挂导致 ws 并存把 Xvnc 卡死）"
                >
                  <Icon name="refresh" size={17} />
                  重新连接
                </button>
                {isAdmin && (
                  <button className="btn" onClick={restartInstance}>
                    <Icon name="restart" size={17} />
                    重启实例
                  </button>
                )}
              </div>
            </div>
          )}

          {dragging && (
            <div className="iv-drop" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
              <div className="drop-card">
                <div className="drop-icon">
                  <Icon name="upload" size={30} />
                </div>
                <div className="drop-title">松开即可上传到桌面</div>
                <div className="drop-sub">上传后在{appLabel}里「+ / 文件」选择即可</div>
              </div>
            </div>
          )}

          {control && !control.free && !control.mine && (
            <div className="iv-lock">
              <div className="iv-lock-card">
                <div className="iv-lock-icon">
                  <Icon name="hand" size={22} />
                </div>
                <div className="iv-lock-title">「{control.holder}」正在操作</div>
                <div className="iv-lock-sub">为了不互相干扰，你现在只能看。需要操作时可以接管，对方会变成只读。</div>
                <button className="btn btn-primary iv-notice-btn" onClick={takeControl}>
                  接管操作
                </button>
              </div>
            </div>
          )}

          {panel === 'files' && (
            <div className="iv-files" role="dialog" aria-label="文件传输">
              <div className="files-head">
                <span className="files-title">
                  <Icon name="folder" size={18} />
                  文件传输
                </span>
                <button className="icon-btn" aria-label="关闭" title="关闭（Esc）" onClick={() => setPanel(null)}>
                  <Icon name="x" size={18} />
                </button>
              </div>
              <input
                ref={fileInput}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files) uploadFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <button className="btn btn-primary files-upload" disabled={uploading} onClick={() => fileInput.current?.click()}>
                {uploading ? <Spinner size="sm" /> : <Icon name="upload" size={17} />}
                {uploading ? `上传中 ${uploadPct}` : '选择文件上传'}
              </button>
              <div className="files-hint">也可以直接把文件拖进画面。{appLabel}里收到的文件，另存到「桌面」后就能在下面下载。</div>
              <div className="files-list">
                {files.length === 0 ? (
                  <div className="files-empty">桌面上还没有文件</div>
                ) : (
                  files.map((f) => (
                    <div key={f.name} className="files-item">
                      <a className="files-dl" href={api.downloadFileUrl(id, f.name)} download={f.name} title={`下载 ${f.name}`}>
                        <Icon name="file" size={17} />
                        <span className="files-name">{f.name}</span>
                        <span className="files-size">{humanSize(f.size)}</span>
                        <Icon name="download" size={15} className="files-dl-ic" />
                      </a>
                      <button className="files-del" aria-label={`删除 ${f.name}`} title="删除" onClick={() => delFile(f.name)}>
                        <Icon name="trash" size={15} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {panel === 'clip' && (
            <div className="iv-files" role="dialog" aria-label="文本剪贴板">
              <div className="files-head">
                <span className="files-title">
                  <Icon name="clipboard" size={18} />
                  文本剪贴板
                </span>
                <button className="icon-btn" aria-label="关闭" title="关闭（Esc）" onClick={() => setPanel(null)}>
                  <Icon name="x" size={18} />
                </button>
              </div>
              <textarea
                className="input clip-area"
                value={clipText}
                onChange={(e) => setClipText(e.target.value)}
                placeholder={`输入或粘贴文字，发送后到${appLabel}的输入框按 Ctrl+V`}
                rows={5}
              />
              <button className="btn btn-primary files-upload" onClick={sendClip}>
                <Icon name="send" size={16} />
                发送到剪贴板
              </button>
              <button className="btn-text files-pull" onClick={pullClipboardFromRemote}>
                <Icon name="download" size={15} />
                读取桌面里复制的文字
              </button>
              <div className="files-hint">用局域网 http 地址访问时，浏览器不让网页直接读写剪贴板，可以用这个框中转。</div>
            </div>
          )}

          {panel === 'settings' && (
            <div className="iv-files" role="dialog" aria-label="桌面设置">
              <div className="files-head">
                <span className="files-title">
                  <Icon name="palette" size={18} />
                  桌面设置
                </span>
                <button className="icon-btn" aria-label="关闭" title="关闭（Esc）" onClick={() => setPanel(null)}>
                  <Icon name="x" size={18} />
                </button>
              </div>
              <div className="settings-tabs" role="tablist">
                <button role="tab" aria-selected={settingsTab === 'bg'} className={'settings-tab' + (settingsTab === 'bg' ? ' on' : '')} onClick={() => setSettingsTab('bg')}>
                  壁纸
                </button>
                <button role="tab" aria-selected={settingsTab === 'font'} className={'settings-tab' + (settingsTab === 'font' ? ' on' : '')} onClick={() => setSettingsTab('font')}>
                  字体
                </button>
              </div>

              {settingsTab === 'bg' && (
                <div className="settings-panel">
                  <input ref={bgInput} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={uploadBg} />
                  <div className="settings-row">
                    <button className="btn btn-sm" disabled={bgUploading} onClick={() => bgInput.current?.click()}>
                      {bgUploading ? <Spinner size="sm" /> : <Icon name="upload" size={16} />}
                      {bgUploading ? '上传中…' : '上传壁纸'}
                    </button>
                    {currentBg && (
                      <button className="btn-text danger" onClick={clearBg}>
                        恢复默认黑屏
                      </button>
                    )}
                  </div>
                  <div className="files-hint">点缩略图即可应用，支持 JPG / PNG 等常见格式。</div>
                  {bgList.length === 0 && <div className="files-empty">还没有壁纸</div>}
                  <div className="bg-grid">
                    {bgList.map((name) => (
                      <div key={name} className={'bg-card' + (currentBg === name ? ' active' : '')} onClick={() => applyBg(name)} title="点击应用">
                        <div className="bg-thumb-wrap">
                          <img className="bg-thumb" src={`/api/admin/instances/${id}/backgrounds/${encodeURIComponent(name)}/image`} alt={name} loading="lazy" />
                          {currentBg !== name && <div className="bg-hint">点击应用</div>}
                          {currentBg === name && (
                            <span className="bg-active-badge">
                              <Icon name="check" size={11} strokeWidth={3} />
                              使用中
                            </span>
                          )}
                          <button
                            className="bg-del"
                            aria-label={`删除壁纸 ${name}`}
                            title="删除"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteBg(name);
                            }}
                          >
                            <Icon name="x" size={13} strokeWidth={2.6} />
                          </button>
                        </div>
                        <span className="bg-name">{name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {settingsTab === 'font' && (
                <div className="settings-panel">
                  <input ref={fontInput} type="file" accept=".ttf,.otf,.ttc" multiple style={{ display: 'none' }} onChange={uploadFont} />
                  <div className="settings-row">
                    <button className="btn btn-sm" disabled={fontUploading} onClick={() => fontInput.current?.click()}>
                      {fontUploading ? <Spinner size="sm" /> : <Icon name="upload" size={16} />}
                      {fontUploading ? '上传中…' : '上传字体'}
                    </button>
                    {currentFont && (
                      <button className="btn-text danger" onClick={resetFontDefault}>
                        恢复默认（文泉驿）
                      </button>
                    )}
                  </div>
                  <div className="files-hint">支持 TTF / OTF / TTC。换了字体要重启一次{appLabel}才完全生效。</div>
                  {fontList.length === 0 && <div className="files-empty">还没有上传字体</div>}
                  <div className="font-grid">
                    {fontList.map((name) => (
                      <div key={name} className={'font-card' + (currentFont === name ? ' active' : '')} onClick={() => applyUserFont(name)} title="点击应用">
                        {currentFont === name && (
                          <span className="font-badge">
                            <Icon name="check" size={11} strokeWidth={3} />
                            使用中
                          </span>
                        )}
                        <button
                          className="font-del"
                          aria-label={`删除字体 ${name}`}
                          title="删除"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteFont(name);
                          }}
                        >
                          <Icon name="x" size={13} strokeWidth={2.6} />
                        </button>
                        <div className="font-preview">
                          <span className="font-preview-text">Aa</span>
                        </div>
                        <span className="font-name">{name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          </div>

          {inputMode === 'forward' && (
            <>
              {/* 功能键折叠集合（issue #125）：VNC 里这些键要么被浏览器吃掉、要么手机端根本没有，
                  给一排直接点。经 xdotool 送出，键名须匹配服务端白名单 /^[A-Za-z_]{1,20}$/。 */}
              {showKeys && (
                <div className="iv-keybar">
                  {FUNC_KEYS.map((k) => (
                    <button key={k.key} className="iv-key" title={k.title} aria-label={k.title} disabled={readOnly} onClick={() => pressKey(k.key)}>
                      {k.label}
                    </button>
                  ))}
                </div>
              )}
              <div className="iv-imebar">
                <button
                  className={'iv-imebar-tool' + (showKeys ? ' on' : '')}
                  title="功能键（Esc / Tab / 退格 / 方向键…）"
                  aria-label="功能键"
                  aria-pressed={showKeys}
                  onClick={() => setShowKeys((v) => !v)}
                >
                  <Icon name="keyboard" size={18} />
                </button>
                <textarea
                  className="iv-imebar-input"
                  value={imeText}
                  disabled={readOnly}
                  onChange={(e) => setImeText(e.target.value)}
                  onKeyDown={(e) => {
                    void beat();
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendImeText();
                    }
                  }}
                  title="回车发送，Shift+回车换行"
                  placeholder={
                    readOnly
                      ? `「${control?.holder}」正在操作，你现在只能看；要操作请点画面上的「接管操作」`
                      : autoEnter
                        ? `先点好${appLabel}里的输入框，再在这里打中文，回车发送`
                        : `先点好${appLabel}里的输入框，再在这里打中文，回车只填入、不发送`
                  }
                  rows={1}
                />
                <button
                  className={'iv-imebar-tool' + (autoEnter ? ' on' : '')}
                  title={
                    autoEnter
                      ? '自动回车：开。文字送到应用后立刻回车发出。点击关闭（只填字不发送，便于先编辑再发）'
                      : '自动回车：关。只把文字填进应用输入框，发送由你自己按。点击开启'
                  }
                  aria-label="自动回车"
                  aria-pressed={autoEnter}
                  onClick={toggleAutoEnter}
                >
                  <Icon name="enter" size={18} />
                </button>
                <button
                  className="btn btn-primary iv-imebar-send"
                  disabled={imeSending || !imeText.trim() || readOnly}
                  onClick={sendImeText}
                >
                  {imeSending ? <Spinner size="sm" /> : <Icon name="send" size={16} />}
                  <span className="iv-imebar-send-label">{imeSending ? '发送中' : autoEnter ? '发送' : '填入'}</span>
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// 实例没法直接进桌面时的状态卡：应用图标 + 右下角状态角标 + 标题，下面放说明和能直接点的操作
type Tone = 'off' | 'busy' | 'warn' | 'err';
const TONE_ICON: Record<Tone, IconName> = { off: 'power', busy: 'download', warn: 'download', err: 'alert' };
function StateCard({ inst, tone, title, children }: { inst: InstanceWithStatus; tone: Tone; title: string; children?: ReactNode }) {
  return (
    <div className="iv-stage iv-center">
      <div className="card iv-notice">
        <div className="iv-notice-icon">
          <InstanceIcon icon={inst.icon} appType={inst.appType} size={64} radius={18} />
          <span className={'iv-notice-badge b-' + tone}>
            <Icon name={TONE_ICON[tone]} size={13} strokeWidth={2.6} />
          </span>
        </div>
        <div className="iv-notice-title">{title}</div>
        {children}
      </div>
    </div>
  );
}
