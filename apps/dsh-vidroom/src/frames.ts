/**
 * MiniMax H3 的帧数网格:只接受 17k+5 帧(5、22、39、56、73、90、107、124…),24 fps。
 *
 * ComfyUI 的 MiniMaxH3ImageToVideo 节点收到不在网格上的 length 会自己向上取整
 * (comfy_extras/nodes_minimax_h3.py 的 align_frame_count);这边先吸附到**最近**的
 * 合法帧数,保证提交给 ComfyUI 的永远是网格上的值,报给用户的时长也和成片一致。
 */

/** H3 的帧率。 */
export const H3_FPS = 24;
/** 网格下界。 */
export const H3_MIN_FRAMES = 5;
/** 网格上界。官方口径的上界:124–362 帧(约 5–15 秒),更长是「未测试」。
 * 网格与覆盖范围见 ComfyUI-MiniMaxH3-Tools 的 README(社区整理,非官方一手):
 * https://github.com/Rinne414/ComfyUI-MiniMaxH3-Tools/blob/master/README.md */
export const H3_MAX_FRAMES = 362;

/** 是否落在 17k+5 网格上。 */
export function isValidFrameCount(frames: number): boolean {
  return Number.isInteger(frames) && frames >= H3_MIN_FRAMES && frames <= H3_MAX_FRAMES && frames % 17 === 5;
}

/** 任意帧数 → 最近的 17k+5(夹在 [5, 362] 内)。17 是奇数,不会有两边等距的情况。 */
export function snapFrames(frames: number): number {
  if (!Number.isFinite(frames) || frames <= H3_MIN_FRAMES) return H3_MIN_FRAMES;
  if (frames >= H3_MAX_FRAMES) return H3_MAX_FRAMES;
  return 17 * Math.round((frames - 5) / 17) + 5;
}

/** 秒数 → 合法帧数:先按 24 fps 折成帧数,再吸附。5 秒 → 124,7 秒(168 帧)→ 175 帧 = 7.29 秒。 */
export function framesForSeconds(seconds: number): number {
  return snapFrames(Math.round(seconds * H3_FPS));
}

/** 帧数 → 时长(秒),用于回报。 */
export function secondsForFrames(frames: number): number {
  return frames / H3_FPS;
}
