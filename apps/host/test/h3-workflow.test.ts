import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { H3_MODEL_FILES } from '../src/h3/models.js';
import {
  AI_GENERATED_TAG,
  H3_WORKFLOW_SOURCE,
  InvalidFrameCountError,
  buildH3Prompt,
  buildPromptRequest,
} from '../src/h3/workflow.js';

/** 锁定 commit 下的官方 UI 格式模板原文(test/fixtures),用来逐项核对 API 格式里的参数确实出自它 */
const raw = readFileSync(new URL('./fixtures/video_minimax_h3_t2v.e7cd011d.json', import.meta.url));
const ui = JSON.parse(raw.toString('utf8'));
const sub = ui.definitions.subgraphs[0];
const uiNode = (id: number) => sub.nodes.find((n: { id: number }) => n.id === id);

describe('H3 文生视频工作流(锁定官方模板)', () => {
  const g = buildH3Prompt({ prompt: 'A ginger cat on a windowsill.', frames: 124, seed: 7 });

  it('_source 记着来源仓库、路径、commit 和模板原文 sha256', () => {
    expect(H3_WORKFLOW_SOURCE.repo).toBe('https://github.com/Comfy-Org/workflow_templates');
    expect(H3_WORKFLOW_SOURCE.path).toBe('templates/video_minimax_h3_t2v.json');
    expect(H3_WORKFLOW_SOURCE.commit).toBe('e7cd011d4ded3411c2f481200544f0be6fdc962e');
    expect(createHash('sha256').update(raw).digest('hex')).toBe(H3_WORKFLOW_SOURCE.template_sha256);
  });

  it('关键节点:MiniMaxH3ImageToVideo 不接首尾帧、CLIPLoader type=minimax、res_multistep+simple、20 步、BasicGuider', () => {
    const byType = (t: string) => Object.values(g).filter((n) => n.class_type === t);
    const i2v = byType('MiniMaxH3ImageToVideo');
    expect(i2v).toHaveLength(1);
    expect(i2v[0].inputs).not.toHaveProperty('first_frame');
    expect(i2v[0].inputs).not.toHaveProperty('last_frame');
    expect(byType('CLIPLoader')[0].inputs.type).toBe('minimax');
    expect(byType('KSamplerSelect')[0].inputs.sampler_name).toBe('res_multistep');
    expect(byType('BasicScheduler')[0].inputs).toMatchObject({ scheduler: 'simple', steps: 20, denoise: 1 });
    expect(byType('BasicGuider')).toHaveLength(1);
    // 无 CFG、无负面提示词:没有 CFGGuider / KSampler / 第二个条件输入
    expect(byType('CFGGuider')).toHaveLength(0);
    expect(byType('KSampler')).toHaveLength(0);
    expect(Object.keys(byType('BasicGuider')[0].inputs).sort()).toEqual(['conditioning', 'model']);
    expect(byType('LoraLoaderModelOnly')).toHaveLength(0);
  });

  it('参数出自模板:加载器文件名、采样器、调度器、步数、fps、保存前缀', () => {
    expect(g['140:127'].inputs.unet_name).toBe(uiNode(127).widgets_values[0]);
    expect(g['140:127'].inputs.weight_dtype).toBe(uiNode(127).widgets_values[1]);
    expect([g['140:128'].inputs.clip_name, g['140:128'].inputs.type, g['140:128'].inputs.device]).toEqual(uiNode(128).widgets_values);
    expect(g['140:119'].inputs.vae_name).toBe(uiNode(119).widgets_values[0]);
    expect(g['140:120'].inputs.vae_name).toBe(uiNode(120).widgets_values[0]);
    expect(g['140:123'].inputs.sampler_name).toBe(uiNode(123).widgets_values[0]);
    expect(g['140:124'].inputs.scheduler).toBe(uiNode(124).widgets_values[0]);
    expect(g['140:124'].inputs.denoise).toBe(uiNode(124).widgets_values[2]);
    // turbo 关(模板默认)时步数取 PrimitiveInt 137
    expect(uiNode(139).widgets_values[0]).toBe(false);
    expect(g['140:124'].inputs.steps).toBe(uiNode(137).widgets_values[0]);
    expect([g['140:130'].inputs.fps, g['140:130'].inputs.bit_depth]).toEqual(uiNode(130).widgets_values);
    const save = ui.nodes.find((n: { id: number }) => n.id === 92);
    expect([g['92'].inputs.filename_prefix, g['92'].inputs.format, g['92'].inputs['format.codec']]).toEqual(save.widgets_values);
    // 模板里的 ResolutionSelector:16:9、0.4 MP、32 的倍数 → 864x480
    const res = ui.nodes.find((n: { id: number }) => n.id === 115);
    expect(res.widgets_values).toEqual(['16:9 (Widescreen)', 0.4, 32]);
    const scale = Math.sqrt((0.4 * 1024 * 1024) / (16 * 9));
    expect(g['140:131'].inputs.width).toBe(Math.round((16 * scale) / 32) * 32);
    expect(g['140:131'].inputs.height).toBe(Math.round((9 * scale) / 32) * 32);
  });

  it('只用 ComfyUI 核心节点(零第三方节点),模型文件名都在权重清单里', () => {
    const core = new Set([
      'UNETLoader', 'CLIPLoader', 'VAELoader', 'MiniMaxH3ImageToVideo', 'BasicGuider', 'KSamplerSelect',
      'BasicScheduler', 'RandomNoise', 'SamplerCustomAdvanced', 'VAEDecode', 'VAEDecodeAudio', 'CreateVideo', 'SaveVideo',
    ]);
    for (const n of Object.values(g)) expect(core.has(n.class_type), n.class_type).toBe(true);
    const names = new Set(H3_MODEL_FILES.map((f) => f.fileName));
    for (const n of Object.values(g)) {
      for (const k of ['unet_name', 'clip_name', 'vae_name']) if (k in n.inputs) expect(names.has(n.inputs[k] as string)).toBe(true);
    }
  });

  it('所有连线都指向存在的节点', () => {
    for (const n of Object.values(g)) {
      for (const v of Object.values(n.inputs)) if (Array.isArray(v)) expect(g).toHaveProperty([v[0] as string]);
    }
  });

  it('只填提示词、帧数、种子;请求体带 AI 生成标注', () => {
    expect(g['140:131'].inputs).toMatchObject({ prompt: 'A ginger cat on a windowsill.', length: 124 });
    expect(g['140:129'].inputs.noise_seed).toBe(7);
    const body = buildPromptRequest({ prompt: 'x', frames: 73, seed: 1 }, 'cid');
    expect(body.client_id).toBe('cid');
    expect(body.extra_data.extra_pnginfo.comment).toBe(AI_GENERATED_TAG);
    expect(AI_GENERATED_TAG).toBe('AI-generated with MiniMax H3');
  });

  it('非法帧数不生成请求', () => {
    for (const frames of [72, 120, 0, 363, 73.5]) {
      expect(() => buildH3Prompt({ prompt: 'x', frames, seed: 1 })).toThrow(InvalidFrameCountError);
    }
  });
});
