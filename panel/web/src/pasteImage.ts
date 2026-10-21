// 本机图片粘进应用之前先「瘦身」（#165「大于 1M 的图片无法粘贴并且会导致面板卡死」）。
//
// 为什么卡在 1MB 上下——两道互不相干、却恰好都在 1MB 的坎：
//  1. 容器剪贴板。服务端用 xclip 把图片放进 X 剪贴板。xclip 单次最多直接交出 XExtendedMaxRequestSize/4
//     ≈ 1,048,575 字节，更大的走 INCR 分段协议，而 INCR 进行中它不理会任何别的读取请求。KasmVNC 的 Xvnc 在剪贴板
//     一变就会来取 image/png（Xvnc 的 DLP_ClipTypes 默认含它，用来同步给浏览器），却从不把 INCR 收完：
//     xclip 就此卡死，应用按 Ctrl+V 读剪贴板时跟着卡住——Chromium 内核的应用（浏览器实例、QQ）页面直接
//     「无响应」，而且之后每次粘贴都卡，要重启应用才恢复。
//     实测：1,040,000 字节的 PNG 正常，1,060,000 字节的必卡；同样 3MB 换成 image/jpeg、image/gif 不卡（Xvnc 不取）。
//     新实例镜像已让 Xvnc 不再取 image/png（docker/Dockerfile），但没「升级实例」的旧实例照样会卡，所以这里照样压。
//  2. 反向代理的请求体上限：nginx 默认 client_max_body_size 1m，飞牛 / 1Panel / NPM 等基于 nginx 的反代同理，超了直接 413。
// 所以策略是「先传原图，失败再压缩」（pasteImageWithFallback）：新实例镜像 + 直连时原图能直接粘，Retina 截图保住清晰度；
// 旧实例（服务端回 413 + png_too_big）、反代拒收（413 或直接断连接）、剪贴板仍没响应（clipboard_stuck）时，
// 再把 PNG（以及 BMP / WebP 等会被转成 PNG 的）压到 PASTE_IMAGE_BUDGET 以内重试一次，JPEG 保持 JPEG；
// GIF 不动——重新编码会把动图变成静态图，而且 Xvnc 不取 gif、不会卡剪贴板，只可能被反代拦下（那时给出明确提示）。
// 压缩只缩尺寸、不降色彩：先按体积比例估一个缩放倍数（PNG 体积大致与像素数成正比），不够再逐步缩小，
// 尽量保住截图里的字（Retina 截图缩到一半就是屏幕上看到的「点」尺寸，清晰度基本不损失）。

export const PASTE_IMAGE_BUDGET = 900_000; // 与服务端 PASTE_IMAGE_PNG_MAX（1,000,000）之间留出余量
const MAX_PIXELS = 16_000_000; // Safari 的 canvas 面积上限约 16.7M 像素，超了 toBlob 直接返回 null
const MAX_TRIES = 8;

export interface DecodedImage {
  width: number;
  height: number;
  close(): void;
}
// 图片编解码抽成接口：浏览器里用 createImageBitmap + canvas；单元测试里用假的，只验证「怎么缩、缩几次」
export interface ImageCodec<D extends DecodedImage = DecodedImage> {
  decode(blob: Blob): Promise<D>;
  encode(img: D, width: number, height: number, type: string, quality?: number): Promise<Blob>;
}

export interface FitResult {
  blob: Blob;
  resized: boolean; // 是否重新编码过（false = 原样上传）
  width?: number; // 重新编码后的尺寸
  height?: number;
}

// 不需要处理：已在预算内，或是 GIF（见文件头）
export function pasteImageNeedsFit(file: Blob, budget = PASTE_IMAGE_BUDGET): boolean {
  return file.size > budget && (file.type || '').toLowerCase() !== 'image/gif';
}

export async function fitPasteImage<D extends DecodedImage>(
  file: Blob,
  codec: ImageCodec<D>,
  budget = PASTE_IMAGE_BUDGET,
): Promise<FitResult> {
  if (!pasteImageNeedsFit(file, budget)) return { blob: file, resized: false };
  const srcType = (file.type || '').toLowerCase();
  const outType = srcType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const img = await codec.decode(file);
  try {
    const { width: w, height: h } = img;
    if (!(w > 0 && h > 0)) throw new Error('图片尺寸无效');
    let scale = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)));
    // 原图本来就是 PNG：它的体积就是同尺寸 PNG 体积的好估计，直接按比例一步缩到位，省掉一次注定超标的全尺寸编码
    if (srcType === 'image/png') scale = Math.min(scale, Math.sqrt(budget / file.size) * 0.95);
    let quality = outType === 'image/jpeg' ? 0.9 : undefined;
    for (let i = 0; i < MAX_TRIES; i++) {
      const tw = Math.max(1, Math.round(w * scale));
      const th = Math.max(1, Math.round(h * scale));
      const blob = await codec.encode(img, tw, th, outType, quality);
      if (blob.size <= budget) return { blob, resized: true, width: tw, height: th };
      // JPEG 先降一档质量（照片在 0.8 时肉眼几乎看不出），还不够再缩尺寸
      if (quality !== undefined && quality > 0.8) {
        quality = 0.8;
        continue;
      }
      scale *= Math.min(0.9, Math.sqrt(budget / blob.size) * 0.95);
    }
  } finally {
    img.close();
  }
  throw new Error('图片太大，压缩后仍超过 1MB：请改用「文件」功能发送原图');
}

// ---------- 浏览器实现 ----------
interface BrowserImage extends DecodedImage {
  source: CanvasImageSource;
}
export const browserImageCodec: ImageCodec<BrowserImage> = {
  async decode(blob) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(blob);
        return { width: bmp.width, height: bmp.height, source: bmp, close: () => bmp.close() };
      } catch {
        /* 个别格式 createImageBitmap 不认，退回 <img> */
      }
    }
    const url = URL.createObjectURL(blob);
    try {
      const el = new Image();
      el.src = url;
      await el.decode();
      return { width: el.naturalWidth, height: el.naturalHeight, source: el, close: () => URL.revokeObjectURL(url) };
    } catch {
      URL.revokeObjectURL(url);
      throw new Error('无法读取这张图片，请改用「文件」功能发送');
    }
  },
  encode(img, width, height, type, quality) {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const g = c.getContext('2d');
    if (!g) return Promise.reject(new Error('浏览器不支持图片压缩，请改用「文件」功能发送'));
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    if (type === 'image/jpeg') {
      g.fillStyle = '#fff'; // JPEG 没有透明通道：透明处按白底，免得变成黑块
      g.fillRect(0, 0, width, height);
    }
    g.drawImage(img.source, 0, 0, width, height);
    return new Promise((resolve, reject) =>
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('图片压缩失败，请改用「文件」功能发送'))), type, quality),
    );
  },
};

// ---------- 先原图、失败再压缩 ----------
export interface PasteFailure {
  status?: number;
  code?: string;
  kind?: 'network' | 'timeout';
}
// 哪些失败值得压缩后再试：体积相关的拒收与断连。超时不重试（大图在慢链路上已经等了很久，再来一遍体验更差，提示改用「文件」）
export function shouldRetryCompressed(e: PasteFailure | undefined): boolean {
  if (!e) return false;
  return e.status === 413 || e.code === 'png_too_big' || e.code === 'clipboard_stuck' || e.kind === 'network';
}
export async function pasteImageWithFallback(
  file: Blob,
  upload: (b: Blob) => Promise<unknown>,
  fit: (b: Blob) => Promise<Blob>,
  onCompressing?: () => void,
): Promise<{ compressed: boolean }> {
  try {
    await upload(file);
    return { compressed: false };
  } catch (e: any) {
    // 本来就在预算内（或 GIF）：压了也不会变小，直接把原因交给调用方展示
    if (!pasteImageNeedsFit(file) || !shouldRetryCompressed(e)) throw e;
    onCompressing?.();
    await upload(await fit(file));
    return { compressed: true };
  }
}
