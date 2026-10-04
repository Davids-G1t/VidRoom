/**
 * 面板的「工程」区(第 2 批面):挑一个 `vr.project/1` 工程 → 看计数与问题、最近 run、
 * 工程里的资产并当场回放(视频/音频/图片)。
 *
 * 这一段是第 2 批的**本地内容入口**:参考片、文案、音轨、工程内容只在本地面板与本地路由里出现。
 * 聊天侧那批工程工具默认不注册(`chatTools` 打开才注册,见 `config.ts`),所以面板不是可有可无的装饰。
 */
import { createElement as h, useCallback, useEffect, useState, type ReactNode } from 'react';
import { getJson, postJson, unwrap } from './api.ts';

/**
 * 面板「改工程」的默认示例。
 *
 * 必须是一条真能被接受的 patch:用户点「应用改动」第一个跑的就是它。
 * 两个前提写在这儿,免得又改回旧样子:①路径不带 JSON Pointer 前缀、按白名单形式写 `shots[0].…`;
 * ②它指向 `shots[0]`,所以**空工程(还没有镜头)下点了会被拒** —— 那是预期的,不是 bug。
 * (曾经写成 `/shots/0/text`:前缀不对 + 字段不在白名单里 + 字段不存在,点了必吃 `PATCH_REJECTED`。)
 */
export const DEFAULT_PATCH_EXAMPLE =
  '[{ "op": "replace", "path": "shots[0].generation.prompt", "value": "改成你要的画面描述" }]';

interface ProjectView {
  projectPath: string;
  projectId: string;
  revision: number;
  projectHash: string;
  counts: Record<string, number>;
  issues: string[];
  alignmentIssues: string[];
  reference?: { assetId: string; analysisStatus: string; shots: number };
}

interface ShotView {
  id: string;
  order: number;
  segmentId?: string;
  selectedCandidateId?: string;
}

interface PlanView {
  target: string;
  planHash: string;
  projectHash: string;
  ready: boolean;
  blockers: string[];
  newRequests: number;
  reuseCandidateIds: string[];
  summary: string;
}

interface CandidateView {
  id: string;
  shotId: string;
  assetId: string;
  status: string;
}

interface RunSummary {
  runId: string;
  state: string;
  mode: string;
  error?: string;
}

interface AssetItem {
  id: string;
  kind: string;
  path: string;
  sha256: string;
  missing: boolean;
}

interface ProjectPayload {
  project: ProjectView;
  candidates: CandidateView[];
  missingAssets: string[];
  runs: RunSummary[];
  shots: ShotView[];
}

interface AssetPayload {
  total: number;
  items: AssetItem[];
}

interface ProjectsPayload {
  root: string;
  projects: Array<Partial<ProjectView> & { projectPath: string; error?: string }>;
}

/** 还在动的状态:这些才值得每几秒轮一次。 */
const ACTIVE_STATES = new Set(['queued', 'running', 'awaiting-selection', 'awaiting-alignment']);
const POLL_MS = 3000;

function isActive(runs: RunSummary[]): boolean {
  return runs.some((run) => ACTIVE_STATES.has(run.state));
}

/** 面板上的相对路径 → 同源回放地址(路由只放行已登记资产与 `runs/`)。 */
function mediaUrl(dir: string, relative: string): string {
  return `/vidroom/media?path=${encodeURIComponent(dir)}&asset=${encodeURIComponent(relative)}`;
}

function player(item: AssetItem, dir: string): ReactNode {
  const url = mediaUrl(dir, item.path);
  if (item.missing) return null;
  if (item.kind === 'video') return h('video', { className: 'dvr-media', src: url, controls: true });
  if (item.kind === 'audio') return h('audio', { className: 'dvr-media', src: url, controls: true });
  if (item.kind === 'image') return h('img', { className: 'dvr-media', src: url, alt: item.path });
  return null;
}

/** 一行输入。面板里的排版一律走 class,不用内联 style。 */
function field(
  label: string,
  value: string,
  onChange: (next: string) => void,
  placeholder = '',
): ReactNode {
  return h(
    'div',
    { className: 'dvr-field' },
    h('label', {}, label),
    h('input', {
      className: 'dvr-input',
      value,
      placeholder,
      onChange: (event: { currentTarget: { value: string } }) => onChange(event.currentTarget.value),
    }),
  );
}

function area(label: string, value: string, onChange: (next: string) => void): ReactNode {
  return h(
    'div',
    { className: 'dvr-field' },
    h('label', {}, label),
    h('textarea', {
      className: 'dvr-input dvr-textarea',
      value,
      rows: 4,
      onChange: (event: { currentTarget: { value: string } }) => onChange(event.currentTarget.value),
    }),
  );
}

/**
 * 工程写入口:造工程、改工程(patch)、导素材、手工登记候选、算计划、真渲染、校词窗。
 *
 * 这一段是第 2 批「复刻一条爆款」在本机的全流程:聊天侧那批工具默认不注册,
 * 所以面板必须自己能把从参考片到成片这条链走完 —— 只读面板等于这条链在默认装法下走不通。
 * 全部走同源 POST,与工具面共用同一套 ops(`project-ops.ts`),没有第二份实现。
 */
function ProjectActions(props: {
  dir: string;
  baseHash: string;
  shots: ShotView[];
  assets: AssetItem[];
  reload: () => Promise<void>;
}): ReactNode {
  const { dir, baseHash, shots, assets, reload } = props;
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');
  const [plan, setPlan] = useState<PlanView | undefined>(undefined);
  const [newProjectId, setNewProjectId] = useState('');
  const [referencePath, setReferencePath] = useState('');
  const [referenceUrl, setReferenceUrl] = useState('');
  const [patchText, setPatchText] = useState(DEFAULT_PATCH_EXAMPLE);
  const [importPath, setImportPath] = useState('');
  const [importKind, setImportKind] = useState('video');
  const [shotId, setShotId] = useState('');
  const [assetId, setAssetId] = useState('');
  const [selectNow, setSelectNow] = useState(true);
  const [alignSegmentId, setAlignSegmentId] = useState('');
  const [alignAssetId, setAlignAssetId] = useState('');
  const [alignAudioHash, setAlignAudioHash] = useState('');
  const [alignScriptHash, setAlignScriptHash] = useState('');
  const [windowsText, setWindowsText] = useState('[{"tokenId":"0","startFrame":0,"endFrame":12}]');

  /** 每个写动作都走这一层:成功刷工程,失败把原文写在面板上。 */
  const run = useCallback(
    async (what: string, work: () => Promise<string>): Promise<void> => {
      setNote(`${what}:…`);
      setProblem('');
      try {
        setNote(await work());
        await reload();
      } catch (issue) {
        setNote('');
        setProblem(`${what}:${issue instanceof Error ? issue.message : String(issue)}`);
      }
    },
    [reload],
  );

  const create = (): Promise<void> =>
    run('造工程', async () => {
      const created = unwrap<{ project: ProjectView }>(
        await postJson('/vidroom/project', { action: 'create', projectId: newProjectId.trim() }),
      );
      return `已造工程 ${created.project.projectId}(rev ${created.project.revision}),用上面的下拉选它`;
    });

  const patch = (): Promise<void> =>
    run('改工程', async () => {
      const applied = unwrap<{ changedPaths: string[]; invalidatedShotIds: string[]; alignmentRequired: boolean }>(
        await postJson('/vidroom/project', {
          action: 'patch',
          path: dir,
          baseHash,
          patch: JSON.parse(patchText) as unknown,
        }),
      );
      return `改了 ${applied.changedPaths.length} 处${applied.invalidatedShotIds.length === 0 ? '' : `;${applied.invalidatedShotIds.length} 个镜头要重对齐`}${applied.alignmentRequired ? ';对齐已失效,要重校词窗' : ''}`;
    });

  const registerRef = (): Promise<void> =>
    run('登记参考片', async () => {
      const view = unwrap<{ reference: { assetId: string; analysisStatus: string } }>(
        await postJson('/vidroom/reference', {
          localPath: referencePath,
          projectPath: dir,
          ...(referenceUrl.trim() === '' ? {} : { referenceUrl: referenceUrl.trim() }),
        }),
      );
      return `参考片登记成 ${view.reference.assetId}(${view.reference.analysisStatus})`;
    });

  const importAsset = (): Promise<void> =>
    run('导素材', async () => {
      const imported = unwrap<{ asset: { id: string; path: string } }>(
        await postJson('/vidroom/import', { path: dir, sourcePath: importPath, kind: importKind, origin: 'local' }),
      );
      return `导进来 ${imported.asset.id}(${imported.asset.path})`;
    });

  const addCandidate = (): Promise<void> =>
    run('登记候选', async () => {
      const created = unwrap<{ candidate: { id: string; shotId: string } }>(
        await postJson('/vidroom/candidate', { path: dir, shotId, assetId, select: selectNow }),
      );
      return `候选 ${created.candidate.id} 登记到 ${created.candidate.shotId}${selectNow ? '(已选定)' : ''}`;
    });

  const align = (): Promise<void> =>
    run('校词窗', async () => {
      const aligned = unwrap<{ alignment: { segmentId: string; frames: number } }>(
        await postJson('/vidroom/align', {
          path: dir,
          segmentId: alignSegmentId,
          assetId: alignAssetId,
          audioHash: alignAudioHash,
          scriptHash: alignScriptHash,
          wordWindows: JSON.parse(windowsText) as unknown,
        }),
      );
      return `词窗校完:${aligned.alignment.segmentId} → ${aligned.alignment.frames} 帧`;
    });

  const makePlan = (target: 'candidates' | 'final'): Promise<void> =>
    run(`算计划(${target})`, async () => {
      const planned = unwrap<{ plan: PlanView }>(
        await getJson(`/vidroom/plan?path=${encodeURIComponent(dir)}&target=${target}`),
      );
      setPlan(planned.plan);
      return planned.plan.summary;
    });

  const render = (): Promise<void> =>
    run('渲染', async () => {
      if (plan === undefined) throw new Error('先算一份计划(计划是渲染的入场券)');
      const started = unwrap<{ runId: string; mode: string }>(
        await postJson('/vidroom/render', {
          path: dir,
          // 用哪份计划就用哪种跑法:候选计划 → 出候选,合成计划 → 合成(别拿请求数猜)。
          mode: plan.target === 'final' ? 'compose' : 'generate-missing',
          planHash: plan.planHash,
          expectedProjectHash: plan.projectHash,
        }),
      );
      return `开跑 ${started.runId}(${started.mode});下面 runs 每 3 秒自己刷`;
    });

  return h(
    'div',
    { className: 'dvr-form' },
    h('div', { className: 'dvr-env' }, '工程写入口(本机,不外发)'),
    field('新工程 id(可选)', newProjectId, setNewProjectId, 'vr-demo'),
    h(
      'div',
      { className: 'dvr-field' },
      h(
        'button',
        { className: 'dvr-btn', type: 'button', onClick: () => void create() },
        '造工程',
      ),
    ),
    h(
      'div',
      { className: 'dvr-field' },
      h('label', {}, '参考片(本机绝对路径)'),
      h('input', {
        className: 'dvr-input',
        value: referencePath,
        placeholder: '/home/dav/refs/爆款.mp4',
        onChange: (event: { currentTarget: { value: string } }) => setReferencePath(event.currentTarget.value),
      }),
      h('input', {
        className: 'dvr-input',
        value: referenceUrl,
        placeholder: '原链接(只当文字存档,不下载)',
        onChange: (event: { currentTarget: { value: string } }) => setReferenceUrl(event.currentTarget.value),
      }),
      h('button', { className: 'dvr-btn', type: 'button', onClick: () => void registerRef() }, '登记参考片'),
    ),
    area('改工程(白名单 JSON Patch;镜头用下标:shots[0].generation.prompt / shots[0].edit.inFrame)', patchText, setPatchText),
    h(
      'div',
      { className: 'dvr-field' },
      h(
        'button',
        { className: 'dvr-btn', type: 'button', onClick: () => void patch() },
        '应用改动',
      ),
    ),
    h(
      'div',
      { className: 'dvr-field' },
      h('label', {}, '导素材(本机路径 → 工程资产)'),
      h('input', {
        className: 'dvr-input',
        value: importPath,
        placeholder: '/home/dav/tts/配音.mp3',
        onChange: (event: { currentTarget: { value: string } }) => setImportPath(event.currentTarget.value),
      }),
      h(
        'select',
        {
          className: 'dvr-input',
          value: importKind,
          onChange: (event: { currentTarget: { value: string } }) => setImportKind(event.currentTarget.value),
        },
        ...['video', 'audio', 'image', 'font'].map((kind) => h('option', { key: kind, value: kind }, kind)),
      ),
      h('button', { className: 'dvr-btn', type: 'button', onClick: () => void importAsset() }, '导进来'),
    ),
    h(
      'div',
      { className: 'dvr-field' },
      h('label', {}, '手工登记候选(用工程里已有的素材)'),
      h(
        'select',
        {
          className: 'dvr-input',
          value: shotId,
          onChange: (event: { currentTarget: { value: string } }) => setShotId(event.currentTarget.value),
        },
        h('option', { value: '' }, shots.length === 0 ? '还没有镜头' : '挑镜头…'),
        ...shots.map((shot) => h('option', { key: shot.id, value: shot.id }, `${shot.id}(${shot.segmentId ?? '没绑文案段'})`)),
      ),
      h(
        'select',
        {
          className: 'dvr-input',
          value: assetId,
          onChange: (event: { currentTarget: { value: string } }) => setAssetId(event.currentTarget.value),
        },
        h('option', { value: '' }, assets.length === 0 ? '还没有素材' : '挑素材…'),
        ...assets.map((item) => h('option', { key: item.id, value: item.id }, `${item.id}(${item.kind})`)),
      ),
      h(
        'label',
        { className: 'dvr-check' },
        h('input', {
          type: 'checkbox',
          checked: selectNow,
          onChange: (event: { currentTarget: { checked: boolean } }) => setSelectNow(event.currentTarget.checked),
        }),
        '顺便选定',
      ),
      h('button', { className: 'dvr-btn', type: 'button', onClick: () => void addCandidate() }, '登记候选'),
    ),
    h(
      'div',
      { className: 'dvr-field' },
      h('label', {}, '计划(渲染前必须冻结一份)'),
      h('button', { className: 'dvr-btn', type: 'button', onClick: () => void makePlan('candidates') }, '算候选计划'),
      h('button', { className: 'dvr-btn', type: 'button', onClick: () => void makePlan('final') }, '算合成计划'),
      h(
        'button',
        { className: 'dvr-btn', type: 'button', onClick: () => void render() },
        '按这份计划渲染',
      ),
    ),
    plan === undefined
      ? null
      : h(
          'div',
          { className: plan.ready ? 'dvr-status dvr-status--ok' : 'dvr-status dvr-status--err' },
          plan.summary,
        ),
    h(
      'div',
      { className: 'dvr-field' },
      h('label', {}, '校词窗(词锚:改过文案/音轨才需要)'),
      h('input', {
        className: 'dvr-input',
        value: alignSegmentId,
        placeholder: 'segmentId',
        onChange: (event: { currentTarget: { value: string } }) => setAlignSegmentId(event.currentTarget.value),
      }),
      h('input', {
        className: 'dvr-input',
        value: alignAssetId,
        placeholder: 'assetId(音轨)',
        onChange: (event: { currentTarget: { value: string } }) => setAlignAssetId(event.currentTarget.value),
      }),
      h('input', {
        className: 'dvr-input',
        value: alignAudioHash,
        placeholder: 'audioHash(工程里记的)',
        onChange: (event: { currentTarget: { value: string } }) => setAlignAudioHash(event.currentTarget.value),
      }),
      h('input', {
        className: 'dvr-input',
        value: alignScriptHash,
        placeholder: 'scriptHash(工程里记的)',
        onChange: (event: { currentTarget: { value: string } }) => setAlignScriptHash(event.currentTarget.value),
      }),
      area('wordWindows(JSON:[{tokenId,startFrame,endFrame}])', windowsText, setWindowsText),
      h('button', { className: 'dvr-btn', type: 'button', onClick: () => void align() }, '校词窗'),
    ),
    note === '' ? null : h('div', { className: 'dvr-status dvr-status--ok' }, note),
    problem === '' ? null : h('div', { className: 'dvr-status dvr-status--err' }, problem),
  );
}

export function ProjectPanel(): ReactNode {
  const [root, setRoot] = useState<string>('');
  const [projects, setProjects] = useState<ProjectsPayload['projects']>([]);
  const [dir, setDir] = useState<string>('');
  const [payload, setPayload] = useState<ProjectPayload | undefined>(undefined);
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [error, setError] = useState<string>('');

  const complain = useCallback((problem: unknown): void => {
    setError(problem instanceof Error ? problem.message : String(problem));
  }, []);

  const loadList = useCallback(async (): Promise<void> => {
    try {
      const data = unwrap<ProjectsPayload>(await getJson('/vidroom/projects'));
      setRoot(data.root);
      setProjects(data.projects);
      setError('');
    } catch (problem) {
      complain(problem);
    }
  }, [complain]);

  const open = useCallback(
    async (target: string): Promise<void> => {
      const trimmed = target.trim();
      if (trimmed === '') return;
      setDir(trimmed);
      try {
        const data = unwrap<ProjectPayload>(await getJson(`/vidroom/project?path=${encodeURIComponent(trimmed)}`));
        setPayload(data);
        const page = unwrap<AssetPayload>(
          await getJson(`/vidroom/assets?path=${encodeURIComponent(trimmed)}&limit=12`),
        );
        setAssets(page.items);
        setError('');
      } catch (problem) {
        setPayload(undefined);
        setAssets([]);
        complain(problem);
      }
    },
    [complain],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // 有 run 在跑(或停在待选/待对齐)时才轮,跑完就停。
  useEffect(() => {
    if (payload === undefined || !isActive(payload.runs)) return;
    const timer = setInterval(() => {
      void open(dir);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [payload, dir, open]);

  const view = payload?.project;
  const children: ReactNode[] = [
    h(
      'div',
      { className: 'dvr-env', key: 'title' },
      `工程(${root === '' ? '还在问本机工程根' : root})—— 面板就是第 2 批的本地入口,内容不进聊天`,
    ),
    h(
      'div',
      { className: 'dvr-form', key: 'pick' },
      h(
        'div',
        { className: 'dvr-field' },
        h('label', {}, '打开工程'),
        h(
          'select',
          {
            className: 'dvr-input',
            value: dir,
            onChange: (event: { currentTarget: { value: string } }) => void open(event.currentTarget.value),
          },
          h('option', { value: '' }, projects.length === 0 ? '这个根下还没有工程' : '挑一个…'),
          ...projects.map((item) =>
            h(
              'option',
              { key: item.projectPath, value: item.projectPath },
              item.error === undefined
                ? `${item.projectId ?? item.projectPath}(rev ${item.revision ?? '?'})`
                : `${item.projectPath} —— 读不出来:${item.error}`,
            ),
          ),
        ),
      ),
      h(
        'div',
        { className: 'dvr-field' },
        h(
          'button',
          { className: 'dvr-btn', type: 'button', onClick: () => void loadList() },
          '刷新工程列表',
        ),
      ),
    ),
    error === '' ? null : h('div', { className: 'dvr-status dvr-status--err', key: 'err' }, error),
  ];

  if (view === undefined) {
    children.push(h('div', { className: 'dvr-env', key: 'empty' }, '选一个工程看它的镜头、候选、run 与素材。'));
    return h('div', { className: 'dvr-detail' }, ...children);
  }

  children.push(
    h(
      'div',
      { className: 'dvr-env', key: 'counts' },
      `${view.projectId} · rev ${view.revision} · 资产 ${view.counts.assets ?? 0} · 镜头 ${view.counts.shots ?? 0}` +
        ` · 候选 ${view.counts.candidates ?? 0}(选定 ${view.counts.selected ?? 0}) · 对齐 ${view.counts.alignments ?? 0}` +
        (view.reference === undefined ? '' : ` · 参考 ${view.reference.analysisStatus}`),
    ),
  );

  const problems = [...view.issues, ...view.alignmentIssues, ...(payload?.missingAssets ?? []).map((id) => `缺资产 ${id}`)];
  children.push(
    h(
      'div',
      { className: problems.length === 0 ? 'dvr-status dvr-status--ok' : 'dvr-status dvr-status--err', key: 'issues' },
      problems.length === 0 ? '工程自检没有发现断链' : problems.slice(0, 5).join(' / '),
    ),
  );

  children.push(
    h(ProjectActions, {
      key: 'actions',
      dir,
      baseHash: view.projectHash,
      shots: payload?.shots ?? [],
      assets,
      reload: async () => {
        await open(dir);
      },
    }),
  );

  children.push(
    h(
      'div',
      { className: 'dvr-list', key: 'runs' },
      ...(payload?.runs ?? []).slice(0, 5).map((run) =>
        h(
          'div',
          { className: 'dvr-item', key: run.runId },
          h('div', { className: 'dvr-item-title' }, `${run.runId} · ${run.mode} · ${run.state}`),
          h('div', { className: 'dvr-item-desc' }, run.error === undefined ? '无错误' : run.error),
        ),
      ),
    ),
  );

  children.push(
    h(
      'div',
      { className: 'dvr-list', key: 'assets' },
      ...assets.map((item) =>
        h(
          'div',
          { className: 'dvr-item', key: item.id },
          h('div', { className: 'dvr-item-title' }, `${item.id} · ${item.kind}`),
          h('div', { className: 'dvr-item-desc' }, `${item.path} · ${item.sha256.slice(0, 12)}`),
          player(item, dir),
        ),
      ),
    ),
  );

  return h('div', { className: 'dvr-detail' }, ...children);
}
