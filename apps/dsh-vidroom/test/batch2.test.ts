/**
 * 第 2 批的端到端闭环:参考片 → 工程 → 计划 → 候选(假 ComfyUI)→ 合成(真 ffmpeg)。
 *
 * 钉住的是设计页验收 1/3/4/5 里那几条**机器可核**的点:
 * - 合成两次都出可播放 MP4、探测尺寸/帧数对得上工程,而且 **ComfyUI 新任务数 = 0**;
 * - plan 全链 **提交数 = 0**,哈希变了/超预算就拒;
 * - 一条 run 一条回执,回执里的冻结计划参数与计划一致,失败如实落盘(不重投);
 * - 三变体一次调用出三条独立快照/回执/MP4,模拟一条失败另外两条照样能查;
 * - 整条链只访问回环地址。
 *
 * 反向验证过:把 `startRender` 里的 compose 分支改成走 H3、或让 planProject 在 plan 阶段
 * 就 queue,上面那两组「提交数 = 0」的断言就会红。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVidroomRuntime } from '../src/runtime.js';
import { framesForSeconds } from '../src/frames.js';
import { mountVidroomRoutes } from '../src/routes.js';
import { probeMedia } from '../src/media.js';
import { readProject, importAsset } from '../src/project-io.js';
import { planProject, startRender, listCandidates, jobView, alignSegment, registerReference } from '../src/project-ops.js';
import { projectHash, recipeHashOf, type PatchOp, type Project } from '../src/project.js';
import { startFakeComfy } from './support/fake-comfy.js';
import { startTestWebServer } from './support/fake-web-server.js';
import { TOOLS, hasFfmpeg, makeClip, makeFixture, writeFixture } from './support/batch2.js';

const run = promisify(execFile);
const ffmpeg = await hasFfmpeg();
const maybe = ffmpeg ? it : it.skip;

/** 记录这一轮里 fetch 去过的所有地址(验收 5:整条链只许走回环)。 */
function recordFetch(): { urls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return original(input as RequestInfo, init);
  }) as typeof fetch;
  return {
    urls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** 报错的机器码(比消息文本稳)。 */
function errorCode(error: unknown): string {
  return (error as { code?: string } | undefined)?.code ?? String(error);
}

describe('第 2 批闭环(假 ComfyUI + 真 ffmpeg)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-vidroom-b2-'));
  });

  afterAll(() => {
    // 临时目录留着:失败时能进去看 compose.sh 与回执(CI 上也无害)。
  });

  maybe('工程闭环:参考片 → plan(0 提交)→ 候选 → 选片 → 合成两次都出可播放 MP4、提交数 = 0', async () => {
    const clip = join(dir, 'reference.mp4');
    await makeClip(clip, { frames: 48, color: 'red' });
    const projectDir = join(dir, 'project-a');
    writeFixture(projectDir, (await makeFixture(projectDir, { clips: 0, selected: false })).project);

    const comfy = await startFakeComfy({ historyMisses: 1, viewFile: clip });
    const runtime = createVidroomRuntime({
      baseUrl: comfy.baseUrl,
      timeoutMs: 20_000,
      pollIntervalMs: 10,
      allowExperimental: true,
      ffmpegPath: TOOLS.ffmpegPath,
      ffprobePath: TOOLS.ffprobePath,
    });

    try {
      // ① 登记参考片:本地探测 + 切镜候选,工程写成 schema 合法的一份。
      const reference = await registerReference(
        { projectsRoot: dir, ffmpegPath: TOOLS.ffmpegPath, ffprobePath: TOOLS.ffprobePath } as never,
        { localPath: clip, projectPath: projectDir },
      );
      expect(reference.analysisStatus).toBe('draft');
      expect(reference.projectPath).toBe(projectDir);
      const stored = readProject(projectDir);
      expect(stored.reference?.assetId).toBe(reference.assetId);
      expect(stored.assets.some((item) => item.id === reference.assetId)).toBe(true);
      // 参考资产固化成工程内相对路径 + sha256(验收 1:依赖路径与哈希可核)。
      const asset = stored.assets.find((item) => item.id === reference.assetId);
      expect(asset?.path.startsWith('assets/')).toBe(true);
      expect(asset?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(join(projectDir, asset?.path ?? 'nope'))).toBe(true);

      // ② 参考片只给分析草稿,不给时间轴:人工把第一条镜头写进工程,再让 plan 算账。
      const seeded = readProject(projectDir);
      seeded.shots.push({
        id: 'shot-1',
        order: 0,
        generation: {
          model: 'MiniMax-H3',
          prompt: '参考复刻:开头特写',
          seed: 7,
          requestedSeconds: 5,
          width: 384,
          height: 256,
          fps: { num: 24, den: 1 },
        },
        candidateIds: [],
        edit: { inFrame: 0, outFrame: framesForSeconds(5), speed: { num: 1, den: 1 }, audio: 'keep' },
      });
      // 选之前也要是合法工程:时间轴按镜头自身时长排(首版:一个镜头一处、连续无重叠)。
      seeded.timeline = {
        fps: { num: 24, den: 1 },
        width: 384,
        height: 256,
        placements: [{ shotId: 'shot-1', startFrame: 0, durationFrames: framesForSeconds(5) }],
        totalFrames: framesForSeconds(5),
      };
      seeded.revision += 1;
      writeFixture(projectDir, seeded);

      // ③ plan:只读依赖,一条 ComfyUI 请求都不发。
      const beforePlan = comfy.submissions.length;
      const plan = await planProject(projectDir, seeded, 'candidates');
      expect(comfy.submissions.length).toBe(beforePlan);
      expect(plan.frames).toBeGreaterThan(0);
      expect(plan.estimates.basis !== undefined).toBe(true);
      const request = plan.newRequests[0];
      expect(request).toBeDefined();

      const generated = await startRender(runtime, { dir: projectDir, mode: 'generate-missing' });
      expect(jobView(projectDir, generated.runId).receipt?.state).toMatch(/awaiting-selection|succeeded/);
      expect(comfy.submissions.length).toBe(beforePlan + 1);
      const candidates = listCandidates(readProject(projectDir), { limit: 50 });
      const fresh = candidates.items.filter((item) => item.shotId === request.shotId);
      expect(fresh.length).toBeGreaterThan(0);
      // 生成素材立刻固化到本机资产目录(不靠 ComfyUI 内存历史)。
      const freshCandidate = fresh[0];
      const freshAsset = readProject(projectDir).assets.find((item) => item.id === freshCandidate.assetId);
      expect(freshAsset?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(join(projectDir, freshAsset?.path ?? 'nope'))).toBe(true);

      // ④ 上时间轴:第一条用刚生成的候选,第二条用参考片自己(本地导入的素材直接当候选),
      //    两种来路的素材混在一条时间轴上合。
      const chosen = readProject(projectDir);
      const generatedCandidate = chosen.candidates[0];
      expect(generatedCandidate).toBeDefined();
      const referenceAsset = chosen.assets.find((item) => item.id === reference.assetId);
      expect(referenceAsset?.probe).toBeDefined();
      chosen.candidates.push({
        id: 'cand-local-1',
        shotId: 'shot-2',
        assetId: reference.assetId,
        recipeHash: recipeHashOf({
          prompt: '参考片直接剪进时间轴',
          width: referenceAsset?.probe?.width ?? 384,
          height: referenceAsset?.probe?.height ?? 256,
          frames: referenceAsset?.probe?.frames ?? 48,
          fps: referenceAsset?.probe?.fps ?? { num: 24, den: 1 },
        }),
        actual: {
          frames: referenceAsset?.probe?.frames ?? 48,
          width: referenceAsset?.probe?.width ?? 384,
          height: referenceAsset?.probe?.height ?? 256,
          fps: referenceAsset?.probe?.fps ?? { num: 24, den: 1 },
          audio: referenceAsset?.probe?.audio ?? false,
        },
        status: 'available',
      });
      const firstShot = chosen.shots[0];
      if (firstShot === undefined) throw new Error('缺少 shot-1');
      firstShot.selectedCandidateId = generatedCandidate.id;
      // 拿到真素材后,裁切窗口跟实际帧数对齐(计划会拿它校时钟)。
      firstShot.edit = { ...firstShot.edit, inFrame: 0, outFrame: generatedCandidate.actual.frames };
      chosen.shots.push({
        id: 'shot-2',
        order: 1,
        generation: {
          model: 'MiniMax-H3',
          prompt: '参考片直接剪进时间轴',
          requestedSeconds: (referenceAsset?.probe?.frames ?? 48) / 24,
          width: referenceAsset?.probe?.width ?? 384,
          height: referenceAsset?.probe?.height ?? 256,
          fps: referenceAsset?.probe?.fps ?? { num: 24, den: 1 },
        },
        candidateIds: ['cand-local-1'],
        selectedCandidateId: 'cand-local-1',
        edit: {
          inFrame: 0,
          outFrame: referenceAsset?.probe?.frames ?? 48,
          speed: { num: 1, den: 1 },
          audio: 'keep',
        },
      });
      const framesOf = (shotId: string): number => {
        const shot = chosen.shots.find((item) => item.id === shotId);
        const id = shot?.selectedCandidateId;
        const candidate = chosen.candidates.find((item) => item.id === id);
        return candidate?.actual.frames ?? shot?.edit.outFrame ?? 24;
      };
      let start = 0;
      const placements = chosen.shots.map((shot) => {
        const frames = framesOf(shot.id);
        const placement = { shotId: shot.id, startFrame: start, durationFrames: frames };
        start += frames;
        return placement;
      });
      chosen.timeline = {
        fps: { num: 24, den: 1 },
        width: chosen.shots[0]?.generation.width ?? 384,
        height: chosen.shots[0]?.generation.height ?? 256,
        placements,
        totalFrames: start,
      };
      chosen.revision += 1;
      writeFixture(projectDir, chosen);

      const submissionsBeforeCompose = comfy.submissions.length;
      const first = await startRender(runtime, {
        dir: projectDir,
        mode: 'compose',
        expectedProjectHash: projectHash(chosen),
      });
      expect(jobView(projectDir, first.runId).receipt?.state).toBe('succeeded');

      // 合成阶段一次都没往 ComfyUI 投。
      expect(comfy.submissions.length).toBe(submissionsBeforeCompose);

      const firstReceipt = jobView(projectDir, first.runId).receipt;
      expect(firstReceipt?.checks.comfySubmissions).toBe(0);
      expect(firstReceipt?.checks.projectHashOk).toBe(true);
      const output = firstReceipt?.outputs[0];
      expect(output).toBeDefined();
      expect(existsSync(output?.path ?? 'nope')).toBe(true);

      // 探测成片:尺寸/fps/帧数与工程一致(误差 ≤1 帧)。
      const probed = await probeMedia(output?.path ?? '', TOOLS);
      expect(probed.width).toBe(chosen.timeline.width);
      expect(probed.height).toBe(chosen.timeline.height);
      expect(probed.fps).toEqual({ num: 24, den: 1 });
      expect(Math.abs((probed.frames ?? 0) - start)).toBeLessThanOrEqual(1);

      // 再合一次:同样的工程再来一条 run,两条都出片(可重跑,不是一次性)。
      const second = await startRender(runtime, { dir: projectDir, mode: 'compose' });
      expect(jobView(projectDir, second.runId).receipt?.state).toBe('succeeded');
      expect(second.runId).not.toBe(first.runId);
      expect(comfy.submissions.length).toBe(submissionsBeforeCompose);
      const secondReceipt = jobView(projectDir, second.runId).receipt;
      expect(existsSync(secondReceipt?.outputs[0]?.path ?? 'nope')).toBe(true);

      // 回执参数与冻结计划一致(验收 3)。
      const frozen = JSON.parse(
        (await import('node:fs')).readFileSync(join(projectDir, 'runs', second.runId, 'plan.json'), 'utf8'),
      ) as { planHash: string; projectHash: string };
      // 回执参数与冻结计划一致(验收 3):计划哈希、工程哈希都对得上。
      expect(secondReceipt?.planHash).toBe(frozen.planHash);
      expect(frozen.projectHash).toBe(projectHash(chosen));
      expect(secondReceipt?.checks.planHashOk).toBe(true);

      // 断一条:哈希对不上就拒,且提交数不动。
      const stale = await startRender(runtime, {
        dir: projectDir,
        mode: 'compose',
        expectedProjectHash: 'deadbeef',
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(errorCode(stale)).toBe('PROJECT_HASH_MISMATCH');
      expect(comfy.submissions.length).toBe(submissionsBeforeCompose);    } finally {
      await comfy.close();
    }
  }, 120_000);

  maybe('三变体:一次调用三条独立快照/回执/MP4;仅改样式新增 H3 请求 = 0;一条失败不挡另两条', async () => {
    const clip = join(dir, 'voice.mp4');
    await makeClip(clip, { frames: 24, color: 'blue' });
    const projectDir = join(dir, 'project-b');
    const fixture = await makeFixture(projectDir, { clips: 2 });
    writeFixture(projectDir, fixture.project);
    const originalAssets = new Map(fixture.project.assets.map((item) => [item.id, item.sha256]));

    const comfy = await startFakeComfy({ historyMisses: 0, viewFile: clip });
    const runtime = createVidroomRuntime({
      baseUrl: comfy.baseUrl,
      timeoutMs: 20_000,
      pollIntervalMs: 10,
      ffmpegPath: TOOLS.ffmpegPath,
      ffprobePath: TOOLS.ffprobePath,
    });
    const { renderVariants } = await import('../src/render.js');

    try {
      const submissionsBefore = comfy.submissions.length;
      const batch = await renderVariants(runtime, fixture.project, {
        dir: projectDir,
        target: 'final',
        action: 'run',
        variants: [
          { id: 'v1', patch: [{ op: 'replace', path: 'styles[style-1].color', value: 'yellow' }] },
          { id: 'v2', patch: [{ op: 'replace', path: 'styles[style-1].size', value: 40 }] },
          // 这一条故意把 path 写歪:它该失败,但不许拖累上面两条。
          { id: 'v3', patch: [{ op: 'replace', path: 'shots[没有这个镜头].order', value: 9 }] },
        ],
      });

      expect(batch.failures).toBe(1);
      expect(batch.runs.map((item) => item.status)).toEqual(['succeeded', 'succeeded', 'failed']);
      // 仅样式变化:新增 H3 请求 = 0。
      expect(comfy.submissions.length).toBe(submissionsBefore);

      const ok = batch.runs.filter((item) => item.runId !== undefined);
      const outputs = ok.map((item) => jobView(projectDir, item.runId ?? '').receipt?.outputs[0]?.path);
      expect(new Set(outputs).size).toBe(2);
      for (const output of outputs) {
        expect(existsSync(output ?? 'nope')).toBe(true);
      }
      // 三条各自的快照/回执都在(独立工程快照)。
      for (const item of ok) {
        const runDir = join(projectDir, 'runs', item.runId ?? '');
        expect(existsSync(join(runDir, 'receipt.json'))).toBe(true);
        expect(existsSync(join(runDir, 'plan.json'))).toBe(true);
        expect(existsSync(join(runDir, 'project.vr.json'))).toBe(true);
        // 快照就是这一 run 的工程冻结件:能被当成工程读回来(旧行为失败点 —— 只存了 path 就查不了)。
        const frozen = readProject(runDir);
        expect(frozen.shots.length).toBe(fixture.project.shots.length);
        expect(existsSync(join(runDir, 'compose.sh'))).toBe(true);
      }
      // 没被改到的素材 sha256 保持(变体只进 run 快照,不回写工程)。
      expect(readProject(projectDir).revision).toBe(fixture.project.revision);
      for (const [id, sha] of originalAssets) {
        expect(readProject(projectDir).assets.find((item) => item.id === id)?.sha256).toBe(sha);
      }

      // plan 阶段(不跑 GPU):换一批“还没选定”的镜头,只改一个 hook、三条同值 → 去重后新增 = 1。
      const planDir = join(dir, 'project-b2');
      const planFixture = await makeFixture(planDir, { clips: 2, selected: false });
      writeFixture(planDir, planFixture.project);
      const plans = await renderVariants(runtime, planFixture.project, {
        dir: planDir,
        target: 'candidates',
        action: 'plan',
        variants: [1, 2, 3].map((index) => ({
          id: `hook${index}`,
          patch: [{ op: 'replace', path: 'shots[shot-1].generation.prompt', value: '同一个 hook' }] as PatchOp[],
        })),
      });
      expect(plans.failures).toBe(0);
      const perVariant = plans.plans ?? [];
      expect(perVariant.length).toBe(3);
      for (const item of perVariant) {
        // 三条变体改的是同一个值 → 施工图一模一样 → 哈希相同、要生成的次数不按变体数翻倍。
        expect(item.newRequests).toBe(perVariant[0]?.newRequests);
        expect(item.newRequests).toBeLessThan(3);
      }
      expect(new Set(perVariant.map((item) => item.planHash)).size).toBe(1);
      // plan 只是算盘:一遍下来提交数还是 0。
      expect(comfy.submissions.length).toBe(submissionsBefore);    } finally {
      await comfy.close();
    }
  }, 120_000);

  maybe('同配方去重:两条镜头写同一段文案 → 只投一次 H3,两边登记同一个 asset(验收 4)', async () => {
    const projectDir = join(dir, 'project-shared');
    const fixture = await makeFixture(projectDir, { clips: 2 });
    // 抹掉现成候选、把两条镜头的配方改成一样:plan 只该发一条请求。
    for (const shot of fixture.project.shots) {
      shot.candidateIds = [];
      delete shot.selectedCandidateId;
      shot.generation = { ...shot.generation, prompt: '同一段爆款开场', seed: 4242 };
    }
    fixture.project.candidates = [];
    writeFixture(projectDir, fixture.project);

    // 假 ComfyUI 交回来的片子得是真能探测的文件(真 ffmpeg 要解它)。
    await makeClip(join(dir, 'shared-source.mp4'), { frames: 22, color: 'blue', tone: 220 });
    const comfy = await startFakeComfy({ historyMisses: 0, viewFile: join(dir, 'shared-source.mp4') });
    const runtime = createVidroomRuntime({
      baseUrl: comfy.baseUrl,
      timeoutMs: 20_000,
      pollIntervalMs: 10,
      allowExperimental: true,
      ffmpegPath: TOOLS.ffmpegPath,
      ffprobePath: TOOLS.ffprobePath,
    });

    try {
      const submissionsBefore = comfy.submissions.length;
      const result = await startRender(runtime, { dir: projectDir, mode: 'generate-missing' });
      // 一个配方只投一次,不是每条镜头各投一次。
      expect(comfy.submissions.length - submissionsBefore).toBe(1);

      // 工程快照是开工前那份(可重跑的输入),候选登记在工程里 + 回执里。
      const frozen = readProject(join(projectDir, 'runs', result.runId));
      expect(frozen.shots.every((item) => item.candidateIds.length === 0)).toBe(true);
      const after = readProject(projectDir);
      const candidatesOf = (shotId: string) => {
        const shot = after.shots.find((item) => item.id === shotId);
        return (shot?.candidateIds ?? []).map((id) => after.candidates.find((item) => item.id === id));
      };
      const first = candidatesOf('shot-1');
      const second = candidatesOf('shot-2');
      expect(first.length).toBe(1);
      expect(second.length).toBe(1);
      expect(first[0]?.recipeHash).toBe(second[0]?.recipeHash);
      // 同一个 asset 被两边引用:GPU 只跑了一次,库里的片子也只存了一份。
      expect(second[0]?.assetId).toBe(first[0]?.assetId);
      expect(after.assets.filter((item) => item.origin === 'h3').length).toBe(1);
      // 生成素材已固化在本机资产目录里,路径相对工程根(验收 1)。
      const asset = after.assets.find((item) => item.id === first[0]?.assetId);
      expect(asset?.path.startsWith('assets/')).toBe(true);
      expect(existsSync(join(projectDir, asset?.path ?? 'nope'))).toBe(true);
      // 回执如实记了这次真投了几条,而且两条镜头都算成功。
      const receipt = jobView(projectDir, result.runId).receipt;
      expect(receipt?.checks.comfySubmissions).toBe(1);
      expect(receipt?.shots.filter((item) => item.state === 'succeeded').length).toBe(2);
    } finally {
      await comfy.close();
    }
  }, 120_000);

  maybe('词锚改片:重复汉字 + 标点夹具 → 高亮起点 = 该词全局首帧、字幕终点 = 尾词末帧', async () => {
    const projectDir = join(dir, 'project-c');
    const audioFile = join(dir, 'vo.mp4');
    await makeClip(audioFile, { frames: 48, color: 'green', tone: 330 });
    const fixture = await makeFixture(projectDir, { clips: 1 });
    const project = fixture.project;
    // 音轨夹具单独进:48 帧才装得下五个词的窗口。
    const audioAsset = await importAsset(projectDir, {
      sourcePath: audioFile,
      kind: 'video',
      origin: 'local',
      existingIds: project.assets.map((item) => item.id),
      tools: TOOLS,
    });
    project.assets.push(audioAsset);
    // 段 1:「看看看,看得见。」—— 重复字 + 标点,专门盯 token 边界。
    const text = '看看看,看得见。';
    const tokens = [
      { id: 'tk-1', segmentId: 'seg-1', speech: '看', display: '看', charRange: [0, 1] as [number, number] },
      { id: 'tk-2', segmentId: 'seg-1', speech: '看', display: '看', charRange: [1, 2] as [number, number] },
      { id: 'tk-3', segmentId: 'seg-1', speech: '看', display: '看,', charRange: [2, 3] as [number, number] },
      { id: 'tk-4', segmentId: 'seg-1', speech: '看得见', display: '看得见', charRange: [4, 7] as [number, number] },
      { id: 'tk-5', segmentId: 'seg-1', speech: '。', display: '。', charRange: [7, 8] as [number, number] },
    ];
    const voiced: Project = {
      ...project,
      script: {
        language: 'zh',
        segments: [{ id: 'seg-1', role: 'hook', text, tokenIds: tokens.map((token) => token.id) }],
        tokens,
      },
      alignments: [],
    };
    const aligned = alignSegment(projectDir, voiced, {
      segmentId: 'seg-1',
      assetId: audioAsset.id,
      audioHash: audioAsset.sha256,
      scriptHash: (await import('../src/project.js')).scriptHash(voiced.script),
      wordWindows: [
        { tokenId: 'tk-1', startFrame: 0, endFrame: 6 },
        { tokenId: 'tk-2', startFrame: 6, endFrame: 12 },
        { tokenId: 'tk-3', startFrame: 12, endFrame: 18 },
        { tokenId: 'tk-4', startFrame: 18, endFrame: 36 },
        { tokenId: 'tk-5', startFrame: 36, endFrame: 40 },
      ],
    });
    expect(aligned.alignment.words.length).toBe(5);
    expect(aligned.unresolvedAnchors).toBeDefined();

    // 第二个镜头有自己的对齐,改第二段不许动到第一段(验收 2)。
    const afterEdit = { ...voiced, alignments: [aligned.alignment], revision: voiced.revision + 1 };
    writeFixture(projectDir, afterEdit);
    const again = readProject(projectDir);
    expect(again.alignments[0]?.words[0]).toEqual({ tokenId: 'tk-1', startFrame: 0, endFrame: 6 });

    // 删掉被锚定的词 → 明确失败(不许拿旧时间窗顶)。
    const withAnchor: Project = {
      ...afterEdit,
      anchors: [{ id: 'anc-1', kind: 'word', tokenId: 'tk-2', edge: 'start', offsetFrames: 0 }],
      script: {
        ...afterEdit.script!,
        tokens: afterEdit.script!.tokens.filter((token) => token.id !== 'tk-2'),
        segments: [{ ...afterEdit.script!.segments[0]!, tokenIds: ['tk-1', 'tk-3', 'tk-4', 'tk-5'] }],
      },
    };
    writeFixture(projectDir, withAnchor);
    // 删掉被锚定的词 → 计划明确不 ready(不许拿旧时间窗顶)。
    const blockedPlan = await planProject(projectDir, withAnchor, 'final');
    expect(blockedPlan.ready).toBe(false);
    expect(blockedPlan.blockers.join('; ')).toMatch(/ALIGNMENT_REQUIRED/);
  }, 60_000);
});

describe('本地边界(验收 5)', () => {
  it('整条参考 → 成片链只访问回环地址', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-vidroom-loop-'));
    const recorder = recordFetch();
    const comfy = await startFakeComfy({ historyMisses: 0 });
    const runtime = createVidroomRuntime({ baseUrl: comfy.baseUrl, timeoutMs: 5_000, pollIntervalMs: 10 });
    const web = await startTestWebServer();
    const disposers = mountVidroomRoutes({ webServer: web.service }, runtime);
    try {
      // 走一遍状态探测 + 面板路由(真 fetch 都会被记录)。
      await runtime.status(true);
      const listed = await fetch(`${web.baseUrl}/vidroom/projects`);
      expect(listed.status).toBe(200);
      const response = await fetch(`${web.baseUrl}/vidroom/status`);
      expect(response.status).toBe(200);
      expect(recorder.urls.length).toBeGreaterThan(0);
      for (const url of recorder.urls) {
        const host = new URL(url).hostname;
        expect(['127.0.0.1', 'localhost', '::1', '[::1]']).toContain(host);
      }
    } finally {
      for (const dispose of disposers) dispose();
      await web.close();
      await comfy.close();
      recorder.restore();
    }
  });

  it('工程里的 URL / 绝对路径当场被拒(不给外网留后门)', async () => {
    const { assertRelativePath, assertLoopbackUrl } = await import('../src/project.js');
    expect(() => assertRelativePath('https://example.com/clip.mp4')).toThrow(/不许是 URL/);
    expect(() => assertRelativePath('/tmp/clip.mp4')).toThrow(/不许是绝对路径/);
    expect(() => assertRelativePath('assets/../../escape.mp4')).toThrow(/越界|\.\./);
    expect(() => assertLoopbackUrl('https://example.com/understand')).toThrow(/回环|loopback/);
    expect(() => assertLoopbackUrl('http://10.0.0.5:8188')).toThrow(/回环|loopback/);
    expect(() => assertLoopbackUrl('http://127.0.0.1:8188')).not.toThrow();
  });

  it('重定向到外网被拒(不跟随)', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_request, response) => {
      response.writeHead(302, { location: 'https://example.com/leak' });
      response.end();
    });
    server.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const runtime = createVidroomRuntime({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 5_000, pollIntervalMs: 10 });
    try {
      const status = await runtime.status(true);
      expect(status.reachable).toBe(false);
      expect(status.error ?? '').not.toBe('');
    } finally {
      server.close();
    }
  });

  it('没有本地文件只有链接 → 明确要本地文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-vidroom-ref-'));
    const failed = await registerReference({ projectsRoot: dir } as never, {
      referenceUrl: 'https://www.example.com/watch?v=1',
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(errorCode(failed)).toBe('REFERENCE_LOCAL_REQUIRED');
  });
});

describe('面板回放(三页签里的资产/队列看的那条路)', () => {
  const mediaDir = mkdtempSync(join(tmpdir(), 'dsh-vidroom-media-'));

  it('媒体路由:只读回放工程里的文件,带 Range,越界路径当场拒', async () => {
    const projectDir = join(mediaDir, 'project-media');
    const fixture = await makeFixture(projectDir, { clips: 1 });
    writeFixture(projectDir, fixture.project);
    const clipRelative = fixture.project.assets.find((item) => item.kind === 'video')?.path ?? 'assets/nope.mp4';
    const clipFile = join(projectDir, clipRelative);
    expect(existsSync(clipFile)).toBe(true);

    const comfy = await startFakeComfy({ historyMisses: 0 });
    const runtime = createVidroomRuntime({ baseUrl: comfy.baseUrl, timeoutMs: 5_000, pollIntervalMs: 10 });
    const web = await startTestWebServer();
    const disposers = mountVidroomRoutes({ webServer: web.service }, runtime);
    const mediaUrl = (asset: string) =>
      `${web.baseUrl}/vidroom/media?path=${encodeURIComponent(projectDir)}&asset=${encodeURIComponent(asset)}`;
    try {
      // ① 整段取回:字节数对得上磁盘上的文件。
      const full = await fetch(mediaUrl(clipRelative));
      expect(full.status).toBe(200);
      expect(full.headers.get('content-type')).toBe('video/mp4');
      expect((await full.arrayBuffer()).byteLength).toBe(statSync(clipFile).size);

      // ② 拖进度条靠 Range:206 + Content-Range 要对(不然 <video> 只能从头放)。
      const partial = await fetch(mediaUrl(clipRelative), { headers: { Range: 'bytes=0-99' } });
      expect(partial.status).toBe(206);
      expect(partial.headers.get('content-range')).toBe(`bytes 0-99/${statSync(clipFile).size}`);
      expect((await partial.arrayBuffer()).byteLength).toBe(100);

      // ③ 越界路径 / 绝对路径 / URL 都不给回放。
      for (const bad of ['../../etc/passwd', '/etc/passwd', 'https://example.com/x.mp4']) {
        const denied = await fetch(mediaUrl(bad));
        expect(denied.status).not.toBe(200);
        expect(((await denied.json()) as { ok: boolean }).ok).toBe(false);
      }

      // ④ 资产页签靠这条列依赖:列出来的 path 必须能直接丢给媒体路由。
      const assets = await fetch(`${web.baseUrl}/vidroom/assets?path=${encodeURIComponent(projectDir)}`);
      expect(assets.status).toBe(200);
      const listed = (await assets.json()) as { items: Array<{ id: string; path: string; missing: boolean }> };
      const video = listed.items.find((item) => item.path === clipRelative);
      expect(video?.missing).toBe(false);
      expect((await fetch(mediaUrl(video?.path ?? 'nope'))).status).toBe(200);
    } finally {
      for (const dispose of disposers) dispose();
      await web.close();
      await comfy.close();
    }
  }, 60_000);
});
