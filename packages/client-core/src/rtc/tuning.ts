import { CAMERA_MAX_BITRATE, SCREEN_BITRATE, SCREEN_FRAMERATE } from '@classroom/shared';

/**
 * 在已协商的 sender 上改编码参数。
 *
 * 关键点：`getParameters()` 返回的 encodings 是只读数组，必须整体重建后再 setParameters，
 * 只改其中一个字段、其余字段留空会让浏览器按默认值重置（常见后果是码率上限被无声地抹掉）。
 */
export async function applyEncoding(
  sender: RTCRtpSender,
  opts: { maxBitrate?: number; scaleResolutionDownBy?: number; maxFramerate?: number },
): Promise<boolean> {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      // 尚未协商出编码器，调用 setParameters 会抛错
      params.encodings = [{}];
    }
    params.encodings = params.encodings.map((enc) => ({
      ...enc,
      ...(opts.maxBitrate !== undefined ? { maxBitrate: opts.maxBitrate } : {}),
      ...(opts.scaleResolutionDownBy !== undefined
        ? { scaleResolutionDownBy: opts.scaleResolutionDownBy }
        : {}),
      ...(opts.maxFramerate !== undefined ? { maxFramerate: opts.maxFramerate } : {}),
    }));
    await sender.setParameters(params);
    return true;
  } catch {
    return false;
  }
}

/** 摄像头初始参数：5 人 Mesh 下每人 4 路上行，必须压住 */
export function tuneCameraSender(sender: RTCRtpSender): Promise<boolean> {
  return applyEncoding(sender, {
    maxBitrate: CAMERA_MAX_BITRATE,
    scaleResolutionDownBy: 2,
    maxFramerate: 24,
  });
}

export function tuneScreenSender(sender: RTCRtpSender, quality: 'smooth' | 'hd' = 'smooth'): Promise<boolean> {
  return applyEncoding(sender, {
    maxBitrate: SCREEN_BITRATE[quality],
    maxFramerate: SCREEN_FRAMERATE,
    scaleResolutionDownBy: 1,
  });
}

/**
 * 按「可用上行带宽」决定摄像头降级档位。
 *
 * 1 = 原分辨率，2 = 各向减半，4 = 四分之一。
 * 阈值故意留了很大余量：等真卡到 300kbps 再降级，用户早就看到花屏了。
 */
export function scaleForAvailableBitrate(availableBps: number | null): number {
  if (availableBps === null) return 2;
  if (availableBps < 180_000) return 4;
  if (availableBps < 400_000) return 2;
  return 1;
}
