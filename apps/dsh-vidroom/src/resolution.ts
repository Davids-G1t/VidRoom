/**
 * 分辨率换算。老 VidRoom 的 H3 模板里 ResolutionSelector 把「16:9 / 0.4 MP /
 * 32 的倍数」算成 864x480 写死;插件要能收「0.7MP 16:9」这样的说法,所以把
 * ComfyUI 那个节点的公式照搬过来(comfy_extras/nodes_resolution.py):
 *
 *   total_pixels = megapixels * 1024 * 1024
 *   scale        = sqrt(total_pixels / (w_ratio * h_ratio))
 *   width        = round(w_ratio * scale / multiple) * multiple
 *   height       = round(h_ratio * scale / multiple) * multiple
 *
 * 同一个公式保证与用户自己在画布上选的分辨率一致:0.4MP 16:9 → 864x480,
 * 0.7MP 16:9 → 1152x640。
 */

/** 画布上能选的长宽比(键写成 `16:9` 这种,与 ComfyUI 下拉一致)。 */
export const ASPECT_RATIOS: Record<string, readonly [number, number]> = {
  '1:1': [1, 1],
  '2:3': [2, 3],
  '3:2': [3, 2],
  '3:4': [3, 4],
  '4:3': [4, 3],
  '9:16': [9, 16],
  '16:9': [16, 9],
  '21:9': [21, 9],
};

/** 默认长宽比与像素预算(与老模板一致:16:9、0.4 MP)。 */
export const DEFAULT_ASPECT = '16:9';
export const DEFAULT_MEGAPIXELS = 0.4;

export interface Resolution {
  width: number;
  height: number;
  /** 实际凑出来的像素数(百万),round 之后与目标略有出入,回报时用这个。 */
  megapixels: number;
}

/** 长宽比 + 百万像素 → 宽高(对齐到 multiple 的倍数)。 */
export function resolutionFor(megapixels: number, aspect: string = DEFAULT_ASPECT, multiple = 32): Resolution {
  const ratio = ASPECT_RATIOS[aspect];
  if (ratio === undefined) {
    throw new Error(`不认识的长宽比 ${aspect},可选:${Object.keys(ASPECT_RATIOS).join('、')}`);
  }
  if (!Number.isFinite(megapixels) || megapixels <= 0) {
    throw new Error(`像素数必须是正数,收到 ${megapixels}`);
  }
  const [wRatio, hRatio] = ratio;
  const totalPixels = megapixels * 1024 * 1024;
  const scale = Math.sqrt(totalPixels / (wRatio * hRatio));
  const width = Math.round((wRatio * scale) / multiple) * multiple;
  const height = Math.round((hRatio * scale) / multiple) * multiple;
  return { width, height, megapixels: (width * height) / (1024 * 1024) };
}
