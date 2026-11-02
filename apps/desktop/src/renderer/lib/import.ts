import { MAX_PAGES, PDF_RENDER_WIDTH } from '@classroom/shared';
import type { WhiteboardClient } from '@classroom/client-core';
import { uploadImage } from './files';
import { renderPdfToImages } from './pdf';

export interface ImportProgress {
  phase: '解析 PDF' | '渲染页面' | '上传页面';
  done: number;
  total: number;
}

export interface ImportOptions {
  client: WhiteboardClient;
  roomId?: string;
  onProgress?: (p: ImportProgress) => void;
}

/**
 * 导入 PDF 课件：渲染成图 → 逐页上传 → 作为带背景的页加到白板。
 *
 * 抽成独立函数而不是写在组件里，是为了让「导入」这件事可以被自动化测试直接调用，
 * 测试跑的和用户点的必须是同一条路径。
 *
 * 返回实际加入的页数。
 */
export async function importPdfCourseware(file: File, opts: ImportOptions): Promise<number> {
  const { client, roomId, onProgress } = opts;

  if (!client.isTeacher()) throw new Error('只有老师可以导入课件');
  if (client.doc.pages.length >= MAX_PAGES) {
    throw new Error(`最多 ${MAX_PAGES} 页，请先删掉一些空白页`);
  }

  onProgress?.({ phase: '解析 PDF', done: 0, total: 1 });

  const budget = MAX_PAGES - client.doc.pages.length;
  const rendered = await renderPdfToImages(file, {
    targetWidth: PDF_RENDER_WIDTH,
    maxPages: budget,
    onProgress: (done, total) => onProgress?.({ phase: '渲染页面', done, total }),
  });
  if (rendered.length === 0) throw new Error('这份 PDF 没有可渲染的页面');

  const baseName = file.name.replace(/\.pdf$/i, '');
  const pages: { name: string; width: number; height: number; fileId: string }[] = [];

  for (let i = 0; i < rendered.length; i++) {
    const page = rendered[i];
    if (!page) continue;
    onProgress?.({ phase: '上传页面', done: i + 1, total: rendered.length });
    const dto = await uploadImage(page.blob, {
      roomId,
      width: page.width,
      height: page.height,
      filename: `${baseName}-${i + 1}.png`,
    });
    pages.push({
      name: `${baseName} · ${i + 1}`,
      width: page.width,
      height: page.height,
      fileId: dto.id,
    });
  }

  if (pages.length === 0) throw new Error('没有成功上传任何页面');
  // 上传期间白板可能又加了页，实际能插入的页数以客户端截断结果为准
  const added = client.addPagesWithBackground(pages);
  if (added.length === 0) throw new Error(`最多 ${MAX_PAGES} 页，请先删掉一些空白页`);
  return added.length;
}

export function probeImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('无法读取图片尺寸'));
    img.src = url;
  });
}

/** 把已在服务端的图片课件直接插成白板页，不重复上传 */
export function addImagePages(
  items: { fileId: string; name: string; width: number; height: number }[],
  opts: Pick<ImportOptions, 'client'>,
): number {
  const { client } = opts;
  if (!client.isTeacher()) throw new Error('只有老师可以导入课件');
  const budget = MAX_PAGES - client.doc.pages.length;
  if (budget <= 0) throw new Error(`最多 ${MAX_PAGES} 页，请先删掉一些空白页`);
  const accepted = items.slice(0, budget);
  if (accepted.length === 0) throw new Error('没有可插入的页面');
  const added = client.addPagesWithBackground(accepted);
  if (added.length === 0) throw new Error(`最多 ${MAX_PAGES} 页，请先删掉一些空白页`);
  return added.length;
}

/** 本地图片课件：上传后插成带背景的白板页（等比缩放到渲染宽度内） */
export async function importImageCourseware(file: File, opts: ImportOptions): Promise<number> {
  const { client, roomId, onProgress } = opts;
  if (!client.isTeacher()) throw new Error('只有老师可以导入课件');
  if (client.doc.pages.length >= MAX_PAGES) {
    throw new Error(`最多 ${MAX_PAGES} 页，请先删掉一些空白页`);
  }

  onProgress?.({ phase: '上传页面', done: 0, total: 1 });
  const objectUrl = URL.createObjectURL(file);
  const dim = await probeImageSize(objectUrl).finally(() => URL.revokeObjectURL(objectUrl));
  const dto = await uploadImage(file, {
    roomId,
    width: dim.width,
    height: dim.height,
    filename: file.name,
  });
  onProgress?.({ phase: '上传页面', done: 1, total: 1 });

  return addImagePages(
    [
      {
        fileId: dto.id,
        name: file.name.replace(/\.[^.]+$/, ''),
        width: dim.width,
        height: dim.height,
      },
    ],
    { client },
  );
}
