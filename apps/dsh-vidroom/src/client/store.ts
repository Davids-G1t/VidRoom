/**
 * 面板开合状态。overlay 里那块面板与会话标题栏那个按钮是同一个 bundle 里的
 * 两次注册,靠这个模块级 store + useSyncExternalStore 对齐。
 */
import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let open = false;

function emit(): void {
  for (const listener of listeners) listener();
}

export const panelStore = {
  isOpen: () => open,
  open: () => {
    if (!open) {
      open = true;
      emit();
    }
  },
  close: () => {
    if (open) {
      open = false;
      emit();
    }
  },
  toggle: () => {
    open = !open;
    emit();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** 读面板开合状态。 */
export function usePanelOpen(): boolean {
  return useSyncExternalStore(panelStore.subscribe, panelStore.isOpen, panelStore.isOpen);
}
