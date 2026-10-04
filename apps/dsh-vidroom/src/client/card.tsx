/**
 * vidroom_generate / vidroom_workflows 的工具卡片(tool.call.toolview)。
 * 卡片完全是那份冻结的工具调用块的函数:跑着的显示「出片中」,落地的画
 * 视频或工作流清单。
 */
import { createElement as h, type ReactNode } from 'react';

interface MediaItem {
  kind: string;
  url: string;
  filename: string;
}

interface VideoResult {
  kind: 'sync';
  promptId: string;
  status: 'completed';
  elapsedMs: number;
  media: MediaItem[];
  summary: string;
}

interface ListResult {
  kind: 'list';
  workflows: Array<{ slug: string; title: string; description: string; builtin: boolean; steps: string[] }>;
  env: {
    baseUrl: string;
    reachable: boolean;
    error?: string;
    vramTotalGiB?: number;
    admission: { allowed: boolean; reason: string };
  };
}

interface TextResult {
  kind: 'text';
  slug: string;
  title: string;
  text: string;
}

/** 落地的工具结果节点(宿主 wire 结构的一个截面)。 */
interface ToolResultNode {
  kind: 'tool-result';
  call?: { name?: string; argsRaw?: string } | null;
  isError?: boolean;
  error?: { message?: string; code?: string };
  meta?: unknown;
}

/** 正在跑的调用(宿主在参数里只给这几项)。 */
interface RunningToolCall {
  callId?: string;
  name?: string;
  argsRaw?: string;
}

type Block = ToolResultNode | RunningToolCall;

export interface VidroomCardProps {
  block: Block;
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function argsLine(args: Record<string, unknown>): string {
  const parts: string[] = [];
  const topic = args.topic ?? args.prompt;
  if (typeof topic === 'string') parts.push(topic.length > 60 ? `${topic.slice(0, 60)}…` : topic);
  if (typeof args.seconds === 'number') parts.push(`${args.seconds} 秒`);
  if (typeof args.megapixels === 'number') parts.push(`${args.megapixels} MP`);
  if (typeof args.aspect === 'string') parts.push(args.aspect);
  if (typeof args.slug === 'string') parts.push(args.slug);
  if (typeof args.action === 'string') parts.push(`action=${args.action}`);
  return parts.join(' · ');
}

function media(item: MediaItem): ReactNode {
  if (item.kind === 'video') return h('video', { src: item.url, controls: true, key: item.url });
  if (item.kind === 'image') return h('img', { src: item.url, alt: item.filename, key: item.url });
  if (item.kind === 'audio') return h('audio', { src: item.url, controls: true, key: item.url });
  return h('a', { href: item.url, key: item.url, target: '_blank', rel: 'noreferrer' }, item.filename);
}

export function VidroomCard(props: VidroomCardProps): ReactNode {
  const block = props.block;
  const isResult = (block as ToolResultNode).kind === 'tool-result';
  const name = (block as ToolResultNode).call?.name ?? (block as RunningToolCall).name ?? 'vidroom';
  const args = parseArgs((block as ToolResultNode).call?.argsRaw ?? (block as RunningToolCall).argsRaw);

  if (!isResult) {
    return h(
      'div',
      { className: 'dvr-card' },
      h('div', { className: 'dvr-card-head' }, h('strong', {}, name), h('span', { className: 'dvr-tag' }, '出片中')),
      h('div', { className: 'dvr-status' }, argsLine(args)),
      h('div', { className: 'dvr-media-meta' }, '本机 H3 出一段要几分钟,跑完这里会变成播放器。'),
    );
  }

  const node = block as ToolResultNode;
  if (node.isError === true) {
    return h(
      'div',
      { className: 'dvr-card' },
      h('div', { className: 'dvr-card-head' }, h('strong', {}, name), h('span', { className: 'dvr-tag' }, '失败')),
      h('div', { className: 'dvr-error' }, node.error?.message ?? '出片失败,细节看会话记录。'),
    );
  }

  const meta = node.meta as VideoResult | ListResult | TextResult | undefined;
  if (meta === undefined) {
    return h(
      'div',
      { className: 'dvr-card' },
      h('div', { className: 'dvr-card-head' }, h('strong', {}, name)),
      h('div', { className: 'dvr-status' }, argsLine(args)),
    );
  }

  if (meta.kind === 'list') {
    return h(
      'div',
      { className: 'dvr-card' },
      h(
        'div',
        { className: 'dvr-card-head' },
        h('strong', {}, name),
        h('span', { className: 'dvr-tag' }, `内置 ${meta.workflows.length} 份`),
      ),
      ...meta.workflows.map((workflow) =>
        h(
          'div',
          { key: workflow.slug },
          h('div', { className: 'dvr-item-title' }, `${workflow.title}(${workflow.slug})`),
          h('div', { className: 'dvr-item-desc' }, workflow.steps.join(' → ')),
        ),
      ),
      h(
        'div',
        { className: 'dvr-media-meta' },
        meta.env.reachable
          ? `ComfyUI ${meta.env.baseUrl} · 显存 ${meta.env.vramTotalGiB?.toFixed(1) ?? '?'} GiB · ${meta.env.admission.allowed ? '可出片' : meta.env.admission.reason}`
          : `ComfyUI ${meta.env.baseUrl} 连不上:${meta.env.error ?? '没有应答'}`,
      ),
    );
  }

  if (meta.kind === 'text') {
    return h(
      'div',
      { className: 'dvr-card' },
      h('div', { className: 'dvr-card-head' }, h('strong', {}, name), h('span', { className: 'dvr-tag' }, meta.slug)),
      h('pre', { className: 'dvr-skill' }, meta.text),
    );
  }

  return h(
    'div',
    { className: 'dvr-card' },
    h(
      'div',
      { className: 'dvr-card-head' },
      h('strong', {}, name),
      h('span', { className: 'dvr-tag' }, `prompt ${meta.promptId.slice(0, 8)}`),
      h('span', { className: 'dvr-media-meta' }, meta.summary),
    ),
    ...meta.media.map((item) => h('div', { className: 'dvr-media', key: item.url }, media(item))),
  );
}
