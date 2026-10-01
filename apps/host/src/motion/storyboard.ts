/**
 * 代码渲染视频的「分镜 → 构建」两步(借 tuzhechen2005/opus-video-skills 的「分镜 → 构建 → 审查 → 编码」流程思路,
 * 代码是自己写的):
 * - 分镜:planStoryboard 把一句话需求(标题、副标题、时长、风格)按固定比例拆成几个镜头
 *   (标题出现 → 停留 → 标题淡出,有副标题时在标题出现后插一个「副标题出现」);
 * - 构建:buildComposition 按风格包把分镜写成一份 HyperFrames 合成(HTML + CSS 关键帧动画)。
 *
 * 动画只用 CSS 关键帧(HyperFrames 的运行时会按帧 seek CSS 动画),不引 GSAP 之类的外部脚本;
 * 根元素带 data-no-timeline,告诉 HyperFrames 不用等 GSAP 时间线注册(否则每次白等 45 秒)。
 * 底色画在一个铺满的 .bg 元素上,不画在根元素上:png-sequence 出带透明通道的帧时,HyperFrames 会把页面/根元素的背景
 * 当成透明(实测:根元素上的底色在帧里变成全透明)。
 * 每种风格都有贯穿全片的持续运动(背景漂移 / 进度线),所以任何一段画面长时间完全不动都说明渲染卡住了,
 * 交付前的冻帧检测据此判定。
 */

export const MOTION_STYLES = ['minimal', 'gradient'] as const;
export type MotionStyle = (typeof MOTION_STYLES)[number];

export const STYLE_LABELS: Record<MotionStyle, string> = {
  minimal: '简约文字卡片',
  gradient: '动态渐变背景',
};

export const MOTION_MIN_SECONDS = 3;
export const MOTION_MAX_SECONDS = 30;
export const MOTION_FPS = 30;
export const MOTION_WIDTH = 1280;
export const MOTION_HEIGHT = 720;
export const TITLE_MAX_CHARS = 40;
export const SUBTITLE_MAX_CHARS = 60;

export interface MotionRequest {
  title: string;
  subtitle?: string;
  seconds: number;
  style: MotionStyle;
}

export interface Shot {
  kind: 'title-in' | 'subtitle-in' | 'hold' | 'title-out';
  /** 给人看的镜头名 */
  label: string;
  start: number;
  end: number;
}

export interface Storyboard {
  title: string;
  subtitle: string | null;
  seconds: number;
  style: MotionStyle;
  fps: number;
  width: number;
  height: number;
  shots: Shot[];
}

const round = (n: number) => Math.round(n * 100) / 100;

/** 校验需求;不合格返回原因(给 agent 转告或改写后重试),合格返回 null */
export function requestProblem(req: MotionRequest): string | null {
  const title = req.title.trim();
  if (!title) return '标题不能为空';
  if ([...title].length > TITLE_MAX_CHARS) return `标题最多 ${TITLE_MAX_CHARS} 个字,请缩短`;
  if (req.subtitle && [...req.subtitle.trim()].length > SUBTITLE_MAX_CHARS) return `副标题最多 ${SUBTITLE_MAX_CHARS} 个字,请缩短`;
  if (!Number.isFinite(req.seconds) || req.seconds < MOTION_MIN_SECONDS || req.seconds > MOTION_MAX_SECONDS) {
    return `时长要在 ${MOTION_MIN_SECONDS}–${MOTION_MAX_SECONDS} 秒之间`;
  }
  if (!MOTION_STYLES.includes(req.style)) return `风格只能是 ${MOTION_STYLES.join(' / ')}`;
  return null;
}

/** 分镜:标题出现占前 20%(最长 1.5 秒),淡出占最后 15%(最长 1.2 秒),中间停留;副标题紧跟标题出现 */
export function planStoryboard(req: MotionRequest): Storyboard {
  const seconds = round(req.seconds);
  const introEnd = round(Math.min(1.5, seconds * 0.2));
  const outroStart = round(seconds - Math.min(1.2, seconds * 0.15));
  const subtitle = req.subtitle?.trim() || null;
  const shots: Shot[] = [{ kind: 'title-in', label: '标题出现', start: 0, end: introEnd }];
  if (subtitle) shots.push({ kind: 'subtitle-in', label: '副标题出现', start: introEnd, end: round(Math.min(introEnd + 0.8, outroStart)) });
  shots.push({ kind: 'hold', label: '停留(背景持续运动)', start: introEnd, end: outroStart });
  shots.push({ kind: 'title-out', label: '标题淡出', start: outroStart, end: seconds });
  return {
    title: req.title.trim(),
    subtitle,
    seconds,
    style: req.style,
    fps: MOTION_FPS,
    width: MOTION_WIDTH,
    height: MOTION_HEIGHT,
    shots,
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const shot = (sb: Storyboard, kind: Shot['kind']) => sb.shots.find((s) => s.kind === kind);

/** 一条 CSS animation 声明:名字、时长、缓动、起点 */
const anim = (name: string, start: number, end: number, easing: string, fill = 'both') =>
  `${name} ${round(Math.max(end - start, 0.01))}s ${easing} ${round(start)}s 1 normal ${fill}`;

const FONT = `"Inter", "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif`;

function timings(sb: Storyboard) {
  const intro = shot(sb, 'title-in')!;
  const hold = shot(sb, 'hold')!;
  const outro = shot(sb, 'title-out')!;
  const sub = shot(sb, 'subtitle-in');
  return { intro, hold, outro, sub };
}

/** 简约文字卡片:米白底、深色字,标题自下而上揭开,下划线展开;停留时标题极缓慢放大,底部进度线贯穿全片 */
function minimalCss(sb: Storyboard): string {
  const { intro, hold, outro, sub } = timings(sb);
  return `
  #root { color: #1c1b19; }
  .bg { background: #f4f1ea; }
  .frame { position: absolute; inset: 36px; border: 2px solid #1c1b19; opacity: .12; }
  .stack { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 28px; }
  .out { animation: ${anim('m-out', outro.start, outro.end, 'ease-in', 'forwards')}; }
  .hold { animation: ${anim('m-hold', hold.start, hold.end, 'linear')}; }
  .title { font: 800 104px/1.1 ${FONT}; letter-spacing: -0.02em; animation: ${anim('m-in', intro.start, intro.end, 'cubic-bezier(.2,.8,.2,1)')}; }
  .rule { width: 360px; height: 6px; background: #d9480f; transform-origin: left center; animation: ${anim('m-rule', intro.start, intro.end, 'ease-out')}; }
  .subtitle { font: 500 40px/1.3 ${FONT}; color: #57534e; ${sub ? `animation: ${anim('m-sub', sub.start, sub.end, 'ease-out')};` : ''} }
  .progress { position: absolute; left: 0; bottom: 0; height: 8px; width: 100%; background: #d9480f; transform-origin: left center; animation: ${anim('m-progress', 0, sb.seconds, 'linear')}; }
  @keyframes m-in { from { opacity: 0; transform: translateY(60px); clip-path: inset(100% 0 0 0); } to { opacity: 1; transform: none; clip-path: inset(0 0 0 0); } }
  @keyframes m-rule { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  @keyframes m-sub { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: none; } }
  @keyframes m-hold { from { transform: scale(1); } to { transform: scale(1.05); } }
  @keyframes m-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(-40px); } }
  @keyframes m-progress { from { transform: scaleX(0); } to { transform: scaleX(1); } }`;
}

/** 动态渐变背景:深色底上三团彩色光斑(径向渐变,不用 blur 滤镜——滤镜在画面边缘会出色带)全程漂移,标题从模糊放大到清晰,停留时轻微呼吸,结尾放大淡出 */
function gradientCss(sb: Storyboard): string {
  const { intro, hold, outro, sub } = timings(sb);
  const all = (name: string) => anim(name, 0, sb.seconds, 'linear');
  return `
  #root { color: #fff; }
  .bg { background: #0b1020; }
  .blob { position: absolute; width: 1100px; height: 1100px; border-radius: 50%; }
  .b1 { background: radial-gradient(circle, rgba(124,58,237,.9) 0%, rgba(124,58,237,0) 65%); left: -420px; top: -520px; animation: ${all('g-drift1')}; }
  .b2 { background: radial-gradient(circle, rgba(14,165,233,.85) 0%, rgba(14,165,233,0) 65%); right: -460px; top: -180px; animation: ${all('g-drift2')}; }
  .b3 { background: radial-gradient(circle, rgba(244,63,94,.8) 0%, rgba(244,63,94,0) 65%); left: 60px; bottom: -640px; animation: ${all('g-drift3')}; }
  .stack { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24px; }
  .out { animation: ${anim('g-out', outro.start, outro.end, 'ease-in', 'forwards')}; }
  .hold { animation: ${anim('g-hold', hold.start, hold.end, 'ease-in-out')}; }
  .title { font: 900 116px/1.1 ${FONT}; text-shadow: 0 0 40px rgba(255,255,255,.35); animation: ${anim('g-in', intro.start, intro.end, 'cubic-bezier(.16,1,.3,1)')}; }
  .rule { display: none; }
  .subtitle { font: 500 40px/1.3 ${FONT}; color: rgba(255,255,255,.8); letter-spacing: .08em; ${sub ? `animation: ${anim('g-sub', sub.start, sub.end, 'ease-out')};` : ''} }
  .progress { display: none; }
  @keyframes g-drift1 { from { transform: translate(0, 0) scale(1); } to { transform: translate(420px, 220px) scale(1.25); } }
  @keyframes g-drift2 { from { transform: translate(0, 0) scale(1.1); } to { transform: translate(-380px, 160px) scale(.9); } }
  @keyframes g-drift3 { from { transform: translate(0, 0); } to { transform: translate(-160px, -300px); } }
  @keyframes g-in { from { opacity: 0; transform: scale(.7); filter: blur(24px); } to { opacity: 1; transform: none; filter: blur(0); } }
  @keyframes g-sub { from { opacity: 0; letter-spacing: .5em; } to { opacity: 1; letter-spacing: .08em; } }
  @keyframes g-hold { 0% { transform: scale(1); } 50% { transform: scale(1.04); } 100% { transform: scale(1.02); } }
  @keyframes g-out { from { opacity: 1; transform: scale(1); filter: blur(0); } to { opacity: 0; transform: scale(1.3); filter: blur(16px); } }`;
}

/** 构建:分镜 → 一份自包含的 HyperFrames 合成(index.html)。标题等文字一律转义后再写进 HTML。 */
export function buildComposition(sb: Storyboard): string {
  const css = sb.style === 'minimal' ? minimalCss(sb) : gradientCss(sb);
  const blobs = sb.style === 'gradient' ? '<div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>' : '<div class="frame"></div>';
  const subtitle = sb.subtitle ? `<div class="subtitle">${escapeHtml(sb.subtitle)}</div>` : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(sb.title)}</title>
<style>
  html, body { margin: 0; padding: 0; background: #000; }
  #root { position: relative; width: ${sb.width}px; height: ${sb.height}px; overflow: hidden; }
  .bg { position: absolute; inset: 0; }
${css}
</style>
</head>
<body>
<div id="root" data-composition-id="root" data-no-timeline data-start="0" data-duration="${sb.seconds}" data-width="${sb.width}" data-height="${sb.height}" data-fps="${sb.fps}">
  <div class="bg"></div>
  ${blobs}
  <div class="stack out"><div class="stack hold">
    <div class="title">${escapeHtml(sb.title)}</div>
    <div class="rule"></div>
    ${subtitle}
  </div></div>
  <div class="progress"></div>
</div>
</body>
</html>
`;
}
