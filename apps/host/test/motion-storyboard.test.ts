import { describe, expect, it } from 'vitest';
import { buildComposition, escapeHtml, planStoryboard, requestProblem } from '../src/motion/storyboard.js';

describe('分镜 planStoryboard', () => {
  it('10 秒带副标题:标题出现 → 副标题出现 → 停留 → 标题淡出,首尾相接、覆盖全片', () => {
    const sb = planStoryboard({ title: 'VidRoom', subtitle: '本地视频工作室', seconds: 10, style: 'gradient' });
    expect(sb.shots.map((s) => s.kind)).toEqual(['title-in', 'subtitle-in', 'hold', 'title-out']);
    const [intro, sub, hold, outro] = sb.shots;
    expect(intro).toMatchObject({ start: 0, end: 1.5 });
    expect(sub.start).toBe(intro.end);
    expect(hold).toMatchObject({ start: intro.end, end: outro.start });
    expect(outro).toMatchObject({ start: 8.8, end: 10 });
    expect(sb).toMatchObject({ seconds: 10, fps: 30, width: 1280, height: 720 });
  });

  it('短片按比例缩:3 秒时标题出现 0.6 秒、淡出 0.45 秒;没副标题就没有那一镜', () => {
    const sb = planStoryboard({ title: 'Hi', seconds: 3, style: 'minimal' });
    expect(sb.shots.map((s) => [s.kind, s.start, s.end])).toEqual([
      ['title-in', 0, 0.6],
      ['hold', 0.6, 2.55],
      ['title-out', 2.55, 3],
    ]);
    expect(sb.subtitle).toBeNull();
  });
});

describe('requestProblem', () => {
  it('合格 → null;空标题、超长、时长越界、不认识的风格 → 原因', () => {
    expect(requestProblem({ title: 'VidRoom', seconds: 10, style: 'gradient' })).toBeNull();
    expect(requestProblem({ title: '  ', seconds: 10, style: 'gradient' })).toMatch(/标题/);
    expect(requestProblem({ title: '字'.repeat(41), seconds: 10, style: 'gradient' })).toMatch(/40/);
    expect(requestProblem({ title: 'a', subtitle: 'b'.repeat(61), seconds: 10, style: 'gradient' })).toMatch(/副标题/);
    expect(requestProblem({ title: 'a', seconds: 2, style: 'gradient' })).toMatch(/时长/);
    expect(requestProblem({ title: 'a', seconds: 31, style: 'gradient' })).toMatch(/时长/);
    expect(requestProblem({ title: 'a', seconds: 10, style: 'neon' as never })).toMatch(/风格/);
  });
});

describe('构建 buildComposition', () => {
  const html = (style: 'minimal' | 'gradient', title = 'VidRoom') =>
    buildComposition(planStoryboard({ title, subtitle: '副标题', seconds: 10, style }));

  it('是一份 HyperFrames 合成:根元素带 data-composition-id、时长、尺寸、帧率,且标了 data-no-timeline', () => {
    const h = html('gradient');
    expect(h).toMatch(/<div id="root" data-composition-id="root" data-no-timeline data-start="0" data-duration="10" data-width="1280" data-height="720" data-fps="30">/);
    expect(h).toContain('>VidRoom</div>');
    expect(h).toContain('>副标题</div>');
  });

  it('不引任何外部资源(渲染时不联网):没有 <script>、没有 http 地址', () => {
    for (const style of ['minimal', 'gradient'] as const) {
      const h = html(style);
      expect(h).not.toMatch(/<script/i);
      expect(h).not.toMatch(/https?:\/\//);
    }
  });

  it('两个风格包看得出区别:简约是米白底 + 进度线,渐变是深色底 + 三团光斑', () => {
    const minimal = html('minimal');
    const gradient = html('gradient');
    expect(minimal).toContain('#f4f1ea');
    expect(minimal).toContain('m-progress 10s linear 0s');
    expect(minimal).not.toContain('class="blob');
    expect(gradient).toContain('#0b1020');
    expect(gradient.match(/class="blob b\d"/g)).toHaveLength(3);
    expect(gradient).toContain('g-drift1 10s linear 0s');
  });

  it('底色画在 .bg 上,不画在根元素上(png-sequence 会把根元素背景当透明)', () => {
    for (const style of ['minimal', 'gradient'] as const) {
      const h = html(style);
      expect(h).toMatch(/#root \{ color: [^}]*\}/);
      expect(h).not.toMatch(/#root \{[^}]*background/);
      expect(h).toContain('<div class="bg"></div>');
    }
  });

  it('标题转义,塞不进标签或脚本', () => {
    const h = html('minimal', '<img src=x onerror=alert(1)>"&\'');
    expect(h).not.toContain('<img');
    expect(h).toContain(escapeHtml('<img src=x onerror=alert(1)>"&\''));
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});
