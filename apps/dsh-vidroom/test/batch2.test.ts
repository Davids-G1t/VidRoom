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
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVidroomRuntime } from '../src/runtime.js';
import { apply } from '../src/index.js';
import { framesForSeconds } from '../src/frames.js';
import { mountVidroomRoutes } from '../src/routes.js';
import { DEFAULT_PATCH_EXAMPLE } from '../src/client/project-panel.tsx';
import { probeMedia } from '../src/media.js';
import { buildComposeCommand } from '../src/compose.js';
import { readProject, importAsset, lockFileOf, projectFileOf, updateProject, withProjectLock, writeProject } from '../src/project-io.js';
import { planProject, patchProject, startRender, listCandidates, listAssets, jobView, alignSegment, registerReference, registerCandidate, candidateId, assertRecordedUrl, importProjectAsset } from '../src/project-ops.js';
import { readConfig } from '../src/config.js';
import { emptyProject, projectHash, recipeHashOf, type PatchOp, type Project } from '../src/project.js';
import { assertSupported, h3Capabilities } from '../src/adapter.js';
import { startFakeComfy } from './support/fake-comfy.js';
import { startTestWebServer } from './support/fake-web-server.js';
import { TOOLS, hasFfmpeg, makeClip, makeFixture, writeFixture } from './support/batch2.js';

const run = promisify(execFile);
const ffmpeg = await hasFfmpeg();
const maybe = ffmpeg ? it : it.skip;

/**
 * 带冻结计划的渲染:先 plan 拿 planHash,再 startRender。
 * 第 2 批起 render 必填 planHash —— 旧写法(直接 startRender,不带 planHash)会报 PLAN_HASH_MISMATCH。
 * render 现在非阻塞(校验完就回 runId),所以这里等它跑完才交回 —— 下面的断言看的是终态与产物。
 */
async function renderWithPlan(
  runtime: ReturnType<typeof createVidroomRuntime>,
  request: { dir: string; mode: 'compose' | 'generate-missing'; expectedProjectHash?: string },
): Promise<{ runId: string; mode: string }> {
  const plan = await planProject(
    request.dir,
    readProject(request.dir),
    request.mode === 'compose' ? 'final' : 'candidates',
  );
  const started = await startRender(runtime, {
    dir: request.dir,
    mode: request.mode,
    planHash: plan.planHash,
    ...(request.expectedProjectHash === undefined ? {} : { expectedProjectHash: request.expectedProjectHash }),
  });
  await waitForRun(request.dir, started.runId);
  return started;
}

/** 等一条 run 从 queued/running 走到终态(生成是分钟级的,进度靠轮询)。 */
async function waitForRun(dir: string, runId: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = jobView(dir, runId).receipt?.state;
    if (state !== undefined && state !== 'queued' && state !== 'running') return state;
    if (Date.now() > deadline) throw new Error(`run ${runId} 超时未收尾(当前 ${state ?? '没有回执'})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

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

      // ② 参考片只给分析草稿,不给时间轴:通过工具的 patch 入口把镜头与合成时钟写进工程。
      // 这里故意不直接写文件 —— 直接写就证明不了「工具面能建工程」(那是本轮审查抓的 P1)。
      const added = patchProject(projectDir, {
        baseHash: projectHash(stored),
        patch: [
          {
            op: 'add',
            path: 'shots',
            value: {
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
            },
          },
          {
            op: 'add',
            path: 'timeline',
            value: {
              fps: { num: 24, den: 1 },
              width: 384,
              height: 256,
              placements: [{ shotId: 'shot-1', startFrame: 0, durationFrames: framesForSeconds(5) }],
              totalFrames: framesForSeconds(5),
            },
          },
        ],
      });
      expect(added.changedPaths).toContain('shots');
      expect(added.changedPaths).toContain('timeline');
      const seeded = readProject(projectDir);
      expect(seeded.shots.map((shot) => shot.id)).toEqual(['shot-1']);
      expect(seeded.timeline?.totalFrames).toBe(framesForSeconds(5));

      // ③ plan:只读依赖,一条 ComfyUI 请求都不发。
      const beforePlan = comfy.submissions.length;
      const plan = await planProject(projectDir, seeded, 'candidates');
      expect(comfy.submissions.length).toBe(beforePlan);
      expect(plan.frames).toBeGreaterThan(0);
      expect(plan.estimates.basis !== undefined).toBe(true);
      const request = plan.newRequests[0];
      expect(request).toBeDefined();

      const generated = await renderWithPlan(runtime, { dir: projectDir, mode: 'generate-missing' });
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
      const first = await renderWithPlan(runtime, {
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
      const second = await renderWithPlan(runtime, { dir: projectDir, mode: 'compose' });
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
      const stale = await renderWithPlan(runtime, {
        dir: projectDir,
        mode: 'compose',
        expectedProjectHash: 'deadbeef',
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(errorCode(stale)).toBe('PROJECT_HASH_MISMATCH');
      expect(comfy.submissions.length).toBe(submissionsBeforeCompose);
    } finally {
      await comfy.close();
    }
  }, 120_000);

  maybe('预算超了就拒:plan 列得出来、render 直接回 BUDGET_EXCEEDED,ComfyUI 提交数仍 = 0(验收 3)', async () => {
    const projectDir = join(dir, 'project-budget');
    const fixture = await makeFixture(projectDir, { clips: 0, selected: false });
    fixture.project.shots.push({
      id: 'shot-1',
      order: 0,
      generation: {
        model: 'MiniMax-H3',
        prompt: '参考复刻:超预算那条',
        seed: 11,
        requestedSeconds: 5,
        width: 384,
        height: 256,
        fps: { num: 24, den: 1 },
      },
      candidateIds: [],
      edit: { inFrame: 0, outFrame: framesForSeconds(5), speed: { num: 1, den: 1 }, audio: 'keep' },
    });
    fixture.project.timeline = {
      fps: { num: 24, den: 1 },
      width: 384,
      height: 256,
      placements: [{ shotId: 'shot-1', startFrame: 0, durationFrames: framesForSeconds(5) }],
      totalFrames: framesForSeconds(5),
    };
    writeFixture(projectDir, fixture.project);

    const comfy = await startFakeComfy({});
    const runtime = createVidroomRuntime({
      baseUrl: comfy.baseUrl,
      timeoutMs: 20_000,
      pollIntervalMs: 10,
      allowExperimental: true,
      ffmpegPath: TOOLS.ffmpegPath,
      ffprobePath: TOOLS.ffprobePath,
    });

    try {
      const budget = { maxNewCandidates: 0 };
      const planned = await planProject(projectDir, readProject(projectDir), 'candidates', budget);
      expect(planned.newRequests.length).toBeGreaterThan(0); // 这条确实要新生成
      expect(planned.ready).toBe(false);
      expect(planned.blockers.join('; ')).toMatch(/BUDGET_EXCEEDED/);
      expect(comfy.submissions.length).toBe(0); // plan 阶段一条都不提交

      const rejected = await startRender(runtime, {
        dir: projectDir,
        mode: 'generate-missing',
        planHash: planned.planHash,
        budget,
      }).then(
        () => null,
        (error: unknown) => errorCode(error),
      );
      expect(rejected).toBe('BUDGET_EXCEEDED');
      expect(comfy.submissions.length).toBe(0); // 被拒之后也没提交
    } finally {
      await comfy.close();
    }
  }, 60_000);

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
      const specs = [
        { id: 'v1', patch: [{ op: 'replace', path: 'styles[style-1].color', value: 'yellow' }] },
        { id: 'v2', patch: [{ op: 'replace', path: 'styles[style-1].size', value: 40 }] },
        // 这一条故意把 path 写歪:它该失败,但不许拖累上面两条。
        { id: 'v3', patch: [{ op: 'replace', path: 'shots[没有这个镜头].order', value: 9 }] },
      ];

      // 不带 planHash 就跑:直接拒(run 时每条变体必须有冻结的计划)。旧写法在这儿会静默跑过去。
      const noPlan = await renderVariants(runtime, fixture.project, {
        dir: projectDir,
        target: 'final',
        action: 'run',
        variants: [specs[0]],
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(errorCode(noPlan)).toBe('PLAN_HASH_MISMATCH');

      // 先 plan 拿每条变体的 planHash,再带上去跑。
      const planned = await renderVariants(runtime, fixture.project, {
        dir: projectDir,
        target: 'final',
        action: 'plan',
        variants: specs,
      });
      const hashOf = new Map((planned.plans ?? []).map((item) => [item.variantId, item.planHash]));
      const batch = await renderVariants(runtime, fixture.project, {
        dir: projectDir,
        target: 'final',
        action: 'run',
        variants: specs.map((spec) => ({ ...spec, planHash: hashOf.get(spec.id) ?? 'missing' })),
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
      // 变体各跑各的:同一相对路径的资产, sha256 必须一致
      // (旧行为失败点:两个变体算出同一个 `asset-N`,后者把前者的文件覆盖掉 —— 快照里的哈希就对不上了)。
      const byPath = new Map<string, Set<string>>();
      for (const item of ok) {
        const frozen = readProject(join(projectDir, 'runs', item.runId ?? ''));
        for (const asset of frozen.assets) {
          const shas = byPath.get(asset.path) ?? new Set<string>();
          shas.add(asset.sha256);
          byPath.set(asset.path, shas);
        }
      }
      for (const [path, shas] of byPath) {
        expect(shas.size, `${path} 被两个变体写成了不同内容`).toBe(1);
        expect(existsSync(join(projectDir, path))).toBe(true);
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
      const result = await renderWithPlan(runtime, { dir: projectDir, mode: 'generate-missing' });
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
    // 工程得先在盘上(alignSegment 在锁里重读那份):把这份夹具落盘再对齐。
    writeProject(projectDir, voiced);
    const aligned = alignSegment(projectDir, {
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

    // 删掉被锚定的词 → 当场 ALIGNMENT_REQUIRED(不静默拆锚、也不拿旧时间窗顶;验收 2)。
    const removalCode = ((): string | null => {
      try {
        patchProject(projectDir, { patch: [{ op: 'remove', path: 'script.tokens[tk-2]' }] });
        return null;
      } catch (error: unknown) {
        return errorCode(error);
      }
    })();
    expect(removalCode).toBe('ALIGNMENT_REQUIRED');

    // 硬造一份「锚点指着已删的词」的工程也不许落盘(schema 这一层兜底)。
    const withAnchor: Project = {
      ...afterEdit,
      anchors: [{ id: 'anc-1', kind: 'word', tokenId: 'tk-2', edge: 'start', offsetFrames: 0 }],
      script: {
        ...afterEdit.script!,
        tokens: afterEdit.script!.tokens.filter((token) => token.id !== 'tk-2'),
        segments: [{ ...afterEdit.script!.segments[0]!, tokenIds: ['tk-1', 'tk-3', 'tk-4', 'tk-5'] }],
      },
    };
    expect(() => writeFixture(projectDir, withAnchor)).toThrow(/没有这个词|ALIGNMENT/);
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

describe('本地音轨(audio.mode)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-vidroom-audio-'));
  });

  maybe('纯音频能导入,audio.mode=local 时独立录音真的合进对应段', async () => {
    const projectDir = join(dir, 'project-audio');
    const fixture = await makeFixture(projectDir, { clips: 1 });
    const project = fixture.project;

    // 纯音频(没有画面):旧实现会在这儿被「没有视频轨」拒掉。
    const wav = join(dir, 'vo.wav');
    await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'pcm_s16le', wav]);
    const audioAsset = await importAsset(projectDir, {
      sourcePath: wav,
      kind: 'audio',
      origin: 'local',
      existingIds: project.assets.map((item) => item.id),
      tools: TOOLS,
    });
    expect(audioAsset.probe?.audio).toBe(true);
    expect(audioAsset.probe?.frames).toBe(0);

    // 声纹(独立录音)进工程,再用对齐把资产绑到段。
    project.assets.push(audioAsset);
    const text = '开场一句话。';
    const tokens = [
      { id: 'tk-1', segmentId: 'seg-1', speech: '开场', display: '开场', charRange: [0, 2] as [number, number] },
      { id: 'tk-2', segmentId: 'seg-1', speech: '一句话', display: '一句话', charRange: [2, 5] as [number, number] },
    ];
    const voiced: Project = {
      ...project,
      script: {
        language: 'zh',
        segments: [{ id: 'seg-1', role: 'hook', text, tokenIds: tokens.map((token) => token.id) }],
        tokens,
      },
      alignments: [],
      shots: project.shots.map((shot) => ({ ...shot, segmentId: 'seg-1' })),
    };
    // 工程得先在盘上(alignSegment 在锁里重读那份):把这份夹具落盘再对齐。
    writeProject(projectDir, voiced);
    alignSegment(projectDir, {
      segmentId: 'seg-1',
      assetId: audioAsset.id,
      audioHash: audioAsset.sha256,
      scriptHash: (await import('../src/project.js')).scriptHash(voiced.script),
      wordWindows: [
        { tokenId: 'tk-1', startFrame: 0, endFrame: 8 },
        { tokenId: 'tk-2', startFrame: 8, endFrame: 20 },
      ],
    });
    const withLocal = readProject(projectDir);
    // 对齐就是把独立录音登记进 audio.assetIds 的那一步。
    expect(withLocal.audio?.mode).toBe('local');
    expect(withLocal.audio?.assetIds).toEqual([audioAsset.id]);

    // 合成命令里必须出现独立录音这条输入,而且带上补静音(录音短了也不许音画漂)。
    const outPath = join(projectDir, 'runs', 'run-audio', 'final.mp4');
    const command = buildComposeCommand(withLocal, { dir: projectDir, runId: 'run-audio', outPath, tools: TOOLS });
    expect(command.inputs.some((item) => item.endsWith(`${audioAsset.id}.wav`))).toBe(true);
    expect(command.filterGraph).toContain('apad');

    // 真跑一遍:出得来片,而且成片是「独立录音」的声音而不是静音。
    const comfy = await startFakeComfy({ historyMisses: 0 });
    const runtime = createVidroomRuntime({
      baseUrl: comfy.baseUrl,
      timeoutMs: 20_000,
      pollIntervalMs: 10,
      allowExperimental: true,
      ffmpegPath: TOOLS.ffmpegPath,
      ffprobePath: TOOLS.ffprobePath,
    });
    try {
      const rendered = await renderWithPlan(runtime, { dir: projectDir, mode: 'compose' });
      expect(jobView(projectDir, rendered.runId).receipt?.state).toBe('succeeded');
      const output = join(projectDir, 'runs', rendered.runId, 'final.mp4');
      expect(existsSync(output)).toBe(true);
      const probe = await probeMedia(output, TOOLS);
      expect(probe.audio).toBe(true);
      expect(probe.frames).toBe(withLocal.timeline?.totalFrames);
      // 全程没有提交 H3:这一段音轨是本地录音,不该去要模型。
      expect(comfy.submissions.length).toBe(0);
    } finally {
      await comfy.close();
    }
  }, 60_000);

  maybe('audio.mode=silent 时候选自带的音轨也不许用', async () => {
    const projectDir = join(dir, 'project-silent');
    const fixture = await makeFixture(projectDir, { clips: 1 });
    // 夹具第一条片子带声音(tone),但工程写 silent → 合成里只能是 anullsrc。
    fixture.project.audio = { mode: 'silent', assetIds: [], alignmentStatus: 'pending' };
    writeFixture(projectDir, fixture.project);
    const project = readProject(projectDir);
    const command = buildComposeCommand(project, {
      dir: projectDir,
      runId: 'run-silent',
      outPath: join(projectDir, 'runs', 'run-silent', 'final.mp4'),
      tools: TOOLS,
    });
    expect(command.argv.join(' ')).toContain('anullsrc');
    expect(command.inputs).toHaveLength(1);
  }, 60_000);
});

/**
 * 第 2 批的本地边界:工程内容不进云端对话 —— 聊天侧那批工程工具**默认不注册**。
 *
 * 反向验证:把 `src/index.ts` 里的 `config.chatTools ?` 去掉(回到无条件注册),
 * 第一条断言就会红(默认配置下 `vidroom_project` 又冒出来了)。
 */
describe('工程工具的注册闸', () => {
  function chatHost(): { ctx: Parameters<typeof apply>[0]; names: () => string[] } {
    const names: string[] = [];
    const ctx = {
      tools: {
        register(definition: unknown) {
          const name = String((definition as { name?: unknown }).name);
          names.push(name);
          return () => {
            const at = names.indexOf(name);
            if (at >= 0) names.splice(at, 1);
          };
        },
      },
      get: () => undefined,
      effect: (callback: () => unknown) => {
        callback();
      },
      // 面板路由那条 inject 在本测试里不接线(只测工具注册闸)。
      inject: () => {},
    };
    return { ctx, names };
  }

  it('默认不把工程工具塞进聊天,只留第 1 批的两个', () => {
    const { ctx, names } = chatHost();
    apply(ctx, {});
    expect(names).toEqual(['vidroom_generate', 'vidroom_workflows']);
  });

  it('chatTools: true 才注册工程面(宿主聊天模型在本机跑时才准开)', () => {
    const { ctx, names } = chatHost();
    apply(ctx, { chatTools: true });
    expect(names).toContain('vidroom_project');
    expect(names).toContain('vidroom_align_words');
    expect(names).toContain('vidroom_render');
  });
});

/**
 * 第二轮审查抓出来的边界。每条都是**旧行为会红**的:改回旧写法这些断言就挂。
 */
describe('第二轮审查边界(旧行为会失败的那些)', () => {
  it('资产游标:翻页不漏项(旧行为:游标给「下一条」,每页白丢一项)', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dsh-vidroom-cursor-'));
    const project: Project = emptyProject('cursor');
    for (let index = 1; index <= 5; index += 1) {
      project.assets.push({
        id: `asset-${index}`,
        kind: 'video',
        path: `assets/asset-${index}.mp4`,
        sha256: 'a'.repeat(64),
        origin: 'local',
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const listed = listAssets(projectDir, project, { limit: 2, cursor });
      seen.push(...listed.items.map((item) => item.id));
      cursor = listed.nextCursor;
      if (cursor === undefined) break;
    }

    expect(seen).toEqual(['asset-1', 'asset-2', 'asset-3', 'asset-4', 'asset-5']);
  });

  it('回执停在 running 但本进程没在跑 → 报 unknown(待核),不冒充在跑、不自动重投', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dsh-vidroom-stale-run-'));
    const runDir = join(projectDir, 'runs', 'run-stale');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'receipt.json'),
      `${JSON.stringify(
        {
          runId: 'run-stale',
          projectPath: projectDir,
          projectHash: 'a'.repeat(64),
          planHash: 'b'.repeat(64),
          target: 'final',
          mode: 'final',
          state: 'running',
          startedAt: '2026-10-04T00:00:00.000Z',
          shots: [],
          outputs: [],
          checks: { projectHashOk: true, planHashOk: true, comfySubmissions: 0, h3Requests: 0, reusedCandidates: 0 },
          logs: [],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const list = jobView(projectDir);
    expect(list.runs?.[0]?.state).toBe('unknown');
    const single = jobView(projectDir, 'run-stale');
    expect(single.receipt?.state).toBe('unknown');
    // 提示里要说清楚是「上回留下的」,并且明说不自动重投。
    expect(single.summary).toContain('不自动重投');
  });

  it('工程锁的权重和盘上对不上 → 开工前就拒(旧行为:静默按新权重跑,结果不可比)', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dsh-vidroom-lock-'));
    const project: Project = {
      ...emptyProject('lock'),
      locks: {
        adapterVersion: '0.1.0',
        models: [{ file: '不存在的权重.safetensors', sha256: 'c'.repeat(64) }],
        fontAssetIds: [],
        deferred: [],
      },
    };
    writeFixture(projectDir, project);

    const runtime = createVidroomRuntime({
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 30_000,
      pollIntervalMs: 10,
      allowExperimental: true,
      ffmpegPath: TOOLS.ffmpegPath,
      ffprobePath: TOOLS.ffprobePath,
      modelsRoot: join(projectDir, 'models'),
    });

    const refused = await startRender(runtime, { dir: projectDir, mode: 'compose', planHash: 'd'.repeat(64) }).catch(
      (error: unknown) => error,
    );
    expect(errorCode(refused)).toBe('MODEL_MISMATCH');
  });

  it('能力接口给的默认参数自己能过校验(旧行为:默认 121 帧被 17k+5 网格当场拒)', () => {
    const capabilities = h3Capabilities({
      reachable: true,
      admissionAllowed: true,
      admissionReason: '',
      locks: { adapterVersion: '0.1.0', models: [{ file: 'm.safetensors', sha256: 'e'.repeat(64) }], fontAssetIds: [], deferred: [] },
    });
    expect(() =>
      assertSupported({
        prompt: '默认参数该能直接提交',
        width: capabilities.defaults.width,
        height: capabilities.defaults.height,
        frames: capabilities.defaults.frames,
      }),
    ).not.toThrow();
  });

  maybe('改完文案再合成 → 对齐作废,当场拒(旧行为:拿旧词窗硬合,字幕和画面错位)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-vidroom-stale-align-'));
    const projectDir = join(root, 'project');
    const fixture = await makeFixture(projectDir, { clips: 1 });
    const project = fixture.project;

    const wav = join(root, 'vo.wav');
    await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'pcm_s16le', wav]);
    const audioAsset = await importAsset(projectDir, {
      sourcePath: wav,
      kind: 'audio',
      origin: 'local',
      existingIds: project.assets.map((item) => item.id),
      tools: TOOLS,
    });
    project.assets.push(audioAsset);

    const tokens = [
      { id: 'tk-1', segmentId: 'seg-1', speech: '开场', display: '开场', charRange: [0, 2] as [number, number] },
      { id: 'tk-2', segmentId: 'seg-1', speech: '一句话', display: '一句话', charRange: [2, 5] as [number, number] },
    ];
    const { scriptHash } = await import('../src/project.js');
    const voiced: Project = {
      ...project,
      script: {
        language: 'zh',
        segments: [{ id: 'seg-1', role: 'hook', text: '开场一句话。', tokenIds: tokens.map((token) => token.id) }],
        tokens,
      },
      alignments: [],
      shots: project.shots.map((shot) => ({ ...shot, segmentId: 'seg-1' })),
    };
    // 工程得先在盘上(alignSegment 在锁里重读那份):把这份夹具落盘再对齐。
    writeProject(projectDir, voiced);
    alignSegment(projectDir, {
      segmentId: 'seg-1',
      assetId: audioAsset.id,
      audioHash: audioAsset.sha256,
      scriptHash: scriptHash(voiced.script),
      wordWindows: [
        { tokenId: 'tk-1', startFrame: 0, endFrame: 8 },
        { tokenId: 'tk-2', startFrame: 8, endFrame: 20 },
      ],
    });

    // 文案改了(没重跑对齐):词窗是对着旧文案算的。
    const aligned = readProject(projectDir);
    const stale: Project = {
      ...aligned,
      script: {
        ...aligned.script!,
        segments: aligned.script!.segments.map((segment) => ({ ...segment, text: `${segment.text}又加了一句。` })),
      },
    };
    writeFixture(projectDir, stale);

    const refused = ((): unknown => {
      try {
        buildComposeCommand(stale, {
          dir: projectDir,
          runId: 'run-stale',
          outPath: join(projectDir, 'runs', 'run-stale', 'final.mp4'),
          tools: TOOLS,
        });
        return undefined;
      } catch (error: unknown) {
        return error;
      }
    })();
    expect(errorCode(refused)).toBe('ALIGNMENT_REQUIRED');

    // 对照:文案没改时能正常出命令(证明上面拦的是「作废」而不是「本地音轨一律拦」)。
    const composeArgs = {
      dir: projectDir,
      runId: 'run-ok',
      outPath: join(projectDir, 'runs', 'run-ok', 'final.mp4'),
      tools: TOOLS,
    };
    const ok = buildComposeCommand(aligned, composeArgs);
    const shot0 = aligned.shots[0]!;
    const source = aligned.candidates.find((item) => item.id === shot0.selectedCandidateId)!;
    const samplesAt = (fps: { num: number; den: number }, frame: number): number =>
      Math.round((frame * fps.den * 48_000) / fps.num);
    expect(ok.filterGraph).toContain(
      `atrim=start_sample=${samplesAt(source.actual.fps, shot0.edit.inFrame)}:end_sample=${samplesAt(source.actual.fps, shot0.edit.outFrame)}`,
    );
    // 素材不是 24 fps 时,裁切按**素材自己的** fps 折时间(旧行为:一律当 24 fps,每帧 2000 采样,声音裁歪)。
    const rate30: Project = {
      ...aligned,
      candidates: aligned.candidates.map((item) => ({ ...item, actual: { ...item.actual, fps: { num: 30, den: 1 } } })),
    };
    const slow = buildComposeCommand(rate30, composeArgs);
    expect(slow.filterGraph).toContain(
      `atrim=start_sample=${shot0.edit.inFrame * 1600}:end_sample=${shot0.edit.outFrame * 1600}`,
    );
  }, 60_000);
});

describe('第三轮审查的回归(旧行为必须失败)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vidroom-fix3-'));

  maybe('生成期间别人改过工程:候选照登,那份改动不被整份覆盖', async () => {
    const clip = join(dir, 'clip-merge.mp4');
    await makeClip(clip, { frames: 24, color: 'blue' });
    const projectDir = join(dir, 'project-merge');
    writeFixture(projectDir, (await makeFixture(projectDir, { clips: 1 })).project);

    const comfy = await startFakeComfy({ historyMisses: 0, viewFile: clip });
    const runtime = createVidroomRuntime({
      baseUrl: comfy.baseUrl,
      timeoutMs: 20_000,
      pollIntervalMs: 10,
      allowExperimental: true,
      ffmpegPath: TOOLS.ffmpegPath,
      ffprobePath: TOOLS.ffprobePath,
    });
    try {
      // 先把配方改掉(夹具候选是旧配方):计划里这才真有一条新请求,否则 plan 直接复用,根本没得回写。
      const seeded = readProject(projectDir);
      patchProject(projectDir, {
        baseHash: projectHash(seeded),
        patch: [{ op: 'replace', path: 'shots[0].generation.seed', value: 2024 }],
      });
      const plan = await planProject(projectDir, readProject(projectDir), 'candidates');
      expect(plan.newRequests.length).toBe(1);
      const started = await startRender(runtime, {
        dir: projectDir,
        mode: 'generate-missing',
        planHash: plan.planHash,
      });
      // 生成还在跑:这会儿改工程。旧实现拿开工时那份整份回写,这一改就被抹掉了。
      const mid = readProject(projectDir);
      patchProject(projectDir, {
        baseHash: projectHash(mid),
        patch: [{ op: 'replace', path: 'shots[0].generation.prompt', value: '生成期间改过的提示词' }],
      });

      const state = await waitForRun(projectDir, started.runId);
      expect(['succeeded', 'awaiting-selection', 'awaiting-alignment']).toContain(state);
      const after = readProject(projectDir);
      // ① 我这一跑新登记的候选在;② 别人改的那句提示词也还在。
      expect(after.candidates.length).toBeGreaterThan(1);
      expect(after.shots[0]?.candidateIds.length).toBeGreaterThan(1);
      expect(after.shots[0]?.generation.prompt).toBe('生成期间改过的提示词');
    } finally {
      await comfy.close();
    }
  }, 60_000);

  maybe('同配方两条镜头:留着旧配方候选的那条也要登记新候选,不留假 submitted', async () => {
    const clip = join(dir, 'clip-recipe.mp4');
    await makeClip(clip, { frames: 24, color: 'green' });
    const projectDir = join(dir, 'project-recipe');
    const fixture = await makeFixture(projectDir, { clips: 1 });
    writeFixture(projectDir, fixture.project);

    // shot-1 改成新配方(旧候选留着),shot-2 用同一个新配方:plan 只发一条请求,两条都该收到产物。
    const seeded = readProject(projectDir);
    const shot1 = seeded.shots[0]!;
    const newGeneration = { ...shot1.generation, prompt: '同配方新提示词', seed: 4242 };
    patchProject(projectDir, {
      baseHash: projectHash(seeded),
      patch: [
        { op: 'replace', path: 'shots[0].generation.prompt', value: '同配方新提示词' },
        { op: 'replace', path: 'shots[0].generation.seed', value: 4242 },
        {
          op: 'add',
          path: 'shots',
          value: {
            id: 'shot-2',
            order: 1,
            generation: newGeneration,
            candidateIds: [],
            edit: { inFrame: 0, outFrame: 24, speed: { num: 1, den: 1 }, audio: 'keep' },
          },
        },
        {
          op: 'replace',
          path: 'timeline',
          value: {
            fps: { num: 24, den: 1 },
            width: 320,
            height: 256,
            placements: [
              { shotId: 'shot-1', startFrame: 0, durationFrames: 24 },
              { shotId: 'shot-2', startFrame: 24, durationFrames: 24 },
            ],
            totalFrames: 48,
          },
        },
      ],
    });

    const comfy = await startFakeComfy({ historyMisses: 0, viewFile: clip });
    const runtime = createVidroomRuntime({
      baseUrl: comfy.baseUrl,
      timeoutMs: 20_000,
      pollIntervalMs: 10,
      allowExperimental: true,
      ffmpegPath: TOOLS.ffmpegPath,
      ffprobePath: TOOLS.ffprobePath,
    });
    try {
      const plan = await planProject(projectDir, readProject(projectDir), 'candidates');
      expect(plan.newRequests.length).toBe(1); // 同配方只投一条
      const started = await startRender(runtime, {
        dir: projectDir,
        mode: 'generate-missing',
        planHash: plan.planHash,
      });
      await waitForRun(projectDir, started.runId);

      expect(comfy.submissions.length).toBe(1); // 生成一次
      const after = readProject(projectDir);
      const shotAfter1 = after.shots.find((shot) => shot.id === 'shot-1');
      const shotAfter2 = after.shots.find((shot) => shot.id === 'shot-2');
      // 旧行为:shot-1 因为有旧候选被跳过 → 它永远拿不到新配方的候选,还留着一条假的 submitted 回执。
      expect(shotAfter1?.candidateIds.length).toBe(2);
      expect(shotAfter2?.candidateIds.length).toBe(1);
      const receipt = jobView(projectDir, started.runId).receipt;
      expect(receipt?.shots.some((shot) => shot.state === 'submitted')).toBe(false);
      expect(receipt?.shots.filter((shot) => shot.state === 'succeeded')).toHaveLength(2);
    } finally {
      await comfy.close();
    }
  }, 60_000);

  maybe('渲染是后台的:startRender 回来时还没跑完,靠轮询等到终态', async () => {
    const clip = join(dir, 'clip-async.mp4');
    await makeClip(clip, { frames: 24, color: 'yellow' });
    const projectDir = join(dir, 'project-async');
    writeFixture(projectDir, (await makeFixture(projectDir, { clips: 1 })).project);

    const comfy = await startFakeComfy({ historyMisses: 0, viewFile: clip });
    const runtime = createVidroomRuntime({
      baseUrl: comfy.baseUrl,
      timeoutMs: 20_000,
      pollIntervalMs: 10,
      allowExperimental: true,
      ffmpegPath: TOOLS.ffmpegPath,
      ffprobePath: TOOLS.ffprobePath,
    });
    try {
      const plan = await planProject(projectDir, readProject(projectDir), 'candidates');
      const started = await startRender(runtime, {
        dir: projectDir,
        mode: 'generate-missing',
        planHash: plan.planHash,
      });
      // 旧行为:startRender 阻塞到跑完,这里已经是 succeeded(异步轮询的承诺是假的)。
      expect(['queued', 'running']).toContain(jobView(projectDir, started.runId).receipt?.state);
      // 验收 3 的「单卡并发峰值 = 1」:同一条工程还在跑时再点一次,当场拒。
      const again = await startRender(runtime, {
        dir: projectDir,
        mode: 'generate-missing',
        planHash: plan.planHash,
      }).catch((error: unknown) => error);
      expect(errorCode(again)).toBe('ALREADY_RUNNING');
      expect(await waitForRun(projectDir, started.runId)).not.toBe('running');
      // 跑完了锁要放掉,不然这条工程以后再也开不了(终态写盘与 finally 放锁差一拍,这里轮询等)。
      // 故意传个假 planHash:放锁证据是「不再报 ALREADY_RUNNING、改报哈希对不上」,
      // 顺便避开「轮询成功就真开了一条没人等的 run」这个坑。
      const deadline = Date.now() + 2_000;
      let releasedCode = 'ALREADY_RUNNING';
      while (releasedCode === 'ALREADY_RUNNING' && Date.now() < deadline) {
        const retry = await startRender(runtime, {
          dir: projectDir,
          mode: 'generate-missing',
          planHash: 'sha256:' + '0'.repeat(64),
        }).catch((error: unknown) => error);
        releasedCode = errorCode(retry);
        if (releasedCode === 'ALREADY_RUNNING') await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(releasedCode).toBe('PLAN_HASH_MISMATCH');
    } finally {
      await comfy.close();
    }
  }, 60_000);

  maybe('面板写入口:POST /vidroom/import 与 /vidroom/candidate 真改工程,GET /vidroom/project 给镜头', async () => {
    const projectDir = join(dir, 'project-panel-write');
    writeFixture(projectDir, (await makeFixture(projectDir, { clips: 1 })).project);
    const extra = join(dir, 'extra-clip.mp4');
    await makeClip(extra, { frames: 12, color: 'red' });

    const comfy = await startFakeComfy({ historyMisses: 0 });
    const runtime = createVidroomRuntime({
      baseUrl: comfy.baseUrl,
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      ffmpegPath: TOOLS.ffmpegPath,
      ffprobePath: TOOLS.ffprobePath,
    });
    const web = await startTestWebServer();
    const disposers = mountVidroomRoutes({ webServer: web.service }, runtime);
    const post = (path: string, body: unknown) =>
      fetch(`${web.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      const imported = await post('/vidroom/import', { path: projectDir, sourcePath: extra, kind: 'video' });
      const importedText = imported.ok ? '' : await imported.text();
      expect(imported.status, importedText).toBe(200);
      const payload = (await imported.json()) as { asset: { id: string } };
      expect(payload.asset.id).toMatch(/^asset-/);

      const project = readProject(projectDir);
      const shotId = project.shots[0]!.id;
      const registered = await post('/vidroom/candidate', {
        path: projectDir,
        shotId,
        assetId: payload.asset.id,
        select: true,
      });
      expect(registered.status).toBe(200);
      const created = (await registered.json()) as { candidate: { id: string } };
      const after = readProject(projectDir);
      expect(after.candidates.some((item) => item.id === created.candidate.id)).toBe(true);
      expect(after.shots.find((shot) => shot.id === shotId)?.selectedCandidateId).toBe(created.candidate.id);

      // 面板要靠这份清单列镜头(挑镜头下拉的数据来源)。
      const viewed = await fetch(`${web.baseUrl}/vidroom/project?path=${encodeURIComponent(projectDir)}`);
      const view = (await viewed.json()) as { shots: Array<{ id: string }> };
      expect(view.shots.map((item) => item.id)).toContain(shotId);
    } finally {
      for (const dispose of disposers) dispose();
      await web.close();
      await comfy.close();
    }
  }, 60_000);
});

describe('第四轮审查的回归(旧行为必须失败)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vidroom-fix4-'));

  maybe('跑的时候面板手工登记占了同一个 cand-N:新候选换新 id,回执跟得上', async () => {
    const clip = join(dir, 'clip-collide.mp4');
    await makeClip(clip, { frames: 24, color: 'purple' });
    const projectDir = join(dir, 'project-collide');
    writeFixture(projectDir, (await makeFixture(projectDir, { clips: 1 })).project);

    // 轮询拉长:生成期间留出足够窗口手工登记候选(现实里那是分钟级,这里用 800ms 顶替)。
    const comfy = await startFakeComfy({ historyMisses: 2, viewFile: clip });
    const runtime = createVidroomRuntime({
      baseUrl: comfy.baseUrl,
      timeoutMs: 20_000,
      pollIntervalMs: 400,
      allowExperimental: true,
      ffmpegPath: TOOLS.ffmpegPath,
      ffprobePath: TOOLS.ffprobePath,
    });
    try {
      // 先把配方改掉(夹具候选是旧配方),不然 plan 直接复用、根本没有回写这一步。
      const seeded = readProject(projectDir);
      patchProject(projectDir, {
        baseHash: projectHash(seeded),
        patch: [{ op: 'replace', path: 'shots[0].generation.seed', value: 777 }],
      });
      const plan = await planProject(projectDir, readProject(projectDir), 'candidates');
      expect(plan.newRequests.length).toBe(1);
      const started = await startRender(runtime, { dir: projectDir, mode: 'generate-missing', planHash: plan.planHash });

      const manual = join(dir, 'clip-manual.mp4');
      await makeClip(manual, { frames: 24, color: 'cyan' });
      const running = readProject(projectDir);
      const asset = await importAsset(projectDir, {
        sourcePath: manual,
        kind: 'video',
        origin: 'local',
        existingIds: running.assets.map((item) => item.id),
        tools: TOOLS,
      });
      writeFixture(projectDir, {
        ...running,
        revision: running.revision + 1,
        parentHash: projectHash(running),
        assets: [...running.assets, asset],
      });
      // 面板按当下的工程算 id:这里正好占掉这一跑待用的那个 `cand-N`。
      const manualId = candidateId(readProject(projectDir).candidates.map((item) => item.id));
      registerCandidate(projectDir, { shotId: running.shots[0]!.id, assetId: asset.id, select: false });
      expect(readProject(projectDir).candidates.some((item) => item.id === manualId)).toBe(true);

      expect(await waitForRun(projectDir, started.runId)).not.toBe('running');
      const after = readProject(projectDir);
      const ids = after.candidates.map((item) => item.id);
      // 旧行为:拿开工时那份整份回写,手工登记的那条候选连人带 id 一起没了(candidates 只剩 2 条)。
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toContain(manualId);

      const receipt = jobView(projectDir, started.runId).receipt!;
      const succeeded = receipt.shots.filter((shot) => shot.state === 'succeeded');
      expect(succeeded).toHaveLength(1);
      const receiptCandidate = succeeded[0]!.candidateId!;
      // 旧行为:回执记的是撞车前的 `cand-N`,工程里那条候选已经不是它的了(或者压根不存在)。
      expect(receiptCandidate).not.toBe(manualId);
      expect(after.candidates.some((item) => item.id === receiptCandidate)).toBe(true);
      expect(after.shots[0]!.candidateIds).toEqual(expect.arrayContaining([manualId, receiptCandidate]));
    } finally {
      await comfy.close();
    }
  }, 60_000);

  maybe('能力接口:权重不在盘上就报不就绪,没给工程就明说那半没核', () => {
    const modelsRoot = join(dir, 'models-weights');
    mkdirSync(modelsRoot, { recursive: true });
    writeFileSync(join(modelsRoot, 'a.safetensors'), 'x');
    const locks = {
      adapterVersion: '0.1.0',
      models: [
        { file: 'a.safetensors', sha256: 'a'.repeat(64) },
        { file: 'b.safetensors', sha256: 'b'.repeat(64) },
      ],
      fontAssetIds: [],
      deferred: [],
    };

    // 旧行为:只看「ComfyUI 活着 + 准入通过」就报 localReady,权重缺一份也照说就绪。
    const missing = h3Capabilities({ locks, reachable: true, admissionAllowed: true, admissionReason: '', modelsRoot });
    expect(missing.localReady).toBe(false);
    expect(missing.reasons.join(' ')).toContain('b.safetensors');

    writeFileSync(join(modelsRoot, 'b.safetensors'), 'y');
    const ready = h3Capabilities({ locks, reachable: true, admissionAllowed: true, admissionReason: '', modelsRoot });
    expect(ready.localReady).toBe(true);
    // 只核了文件在不在:哈希复核在 run 里,不能当成已核过。
    expect(ready.notes.join(' ')).toContain('哈希复核在 run 里做');

    // 没给工程:机器那半照报,权重那半不许静默当成就绪。
    const unknown = h3Capabilities({ reachable: true, admissionAllowed: true, admissionReason: '' });
    expect(unknown.localReady).toBe(true);
    expect(unknown.notes.join(' ')).toContain('还没 lock');
  });

  maybe('参考来源地址:外网当文字存档收下,file:/空壳 URL 拒', () => {
    const codeOf = (call: () => void): string => {
      try {
        call();
        return '没报错';
      } catch (error: unknown) {
        return errorCode(error);
      }
    };
    // 旧行为:一律只收本机地址 —— 爆款原片这种外网参考链接根本记不进来。
    expect(() => assertRecordedUrl('https://www.example.com/viral/123?t=3')).not.toThrow();
    expect(() => assertRecordedUrl('http://127.0.0.1:8000/x')).not.toThrow();
    expect(codeOf(() => assertRecordedUrl('file:///etc/passwd'))).toBe('PROJECT_INVALID');
    expect(codeOf(() => assertRecordedUrl('data:text/plain,hi'))).toBe('PROJECT_INVALID');
    expect(codeOf(() => assertRecordedUrl('随便写的'))).toBe('PROJECT_INVALID');
  });
});

describe('第五轮(合后自查)的回归', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vidroom-fix5-'));

  maybe('导入素材期间别人改了工程:那条改动不被导入的旧快照盖掉', async () => {
    const projectDir = join(dir, 'project-import-race');
    const fixture = await makeFixture(projectDir, { clips: 1 });
    writeFixture(projectDir, fixture.project);
    const incoming = join(dir, 'clip-import-race.mp4');
    await makeClip(incoming, { frames: 12, color: 'orange' });

    const config = readConfig({ ffmpegPath: TOOLS.ffmpegPath, ffprobePath: TOOLS.ffprobePath });
    // 导入里会 await(算 sha256 + 跑探针):不等它,趁这段时间改一次工程。
    // 旧行为(f5ec4d9 之前)是拿开工时那份整份回写,这句提示词连人带改动一起被盖回去。
    // f5ec4d9 已改成收尾重读;本 PR 再把收尾换成 `updateProject`(带乐观哈希复核)。这条用例把它钉住。
    const importing = importProjectAsset(config, projectDir, { sourcePath: incoming, kind: 'video' });
    const mid = readProject(projectDir);
    patchProject(projectDir, {
      baseHash: projectHash(mid),
      patch: [{ op: 'replace', path: 'shots[0].generation.prompt', value: '导入期间改过的提示词' }],
    });
    const { asset } = await importing;

    const after = readProject(projectDir);
    expect(after.assets.some((item) => item.id === asset.id)).toBe(true);
    expect(after.shots[0]!.generation.prompt).toBe('导入期间改过的提示词');
  }, 60_000);

  maybe('两条导入同时跑:两份资产都进工程,后收尾的不把先收尾的盖掉', async () => {
    const projectDir = join(dir, 'project-import-parallel');
    const fixture = await makeFixture(projectDir, { clips: 1 });
    writeFixture(projectDir, fixture.project);
    const first = join(dir, 'clip-p1.mp4');
    const second = join(dir, 'clip-p2.mp4');
    await makeClip(first, { frames: 10, color: 'red' });
    await makeClip(second, { frames: 10, color: 'blue' });

    // 两条不 await 地同时发:中间的哈希+探针会让出事件循环,两边都拿同一份旧快照开头。
    const config = readConfig({ ffmpegPath: TOOLS.ffmpegPath, ffprobePath: TOOLS.ffprobePath });
    const [one, two] = await Promise.all([
      importProjectAsset(config, projectDir, { sourcePath: first, kind: 'video' }),
      importProjectAsset(config, projectDir, { sourcePath: second, kind: 'video' }),
    ]);

    const after = readProject(projectDir);
    const ids = after.assets.map((item) => item.id);
    expect(ids).toContain(one.asset.id);
    expect(ids).toContain(two.asset.id);
    expect(one.asset.id).not.toBe(two.asset.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 60_000);

  maybe('updateProject:合并期间工程被从别处改了 → 复核发现后重来,不静默覆盖', async () => {
    const projectDir = join(dir, 'project-update-retry');
    const fixture = await makeFixture(projectDir, { clips: 1 });
    writeFixture(projectDir, fixture.project);

    let calls = 0;
    const merged = updateProject(projectDir, (current) => {
      calls += 1;
      // 第一次合并时,假装别人在「读出这份工程 → 写回」之间插了一手(改了种子)。
      if (calls === 1) {
        writeProject(projectDir, {
          ...current,
          revision: current.revision + 1,
          parentHash: projectHash(current),
          shots: current.shots.map((shot) => ({ ...shot, generation: { ...shot.generation, seed: 999 } })),
        });
      }
      return {
        ...current,
        revision: current.revision + 1,
        parentHash: projectHash(current),
        shots: current.shots.map((shot) => ({ ...shot, generation: { ...shot.generation, prompt: '合并写的提示词' } })),
      };
    });

    // 旧行为(读一次写一次):调一次就落盘,别处那次的改动静静地没了,也不会重来。
    expect(calls).toBe(2);
    // 别处的改动是被第二次合并读进来、写下去,不是被覆盖。
    expect(merged.shots[0]!.generation.seed).toBe(999);
    expect(merged.shots[0]!.generation.prompt).toBe('合并写的提示词');
    const after = readProject(projectDir);
    expect(after.shots[0]!.generation.seed).toBe(999);
    expect(after.shots[0]!.generation.prompt).toBe('合并写的提示词');
  }, 60_000);

  maybe('updateProject:每次都被别处改掉 → 撞满就抛 PROJECT_BUSY,不无限重试', async () => {
    const projectDir = join(dir, 'project-update-busy');
    const fixture = await makeFixture(projectDir, { clips: 1 });
    writeFixture(projectDir, fixture.project);

    let calls = 0;
    const boom = (): string => {
      try {
        updateProject(projectDir, (current) => {
          calls += 1;
          writeProject(projectDir, {
            ...current,
            revision: current.revision + 1,
            parentHash: projectHash(current),
            shots: current.shots.map((shot) => ({ ...shot, generation: { ...shot.generation, seed: calls } })),
          });
          return { ...current, revision: current.revision + 1, parentHash: projectHash(current) };
        });
        return '没报错';
      } catch (error: unknown) {
        return errorCode(error);
      }
    };

    expect(boom()).toBe('PROJECT_BUSY');
    // 有上限:撞这么多次就不是运气差,该让人看一眼,而不是转到天荒地老。
    expect(calls).toBeGreaterThan(1);
  }, 60_000);

  maybe('面板「改工程」的默认示例当场能应用(不变量:用户点「应用改动」第一个跑的就是它)', async () => {
    const projectDir = join(dir, 'project-default-patch');
    const fixture = await makeFixture(projectDir, { clips: 1 });
    writeFixture(projectDir, fixture.project);

    const example = JSON.parse(DEFAULT_PATCH_EXAMPLE) as PatchOp[];
    const patched = patchProject(projectDir, {
      baseHash: projectHash(readProject(projectDir)),
      patch: example,
    });
    expect(patched.project.shots[0]!.generation.prompt).toBe('改成你要的画面描述');
  }, 60_000);
});

/**
 * 写锁(第六轮审查的回归):工程写者不止一个进程 —— dsh 容器里的面板、机器人进程里的 CLI、
 * 面板拉起的渲染回写都会写同一条工程。「锁内读-改-写」是这层的互斥,旧行为(没锁)下
 * 两个进程可以同时进「读 → 算 → 写」,后写的把先写的整份盖掉。
 *
 * 这几条不用 ffmpeg(夹具是空工程),所以是 `it` 不是 `maybe`:没装 ffmpeg 也得跑。
 */
describe('工程写锁(跨进程互斥)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vidroom-lock-'));

  /** 一条只有 id 的空工程:这几条盯的是写锁,不需要媒体。 */
  function seedProject(name: string): string {
    const projectDir = join(dir, name);
    writeProject(projectDir, emptyProject(name));
    return projectDir;
  }

  /**
   * 找一个真正没在跑的 pid:起个空进程、等它退掉,它用过的那个 pid 刚变成死的。
   * (不抚一个「看着像空号」的区间 —— 那要赌这台机器上没有别的进程占着。)
   */
  function deadPid(): number {
    const ghost = spawnSync(process.execPath, ['-e', '']);
    const pid = ghost.pid;
    if (typeof pid === 'number' && pid > 0) {
      try {
        process.kill(pid, 0);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid;
      }
    }
    throw new Error('连一个刚死过的 pid 都拿不到');
  }

  it('锁被别的进程占着(新锁)→ 等到超时抛 PROJECT_BUSY,不静默写', () => {
    const projectDir = seedProject('project-locked');
    // 冒充另一个活着的写者:锁文件在、年龄是新的(没到废锁线,不许抢)。
    writeFileSync(lockFileOf(projectDir), `other-process-token ${process.pid}\n`);
    const before = readProject(projectDir);

    const code = ((): string | null => {
      try {
        updateProject(projectDir, (current) => ({ ...current, revision: current.revision + 1 }));
        return null;
      } catch (error: unknown) {
        return errorCode(error);
      }
    })();
    expect(code).toBe('PROJECT_BUSY');
    // 拒了就是一点都没写:revision 还是那份(旧行为会照写不误)。
    expect(readProject(projectDir).revision).toBe(before.revision);
    // 别人的锁还在(没被顺手删掉)。
    expect(existsSync(lockFileOf(projectDir))).toBe(true);
  }, 30_000);

  it('新建工程那两条路也认手:锁在落盘前被替掉 → 不落盘(PROJECT_BUSY)', () => {
    // 新建的空白工程与首次登记的参考片,是仅有的两条直接调 writeProject 的路:
    // 它们写之前也得先认一次手,不然上面那条 assertOwned 就只管住了 updateProject 那一半。
    const dir = join(mkdtempSync(join(tmpdir(), 'vr-')), 'project-seed-guard');
    mkdirSync(dir, { recursive: true });

    const code = ((): string | null => {
      try {
        withProjectLock(dir, (assertOwned) => {
          // 冒充另一个进程:落盘前把锁换成它的令牌(旧行为:照写)。
          writeFileSync(lockFileOf(dir), `thief-token ${process.pid}\n`);
          assertOwned();
          writeProject(dir, emptyProject('project-seed-guard'));
          return null;
        });
        return null;
      } catch (error: unknown) {
        return errorCode(error);
      }
    })();

    expect(code).toBe('PROJECT_BUSY');
    expect(existsSync(projectFileOf(dir))).toBe(false);
  }, 30_000);

  it('旧锁一律不自动抢(崩溃的 / 活人卡住的 / 空锁 / 坏 pid 四种形态)→ PROJECT_BUSY,锁原样留着,报错说得出是谁的', () => {
    // 回收一把「看着像废锁」的锁只能先看后删 —— 那两步之间锁可能换主,删下去删的就是别人的活锁。
    // 所以这里四种形态一律动都不动:报错里说清楚是哪把、谁留的、躺了多久,让人确认后手删。
    const stale = new Date(Date.now() - 120_000);
    const shapes: Array<{ name: string; content: string }> = [
      { name: 'project-dead-holder', content: `crashed-process-token ${deadPid()}\n` },
      // 活人卡住:按年龄算很旧,但写它的那个 pid 还在跑。
      { name: 'project-slow-holder', content: `slow-holder-token ${process.pid}\n` },
      // 位占上了、里面什么都没有(别的工具写的,或崩在写入中间)。
      { name: 'project-headless-lock', content: '' },
      // 内容写了一半:令牌有、pid 读不出数。
      { name: 'project-bad-pid-lock', content: 'half-written-token\n' },
    ];

    for (const shape of shapes) {
      const projectDir = seedProject(shape.name);
      const before = readProject(projectDir);
      writeFileSync(lockFileOf(projectDir), shape.content);
      utimesSync(lockFileOf(projectDir), stale, stale);

      const message = ((): string => {
        try {
          updateProject(projectDir, (current) => ({ ...current, revision: current.revision + 1 }));
          return '写了(不该:旧锁不许被自动抢,更不许悄悄写) ';
        } catch (error: unknown) {
          return (error as Error).message;
        }
      })();

      // 一点都没写,而且那把锁原样留着(没被删、也没被改)。
      expect(readProject(projectDir).revision).toBe(before.revision);
      expect(readFileSync(lockFileOf(projectDir), 'utf8')).toBe(shape.content);
      // 报错要把「哪把锁、谁的、躺了多久」说出来,不然人只能去猜该删哪个文件。
      expect(message).toContain(lockFileOf(projectDir));
      expect(message).toContain('躺了约 2 分钟');
      expect(message).toContain('确认没人在写就删掉它再来');
    }
  }, 60_000);

  it('锁文件被人删掉或换成别人的 → 落盘前认出来:不写,也不动别人那把', () => {
    for (const mode of ['deleted', 'replaced'] as const) {
      const projectDir = seedProject(`project-lock-${mode}`);
      const before = readProject(projectDir);

      const code = ((): string | null => {
        try {
          updateProject(projectDir, (current) => {
            // 别的东西在这当口把锁删了 / 换成了它的令牌(新写法里没有「按年龄清废锁」这条路了,
            // 但人要手删、别的工具也可能来碰):这时按路径删它,就是替第三个写者开门。
            if (mode === 'deleted') unlinkSync(lockFileOf(projectDir));
            else writeFileSync(lockFileOf(projectDir), `thief-token ${process.pid}\n`);
            return { ...current, revision: current.revision + 1 };
          });
          return null;
        } catch (error: unknown) {
          return errorCode(error);
        }
      })();

      expect(code).toBe('PROJECT_BUSY');
      expect(readProject(projectDir).revision).toBe(before.revision);
      if (mode === 'replaced') {
        // 收尾时不许把别人那把锁删掉。
        expect(readFileSync(lockFileOf(projectDir), 'utf8').trim()).toBe(`thief-token ${process.pid}`);
      } else {
        // 已经被删了:我不该反过来把它建回去(建回去等于替人占位)。
        expect(existsSync(lockFileOf(projectDir))).toBe(false);
      }
    }
  }, 30_000);

  it('真起第二个进程占锁 → PROJECT_BUSY(锁是跨进程的,不是内存里那把)', async () => {
    const projectDir = seedProject('project-real-process');
    const before = readProject(projectDir);
    const lock = lockFileOf(projectDir);
    const ready = `${lock}.ready`;
    const release = `${lock}.release`;
    // 子进程自己拿自己的 pid 写锁(锁文件里记的就是持有者),拿住直到父进程叫它放。
    const child = [
      "const fs=require('fs');const [lock,ready,release]=process.argv.slice(1);",
      "fs.writeFileSync(lock,'subprocess-'+process.pid+' '+process.pid+'\\n');",
      "fs.writeFileSync(ready,String(process.pid));",
      'const t=setInterval(()=>{if(!fs.existsSync(release))return;clearInterval(t);',
      'try{fs.unlinkSync(lock)}catch{};try{fs.unlinkSync(ready)}catch{};process.exit(0);},20);',
    ].join('');
    const holder = run('node', ['-e', child, lock, ready, release]);
    try {
      // 等它真占上锁(不是睡一个猜出来的毫秒数 —— 那样负载一高就随机红)。
      for (let i = 0; i < 500 && !existsSync(ready); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(ready)).toBe(true);
      const childPid = readFileSync(ready, 'utf8').trim();
      expect(childPid).toMatch(/^\d+$/);
      // 锁里第二个字段得是那个子进程的 pid:这才是「活着的别的进程」,和上面那条
      // 「活 pid 不许被抢」是同一件事的两面。
      expect(readFileSync(lock, 'utf8').trim().split(/\s+/)[1]).toBe(childPid);

      const code = ((): string | null => {
        try {
          updateProject(projectDir, (current) => ({ ...current, revision: current.revision + 1 }));
          return null;
        } catch (error: unknown) {
          return errorCode(error);
        }
      })();
      expect(code).toBe('PROJECT_BUSY');
      expect(readProject(projectDir).revision).toBe(before.revision);
    } finally {
      // 不管上面怎样都叫它放锁退出,不留孤儿进程。
      writeFileSync(release, 'go\n');
      await holder;
    }
    expect(existsSync(lock)).toBe(false);
  }, 60_000);

  it('一个进程拿着锁在写、另一个进程同时写 → 被锁挡下,工程只动了一次(真跨进程,不靠调度运气)', async () => {
    const projectDir = seedProject('project-lock-race');
    const before = readProject(projectDir);
    const held = join(dir, 'race.held');
    const holderOut = join(dir, 'race-holder.out');
    const contenderOut = join(dir, 'race-contender.out');
    // 子进程要 import 到 src/*.ts,所以第二个进程也走 vitest(它自己解析 TS)而不是裸 node。
    const child = (env: Record<string, string>) =>
      run('corepack', ['pnpm', 'exec', 'vitest', 'run', 'test/lock-race-child.test.ts'], {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        maxBuffer: 8 * 1024 * 1024,
      });

    // 拿锁那个:拿住之后在临界区里等对方那一下(它的尝试结果落地了才放锁)。
    const holder = child({
      VR_LOCK_CHILD_MODE: 'hold',
      VR_LOCK_CHILD_DIR: projectDir,
      VR_LOCK_CHILD_OUT: holderOut,
      VR_LOCK_CHILD_HELD: held,
      VR_LOCK_CHILD_WAIT_OUT: contenderOut,
    });
    // 抢的那个:等 `.held` 出现(对方确实在临界区里)才动手 —— 自己不看时间,就不会被调度运气放过去。
    const contender = child({
      VR_LOCK_CHILD_MODE: 'contend',
      VR_LOCK_CHILD_DIR: projectDir,
      VR_LOCK_CHILD_OUT: contenderOut,
      VR_LOCK_CHILD_HELD: held,
    });
    await Promise.all([holder, contender]);

    // 没锁的实现里这边会写成功 —— 这条就对不上。
    expect(readFileSync(contenderOut, 'utf8').trim()).toBe('PROJECT_BUSY');
    expect(readFileSync(holderOut, 'utf8').trim()).toBe('wrote');
    // 被挡下的那次一点没写:只动了拿锁那个的一次。
    expect(readProject(projectDir).revision).toBe(before.revision + 1);
    // 两个进程都收工之后锁没留下,下个人还能正常写。
    expect(existsSync(lockFileOf(projectDir))).toBe(false);
    const after = updateProject(projectDir, (current) => ({
      ...current,
      revision: current.revision + 1,
      parentHash: projectHash(current),
    }));
    expect(after.revision).toBe(before.revision + 2);
  }, 180_000);
});
