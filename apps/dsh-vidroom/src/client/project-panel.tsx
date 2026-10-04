/**
 * 面板的「工程」区(第 2 批面):挑一个 `vr.project/1` 工程 → 看计数与问题、最近 run、
 * 工程里的资产并当场回放(视频/音频/图片)。
 *
 * 这一段是第 2 批的**本地内容入口**:参考片、文案、音轨、工程内容只在本地面板与本地路由里出现。
 * 聊天侧那批工程工具默认不注册(`chatTools` 打开才注册,见 `config.ts`),所以面板不是可有可无的装饰。
 */
import { createElement as h, useCallback, useEffect, useState, type ReactNode } from 'react';
import { getJson, unwrap } from './api.ts';

interface ProjectView {
  projectPath: string;
  projectId: string;
  revision: number;
  counts: Record<string, number>;
  issues: string[];
  alignmentIssues: string[];
  reference?: { assetId: string; analysisStatus: string; shots: number };
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
