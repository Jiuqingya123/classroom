/** 全局上限与节流参数。双端共用，改动必须同步考虑服务端校验。 */

/** 一个教室最多同时在线人数（1 老师 + 4 学生） */
export const MAX_PARTICIPANTS = 5;
/** 单房间最多白板页数 */
export const MAX_PAGES = 50;
/** 单页最多元素数，防止恶意/异常造成的白板膨胀 */
export const MAX_ELEMENTS_PER_PAGE = 4000;
/** 单条笔迹最多点数。手写笔 120Hz 采样，一笔几秒就能上千点，超过这个值一定是异常 */
export const MAX_STROKE_POINTS = 20_000;
/** 单张图片上限（MB） */
export const MAX_IMAGE_MB = 5;
/** PDF 课件上限（MB） */
export const MAX_PDF_MB = 80;
/** PDF 每页渲染目标宽度（px），决定背景图清晰度与体积 */
export const PDF_RENDER_WIDTH = 1600;
/** 默认白板页逻辑尺寸（16:9） */
export const DEFAULT_PAGE_WIDTH = 1600;
export const DEFAULT_PAGE_HEIGHT = 900;

/** 摄像头发送码率上限。5 人 Mesh 下每人 4 路上行，必须压住。 */
export const CAMERA_MAX_BITRATE = 250_000;
/** 摄像头采集后降采样倍数（发送 320x240，本地预览仍全分辨率） */
export const CAMERA_SCALE_DOWN = 2;

/** 屏幕共享两档码率 */
export const SCREEN_BITRATE = { smooth: 1_000_000, hd: 2_500_000 } as const;
export const SCREEN_FRAMERATE = 15;

/** 光标广播频率上限（Hz） */
export const CURSOR_HZ = 20;
/** 白板落库 debounce（ms） */
export const WB_PERSIST_DEBOUNCE_MS = 2_000;
/** 白板兜底快照间隔（ms） */
export const WB_SNAPSHOT_INTERVAL_MS = 60_000;
/** 单 socket 白板 op 速率上限（条/秒） */
export const WB_OP_RATE = 60;
/** 单 socket 信令速率上限（条/秒） */
export const SIGNAL_RATE = 200;
/** 空房间在内存中保留时长（ms），期间掉线可秒级重连 */
export const ROOM_GC_DELAY_MS = 10 * 60_000;
/** socket.io 单条消息上限，白板全量 sync 可能超过默认 1MB */
export const MAX_SOCKET_PAYLOAD = 2 * 1024 * 1024;
