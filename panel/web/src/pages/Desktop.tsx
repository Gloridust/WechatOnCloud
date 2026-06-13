import { useEffect, useRef, useState, type CompositionEvent, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useUI } from '../ui';
import { useAuth } from '../auth';
import { useInstances } from '../AppShell';
import { VncAudio } from '../vncAudio';
import {
  ImeCommitBuffer,
  ImeDiagnostics,
  ImeInstanceTextQueue,
  ImeRemoteTextSender,
  ImeTransportHealth,
  ImeTransportProbe,
  type ImeClipboardPushResult,
  type ImeRemoteFocusPoint,
  type ImeRemoteTextSenderHandlers,
  imeProxyClassName,
  imeProxyCommitTransport,
  imeProxyEventPoint,
  imeProxyFrameMatchesInstance,
  imeProxyFrameRectFromViewportGeometry,
  imeProxyFrameViewportGeometry,
  imeProxyMobileViewportPosition,
  imeProxyPositionFromFrameClick,
  imeProxyRemoteClickPoint,
  imeProxyShouldApplySwitchCleanup,
  imeProxyShortcutKey,
  imeProxyShouldActivateFromFrameClick,
  imeProxyShouldPreClickRemoteFocus,
  imeProxyShouldProbeOnFocusActivation,
  imeProxyShouldSkipDuplicateActivation,
} from '../imeProxy';

// KasmVNC noVNC 页面；反代按实例隔离：/desktop/<id>/* → 对应容器，注入凭据。
function desktopUrl(id: string) {
  return (
    `/desktop/${id}/vnc/index.html?autoconnect=1&path=desktop/${id}/websockify&resize=remote` +
    '&reconnect=true&reconnect_delay=2000&clipboard_up=true&clipboard_down=true&clipboard_seamless=true'
  );
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
  // 中文输入条：面板里的真实 textarea（原生客户端输入法 100% 可用），回车经 xclip+xdotool 粘进微信。
  const [imeBar, setImeBar] = useState(false); // 兜底输入条，默认收起；日常输入走透明代理
  const [imeProxyEnabled, setImeProxyEnabled] = useState(true);
  const [imeProxyMobile, setImeProxyMobile] = useState(false);
  const [imeProxyTyping, setImeProxyTyping] = useState(false);
  const [imeProxyActive, setImeProxyActive] = useState(false);
  const [imeText, setImeText] = useState('');
  const [imeSending, setImeSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [control, setControl] = useState<{
    free: boolean;
    mine: boolean;
    holder: string | null;
  } | null>(null);
  const [vncNonce, setVncNonce] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const imeProxyRef = useRef<HTMLTextAreaElement>(null);
  const dragDepth = useRef(0);
  const lastBeat = useRef(0);
  const audioRef = useRef<VncAudio | null>(null);
  const imeBuffer = useRef<ImeCommitBuffer | null>(null);
  const imeDiagnostics = useRef(new ImeDiagnostics());
  const imeTransportHealth = useRef(new ImeTransportHealth());
  const imeTransportProbe = useRef<ImeTransportProbe | null>(null);
  const imeSender = useRef<ImeRemoteTextSender | null>(null);
  const imePos = useRef<{ x: number; y: number | null }>({ x: 24, y: 72 });
  const imeQueue = useRef<ImeInstanceTextQueue | null>(null);
  const imeRemoteFocus = useRef<ImeRemoteFocusPoint | null>(null);
  const imeProxyActivitySeq = useRef(0);
  const imeLastActivation = useRef<{
    eventType: string;
    clientX: number;
    clientY: number;
    at: number;
  } | null>(null);

  const inst = instances.find((i) => i.id === id);
  // 进入实例时，共享列表可能尚未同步（管理页新建/安装后），先按"探测中"显示加载态，
  // 等列表刷新到该实例或超时后再判定是否真的不存在，避免从管理页跳转时误报"实例不存在"。
  const [probing, setProbing] = useState(true);
  const offline = inst ? inst.runtime !== 'running' : false;
  const installed =
    !!inst && inst.wechat.installed && inst.wechat.phase !== 'downloading';
  const showVnc = !!inst && !offline && installed;

  // 切换实例时重置内嵌态
  useEffect(() => {
    let alive = true;
    const cleanupSeq = imeProxyActivitySeq.current;
    setFrameLoaded(false);
    setLoadStuck(false);
    setShowFiles(false);
    setFiles([]);
    setShowClip(false);
    setClipText('');
    setImeText('');
    void imeQueue.current?.flushAndReset().finally(() => {
      if (
        !imeProxyShouldApplySwitchCleanup({
          alive,
          startedSeq: cleanupSeq,
          currentSeq: imeProxyActivitySeq.current,
        })
      )
        return;
      imeRemoteFocus.current = null;
      imeBuffer.current?.reset();
      blurImeProxy();
    });
    setProbing(true);
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    (window as any).__wocImeDiagnostics = {
      entries: () => imeDiagnostics.current.entries(),
      clear: () => imeDiagnostics.current.clear(),
    };
    (window as any).__wocImeServerDiagnostics = {
      entries: () => api.imeDiagnostics(),
      clear: () => api.imeDiagnostics(true),
    };
    return () => {
      if ((window as any).__wocImeDiagnostics?.entries) {
        delete (window as any).__wocImeDiagnostics;
      }
      if ((window as any).__wocImeServerDiagnostics?.entries) {
        delete (window as any).__wocImeServerDiagnostics;
      }
    };
  }, []);

  useEffect(() => {
    const sync = () => {
      const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
      setImeProxyMobile(coarse || window.innerWidth <= 720);
    };
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  useEffect(() => {
    if (!imeProxyMobile || !imeProxyEnabled) return;
    const sync = () => {
      const pos = imeProxyMobileViewportPosition({
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        visualViewportTop: window.visualViewport?.offsetTop,
        visualViewportHeight: window.visualViewport?.height,
      });
      imePos.current = pos;
      const ta = imeProxyRef.current;
      if (ta && document.activeElement === ta) {
        ta.style.left = `${pos.x}px`;
        ta.style.top = '';
      }
    };
    sync();
    window.visualViewport?.addEventListener('resize', sync);
    window.visualViewport?.addEventListener('scroll', sync);
    window.addEventListener('orientationchange', sync);
    return () => {
      window.visualViewport?.removeEventListener('resize', sync);
      window.visualViewport?.removeEventListener('scroll', sync);
      window.removeEventListener('orientationchange', sync);
    };
  }, [imeProxyEnabled, imeProxyMobile]);

  // 桌面久未加载出来 → 判为"无响应"，把无限转圈换成可操作的重试/重启，不让用户干等。
  // （实测容器跑久了会 I/O/服务 stall，进程没死、显示在线，但读不出 VNC 文件而永远连接中。）
  useEffect(() => {
    setLoadStuck(false);
    if (!showVnc || frameLoaded) return;
    const t = window.setTimeout(() => setLoadStuck(true), 12000);
    return () => window.clearTimeout(t);
  }, [showVnc, frameLoaded, id, vncNonce]);

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
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types || []).includes('Files');
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

  const vncCanvasRect = () => {
    try {
      const doc = frameRef.current?.contentDocument;
      const canvas =
        (doc?.querySelector('#noVNC_canvas') as HTMLElement | null) ??
        (doc?.querySelector('canvas') as HTMLElement | null);
      return canvas?.getBoundingClientRect() ?? null;
    } catch {
      return null;
    }
  };

  // 用户在 VNC 内真实操作（鼠标/键盘/滚轮）时续约控制权（同源 iframe 可监听）。节流 2.5s。
  // 只读用户的操作已被遮罩拦截/失焦，不会误续约；空闲不操作则超时自动释放。
  useEffect(() => {
    if (!showVnc || !id || !frameLoaded) return;
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    const onInteract = async (ev?: Event) => {
      const point = ev
        ? imeProxyEventPoint(ev as MouseEvent | TouchEvent)
        : null;
      if (point) {
        const eventType = ev?.type || '';
        const now = Date.now();
        if (
          imeProxyShouldSkipDuplicateActivation({
            eventType,
            clientX: point.clientX,
            clientY: point.clientY,
            now,
            last: imeLastActivation.current,
          })
        )
          return;
        const rect = frameRef.current?.getBoundingClientRect();
        if (rect) {
          const canvasRect = vncCanvasRect();
          const remoteGeometry = imeProxyFrameViewportGeometry({
            frame: { left: 0, top: 0, width: rect.width, height: rect.height },
            canvas: canvasRect,
          });
          if (
            imeProxyShouldActivateFromFrameClick({
              frame: imeProxyFrameRectFromViewportGeometry(remoteGeometry),
              clientX: point.clientX,
              clientY: point.clientY,
            })
          ) {
            imeProxyActivitySeq.current++;
            const remotePoint = imeProxyRemoteClickPoint({
              clientX: point.clientX,
              clientY: point.clientY,
              ...remoteGeometry,
            });
            const remoteFocus = imeProxyShouldPreClickRemoteFocus({
              mobile: imeProxyMobile,
            })
              ? api.clickInInstance(id, remotePoint.xRatio, remotePoint.yRatio)
              : Promise.resolve();
            imeRemoteFocus.current = remotePoint;
            imeQueue.current?.setFocus(id, remotePoint, remoteFocus);
            void remoteFocus.catch(() => undefined);
            imePos.current = imeProxyMobile
              ? imeProxyMobileViewportPosition({
                  viewportWidth: window.innerWidth,
                  viewportHeight: window.innerHeight,
                  visualViewportTop: window.visualViewport?.offsetTop,
                  visualViewportHeight: window.visualViewport?.height,
                })
              : imeProxyPositionFromFrameClick({
                  frame: rect,
                  clientX: point.clientX,
                  clientY: point.clientY,
                  viewportWidth: window.innerWidth,
                  viewportHeight: window.innerHeight,
                });
            if (imeProxyMobile) focusImeProxy();
            else window.setTimeout(focusImeProxy, 30);
            if (imeProxyShouldProbeOnFocusActivation({ mobile: imeProxyMobile }))
              void imeTransportProbe.current?.ensure(id);
            imeLastActivation.current = {
              eventType,
              clientX: point.clientX,
              clientY: point.clientY,
              at: now,
            };
          } else {
            blurImeProxy();
          }
        }
      }
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
    const evs = ['mousedown', 'pointerdown', 'touchstart', 'keydown', 'wheel'] as const;
    try {
      evs.forEach((e) =>
        win.addEventListener(e, onInteract, { capture: true, passive: true }),
      );
    } catch {
      return;
    }
    return () => {
      try {
        evs.forEach((e) =>
          win.removeEventListener(e, onInteract, { capture: true } as any),
        );
      } catch {
        /* ignore */
      }
    };
  }, [showVnc, id, frameLoaded, imeProxyMobile, imeProxyEnabled, control]);

  // 每次进入/重连桌面前，强制把 KasmVNC 的 enable_ime 设为【关】。
  // 原因：开启 IME 模式后，noVNC 用隐藏 textarea + 合成事件还原中文，需要前端拦截/差分，环环相扣极脆，
  // 实测会"中文混数字时丢最后两个汉字+首个数字"等损坏。中文输入改由底部「中文输入条」可靠承担
  // （面板真实 textarea 原生输入法 → xclip+xdotool 粘贴），故 VNC 直接打字回归纯 keysym：英文/数字/
  // 标点都正常、不再损坏；中文直接打不进（请用输入条）。iframe 同源共享 localStorage，加载前设好即生效。
  useEffect(() => {
    try {
      window.localStorage.setItem('enable_ime', 'false');
    } catch {
      /* 隐私模式等禁用 localStorage：忽略 */
    }
  }, [id, vncNonce]);

  // 音频/麦克风桥接：实例就绪即自动连接 kclient 的音频流（扬声器恒开，无需手动找工具条）；
  // 仅当本实例处于焦点（标签页可见且窗口聚焦）时出声/收音，失焦立即断开，避免多实例多端串音。
  useEffect(() => {
    if (!showVnc || !id) return;
    const audio = new VncAudio(id);
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
  }, [showVnc, id]);

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
      toast(`已上传 ${ok} 个文件到桌面，微信里可直接选取`, 'ok');
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
    if (!(await confirm({ title: `删除「${name}」？`, body: '将从微信桌面（~/Desktop）移除该文件。', danger: true, confirmText: '删除' }))) return;
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
    if (imeProxyEnabled) {
      focusImeProxy();
      return;
    }
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
  const pushClipboardToRemote = (
    instanceId: string,
    text: string,
  ): ImeClipboardPushResult => {
    if (instanceId !== id) return 'unavailable';
    try {
      const frame = frameRef.current;
      if (
        !frame ||
        !imeProxyFrameMatchesInstance({
          instanceId,
          frameSrc: frame.getAttribute('src') || frame.src,
        })
      )
        return 'unavailable';
      const doc = frameRef.current?.contentDocument;
      const ta = doc?.getElementById(
        'noVNC_clipboard_text',
      ) as HTMLTextAreaElement | null;
      if (!doc || !ta) return 'failed';
      ta.value = text;
      ta.dispatchEvent(
        new (frameRef.current!.contentWindow as any).Event('change', {
          bubbles: true,
        }),
      );
      return 'ok';
    } catch {
      return 'failed';
    }
  };

  const pasteTextToRemote = async (
    instanceId: string,
    text: string,
    focus?: ImeRemoteFocusPoint,
  ) => {
    if (!text) return;
    if (control && !control.free && !control.mine)
      throw new Error(`当前由 ${control.holder || '其他用户'} 操作`);
    const sender = imeSender.current;
    if (!sender) return;
    await sender.send(
      instanceId,
      text,
      focus ?? imeRemoteFocus.current ?? undefined,
    );
  };

  const queueTextToRemote = (text: string) => {
    if (!id) return;
    const queue = imeQueue.current;
    if (!queue) return;
    queue.enqueue(id, text);
  };

  const sendClip = () => {
    const t = clipText;
    if (!t) {
      toast('请先输入要发送的文本', 'error');
      return;
    }
    if (pushClipboardToRemote(id, t) === 'ok') {
      toast('已发送到容器剪贴板，请在微信输入框按 Ctrl+V 粘贴', 'ok');
    } else {
      toast('发送失败：桌面尚未连接', 'error');
    }
  };

  if (!imeBuffer.current) {
    imeBuffer.current = new ImeCommitBuffer((text) => queueTextToRemote(text));
  }
  imeBuffer.current.setCommit((text) => queueTextToRemote(text));
  if (!imeQueue.current) {
    imeQueue.current = new ImeInstanceTextQueue(
      pasteTextToRemote,
      (e: any) => toast(e?.message || '输入发送失败', 'error'),
      { diagnostics: imeDiagnostics.current },
    );
  }
  const readRemoteClipboard = async (instanceId: string) => {
    const { text } = await api.readInstanceClipboard(instanceId);
    return text;
  };
  if (!imeTransportProbe.current) {
    imeTransportProbe.current = new ImeTransportProbe({
      health: imeTransportHealth.current,
      pushClipboard: pushClipboardToRemote,
      readClipboard: readRemoteClipboard,
    });
  }
  imeTransportProbe.current.setHandlers({
    pushClipboard: pushClipboardToRemote,
    readClipboard: readRemoteClipboard,
  });
  const imeSenderHandlers: ImeRemoteTextSenderHandlers = {
    pushClipboard: pushClipboardToRemote,
    pasteClipboard: async (instanceId, focus, expectedText) => {
      await api.pasteClipboardInInstance(
        instanceId,
        focus.xRatio,
        focus.yRatio,
        expectedText,
      );
    },
    sendKey: (instanceId, key) => api.sendKeyToInstance(instanceId, key),
    typeText: (instanceId, text, focus) =>
      api.typeInInstance(instanceId, text, focus),
    readClipboard: async (instanceId) => {
      const { text } = await api.readInstanceClipboard(instanceId);
      return text;
    },
  };
  if (!imeSender.current) {
    imeSender.current = new ImeRemoteTextSender(
      {
        health: imeTransportHealth.current,
        probe: imeTransportProbe.current,
        diagnostics: imeDiagnostics.current,
      },
      imeSenderHandlers,
    );
  } else {
    imeSender.current.setHandlers(imeSenderHandlers);
  }
  imeQueue.current.setHandlers(pasteTextToRemote, (e: any) =>
    toast(e?.message || '输入发送失败', 'error'),
  );

  function focusImeProxy() {
    if (!imeProxyEnabled || !showVnc || !frameLoaded) return;
    if (control && !control.free && !control.mine) return;
    const ta = imeProxyRef.current;
    if (!ta) return;
    imeProxyActivitySeq.current++;
    ta.style.left = `${imePos.current.x}px`;
    ta.style.top = imeProxyMobile ? '' : `${imePos.current.y}px`;
    ta.value = '';
    setImeProxyTyping(false);
    setImeProxyActive(true);
    ta.focus({ preventScroll: true });
    try {
      ta.setSelectionRange(ta.value.length, ta.value.length);
    } catch {
      /* ignore */
    }
  }

  function blurImeProxy() {
    const ta = imeProxyRef.current;
    if (!ta) return;
    ta.value = '';
    setImeProxyTyping(false);
    setImeProxyActive(false);
    ta.blur();
  }

  const onImeProxyInput = (e: FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const native = e.nativeEvent as InputEvent;
    imeProxyActivitySeq.current++;
    setImeProxyTyping(!!el.value);
    imeBuffer.current?.input(el.value, !!native.isComposing);
    if (!native.isComposing) {
      el.value = '';
      setImeProxyTyping(false);
    }
  };

  const onImeProxyCompositionEnd = (
    e: CompositionEvent<HTMLTextAreaElement>,
  ) => {
    const el = e.currentTarget;
    imeProxyActivitySeq.current++;
    imeBuffer.current?.compositionEnd(el.value);
    el.value = '';
    setImeProxyTyping(false);
    window.setTimeout(focusImeProxy, 0);
  };

  const onImeProxyKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!id || e.nativeEvent.isComposing) return;
    const shortcut = imeProxyShortcutKey({
      key: e.key,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      isComposing: e.nativeEvent.isComposing,
    });
    if (shortcut) {
      e.preventDefault();
      void (async () => {
        await imeQueue.current?.flush(id);
        await api.sendKeyToInstance(id, shortcut);
      })().catch((err: any) =>
        toast(err?.message || '按键发送失败', 'error'),
      );
      return;
    }
    const editableKeys = new Set([
      'Backspace',
      'Delete',
      'Enter',
      'Tab',
      'Escape',
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'Home',
      'End',
    ]);
    if (!editableKeys.has(e.key)) return;
    e.preventDefault();
    void (async () => {
      await imeQueue.current?.flush(id);
      await api.sendKeyToInstance(id, e.key);
    })().catch((err: any) =>
      toast(err?.message || '按键发送失败', 'error'),
    );
  };

  // 中文输入条发送：把本框文本经 xclip+xdotool 直接粘进微信当前聚焦的输入框（绕开 VNC IME）。
  // 在面板的真实 textarea 里用原生输入法打字，100% 可靠，不依赖 VNC 的 enable_ime / 合成事件。
  const sendImeText = async () => {
    const t = imeText;
    if (!t.trim() || !id) return;
    setImeSending(true);
    try {
      await pasteTextToRemote(id, t);
      setImeText('');
    } catch (e: any) {
      toast(
        e?.message ||
          '发送失败：请确认实例已「升级实例」（镜像含 xclip/xdotool）',
        'error',
      );
    } finally {
      setImeSending(false);
    }
  };

  // 读取容器（微信侧）当前剪贴板内容到本框，便于把容器内复制的文字带回本地
  const pullClipboardFromRemote = () => {
    try {
      const doc = frameRef.current?.contentDocument;
      const ta = doc?.getElementById(
        'noVNC_clipboard_text',
      ) as HTMLTextAreaElement | null;
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
      body: '会重建容器（聊天记录保留），微信重新启动，约十几秒；用于修复卡死/最小化丢失等。',
      confirmText: '重启',
    });
    if (!ok) return;
    try {
      await api.instanceRestart(id);
      toast('已重启，正在重连…', 'ok');
      setFrameLoaded(false);
      setVncNonce((n) => n + 1); // 强制 iframe 重挂、重连
      await reload();
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

  const title = inst?.name || '微信实例';

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
              className={'ws-action' + (imeProxyEnabled ? ' on' : '')}
              title="本机输入法直通：中英文、数字、标点混输，上屏后立即进入微信"
              onClick={() => setImeProxyEnabled((v) => !v)}
            >
              即时输入
            </button>
            <button
              className={'ws-action' + (imeBar ? ' on' : '')}
              title="打开兜底输入条：输入一段后发送到微信"
              onClick={() => setImeBar((v) => !v)}
            >
              输入条
            </button>
            <button
              className="ws-action"
              title="把文本发送到容器剪贴板（局域网 http 下也可用）"
              onClick={() => setShowClip((v) => !v)}
            >
              剪贴板
            </button>
            {isAdmin && (
              <button
                className="ws-action"
                title="重启实例（修复卡死/最小化丢失）"
                onClick={restartInstance}
              >
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
            <button
              className="btn btn-primary iv-notice-btn"
              onClick={() => nav('/')}
            >
              返回主页
            </button>
          </div>
        </div>
      ) : offline ? (
        <div className="iv-stage iv-center">
          <div className="iv-notice">
            <div className="iv-notice-title">
              {inst.runtime === 'missing' ? '容器尚未创建' : '实例已停止'}
            </div>
            {isAdmin ? (
              <button
                className="btn btn-primary iv-notice-btn"
                disabled={starting}
                onClick={start}
              >
                {starting
                  ? '启动中…'
                  : inst.runtime === 'missing'
                    ? '创建并启动'
                    : '启动实例'}
              </button>
            ) : (
              <div className="iv-notice-sub">请联系管理员启动该实例</div>
            )}
            {isAdmin && (
              <button
                className="btn-text"
                onClick={() => window.open(api.instanceLogsUrl(id), '_blank')}
              >
                查看日志
              </button>
            )}
          </div>
        </div>
      ) : ['downloading', 'extracting', 'installing'].includes(
          inst.wechat.phase,
        ) ? (
        <div className="iv-stage iv-center">
          <div className="iv-notice">
            <div className="spinner" />
            <div className="iv-notice-title">微信安装中…</div>
            <div className="iv-notice-sub">
              {inst.wechat.message || '请稍候'}
              {inst.wechat.percent >= 0
                ? ` · ${inst.wechat.percent}%`
                : ''}{' '}
              ——完成后自动进入，无需刷新
            </div>
          </div>
        </div>
      ) : !installed ? (
        <div className="iv-stage iv-center">
          <div className="iv-notice">
            <div className="iv-notice-title">
              {inst.wechat.phase === 'error' ? '微信安装出错' : '微信尚未安装'}
            </div>
            <div className="iv-notice-sub">
              {inst.wechat.phase === 'error'
                ? inst.wechat.message || '安装失败，可在「管理」重试'
                : '该实例容器已就绪，但尚未安装微信'}
            </div>
            {isAdmin ? (
              <button
                className="btn btn-primary iv-notice-btn"
                onClick={() => nav('/admin')}
              >
                去「管理」
                {inst.wechat.phase === 'error' ? '重试 / 更新' : '下载安装'}
              </button>
            ) : (
              <div className="iv-notice-sub">
                请联系管理员在「管理」中下载安装微信
              </div>
            )}
            {isAdmin && (
              <button
                className="btn-text"
                onClick={() => window.open(api.instanceLogsUrl(id), '_blank')}
              >
                查看日志
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="iv-stage iv-stage--vnc">
          <div
            className="iv-canvas"
            onMouseDown={() => window.setTimeout(focusImeProxy, 0)}
          >
            <iframe
              key={`${id}:${vncNonce}`}
              ref={frameRef}
              className="iv-frame"
              src={desktopUrl(id)}
              title="电脑版微信"
              allow="clipboard-read; clipboard-write; microphone; camera; autoplay"
              onLoad={() => {
                setFrameLoaded(true);
                setTimeout(() => {
                  focusFrame(); // 加载完把键盘焦点交给 VNC
                  window.setTimeout(focusImeProxy, 0);
                  injectVncStyle(); // 让原生控制条在深色背景下可见
                  // 注意：不再调用 patchVncIme —— enable_ime 已关；中文由透明输入代理承接，
                  // 上屏后通过剪贴板 + Ctrl+V 进微信，输入条只作为兜底。
                }, 500);
              }}
            />

            {!frameLoaded && !loadStuck && (
              <div className="iv-loading">
                <div className="spinner" />
                <div className="iv-loading-text">正在连接桌面…</div>
                <div className="iv-loading-sub">首次进入请扫码登录微信</div>
                <div className="iv-loading-sub">
                  拖文件到此处即可上传；声音自动开启，点一下画面即可出声
                </div>
                {!window.isSecureContext && (
                  <div className="iv-loading-warn">
                    当前非 HTTPS
                    访问，浏览器将禁用麦克风与摄像头（音频播放不受影响）
                  </div>
                )}
              </div>
            )}

            {!frameLoaded && loadStuck && (
              <div className="iv-loading">
                <div className="iv-loading-text">桌面无响应</div>
                <div className="iv-loading-sub">
                  连接超时。可能是实例临时卡住，先「重新连接」；若仍无效请「重启实例」。
                </div>
                <div className="iv-stuck-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      setLoadStuck(false);
                      setFrameLoaded(false);
                      setVncNonce((n) => n + 1); // 强制 iframe 重挂、重新请求
                    }}
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
                  管理员也可稍候，面板会自动检测无响应实例并重启自愈。
                </div>
              </div>
            )}

            {dragging && (
              <div
                className="iv-drop"
                onDrop={onDrop}
                onDragOver={(e) => e.preventDefault()}
              >
                <div className="drop-card">
                  <div className="drop-icon">⬇</div>
                  <div className="drop-title">松开上传到微信桌面</div>
                  <div className="drop-sub">
                    上传后在微信里「+ / 文件」选择即可
                  </div>
                </div>
              </div>
            )}

            {control && !control.free && !control.mine && (
              <div className="iv-lock">
                <div className="iv-lock-card">
                  <div className="iv-lock-title">
                    「{control.holder}」正在操作
                  </div>
                  <div className="iv-lock-sub">
                    为避免多端互相干扰，你当前为只读模式。
                  </div>
                  <button
                    className="btn btn-primary iv-notice-btn"
                    onClick={takeControl}
                  >
                    申请控制
                  </button>
                </div>
              </div>
            )}

            {showFiles && (
              <div className="iv-files">
                <div className="files-head">
                  <span>文件传输</span>
                  <button
                    className="btn-text"
                    onClick={() => setShowFiles(false)}
                  >
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
                <button
                  className="btn btn-primary files-upload"
                  disabled={uploading}
                  onClick={() => fileInput.current?.click()}
                >
                  {uploading ? '上传中…' : '＋ 选择文件上传'}
                </button>
                <div className="files-hint">
                  也可直接把文件拖进来。下方为桌面（~/Desktop）里的文件，微信收到的文件另存到桌面即可在此下载。
                </div>
                <div className="files-list">
                  {files.length === 0 && (
                    <div
                      className="muted small"
                      style={{ padding: '10px 2px' }}
                    >
                      暂无文件
                    </div>
                  )}
                  {files.map((f) => (
                    <div key={f.name} className="files-item">
                      <a
                        className="files-dl"
                        href={api.downloadFileUrl(id, f.name)}
                        download={f.name}
                        title="下载"
                      >
                        <span className="files-name">{f.name}</span>
                        <span className="files-size">
                          {humanSize(f.size)} ↓
                        </span>
                      </a>
                      <button
                        className="files-del"
                        title="删除"
                        onClick={() => delFile(f.name)}
                      >
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
                  <button
                    className="btn-text"
                    onClick={() => setShowClip(false)}
                  >
                    关闭
                  </button>
                </div>
                <textarea
                  className="clip-area"
                  value={clipText}
                  onChange={(e) => setClipText(e.target.value)}
                  placeholder="在此输入或粘贴文本，点「发送到微信」后到微信输入框按 Ctrl+V 粘贴"
                  rows={5}
                />
                <button
                  className="btn btn-primary files-upload"
                  onClick={sendClip}
                >
                  发送到微信（容器剪贴板）
                </button>
                <button
                  className="btn-text"
                  style={{ alignSelf: 'flex-start', marginTop: 6 }}
                  onClick={pullClipboardFromRemote}
                >
                  ↓ 读取容器剪贴板到此框
                </button>
                <div className="files-hint">
                  局域网 http
                  访问时浏览器会禁用系统级剪贴板同步，故用此框中转：文本→容器剪贴板，再在微信里
                  Ctrl+V。
                </div>
              </div>
            )}
          </div>

          <textarea
            ref={imeProxyRef}
            className={imeProxyClassName({
              mobile: imeProxyMobile,
              typing: imeProxyTyping,
              active: imeProxyActive,
            })}
            aria-label="远程桌面输入代理"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            enterKeyHint="send"
            inputMode="text"
            placeholder=" "
            spellCheck={false}
            onCompositionStart={() => imeBuffer.current?.compositionStart()}
            onCompositionEnd={onImeProxyCompositionEnd}
            onInput={onImeProxyInput}
            onKeyDown={onImeProxyKeyDown}
          />

          {imeBar && (
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
                placeholder="中文输入这里 → 回车送进微信（先点好微信的输入框）。Shift+回车换行。"
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
