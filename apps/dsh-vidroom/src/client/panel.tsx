/**
 * VidRoom 面板(shell.overlay,id `vidroom.panel`):工作流库 + 第 2 批的工程面。
 * 上半:内置工作流,点一份就在下面看它的 SKILL.md 原文、填一句主题、点运行;
 * 出片是分钟级,所以点完立刻拿到一条运行记录,后面每两秒轮一次进度。
 * 下半:挑一个 `vr.project/1` 工程,看它的镜头/候选/run/资产并当场回放。
 */
import { createElement as h, useCallback, useEffect, useState, type ReactNode } from 'react';
import { getJson, postJson, unwrap } from './api.ts';
import { panelStore, usePanelOpen } from './store.ts';
import { ProjectPanel } from './project-panel.tsx';

interface WorkflowSummary {
  slug: string;
  title: string;
  description: string;
  builtin: boolean;
  steps: string[];
  defaults: { seconds: number | string; megapixels: number | string; aspect: string };
}

interface EnvStatus {
  baseUrl: string;
  reachable: boolean;
  error?: string;
  vramTotalGiB?: number;
  vramFreeGiB?: number;
  admission: { allowed: boolean; tier: string; reason: string };
}

interface MediaItem {
  kind: string;
  url: string;
  filename: string;
}

interface RunRecord {
  id: string;
  slug: string;
  title: string;
  topic: string;
  status: 'running' | 'success' | 'error';
  media: MediaItem[];
  error?: string;
}

const POLL_MS = 2000;

function envLine(env: EnvStatus | undefined): string {
  if (env === undefined) return '正在问 ComfyUI…';
  if (!env.reachable) return `ComfyUI ${env.baseUrl} 连不上:${env.error ?? '没有应答'}`;
  const vram = env.vramTotalGiB === undefined ? '' : ` · 显存 ${env.vramTotalGiB.toFixed(1)} GiB`;
  return `ComfyUI ${env.baseUrl} 在${vram} · ${env.admission.allowed ? '可出片' : env.admission.reason}`;
}

export function VidroomPanel(): ReactNode {
  const open = usePanelOpen();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [env, setEnv] = useState<EnvStatus | undefined>(undefined);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [skillText, setSkillText] = useState<string>('');
  const [topic, setTopic] = useState<string>('');
  const [seconds, setSeconds] = useState<string>('');
  const [megapixels, setMegapixels] = useState<string>('');
  const [aspect, setAspect] = useState<string>('');
  const [run, setRun] = useState<RunRecord | undefined>(undefined);
  const [error, setError] = useState<string>('');

  const load = useCallback(async (): Promise<void> => {
    try {
      const payload = unwrap<{ workflows: WorkflowSummary[]; env: EnvStatus }>(await getJson('/vidroom/workflows'));
      setWorkflows(payload.workflows);
      setEnv(payload.env);
      setError('');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const select = useCallback(
    async (slug: string): Promise<void> => {
      setSelected(slug);
      setRun(undefined);
      const summary = workflows.find((item) => item.slug === slug);
      if (summary !== undefined) {
        setSeconds(String(summary.defaults.seconds));
        setMegapixels(String(summary.defaults.megapixels));
        setAspect(String(summary.defaults.aspect));
      }
      try {
        const payload = unwrap<{ workflow: { text: string } }>(
          await getJson(`/vidroom/workflow?slug=${encodeURIComponent(slug)}`),
        );
        setSkillText(payload.workflow.text);
        setError('');
      } catch (problem) {
        setSkillText('');
        setError(problem instanceof Error ? problem.message : String(problem));
      }
    },
    [workflows],
  );

  const start = useCallback(async (): Promise<void> => {
    if (selected === undefined) return;
    try {
      const body: Record<string, unknown> = { slug: selected, topic };
      if (seconds.trim() !== '') body.seconds = Number(seconds);
      if (megapixels.trim() !== '') body.megapixels = Number(megapixels);
      if (aspect.trim() !== '') body.aspect = aspect.trim();
      const payload = unwrap<{ run: RunRecord }>(await postJson('/vidroom/run', body));
      setRun(payload.run);
      setError('');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  }, [selected, topic, seconds, megapixels, aspect]);

  // 运行中每两秒轮一次;完成/失败就停。
  useEffect(() => {
    if (run === undefined || run.status !== 'running') return;
    const id = run.id;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const payload = unwrap<{ run: RunRecord }>(await getJson(`/vidroom/run?id=${encodeURIComponent(id)}`));
          setRun(payload.run);
        } catch (problem) {
          setError(problem instanceof Error ? problem.message : String(problem));
        }
      })();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [run]);

  if (!open) return null;

  const current = workflows.find((item) => item.slug === selected);

  const children: ReactNode[] = [
    h(
      'div',
      { className: 'dvr-head', key: 'head' },
      h('span', {}, '本地出片 · 工作流库'),
      h(
        'span',
        { className: 'dvr-head-actions' },
        h('button', { className: 'dvr-btn', onClick: () => void load(), type: 'button' }, '刷新'),
        h('button', { className: 'dvr-btn', onClick: () => panelStore.close(), type: 'button' }, '关闭'),
      ),
    ),
    h(
      'div',
      { className: 'dvr-body', key: 'body' },
      h('div', { className: env === undefined || env.reachable ? 'dvr-env' : 'dvr-env dvr-env--bad' }, envLine(env)),
      error === '' ? null : h('div', { className: 'dvr-status dvr-status--err' }, error),
      h(
        'div',
        { className: 'dvr-list' },
        ...workflows.map((workflow) =>
          h(
            'button',
            {
              key: workflow.slug,
              type: 'button',
              className: workflow.slug === selected ? 'dvr-item dvr-item--active' : 'dvr-item',
              onClick: () => void select(workflow.slug),
            },
            h('div', { className: 'dvr-item-title' }, workflow.title),
            h('div', { className: 'dvr-item-desc' }, `${workflow.slug} · ${workflow.steps.join(' → ')}`),
            h('div', { className: 'dvr-item-desc' }, workflow.description),
          ),
        ),
      ),
      current === undefined
        ? h('div', { className: 'dvr-env' }, '点一份工作流看它的 SKILL.md 原文并运行。')
        : h(
            'div',
            { className: 'dvr-detail' },
            h('div', { className: 'dvr-env' }, `SKILL.md 原文(${current.slug})`),
            h('pre', { className: 'dvr-skill' }, skillText),
            h(
              'div',
              { className: 'dvr-form' },
              h(
                'div',
                { className: 'dvr-field' },
                h('label', {}, '主题'),
                h('textarea', {
                  className: 'dvr-textarea',
                  value: topic,
                  placeholder: '一句话说清画面(中文也行)',
                  onInput: (event: { currentTarget: { value: string } }) => setTopic(event.currentTarget.value),
                }),
              ),
              h(
                'div',
                { className: 'dvr-field' },
                h('label', {}, '秒数'),
                h('input', {
                  className: 'dvr-input',
                  value: seconds,
                  onInput: (event: { currentTarget: { value: string } }) => setSeconds(event.currentTarget.value),
                }),
              ),
              h(
                'div',
                { className: 'dvr-field' },
                h('label', {}, '像素(百万)'),
                h('input', {
                  className: 'dvr-input',
                  value: megapixels,
                  onInput: (event: { currentTarget: { value: string } }) => setMegapixels(event.currentTarget.value),
                }),
              ),
              h(
                'div',
                { className: 'dvr-field' },
                h('label', {}, '长宽比'),
                h('input', {
                  className: 'dvr-input',
                  value: aspect,
                  onInput: (event: { currentTarget: { value: string } }) => setAspect(event.currentTarget.value),
                }),
              ),
              h(
                'div',
                { className: 'dvr-field' },
                h(
                  'button',
                  {
                    className: 'dvr-btn',
                    type: 'button',
                    disabled: topic.trim() === '' || run?.status === 'running',
                    onClick: () => void start(),
                  },
                  run?.status === 'running' ? '出片中…' : '运行',
                ),
              ),
            ),
            run === undefined
              ? null
              : h(
                  'div',
                  {},
                  h(
                    'div',
                    { className: run.status === 'error' ? 'dvr-status dvr-status--err' : 'dvr-status dvr-status--ok' },
                    run.status === 'running'
                      ? `跑着呢(${run.id})…H3 出一段要几分钟,别关页面。`
                      : run.status === 'success'
                        ? `出好了(${run.id})`
                        : `失败:${run.error ?? '没给原因'}`,
                  ),
                  ...run.media.map((item) =>
                    h(
                      'div',
                      { className: 'dvr-media', key: item.url },
                      item.kind === 'video'
                        ? h('video', { src: item.url, controls: true })
                        : item.kind === 'image'
                          ? h('img', { src: item.url, alt: item.filename })
                          : item.kind === 'audio'
                            ? h('audio', { src: item.url, controls: true })
                            : null,
                      h('div', { className: 'dvr-media-meta' }, `${item.kind} · ${item.filename}`),
                    ),
                  ),
                ),
          ),
    ),
  ];

  return h('div', { className: 'dvr-panel' }, ...children, h(ProjectPanel, { key: 'project' }));
}
