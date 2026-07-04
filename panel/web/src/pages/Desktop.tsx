import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, appProfile } from '../api';
import { useUI } from '../ui';
import { useAuth } from '../auth';
import { useInstances } from '../AppShell';
import { VncAudio } from '../vncAudio';

// KasmVNC noVNC 页面；反代按实例隔离：/desktop/<id>/* → 对应容器，注入凭据。
function desktopUrl(id: string) {
  return (
    `/desktop/${id}/vnc/index.html?autoconnect=1&path=desktop/${id}/websockify&resize=remote` +
    '&reconnect=true&reconnect_delay=2000&clipboard_up=true&clipboard_down=true&clipboard_seamless=true'
  );
}

// Kasm 嵌入文档要求 iframe allow 含 self，才能把 clipboard-read/write 传给内嵌 noVNC（KasmVDI 模式）。
function vncIframeAllow() {
  return 'clipboard-read; clipboard-write; self; microphone; camera; autoplay';
}

// 「无感输入」钩子：装进同源 iframe，让用户直接在微信里打中文。
// - compositionend（中文提交）→ 经 xclip+xdotool 转发（绕开 VNC keysym 容量上限）。
// - 转发未完成期间（队列活跃），把后续可见字符 + 回车/退格也串进同一队列按序送出 →
//   彻底消除"中文走异步、数字走 keysym 抢跑"导致的"你好123→23"丢字。
// - 队列空闲时不干预：英文/数字仍走原生 keysym，零延迟。
// 返回清理函数（切回转发模式 / 重连 / 卸载时移除监听）。
function installSeamlessIme(win: Window, doc: Document, instId: string): () => void {
  type Job = { kind: 'text'; data: string } | { kind: 'key'; data: string };
  const queue: Job[] = [];
  let draining = false;
  const active = () => draining || queue.length > 0;

  const drain = async () => {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const job = queue[0];
      try {
        if (job.kind === 'text') await api.typeInInstance(instId, job.data);
        else await api.keyInInstance(instId, job.data);
      } catch {
        /* 单条失败丢弃，继续后续，避免卡住队列 */
      }
      queue.shift();
    }
    draining = false;
  };

  const onCompositionEnd = (e: Event) => {
    const txt = (e as CompositionEvent).data;
    if (!txt) return;
    queue.push({ kind: 'text', data: txt });
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

  doc.addEventListener('compositionend', onCompositionEnd, true);
  win.addEventListener('keydown', onKeyDownCapture, true);
  return () => {
    doc.removeEventListener('compositionend', onCompositionEnd, true);
    win.removeEventListener('keydown', onKeyDownCapture, true);
  };
}

// 修复 KasmVNC 无缝剪贴板「同窗口粘贴始终旧内容」：
// noVNC 仅在 window focus 变化后的第一次 click 才调 checkLocalClipboard()，同窗口内 _resendClipboardNextUserDrivenEvent
// 已为 false 就不再重读本机剪贴板；切换微信窗口会触发 focus → 才更新。此处每次 Ctrl+V 前强制同步。
function installClipboardFreshSync(win: Window, doc: Document): () => void {
  if (!win.isSecureContext) return () => {};

  let busy = false;
  const isPaste = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'v';

  const syncTextToRemote = (text: string) => {
    win.postMessage({ action: 'clipboardsnd', value: text }, '*');
  };

  const syncFromLocal = async (): Promise<boolean> => {
    if (!navigator.clipboard?.read) {
      if (!navigator.clipboard?.readText) return false;
      const text = await navigator.clipboard.readText();
      if (text) syncTextToRemote(text);
      return !!text;
    }
    const items = await navigator.clipboard.read();
    const ui = (win as any).UI;
    if (ui?.rfb?.clipboardPasteDataFrom) {
      await ui.rfb.clipboardPasteDataFrom(items);
      return true;
    }
    for (const item of items) {
      if (item.types.includes('text/plain')) {
        const text = await (await item.getType('text/plain')).text();
        if (text) {
          syncTextToRemote(text);
          return true;
        }
      }
    }
    return false;
  };

  const forwardPaste = () => {
    const mod = /Mac|iPhone|iPad/i.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
    const target = doc.getElementById('noVNC_keyboardinput') || doc.getElementById('noVNC_canvas');
    if (!target) return;
    for (const type of ['keydown', 'keyup'] as const) {
      target.dispatchEvent(
        new KeyboardEvent(type, { key: 'v', code: 'KeyV', bubbles: true, cancelable: true, ...mod }),
      );
    }
  };

  const onKeyDown = async (e: KeyboardEvent) => {
    if (!isPaste(e) || busy) return;
    busy = true;
    e.preventDefault();
    e.stopImmediatePropagation();
    try {
      await syncFromLocal();
      // 等剪贴板经 VNC 推到容器后再发 Ctrl+V
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      forwardPaste();
    } catch {
      forwardPaste();
    } finally {
      busy = false;
    }
  };

  const onMouseDown = () => {
    // 点击输入框后常会紧跟 Ctrl+V；提前异步同步，缩小 race 窗口
    void syncFromLocal().catch(() => {});
  };

  win.addEventListener('keydown', onKeyDown, true);
  win.addEventListener('mousedown', onMouseDown, true);
  return () => {
    win.removeEventListener('keydown', onKeyDown, true);
    win.removeEventListener('mousedown', onMouseDown, true);
  };
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

const MenuIcon = (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M4 6h16M4 12h16M4 18h16" />
  </svg>
);

export default function InstanceView({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { user } = useAuth();
  const { toast, confirm } = useUI();
  const { instances, loaded, reload } = useInstances();
  const isAdmin = user?.role === 'admin';

  const [frameLoaded, setFrameLoaded] = useState(false);
  const [loadStuck, setLoadStuck] = useState(false); // iframe 久未加载出来（疑似实例无响应）
  const [dragging, setDragging] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [files, setFiles] = useState<TFile[]>([]);
  const [showClip, setShowClip] = useState(false);
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
  // 声音（扬声器）开关，默认关。1.1.7 本就没有音频桥、连接很稳；音频是经一条额外 socket.io 连到实例 kclient，
  // 为排除它对连接稳定性的影响、并回到 1.1.7 的连接行为，默认不连音频桥；想听声音再开（开关进 effect 依赖，
  // 关→断开音频桥，开→建立）。
  const [soundOn, setSoundOn] = useState(() => {
    try {
      return window.localStorage.getItem('woc_sound_on') === '1';
    } catch {
      return false;
    }
  });
  const toggleSound = () => {
    const v = !soundOn;
    setSoundOn(v);
    try {
      window.localStorage.setItem('woc_sound_on', v ? '1' : '0');
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
  const [starting, setStarting] = useState(false);
  const [control, setControl] = useState<{ free: boolean; mine: boolean; holder: string | null } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const remoteClipRef = useRef(''); // KasmVDI 下容器→本机走 postMessage，textarea 不更新
  const dragDepth = useRef(0);
  const lastBeat = useRef(0);
  const audioRef = useRef<VncAudio | null>(null);

  const inst = instances.find((i) => i.id === id);
  const profile = appProfile(inst?.appType); // 按应用类型显示正确文案（微信/Chromium…）
  const appLabel = profile.label;
  // 进入实例时，共享列表可能尚未同步（管理页新建/安装后），先按"探测中"显示加载态，
  // 等列表刷新到该实例或超时后再判定是否真的不存在，避免从管理页跳转时误报"实例不存在"。
  const [probing, setProbing] = useState(true);
  const offline = inst ? inst.runtime !== 'running' : false;
  const installed = !!inst && inst.wechat.installed && inst.wechat.phase !== 'downloading';
  const showVnc = !!inst && !offline && installed;

  // 切换实例时重置内嵌态
  useEffect(() => {
    setFrameLoaded(false);
    setLoadStuck(false);
    setShowFiles(false);
    setFiles([]);
    setShowClip(false);
    setClipText('');
    remoteClipRef.current = '';
    setImeText('');
    setProbing(true);
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

  // 用户在 VNC 内真实操作（鼠标/键盘/滚轮）时续约控制权（同源 iframe 可监听）。节流 2.5s。
  // 只读用户的操作已被遮罩拦截/失焦，不会误续约；空闲不操作则超时自动释放。
  useEffect(() => {
    if (!showVnc || !id || !frameLoaded) return;
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    const onInteract = async () => {
      const now = Date.now();
      if (now - lastBeat.current < 2500) return;
      lastBeat.current = now;
      try {
        const r = await api.controlBeat(id);
        setControl({ free: false, mine: r.mine, holder: r.holder });
      } catch {
        /* ignore */
      }
    };
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
  }, [showVnc, id, frameLoaded]);

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

  // KasmVDI 模式：容器→本机剪贴板经 postMessage clipboardrx 回传（不会写入 noVNC 面板 textarea）。
  useEffect(() => {
    if (!showVnc || !frameLoaded) return;
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      if (e.data?.action === 'clipboardrx' && typeof e.data.value === 'string') {
        remoteClipRef.current = e.data.value;
        setClipText(e.data.value);
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [showVnc, frameLoaded, id]);

  // 每次粘贴前强制同步本机剪贴板（修 KasmVNC 同窗口不重读的 bug）
  useEffect(() => {
    if (!showVnc || !frameLoaded) return;
    const win = frameRef.current?.contentWindow;
    const doc = frameRef.current?.contentDocument;
    if (!win || !doc) return;
    return installClipboardFreshSync(win, doc);
  }, [showVnc, frameLoaded, id]);

  // 无感模式：往同源 iframe 装「中文转发 + 有序队列」钩子；切回转发/重连/卸载时自动移除。
  useEffect(() => {
    if (inputMode !== 'seamless' || !showVnc || !frameLoaded || !id) return;
    const win = frameRef.current?.contentWindow;
    const doc = frameRef.current?.contentDocument;
    if (!win || !doc) return;
    const cleanup = installSeamlessIme(win, doc, id);
    return cleanup;
  }, [inputMode, showVnc, frameLoaded, id]);

  // 音频/麦克风桥接：实例就绪即自动连接 kclient 的音频流（扬声器恒开，无需手动找工具条）；
  // 仅当本实例处于焦点（标签页可见且窗口聚焦）时出声/收音，失焦立即断开，避免多实例多端串音。
  useEffect(() => {
    if (!showVnc || !id || !soundOn) return; // 声音默认关：未开则完全不连音频桥（回到 1.1.7 无音频的连接行为）
    const audio = new VncAudio(id, micOn);
    audioRef.current = audio;
    audio.connect();
    const isFocused = () => !document.hidden && document.hasFocus();
    const sync = () => audio.setActive(isFocused());
    sync(); // 初始：若当前已聚焦则立即开声
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      audio.destroy();
      audioRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showVnc, id, soundOn]);

  // VNC 连接态监测——仅记录、不自动重连/重启。
  // 1.1.7 本就没有任何"面板侧自动重连/自动重启"，连接很稳；本会话加的自动重载/自动重启(heal)/回前台重载
  // 反而造成"频繁卡死/重启"的churn，故全部撤掉，回到 1.1.7 的行为：由 noVNC 自带重连兜底，仍不行用户手动
  // 「重新连接/重启」。这里只把 kasmweb 在 iframe <html> 上的连接态 class 变化回传 [client] 日志，用于排查。
  useEffect(() => {
    if (!showVnc || !frameLoaded || !id) return;
    let lastState = '';
    const t = window.setInterval(() => {
      let state = '';
      try {
        const c = frameRef.current?.contentDocument?.documentElement?.classList;
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
  }, [showVnc, frameLoaded, id]);

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

  const uploadFiles = async (list: FileList | File[]) => {
    const arr = Array.from(list);
    if (!arr.length) return;
    setUploading(true);
    let ok = 0;
    for (const f of arr) {
      try {
        await api.uploadFile(id, f);
        ok++;
      } catch (e: any) {
        toast(`${f.name}: ${e.message || '上传失败'}`, 'error');
      }
    }
    setUploading(false);
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

  // 跨设备剪贴板：noVNC 在 iframe 内会进入 KasmVDI 模式，官方上行通道是 postMessage clipboardsnd；
  // 同时触发 textarea change 作为兜底（走 UI.clipboardSend → RFB.clipboardPasteFrom）。
  const pushClipboardToRemote = (text: string): boolean => {
    try {
      const win = frameRef.current?.contentWindow;
      if (!win) return false;
      win.postMessage({ action: 'clipboardsnd', value: text }, '*');
      try {
        const ta = frameRef.current?.contentDocument?.getElementById('noVNC_clipboard_text') as HTMLTextAreaElement | null;
        if (ta) {
          ta.value = text;
          ta.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch {
        /* postMessage 已发出，DOM 兜底失败可忽略 */
      }
      return true;
    } catch {
      return false;
    }
  };

  // 安全上下文（HTTPS / localhost）下读取本机剪贴板：文本直送容器，图片自动上传到桌面。
  const pasteFromLocal = async () => {
    if (!window.isSecureContext || !navigator.clipboard?.read) {
      toast('无法自动读取本机剪贴板（需 HTTPS 或 localhost）。请在本框内手动 Ctrl+V 粘贴', 'error');
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        if (item.types.includes('image/png')) {
          const blob = await item.getType('image/png');
          const file = new File([blob], `clipboard-${Date.now()}.png`, { type: 'image/png' });
          if (!id) return;
          setUploading(true);
          try {
            await api.uploadFile(id, file);
            toast('剪贴板图片已上传到桌面，可在应用里打开发送', 'ok');
            refreshFiles();
          } finally {
            setUploading(false);
          }
          return;
        }
        if (item.types.includes('text/plain')) {
          const text = await (await item.getType('text/plain')).text();
          setClipText(text);
          if (pushClipboardToRemote(text)) {
            toast('本机文本已发送到容器剪贴板，在应用输入框按 Ctrl+V 粘贴', 'ok');
          } else {
            toast('发送失败：桌面尚未连接', 'error');
          }
          return;
        }
      }
      toast('剪贴板中没有可识别的文本或图片', 'error');
    } catch {
      toast('读取本机剪贴板被拒绝，请允许浏览器剪贴板权限后重试', 'error');
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
  const sendImeText = async () => {
    const t = imeText;
    if (!t.trim() || !id) return;
    setImeSending(true);
    try {
      await api.typeInInstance(id, t);
      setImeText('');
    } catch (e: any) {
      toast(e?.message || '发送失败：请确认实例已「升级实例」（镜像含 xclip/xdotool）', 'error');
    } finally {
      setImeSending(false);
    }
  };

  // 读取容器（微信侧）当前剪贴板：KasmVDI 下以 postMessage 缓存为准，textarea 可能陈旧
  const pullClipboardFromRemote = () => {
    try {
      const cached = remoteClipRef.current;
      if (cached) {
        setClipText(cached);
        toast('已读取容器剪贴板', 'ok');
        return;
      }
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

  const title = inst?.name || '实例';

  return (
    <div className="ws-page">
      <header className="ws-head">
        <button className="ws-menu" onClick={onOpenMenu} aria-label="菜单">
          {MenuIcon}
        </button>
        <span className="ws-title">{title}</span>
        {showVnc && (
          <>
            <button
              className="ws-action"
              title="文件传输"
              onClick={() => {
                setShowFiles((v) => !v);
                if (!showFiles) refreshFiles();
              }}
            >
              文件
            </button>
            <button
              className={'ws-action' + (inputMode === 'seamless' ? ' on' : '')}
              title={
                inputMode === 'seamless'
                  ? '无感输入：直接在应用输入框里打中文（提交后转发，已修复混数字丢字）。点击切回「转发输入条」'
                  : '转发输入：用底部输入条打中文，最稳。点击切到「无感输入」（直接在应用里打）'
              }
              onClick={() => setMode(inputMode === 'seamless' ? 'forward' : 'seamless')}
            >
              输入：{inputMode === 'seamless' ? '无感' : '转发'}
            </button>
            <button
              className="ws-action"
              title="把文本发送到容器剪贴板（局域网 http 下也可用）"
              onClick={() => setShowClip((v) => !v)}
            >
              剪贴板
            </button>
            <button
              className={'ws-action' + (soundOn ? ' on' : '')}
              title={soundOn ? '声音已开：已连接实例音频。点击关闭（关闭可减少一条到实例的连接，更稳）' : '声音已关：默认不连音频桥（连接更稳）。点此开启以听到实例声音'}
              onClick={toggleSound}
            >
              声音：{soundOn ? '开' : '关'}
            </button>
            {soundOn && (
              <button
                className={'ws-action' + (micOn ? ' on' : '')}
                title={
                  micOn
                    ? '麦克风已开：占用本机麦克风（AirPods 等可能被切到低音质通话模式）。点击关闭'
                    : '麦克风已关：不占用麦克风，AirPods 保持高音质输出。需要语音/通话时点此开启'
                }
                onClick={toggleMic}
              >
                麦克风：{micOn ? '开' : '关'}
              </button>
            )}
            {isAdmin && (
              <button className="ws-action" title="重启实例（修复卡死/最小化丢失）" onClick={restartInstance}>
                重启
              </button>
            )}
          </>
        )}
      </header>

      {/* —— 各种态 —— */}
      {!loaded || (probing && !inst) ? (
        <div className="iv-stage iv-center">
          <div className="spinner" />
        </div>
      ) : !inst ? (
        <div className="iv-stage iv-center">
          <div className="iv-notice">
            <div className="iv-notice-title">无权访问或实例不存在</div>
            <button className="btn btn-primary iv-notice-btn" onClick={() => nav('/')}>
              返回主页
            </button>
          </div>
        </div>
      ) : offline ? (
        <div className="iv-stage iv-center">
          <div className="iv-notice">
            <div className="iv-notice-title">{inst.runtime === 'missing' ? '容器尚未创建' : '实例已停止'}</div>
            {isAdmin ? (
              <button className="btn btn-primary iv-notice-btn" disabled={starting} onClick={start}>
                {starting ? '启动中…' : inst.runtime === 'missing' ? '创建并启动' : '启动实例'}
              </button>
            ) : (
              <div className="iv-notice-sub">请联系管理员启动该实例</div>
            )}
            {isAdmin && (
              <button className="btn-text" onClick={() => window.open(api.instanceLogsUrl(id), '_blank')}>
                查看日志
              </button>
            )}
          </div>
        </div>
      ) : ['downloading', 'extracting', 'installing'].includes(inst.wechat.phase) ? (
        <div className="iv-stage iv-center">
          <div className="iv-notice">
            <div className="spinner" />
            <div className="iv-notice-title">{appLabel}安装中…</div>
            <div className="iv-notice-sub">
              {inst.wechat.message || '请稍候'}
              {inst.wechat.percent >= 0 ? ` · ${inst.wechat.percent}%` : ''} ——完成后自动进入，无需刷新
            </div>
          </div>
        </div>
      ) : !installed ? (
        <div className="iv-stage iv-center">
          <div className="iv-notice">
            <div className="iv-notice-title">{inst.wechat.phase === 'error' ? `${appLabel}安装出错` : `${appLabel}尚未安装`}</div>
            <div className="iv-notice-sub">
              {inst.wechat.phase === 'error'
                ? inst.wechat.message || '安装失败，可在「管理」重试'
                : `该实例容器已就绪，但尚未安装${appLabel}`}
            </div>
            {isAdmin ? (
              <button className="btn btn-primary iv-notice-btn" onClick={() => nav('/admin')}>
                去「管理」{inst.wechat.phase === 'error' ? '重试 / 更新' : '下载安装'}
              </button>
            ) : (
              <div className="iv-notice-sub">请联系管理员在「管理」中下载安装{appLabel}</div>
            )}
            {isAdmin && (
              <button className="btn-text" onClick={() => window.open(api.instanceLogsUrl(id), '_blank')}>
                查看日志
              </button>
            )}
          </div>
        </div>
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
            allow={vncIframeAllow()}
            onLoad={() => {
              setFrameLoaded(true);
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
              <div className="spinner" />
              <div className="iv-loading-text">正在连接桌面…</div>
              <div className="iv-loading-sub">{profile.enterHint}</div>
              <div className="iv-loading-sub">拖文件到此处即可上传；声音自动开启，点一下画面即可出声</div>
              {!window.isSecureContext && (
                <div className="iv-loading-warn">当前非安全上下文（非 HTTPS 且非 localhost），浏览器将禁用剪贴板/麦克风/摄像头（音频播放不受影响）</div>
              )}
            </div>
          )}

          {!frameLoaded && loadStuck && (
            <div className="iv-loading">
              <div className="iv-loading-text">桌面无响应</div>
              <div className="iv-loading-sub">连接超时。可能是实例临时卡住，先「重新连接」；若仍无效请「重启实例」。</div>
              <div className="iv-stuck-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => window.location.reload()}
                  title="整页重载干净重连（避免页内重挂导致 ws 并存把 Xvnc 卡死）"
                >
                  重新连接
                </button>
                {isAdmin && (
                  <button className="btn" onClick={restartInstance}>
                    重启实例
                  </button>
                )}
              </div>
              <div className="iv-loading-sub" style={{ marginTop: 8 }}>
                若反复无响应，点「重启实例」即可恢复（数据保留）。
              </div>
            </div>
          )}

          {dragging && (
            <div className="iv-drop" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
              <div className="drop-card">
                <div className="drop-icon">⬇</div>
                <div className="drop-title">松开上传到桌面</div>
                <div className="drop-sub">上传后在应用里「+ / 文件」选择即可</div>
              </div>
            </div>
          )}

          {control && !control.free && !control.mine && (
            <div className="iv-lock">
              <div className="iv-lock-card">
                <div className="iv-lock-title">「{control.holder}」正在操作</div>
                <div className="iv-lock-sub">为避免多端互相干扰，你当前为只读模式。</div>
                <button className="btn btn-primary iv-notice-btn" onClick={takeControl}>
                  申请控制
                </button>
              </div>
            </div>
          )}

          {showFiles && (
            <div className="iv-files">
              <div className="files-head">
                <span>文件传输</span>
                <button className="btn-text" onClick={() => setShowFiles(false)}>
                  关闭
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
                {uploading ? '上传中…' : '＋ 选择文件上传'}
              </button>
              <div className="files-hint">也可直接把文件拖进来。下方为桌面（~/Desktop）里的文件，应用收到的文件另存到桌面即可在此下载。</div>
              <div className="files-list">
                {files.length === 0 && (
                  <div className="muted small" style={{ padding: '10px 2px' }}>
                    暂无文件
                  </div>
                )}
                {files.map((f) => (
                  <div key={f.name} className="files-item">
                    <a className="files-dl" href={api.downloadFileUrl(id, f.name)} download={f.name} title="下载">
                      <span className="files-name">{f.name}</span>
                      <span className="files-size">{humanSize(f.size)} ↓</span>
                    </a>
                    <button className="files-del" title="删除" onClick={() => delFile(f.name)}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {showClip && (
            <div className="iv-files">
              <div className="files-head">
                <span>文本剪贴板</span>
                <button className="btn-text" onClick={() => setShowClip(false)}>
                  关闭
                </button>
              </div>
              <textarea
                className="clip-area"
                value={clipText}
                onChange={(e) => setClipText(e.target.value)}
                placeholder="在此输入或粘贴文本，点「发送到剪贴板」后到应用输入框按 Ctrl+V 粘贴"
                rows={5}
              />
              <div className="clip-actions">
                <button className="btn btn-primary files-upload" onClick={sendClip}>
                  发送到剪贴板
                </button>
                {window.isSecureContext && (
                  <button className="btn files-upload" disabled={uploading} onClick={pasteFromLocal}>
                    从本机剪贴板读取
                  </button>
                )}
              </div>
              <button className="btn-text" style={{ alignSelf: 'flex-start', marginTop: 6 }} onClick={pullClipboardFromRemote}>
                ↓ 读取容器剪贴板到此框
              </button>
              <div className="files-hint">
                {window.isSecureContext
                  ? 'HTTPS 或 localhost 下桌面内可直接 Ctrl+C/V 同步剪贴板（含图片）。若未生效，用「从本机剪贴板读取」或在此框粘贴后点发送。'
                  : '局域网 IP 的 http 访问不是安全上下文，浏览器禁用剪贴板 API。请在此框手动 Ctrl+V 粘贴文本后点「发送」；图片请用「文件」上传。'}
              </div>
            </div>
          )}
          </div>

          {inputMode === 'forward' && (
            <div className="iv-imebar">
              <textarea
                className="iv-imebar-input"
                value={imeText}
                onChange={(e) => setImeText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendImeText();
                  }
                }}
                placeholder="中文输入这里 → 回车送进应用（先点好应用的输入框）。Shift+回车换行。"
                rows={1}
              />
              <button
                className="btn btn-primary iv-imebar-send"
                disabled={imeSending || !imeText.trim()}
                onClick={sendImeText}
              >
                {imeSending ? '发送中' : '发送'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
