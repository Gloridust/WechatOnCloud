// 诊断包里「崩溃定位」相关的纯解析逻辑（不依赖 docker，便于单独验证）：
//   · 宿主 CPU 型号与指令集（推出 x86-64 微架构级别、是否在虚拟机里）
//   · crashpad 写下的 minidump 只取元数据：信号、崩溃模块+偏移、崩溃处指令字节
// 起因 #166：微信内置浏览器（看公众号的窗口，Chromium 内核 WeChatAppEx）崩溃页只显示「错误代码：SIGILL」。
// x86 上 SIGILL 可能是 Chromium 主动崩溃（CHECK / NOTREACHED / 内存不足 → int3;ud2、libc++ 加固断言 / CFI → ud2），
// 也可能是 CPU 真不支持某条指令（虚拟机裁掉了 AVX、库按新指令集编译没做运行时检测……）。两者只看崩溃页分不出来，
// 看转储里崩溃处的那几个字节就能分：0f 0b 是 ud2（主动崩溃），c4/c5/62 开头是 AVX/AVX-512 指令（指令集问题）。
//
// ⚠️ 隐私：诊断包会被用户公开贴到 GitHub。转储里有崩溃进程的栈和堆内存（可能含聊天内容、网址里的登录票据），
// 这里绝不输出任何内存内容，只输出：信号与 si_code、崩溃地址所在模块名+偏移+build-id、崩溃处指令字节（仅当该地址
// 落在已加载模块里——那是公开发布的二进制本身的字节；不在模块里如 JIT 代码，只给分类不给字节）、白名单注解
//（进程类型 / 产品 / 版本 / 架构）、转储记录的 CPU 型号、崩溃线程名。注解里的命令行开关、页面来源等一律不碰。

import { readFileSync } from 'node:fs';

// ---------- 宿主 CPU ----------

// psABI 的 x86-64 微架构级别（与 glibc-hwcaps 判定同一套），值是 /proc/cpuinfo 里的 flag 名。
// v2 的 SSE3 在 cpuinfo 里叫 pni；v3 的 LZCNT 叫 abm、OSXSAVE 以 xsave 代表（内核没启用 XSAVE 时会去掉该 flag）。
const X86_LEVELS: { level: string; flags: string[] }[] = [
  { level: 'v2', flags: ['cx16', 'lahf_lm', 'popcnt', 'pni', 'sse4_1', 'sse4_2', 'ssse3'] },
  { level: 'v3', flags: ['avx', 'avx2', 'bmi1', 'bmi2', 'f16c', 'fma', 'abm', 'movbe', 'xsave'] },
  { level: 'v4', flags: ['avx512f', 'avx512bw', 'avx512cd', 'avx512dq', 'avx512vl'] },
];
// 列进诊断包的关键 flag（显示名 → cpuinfo 名）
const X86_KEY_FLAGS: [string, string][] = [
  ['sse3', 'pni'], ['ssse3', 'ssse3'], ['sse4_1', 'sse4_1'], ['sse4_2', 'sse4_2'], ['popcnt', 'popcnt'],
  ['avx', 'avx'], ['avx2', 'avx2'], ['fma', 'fma'], ['bmi1', 'bmi1'], ['bmi2', 'bmi2'], ['f16c', 'f16c'],
  ['movbe', 'movbe'], ['aes', 'aes'], ['pclmulqdq', 'pclmulqdq'], ['sha_ni', 'sha_ni'], ['avx512f', 'avx512f'],
  ['avx512bw', 'avx512bw'], ['avx512vl', 'avx512vl'], ['avx_vnni', 'avx_vnni'],
];

export function x86LevelOf(flags: Set<string>): { level: string; missingNext: string[] } {
  let level = 'v1';
  for (const l of X86_LEVELS) {
    const missing = l.flags.filter((f) => !flags.has(f));
    if (missing.length) return { level, missingNext: missing.map((f) => (f === 'pni' ? 'sse3' : f === 'abm' ? 'lzcnt(abm)' : f)) };
    level = l.level;
  }
  return { level, missingNext: [] };
}

// 读面板自己看到的 /proc/cpuinfo：/proc/cpuinfo 不随容器命名空间隔离，面板与实例在同一宿主内核上，看到的是同一份。
export function describeHostCpu(cpuinfo: string): string {
  const blocks = cpuinfo.split(/\n\s*\n/).filter((b) => b.trim());
  if (!blocks.length) return '（读不到 /proc/cpuinfo）\n';
  const field = (b: string, k: string) => {
    const m = b.match(new RegExp(`^${k}\\s*:\\s*(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  const first = blocks.find((b) => /^(flags|Features)\s*:/m.test(b)) || blocks[0];
  const nproc = (cpuinfo.match(/^processor\s*:/gm) || []).length;
  let s = '';
  const flagsLine = field(first, 'flags');
  if (flagsLine) {
    const flags = new Set(flagsLine.split(/\s+/));
    const model = field(first, 'model name') || '（未知型号）';
    s += `型号: ${model} · ${field(first, 'vendor_id')} family ${field(first, 'cpu family')} model ${field(first, 'model')} stepping ${field(first, 'stepping')}`;
    const mc = field(first, 'microcode');
    s += mc ? ` · 微码 ${mc}\n` : '\n';
    s += `逻辑 CPU: ${nproc || '?'} · 虚拟机: ${flags.has('hypervisor') ? '是（有 hypervisor 标志：CPU 型号/指令集可能被虚拟化层裁剪，PVE/ESXi 等请把虚拟机 CPU 类型设为 host）' : '否'}\n`;
    const lv = x86LevelOf(flags);
    s += `x86-64 微架构级别: ${lv.level}${lv.missingNext.length ? `（达到下一级还缺: ${lv.missingNext.join(' ')}）` : ''}\n`;
    const has = X86_KEY_FLAGS.filter(([, f]) => flags.has(f)).map(([n]) => n);
    const lack = X86_KEY_FLAGS.filter(([, f]) => !flags.has(f)).map(([n]) => n);
    s += `关键指令集: 有 ${has.join(' ') || '（无）'} · 无 ${lack.join(' ') || '（无）'}\n`;
    return s;
  }
  const feat = field(first, 'Features');
  if (feat) {
    const f = new Set(feat.split(/\s+/));
    s += `ARM CPU: implementer ${field(first, 'CPU implementer') || '?'} · part ${field(first, 'CPU part') || '?'} · variant ${field(first, 'CPU variant') || '?'} · revision ${field(first, 'CPU revision') || '?'}\n`;
    s += `逻辑 CPU: ${nproc || '?'}\n`;
    s += `Features: ${feat}\n`;
    // 已知坑：内核报告 SME/SME2 而 CPU 没有 SVE（Apple M4 一类）时，微信内置浏览器按 hwcap 选中 SME2 代码路径
    // → 执行 SVE 指令 → SIGILL（ltaoo/wx_channels_download#570，视频号播放即崩）。
    const sme = ['sme', 'sme2'].filter((x) => f.has(x));
    if (sme.length && !f.has('sve')) s += `⚠️ 内核报告 ${sme.join('/')} 但没有 sve：微信内置浏览器可能选错 SIMD 路径而 SIGILL（见 wx_channels_download#570）\n`;
    return s;
  }
  return `（/proc/cpuinfo 里没有 flags / Features 行）\n`;
}

// 内核内存策略与总量：overcommit=2（严格记账）或 max_map_count 过小时，Chromium 预留大块地址空间失败 →
// 走「内存不足」主动崩溃。/proc/sys/vm 与 /proc/meminfo 同样不随容器隔离。
export function describeHostMemPolicy(): string {
  const rd = (p: string) => {
    try {
      return readFileSync(p, 'utf8').trim();
    } catch {
      return '?';
    }
  };
  let s = `内核内存策略: vm.overcommit_memory=${rd('/proc/sys/vm/overcommit_memory')} · overcommit_ratio=${rd('/proc/sys/vm/overcommit_ratio')} · vm.max_map_count=${rd('/proc/sys/vm/max_map_count')}\n`;
  try {
    const mi = readFileSync('/proc/meminfo', 'utf8');
    const kb = (k: string) => {
      const m = mi.match(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm'));
      return m ? `${(Number(m[1]) / 1048576).toFixed(1)}G` : '?';
    };
    s += `内存: 总 ${kb('MemTotal')} · 可用 ${kb('MemAvailable')} · Swap ${kb('SwapTotal')}（剩 ${kb('SwapFree')}） · CommitLimit ${kb('CommitLimit')} · Committed_AS ${kb('Committed_AS')}\n`;
  } catch {
    s += '内存: 读不到 /proc/meminfo\n';
  }
  return s;
}

// ---------- minidump ----------

const MD_SIGNATURE = 0x504d444d; // 'MDMP'
const ST_MODULE_LIST = 4;
const ST_MEMORY_LIST = 5;
const ST_EXCEPTION = 6;
const ST_SYSTEM_INFO = 7;
const ST_THREAD_NAMES = 24;
const ST_CRASHPAD_INFO = 0x43500001;
const ARCH_X86 = 0;
const ARCH_AMD64 = 9;
const ARCH_ARM64 = 12;

const SIGNALS: Record<number, string> = {
  1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE',
  9: 'SIGKILL', 11: 'SIGSEGV', 13: 'SIGPIPE', 15: 'SIGTERM', 31: 'SIGSYS',
};
const SI_CODES: Record<number, Record<number, string>> = {
  4: { 1: 'ILL_ILLOPC', 2: 'ILL_ILLOPN', 3: 'ILL_ILLADR', 4: 'ILL_ILLTRP', 5: 'ILL_PRVOPC', 6: 'ILL_PRVREG', 7: 'ILL_COPROC', 8: 'ILL_BADSTK' },
  5: { 1: 'TRAP_BRKPT', 2: 'TRAP_TRACE' },
  7: { 1: 'BUS_ADRALN', 2: 'BUS_ADRERR', 3: 'BUS_OBJERR' },
  11: { 1: 'SEGV_MAPERR', 2: 'SEGV_ACCERR', 3: 'SEGV_BNDERR', 4: 'SEGV_PKUERR' },
};
const SI_GENERIC: Record<number, string> = { 0: 'SI_USER', 0x80: 'SI_KERNEL', [-1]: 'SI_QUEUE', [-6]: 'SI_TKILL' };
// 白名单注解：只取这些键，且值只保留短的可打印 ASCII。其余（命令行开关、页面来源、实验分组……）一律不输出。
const SIMPLE_ANNOTATIONS = ['prod', 'ver', 'plat'];
const MODULE_ANNOTATIONS = ['ptype', 'osarch'];

class Oob extends Error {}

// 带边界检查的小端读取；越界抛 Oob（转储被截断 / 结构损坏），由调用方降级为「读不到这一项」。
class Reader {
  constructor(private readonly b: Buffer) {}
  private chk(o: number, n: number): void {
    if (!Number.isInteger(o) || o < 0 || o + n > this.b.length) throw new Oob();
  }
  u8(o: number): number {
    this.chk(o, 1);
    return this.b[o];
  }
  u16(o: number): number {
    this.chk(o, 2);
    return this.b.readUInt16LE(o);
  }
  u32(o: number): number {
    this.chk(o, 4);
    return this.b.readUInt32LE(o);
  }
  i32(o: number): number {
    this.chk(o, 4);
    return this.b.readInt32LE(o);
  }
  u64(o: number): bigint {
    this.chk(o, 8);
    return this.b.readBigUInt64LE(o);
  }
  bytes(o: number, n: number): Buffer {
    this.chk(o, n);
    return this.b.subarray(o, o + n);
  }
  // MINIDUMP_STRING：u32 字节长度 + UTF-16LE
  mdString(rva: number, max = 512): string {
    const len = Math.min(this.u32(rva), max * 2);
    return this.bytes(rva + 4, len - (len % 2)).toString('utf16le');
  }
  // crashpad 的 MinidumpUTF8String / MinidumpByteArray：u32 长度 + 字节
  utf8(rva: number, max = 256): string {
    const len = Math.min(this.u32(rva), max);
    return this.bytes(rva + 4, len).toString('utf8');
  }
}

const hex = (v: bigint | number) => '0x' + v.toString(16);
const printable = (s: string, max: number) => s.replace(/[^\x20-\x7e]/g, '').slice(0, max);
const baseName = (p: string) => printable(p.split('/').pop() || p, 64);

// 崩溃处指令分类。x86-64 的 at[] 从 PC 起，prev 是 PC 前一字节（判断 int3;ud2 序列用）。
function classifyX86(sig: number, prev: number | null, at: Buffer): string {
  if (sig === 5 && prev === 0xcc) return 'int3 断点（Chromium 主动崩溃 IMMEDIATE_CRASH：CHECK/NOTREACHED/内存不足等）——不是 CPU 不支持的指令';
  if (at[0] === 0x0f && at[1] === 0x0b) {
    return prev === 0xcc
      ? 'ud2，紧跟在 int3 之后（Chromium 主动崩溃序列 int3;ud2：CHECK/NOTREACHED/内存不足等）——不是 CPU 不支持的指令'
      : 'ud2（编译器插入的陷阱：libc++ 加固断言 / CFI 校验 / __builtin_trap 等，属主动崩溃）——不是 CPU 不支持的指令';
  }
  if (at[0] === 0xcc) return 'int3';
  let i = 0;
  while (i < at.length && [0x66, 0x67, 0xf2, 0xf3, 0x2e, 0x3e, 0x26, 0x36, 0x64, 0x65, 0xf0].includes(at[i])) i++;
  if (i < at.length && at[i] >= 0x40 && at[i] <= 0x4f) i++; // REX
  const op = at[i];
  if (op === 0x62) return 'EVEX 编码指令（AVX-512）——若 CPU 不支持 AVX-512，就是指令集问题';
  if (op === 0xc4 || op === 0xc5) return 'VEX 编码指令（AVX/AVX2/FMA/BMI 等）——若 CPU 不支持对应扩展，就是指令集问题';
  if (op === 0x0f && (at[i + 1] === 0x38 || at[i + 1] === 0x3a)) return '0F38/0F3A 扩展指令（SSSE3/SSE4.x/AES/SHA 等）——若 CPU 不支持对应扩展，就是指令集问题';
  return '普通指令（不像主动崩溃，也不像新指令集扩展）';
}

function classifyArm64(at: Buffer): string {
  if (at.length < 4) return '（字节不足）';
  const insn = at.readUInt32LE(0);
  if ((insn & 0xffe0001f) >>> 0 === 0xd4200000) return 'brk 断点（Chromium 主动崩溃 / __builtin_trap）——不是 CPU 不支持的指令';
  if ((insn & 0xffe0001f) >>> 0 === 0xd4400000) return 'hlt（Chromium 主动崩溃序列）——不是 CPU 不支持的指令';
  if ((insn & 0xffe0001f) >>> 0 === 0xd4000001) return 'svc 系统调用中（信号多为外部发送）';
  if ((insn & 0xffff0000) >>> 0 === 0) return 'udf（永久未定义指令，编译器陷阱）';
  const op0 = (insn >>> 25) & 0xf;
  if (op0 === 0x2) return 'SVE/SVE2 指令——若 CPU 没有 SVE（如 Apple M4），就是指令集问题（见 wx_channels_download#570）';
  if (op0 === 0x0 && insn >>> 31 === 1) return 'SME 指令——若 CPU/内核不支持 SME，就是指令集问题';
  return '普通指令（不像主动崩溃，也不像 SVE/SME）';
}

function signalText(sig: number, code: number): string {
  const name = SIGNALS[sig] || `信号${sig}`;
  const cname = SI_CODES[sig]?.[code] || SI_GENERIC[code] || String(code);
  let s = `${name}(${sig}) · si_code=${cname}`;
  if (code <= 0) s += '（由 kill/raise/abort 发送，不是某条指令触发的）';
  return s;
}

// 解析一份 minidump（可能只读了前若干字节：truncated=true），返回诊断包里的若干行。
export function summarizeMinidump(buf: Buffer, truncated: boolean): string[] {
  const r = new Reader(buf);
  const out: string[] = [];
  const miss = (what: string) => out.push(`${what}: 读不到${truncated ? '（转储超出读取上限，后半未读）' : '（结构不完整）'}`);
  try {
    if (r.u32(0) !== MD_SIGNATURE) return ['不是 minidump（文件头不符）'];
  } catch {
    return ['文件过短，不是完整的 minidump'];
  }
  const streams = new Map<number, { size: number; rva: number }>();
  try {
    const n = Math.min(r.u32(8), 256);
    const dir = r.u32(12);
    for (let i = 0; i < n; i++) {
      const t = r.u32(dir + i * 12);
      if (!streams.has(t)) streams.set(t, { size: r.u32(dir + i * 12 + 4), rva: r.u32(dir + i * 12 + 8) });
    }
  } catch {
    return ['流目录读不全（文件损坏或被截断）'];
  }
  let ts = 0;
  try {
    ts = r.u32(20);
  } catch {
    /* 无时间戳 */
  }

  // 系统信息：架构 + CPU family/model（与 /proc/cpuinfo 对得上）。crashpad 写 x86_64 时 CPU_INFORMATION 是
  // OtherCpuInfo（Windows PF_* 特性位，没有厂商串），family/model/stepping 在 ProcessorLevel / ProcessorRevision；
  // 32 位 x86 才是 X86CpuInfo（厂商串 + CPUID(1).EAX 签名）。
  let arch = -1;
  let cpu = '';
  const si = streams.get(ST_SYSTEM_INFO);
  if (si) {
    try {
      arch = r.u16(si.rva);
      const ncpu = r.u8(si.rva + 6);
      if (arch === ARCH_AMD64) {
        const rev = r.u16(si.rva + 4);
        cpu = `x86_64 · family ${r.u16(si.rva + 2)} model ${rev >>> 8} stepping ${rev & 0xff} · ${ncpu} 核`;
      } else if (arch === ARCH_X86) {
        const vendor = printable(r.bytes(si.rva + 32, 12).toString('latin1'), 12);
        const sig = r.u32(si.rva + 44);
        let family = (sig >>> 8) & 0xf;
        let model = (sig >>> 4) & 0xf;
        if (family === 0xf) family += (sig >>> 20) & 0xff;
        if (family === 0x6 || family >= 0xf) model += ((sig >>> 16) & 0xf) << 4;
        cpu = `x86 · ${vendor} family ${family} model ${model} stepping ${sig & 0xf} · ${ncpu} 核`;
      } else if (arch === ARCH_ARM64) {
        cpu = `arm64 · ${ncpu} 核`;
      } else {
        cpu = `架构代码 ${arch} · ${ncpu} 核`;
      }
    } catch {
      /* 留空 */
    }
  }

  // 白名单注解
  const ann: string[] = [];
  const ci = streams.get(ST_CRASHPAD_INFO);
  if (ci) {
    try {
      const saRva = r.u32(ci.rva + 40);
      if (saRva) {
        const cnt = Math.min(r.u32(saRva), 512);
        for (let i = 0; i < cnt; i++) {
          const k = r.utf8(r.u32(saRva + 4 + i * 8), 64);
          if (SIMPLE_ANNOTATIONS.includes(k)) ann.push(`${k}=${printable(r.utf8(r.u32(saRva + 8 + i * 8), 128), 64)}`);
        }
      }
      const mlRva = r.u32(ci.rva + 48);
      if (mlRva) {
        const cnt = Math.min(r.u32(mlRva), 1024);
        for (let i = 0; i < cnt; i++) {
          const infoRva = r.u32(mlRva + 4 + i * 12 + 8);
          const objRva = r.u32(infoRva + 24); // MinidumpModuleCrashpadInfo.annotation_objects
          if (!objRva) continue;
          const oc = Math.min(r.u32(objRva), 4096);
          for (let j = 0; j < oc; j++) {
            const e = objRva + 4 + j * 12;
            const name = r.utf8(r.u32(e), 64);
            if (MODULE_ANNOTATIONS.includes(name) && r.u16(e + 4) === 1) ann.push(`${name}=${printable(r.utf8(r.u32(e + 8), 128), 64)}`);
          }
        }
      }
    } catch {
      /* 注解读不全不影响其它项 */
    }
  }
  const head = [ts ? `崩溃于 ${new Date(ts * 1000).toISOString().replace('.000Z', 'Z')}` : '', ...ann, cpu].filter(Boolean);
  if (head.length) out.push(head.join(' · '));

  // 异常：信号 + si_code + 线程 + PC
  const ex = streams.get(ST_EXCEPTION);
  if (!ex) {
    out.push('没有异常流（不是崩溃转储，或是主动上报的非崩溃转储）');
    return out;
  }
  let sig = 0;
  let pc: bigint | null = null;
  let tid = -1;
  try {
    tid = r.u32(ex.rva);
    sig = r.u32(ex.rva + 8);
    const code = r.i32(ex.rva + 12);
    const addr = r.u64(ex.rva + 24);
    out.push(`信号: ${signalText(sig, code)}`);
    // PC 取异常线程上下文：int3 这类陷阱 si_addr 为 0，上下文里的 PC 才准。上下文布局：AMD64 rip@0xF8，ARM64 pc@0x108。
    const ctxSize = r.u32(ex.rva + 160);
    const ctxRva = r.u32(ex.rva + 164);
    if (arch === ARCH_AMD64 && ctxSize >= 0x100) pc = r.u64(ctxRva + 0xf8);
    else if (arch === ARCH_ARM64 && ctxSize >= 0x110) pc = r.u64(ctxRva + 0x108);
    if (pc === null || pc === 0n) pc = addr || null;
  } catch {
    miss('异常信息');
    return out;
  }

  // 崩溃线程名（Chromium 线程名如 Compositor / Chrome_ChildIOThread，可看出崩在哪类工作上）
  const tn = streams.get(ST_THREAD_NAMES);
  if (tn && tid >= 0) {
    try {
      const cnt = Math.min(r.u32(tn.rva), 4096);
      for (let i = 0; i < cnt; i++) {
        const e = tn.rva + 4 + i * 12;
        if (r.u32(e) !== tid) continue;
        const nm = printable(r.mdString(Number(r.u64(e + 4)), 64), 32);
        if (nm) out.push(`崩溃线程: ${nm}`);
        break;
      }
    } catch {
      /* 线程名可缺省 */
    }
  }

  if (pc === null) {
    out.push('崩溃地址: 未记录');
    return out;
  }

  // 崩溃地址归属的模块（名字只取 basename）+ build-id（CodeView 'BpEL' 记录里的 ELF build-id）
  let inModule = false;
  const ml = streams.get(ST_MODULE_LIST);
  if (ml) {
    try {
      const cnt = Math.min(r.u32(ml.rva), 4096);
      let found = '';
      for (let i = 0; i < cnt; i++) {
        const m = ml.rva + 4 + i * 108;
        const base = r.u64(m);
        const size = BigInt(r.u32(m + 8));
        if (pc < base || pc >= base + size) continue;
        const name = baseName(r.mdString(r.u32(m + 20)));
        let bid = '';
        try {
          const cvSize = r.u32(m + 76);
          const cvRva = r.u32(m + 80);
          if (cvSize > 4 && r.u32(cvRva) === 0x4270454c) bid = r.bytes(cvRva + 4, Math.min(cvSize - 4, 20)).toString('hex');
        } catch {
          /* build-id 可缺省 */
        }
        found = `${name}+${hex(pc - base)}${bid ? `（build-id ${bid}）` : ''}`;
        inModule = true;
        break;
      }
      out.push(`崩溃位置: ${found || `${hex(pc)}${cnt ? '（不在任何已加载模块内，可能是 V8 JIT 生成的代码）' : '（转储里的模块列表为空）'}`}`);
    } catch {
      miss('模块列表');
    }
  } else {
    out.push(`崩溃位置: ${hex(pc)}（转储没有模块列表）`);
  }

  // 崩溃处指令字节：crashpad 会抓 PC 附近一小段内存（实测 PC 前 128 字节起、共 512 字节左右）
  const mem = streams.get(ST_MEMORY_LIST);
  if (mem && arch >= 0) {
    try {
      const cnt = Math.min(r.u32(mem.rva), 65536);
      let shown = false;
      for (let i = 0; i < cnt; i++) {
        const e = mem.rva + 4 + i * 16;
        const start = r.u64(e);
        const size = BigInt(r.u32(e + 8));
        if (pc < start || pc >= start + size) continue;
        const off = r.u32(e + 12) + Number(pc - start);
        const avail = Number(start + size - pc);
        const at = r.bytes(off, Math.min(16, avail));
        const prev = pc > start ? r.u8(off - 1) : null;
        // 指令分类只对 SIGILL / SIGTRAP 有意义；段错误等只给字节
        const kind =
          sig !== 4 && sig !== 5
            ? `（${SIGNALS[sig] || '该信号'} 与指令集无关，不做分类）`
            : arch === ARCH_ARM64
              ? classifyArm64(at)
              : classifyX86(sig, prev, at);
        if (inModule) {
          const bytes = (arch === ARCH_ARM64 ? '' : prev !== null ? `(${prev.toString(16).padStart(2, '0')}) ` : '') + [...at].map((b) => b.toString(16).padStart(2, '0')).join(' ');
          out.push(`崩溃处指令: ${bytes} → ${kind}`);
        } else {
          out.push(`崩溃处指令: ${kind}（不在模块内，不导出字节）`);
        }
        shown = true;
        break;
      }
      if (!shown) out.push('崩溃处指令: 转储里没有该地址的内存');
    } catch {
      miss('崩溃处内存');
    }
  }
  return out;
}
