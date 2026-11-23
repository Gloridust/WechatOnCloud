// 未读消息通知（1.6.6）：订阅 SSE，收到"有未读"时做三件事——
// 1) 浏览器标签标题闪烁（切走也能注意到）；2) 桌面 Notification（需授权）；3) 短提示音。
// 只在后端开关打开时订阅；用户对某实例可单独静音（localStorage）。
import { useEffect, useRef, useState } from 'react';
import { api } from './api';

export interface UnreadNotifyState {
  enabled: boolean; // 后端总开关
  muted: boolean; // 本实例是否静音
  hasUnread: boolean; // 当前是否有未读
  supported: boolean; // 浏览器是否支持桌面通知
  grant: () => Promise<void>; // 请求桌面通知权限
  toggleMute: () => void;
  check: () => Promise<void>; // 手动检查一次
}

const muteKey = (id: string | undefined) => `woc_unread_muted_${id || ''}`;
const baseTitle = typeof document !== 'undefined' ? document.title : '';

export function useUnreadNotify(id: string | undefined, instName: string): UnreadNotifyState {
  const [enabled, setEnabled] = useState(false);
  const [muted, setMuted] = useState(() => {
    try { return window.localStorage.getItem(muteKey(id)) === '1'; } catch { return false; }
  });
  const [hasUnread, setHasUnread] = useState(false);
  const [supported] = useState(() => typeof window !== 'undefined' && 'Notification' in window);
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported',
  );
  const blinkRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // 提示音：用 Web Audio 合成两声短"叮"，无需音频文件。
  const beep = () => {
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ctx = audioCtxRef.current || (audioCtxRef.current = new Ctx());
      [0, 0.18].forEach((delay) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
        g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + delay + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.14);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + delay);
        o.stop(ctx.currentTime + delay + 0.15);
      });
    } catch { /* ignore */ }
  };

  const stopBlink = () => {
    if (blinkRef.current !== null) { window.clearInterval(blinkRef.current); blinkRef.current = null; }
    document.title = baseTitle;
  };
  const startBlink = () => {
    if (blinkRef.current !== null) return;
    let on = false;
    blinkRef.current = window.setInterval(() => {
      on = !on;
      document.title = on ? '● 新消息' : baseTitle;
    }, 900);
  };

  const alertNow = (badges: number) => {
    if (muted) return;
    startBlink();
    beep();
    if (supported && Notification.permission === 'granted') {
      try {
        new Notification(`${instName} 有新消息`, {
          body: badges > 0 ? `检测到 ${badges} 处未读，点开面板查看` : '点开面板查看',
          tag: `woc-unread-${id}`,
        } as NotificationOptions);
      } catch { /* ignore */ }
    }
  };

  // 查询后端开关 + 订阅 SSE。
  useEffect(() => {
    if (!id) return;
    let es: EventSource | null = null;
    let alive = true;
    api.unreadConfig(id)
      .then((cfg) => {
        if (!alive || !cfg.enabled) return;
        setEnabled(true);
        setHasUnread(cfg.hasUnread);
        if (cfg.hasUnread) startBlink();
        es = new EventSource(`/api/instances/${id}/unread/events`);
        es.addEventListener('unread', (e) => {
          try {
            const d = JSON.parse((e as MessageEvent).data);
            setHasUnread(d.hasUnread);
            if (d.hasUnread) alertNow(d.badges || 0);
            else stopBlink();
          } catch { /* ignore */ }
        });
        es.onerror = () => { /* EventSource 自动重连 */ };
      })
      .catch(() => { /* 后端未开启或请求失败：静默 */ });
    return () => {
      alive = false;
      es?.close();
      stopBlink();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, muted, instName]);

  // 标签页重新获得焦点时，停止闪烁（用户已经看到）。
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === 'visible') stopBlink(); };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const grant = async () => {
    if (!supported) return;
    try {
      const p = await Notification.requestPermission();
      setPerm(p);
    } catch { /* ignore */ }
  };
  const toggleMute = () => {
    setMuted((v) => {
      const nv = !v;
      try { window.localStorage.setItem(muteKey(id), nv ? '1' : '0'); } catch { /* ignore */ }
      if (nv) stopBlink();
      return nv;
    });
  };
  const check = async () => {
    if (!id) return;
    try {
      const r = await api.unreadCheck(id);
      setHasUnread(r.hasUnread);
      if (r.hasUnread) alertNow(r.badges || 0);
      else stopBlink();
    } catch { /* ignore */ }
  };

  return { enabled, muted, hasUnread, supported: supported && perm !== 'denied', grant, toggleMute, check };
}
