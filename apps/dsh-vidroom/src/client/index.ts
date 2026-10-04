/**
 * dsh-vidroom 的网页端半边:注册两个工具卡片、一块工作流库面板(shell.overlay),
 * 以及会话标题栏上那个开面板的按钮。都走 slots.inject,等宿主声明出对应的槽位
 * 再挂,插件卸载时一起撤。
 */
import { createElement as h, type ReactNode } from 'react';
import { VidroomCard, type VidroomCardProps } from './card.tsx';
import { VidroomPanel } from './panel.tsx';
import { panelStore, usePanelOpen } from './store.ts';
import { injectStyles } from './styles.ts';

export const name = 'dsh-vidroom';
export const inject = ['slots'];

interface SlotsService {
  inject(slot: string, register: () => unknown): void;
  register(meta: Record<string, unknown>, component: unknown): unknown;
}

interface VidroomClientContext {
  effect(callback: () => unknown, label?: string): void;
  slots: SlotsService;
}

/** 会话标题栏上的开面板按钮。 */
function VidroomTrigger(): ReactNode {
  const open = usePanelOpen();
  return h(
    'button',
    {
      className: 'dvr-btn',
      type: 'button',
      title: '本地出片 · 工作流库',
      onClick: () => panelStore.toggle(),
    },
    open ? '收起出片' : '本地出片',
  );
}

export function apply(ctx: VidroomClientContext): void {
  ctx.effect(() => injectStyles(), 'dsh-vidroom: styles');

  for (const tool of ['vidroom_generate', 'vidroom_workflows']) {
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register({ name: 'tool.call.toolview', key: tool }, (props: unknown) =>
        h(VidroomCard, (props ?? {}) as unknown as VidroomCardProps),
      ),
    );
  }

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'vidroom.panel', order: 40, label: () => '本地出片' }, () =>
      h(VidroomPanel),
    ),
  );

  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      { name: 'conversation.session.header.actions', id: 'vidroom', order: 120, label: () => '本地出片' },
      () => h(VidroomTrigger),
    ),
  );
}
