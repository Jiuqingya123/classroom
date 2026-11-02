import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Worker 必须显式指定，否则 pdfjs 会退化到主线程解析，一个 30 页课件能卡住整个界面
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface RenderedPage {
  blob: Blob;
  width: number;
  height: number;
}

export interface RenderPdfOptions {
  /** 目标渲染宽度（px）。PDF_RENDER_WIDTH = 1600 时投影到 1080p 刚好清晰 */
  targetWidth: number;
  /** 最多渲染多少页，防止有人拖进来一个 500 页的手册把内存打爆 */
  maxPages?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface PdfInfo {
  numPages: number;
}

export async function readPdfInfo(file: File): Promise<PdfInfo> {
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data });
  try {
    const doc = await task.promise;
    return { numPages: doc.numPages };
  } finally {
    await task.destroy();
  }
}

/**
 * 把 PDF 逐页渲染成 PNG。
 *
 * 为什么要转成图片：白板页的模型里 background 只有「一张位图」，这样客户端渲染
 * 只需要一次 drawImage，翻页/缩放不受矢量解析拖累；PDF 原文也不必留在客户端。
 */
export async function renderPdfToImages(
  file: File,
  opts: RenderPdfOptions,
): Promise<RenderedPage[]> {
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;

  const total = opts.maxPages ? Math.min(doc.numPages, opts.maxPages) : doc.numPages;
  const out: RenderedPage[] = [];

  try {
    for (let i = 1; i <= total; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      // 限制在 0.5~3 倍之间：太小的 PDF 放大 3 倍够用，太大的别超过 3 倍浪费内存
      const scale = Math.min(3, Math.max(0.5, opts.targetWidth / base.width));
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));

      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('无法创建画布上下文');

      // PDF 页面本身是透明的，不铺白底的话 PNG 透明区在白板上会透出深色背景
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvas, viewport }).promise;

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('导出页面图片失败'))),
          'image/png',
        );
      });

      out.push({ blob, width: canvas.width, height: canvas.height });
      opts.onProgress?.(i, total);

      page.cleanup();
      // 主动断开引用，长文档不这么做内存会一路涨
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    // 必须销毁 loadingTask 而不是 doc：worker 由它持有，漏掉会留下常驻线程
    await task.destroy();
  }

  return out;
}
