/**
 * MiniMax H3 的帧数网格:只接受 17k+5 帧(k ≥ 0:5、22、39、56、73、90、107、124…),24 fps。
 * ComfyUI 的 MiniMaxH3ImageToVideo 节点收到不在网格上的 length 会自己向上取整
 * (comfy_extras/nodes_minimax_h3.py 的 align_frame_count);Host 这边先吸附到**最近**的合法帧数,
 * 保证提交给 ComfyUI 的永远是网格上的值,记进作品库的时长也和成片一致。
 */

export const H3_FPS = 24;
export const H3_MIN_FRAMES = 5;
/** 模型训练覆盖约 124–362 帧(约 5–15 秒);更长官方写的是「未测试」,这里封顶 362 */
export const H3_MAX_FRAMES = 362;

export function isValidFrameCount(n: number): boolean {
  return Number.isInteger(n) && n >= H3_MIN_FRAMES && n <= H3_MAX_FRAMES && n % 17 === 5;
}

/** 任意帧数 → 最近的 17k+5(夹在 [5, 362] 内)。17 是奇数,不会有两边等距的情况。 */
export function snapFrames(n: number): number {
  if (!Number.isFinite(n) || n <= H3_MIN_FRAMES) return H3_MIN_FRAMES;
  if (n >= H3_MAX_FRAMES) return H3_MAX_FRAMES;
  const k = Math.round((n - 5) / 17);
  return 17 * k + 5;
}

/** 时长(秒)→ 合法帧数:先按 24 fps 折成帧数,再吸附。3 秒 → 73,5 秒 → 124。 */
export function framesForSeconds(seconds: number): number {
  return snapFrames(Math.round(seconds * H3_FPS));
}
