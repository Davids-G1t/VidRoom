/** H3 请求体:四处填空 + 非法帧数不提交。 */
import { describe, expect, it } from 'vitest';
import { AI_GENERATED_TAG, InvalidFrameCountError, buildH3Prompt } from '../src/h3.js';

const PARAMS = { prompt: '一只猫', frames: 175, width: 1152, height: 640, seed: 42 };

describe('H3 请求体', () => {
  it('只填四处:提示词、帧数、宽高、种子', () => {
    const graph = buildH3Prompt(PARAMS);
    expect(graph['140:131']?.inputs.prompt).toBe('一只猫');
    expect(graph['140:131']?.inputs.length).toBe(175);
    expect(graph['140:131']?.inputs.width).toBe(1152);
    expect(graph['140:131']?.inputs.height).toBe(640);
    expect(graph['140:129']?.inputs.noise_seed).toBe(42);
    expect(Object.keys(graph).length).toBeGreaterThan(10);
  });

  it('每次返回的是模板的深拷贝,上一次的填空不会渗进下一次', () => {
    const first = buildH3Prompt(PARAMS);
    const second = buildH3Prompt({ ...PARAMS, prompt: '一只狗' });
    expect(first['140:131']?.inputs.prompt).toBe('一只猫');
    expect(second['140:131']?.inputs.prompt).toBe('一只狗');
    expect(first).not.toBe(second);
    expect(first['140:131']).not.toBe(second['140:131']);
  });

  it('不在 17k+5 网格上的帧数直接抛错,不提交', () => {
    expect(() => buildH3Prompt({ ...PARAMS, frames: 169 })).toThrow(InvalidFrameCountError);
    expect(() => buildH3Prompt({ ...PARAMS, frames: 169 })).toThrow(/帧数 169 不在 H3 的 17k\+5 网格上/);
  });

  it('空提示词不提交', () => {
    expect(() => buildH3Prompt({ ...PARAMS, prompt: '   ' })).toThrow(/提示词为空/);
  });

  it('成片标注写的就是给 ExtraPNGInfo 的那个字符串', () => {
    expect(AI_GENERATED_TAG).toBe('AI-generated with MiniMax H3');
  });
});
