// VNC 音频/麦克风桥接（扬声器 + 麦克风）。
//
// 背景：linuxserver KasmVNC 的音频不在我们内嵌的原生 noVNC 客户端里，而在它外层的 kclient
// （容器内 nginx :3000 / → kclient :6900）通过 socket.io（路径 audio/socket.io）提供：
//   - 扬声器：服务端把 PulseAudio sink 的 PCM 通过 'audio' 事件推下来，前端用 Web Audio 播放；
//   - 麦克风：前端采集 Int16 通过 'micdata' 事件上传，服务端灌进 PulseAudio。
// 我们没有内嵌 kclient（会破坏对原生客户端的 IME / 剪贴板 / 控制条定制），故在面板父页面直接
// 复刻它的音频客户端，连到经面板反代的 /desktop/<id>/audio/socket.io。这样还能精确控制：
//   - 「强制开启」：实例就绪即自动连接、首个用户手势后开始播放（浏览器自动播放策略所限）；
//   - 「焦点不在该实例时断开」：标签页隐藏 / 失焦 / 离开页面时关闭，避免多实例多端互相串音。
//
// 麦克风需要「安全上下文」(HTTPS 或 localhost) 才有 getUserMedia；局域网 http 下浏览器禁用，
// 此时自动跳过麦克风、只保留扬声器。

// kclient 服务端用的 socket.io 版本未知，为避免协议不匹配，动态加载它自带的 socket.io.js
// （经反代取 /desktop/<id>/audio/socket.io/socket.io.js），用全局 io，而非打包我们自己的版本。
function loadIo(id: string): Promise<any> {
  const w = window as any;
  if (w.io) return Promise.resolve(w.io);
  const existing = document.getElementById('woc-socketio') as HTMLScriptElement | null;
  if (existing && (existing as any)._wocPromise) return (existing as any)._wocPromise;
  const p = new Promise<any>((resolve, reject) => {
    const s = document.createElement('script');
    s.id = 'woc-socketio';
    s.src = `/desktop/${encodeURIComponent(id)}/audio/socket.io/socket.io.js`;
    s.onload = () => ((window as any).io ? resolve((window as any).io) : reject(new Error('io 未就绪')));
    s.onerror = () => reject(new Error('加载 socket.io 失败'));
    document.head.appendChild(s);
    (s as any)._wocPromise = p;
  });
  return p;
}

// PCM 播放器：忠实复刻 kclient 的解码/调度（Int16 立体声 @ 44100 → Web Audio），
// 这套参数与服务端音频格式匹配，改动易出杂音，故照搬。
class PcmPlayer {
  audioCtx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private startTime = 0;
  private buffer: Float32Array = new Float32Array(0);
  private playing = false;
  private lock = false;
  private resetTimer: number | undefined;

  init() {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    this.audioCtx = new Ctx({ sampleRate: 44100 });
    this.audioCtx!.resume().catch(() => {});
    this.gain = this.audioCtx!.createGain();
    this.gain.gain.value = 1;
    this.gain.connect(this.audioCtx!.destination);
    this.startTime = this.audioCtx!.currentTime;
    // 与 kclient 一致：100ms 内无新数据则清空缓冲，避免拖尾/堆积
    this.resetTimer = window.setInterval(() => {
      if (this.playing) {
        if (!this.lock) {
          this.buffer = new Float32Array(0);
          this.playing = false;
        }
        this.lock = false;
      }
    }, 100);
  }

  feed(data: ArrayBuffer) {
    if (!this.audioCtx) return;
    this.lock = true;
    const i16 = new Int16Array(data);
    const f32 = Float32Array.from(i16, (x) => x / 32767);
    const merged = new Float32Array(this.buffer.length + f32.length);
    merged.set(this.buffer);
    merged.set(f32, this.buffer.length);
    this.buffer = merged;
    const frames = this.buffer.length / 2; // 立体声
    const duration = frames / 44100 / 2; // 与 kclient 的 buffAudio.duration/2 等价
    if (duration > 0.05 || this.playing) {
      this.playing = true;
      const buffAudio = this.audioCtx.createBuffer(2, this.buffer.length, 44100);
      const left = buffAudio.getChannelData(0);
      const right = buffAudio.getChannelData(1);
      let bc = 0;
      let off = 1;
      for (let i = 0; i < frames; i++) {
        left[i] = this.buffer[bc];
        bc += 2;
        right[i] = this.buffer[off];
        off += 2;
      }
      this.buffer = new Float32Array(0);
      if (this.startTime < this.audioCtx.currentTime) this.startTime = this.audioCtx.currentTime;
      const src = this.audioCtx.createBufferSource();
      src.buffer = buffAudio;
      src.connect(this.gain!);
      src.start(this.startTime);
      this.startTime += buffAudio.duration / 2;
    }
  }

  destroy() {
    if (this.resetTimer) window.clearInterval(this.resetTimer);
    this.resetTimer = undefined;
    this.buffer = new Float32Array(0);
    this.playing = false;
    try {
      this.audioCtx?.close();
    } catch {
      /* ignore */
    }
    this.audioCtx = null;
    this.gain = null;
  }
}

export class VncAudio {
  private id: string;
  private socket: any = null;
  private player: PcmPlayer | null = null;
  private active = false; // 当前实例是否处于"焦点中"（应出声）
  private opened = false; // 是否已对服务端 emit('open')
  private micStream: MediaStream | null = null;
  private micCtx: AudioContext | null = null;
  private micNode: ScriptProcessorNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private gestureBound = false;
  private destroyed = false;
  private micEnabled = false; // 麦克风默认关：避免一打开实例就 getUserMedia 抢占麦克风（会把 AirPods 切到低质通话模式）

  constructor(id: string, micEnabled = false) {
    this.id = id;
    this.micEnabled = micEnabled;
  }

  // 麦克风开关：关 → 释放麦克风（AirPods 回到高质输出）；开且本实例在焦点 → 采集并上传。扬声器不受影响。
  setMicEnabled(on: boolean) {
    if (this.destroyed) return;
    this.micEnabled = on;
    if (on && this.active) this.startMic();
    else this.stopMic();
  }

  // 建立 socket 连接（不自动出声，由 setActive 控制）。
  async connect() {
    if (this.socket || this.destroyed) return;
    const io = await loadIo(this.id);
    if (this.destroyed) return;
    this.socket = io(window.location.origin, {
      path: `/desktop/${this.id}/audio/socket.io`,
      transports: ['websocket', 'polling'],
      withCredentials: true,
      reconnection: true,
    });
    this.socket.on('audio', (data: ArrayBuffer) => {
      if (this.active && this.player) this.player.feed(data);
    });
    this.socket.on('connect', () => {
      if (this.active) this.open();
    });
  }

  // 焦点变化时调用：true=本实例获得焦点（出声+收音），false=失焦（断开设备）。
  setActive(on: boolean) {
    if (this.destroyed) return;
    this.active = on;
    if (on) {
      this.open();
      this.startMic();
    } else {
      this.close();
      this.stopMic();
    }
  }

  // 外部（同源 iframe 内的用户手势）通知：恢复被浏览器自动播放策略挂起的播放上下文。
  // 关键：ensureResumeOnGesture 的监听绑在父窗口上，而用户点的是 iframe 内的桌面画面，事件不冒泡到父窗口，
  // 故"点画面"无法解挂起。这里由 Desktop 在 iframe 手势时主动调用，让点桌面也能出声（不必重开声音开关）。
  resumePlayback() {
    if (this.destroyed) return;
    this.player?.audioCtx?.resume().catch(() => {});
  }

  private open() {
    if (!this.socket || !this.socket.connected) return;
    if (!this.opened) {
      this.socket.emit('open', '');
      this.opened = true;
    }
    if (!this.player) {
      this.player = new PcmPlayer();
      this.player.init();
    }
    this.ensureResumeOnGesture();
  }

  private close() {
    if (this.socket && this.opened) {
      try {
        this.socket.emit('close', '');
      } catch {
        /* ignore */
      }
    }
    this.opened = false;
    this.player?.destroy();
    this.player = null;
  }

  // 浏览器自动播放策略：AudioContext 常被挂起，需用户手势恢复。绑定一次性手势监听，
  // 用户点进画面/按键时自动 resume，实现"无需手动点工具条即可出声"。
  private ensureResumeOnGesture() {
    const ctx = this.player?.audioCtx;
    if (!ctx) return;
    if (ctx.state !== 'suspended' || this.gestureBound) return;
    this.gestureBound = true;
    const resume = () => {
      this.player?.audioCtx?.resume().catch(() => {});
      window.removeEventListener('pointerdown', resume, true);
      window.removeEventListener('keydown', resume, true);
      this.gestureBound = false;
    };
    window.addEventListener('pointerdown', resume, true);
    window.addEventListener('keydown', resume, true);
  }

  private async startMic() {
    if (!this.micEnabled) return; // 麦克风开关关闭：不 getUserMedia、不抢占麦克风
    // 麦克风需安全上下文（HTTPS / localhost）；http 局域网下静默跳过，只保留扬声器。
    if (this.micCtx || !this.socket) return;
    const md = navigator.mediaDevices;
    if (!window.isSecureContext || !md || !md.getUserMedia) return;
    try {
      const stream = await md.getUserMedia({ audio: true });
      if (this.destroyed || !this.active) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.micStream = stream;
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      this.micCtx = new Ctx();
      this.micSource = this.micCtx!.createMediaStreamSource(stream);
      this.micNode = this.micCtx!.createScriptProcessor(512, 1, 1);
      this.micSource.connect(this.micNode);
      this.micNode.connect(this.micCtx!.destination);
      this.micNode.onaudioprocess = (e) => {
        if (!this.active || !this.socket) return;
        const input = e.inputBuffer.getChannelData(0);
        // 简单能量门限：近乎静音不上传，省带宽（替代 kclient 的 JSON.size 启发式）
        let peak = 0;
        for (let i = 0; i < input.length; i++) {
          const a = input[i] < 0 ? -input[i] : input[i];
          if (a > peak) peak = a;
        }
        if (peak < 0.01) return;
        const i16 = Int16Array.from(input, (x) => Math.max(-32768, Math.min(32767, x * 32767)));
        this.socket.emit('micdata', i16.buffer);
      };
    } catch {
      this.stopMic();
    }
  }

  private stopMic() {
    try {
      if (this.micNode) this.micNode.onaudioprocess = null as any;
      this.micNode?.disconnect();
      this.micSource?.disconnect();
      this.micStream?.getTracks().forEach((t) => t.stop());
      this.micCtx?.close();
    } catch {
      /* ignore */
    }
    this.micNode = null;
    this.micSource = null;
    this.micStream = null;
    this.micCtx = null;
  }

  destroy() {
    this.destroyed = true;
    this.close();
    this.stopMic();
    try {
      this.socket?.disconnect();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }
}
