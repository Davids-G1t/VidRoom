/** 插件自带的数据目录(`workflows/`,包根下):H3 模板与内置工作流的 SKILL.md 都住这里。 */
import { fileURLToPath } from 'node:url';

/**
 * `src/paths.ts` 与编译产物 `lib/paths.js` 都在包根下一层,所以这一条相对路径
 * 两边都指到同一个 `workflows/`。
 */
export function workflowsRoot(): string {
  return fileURLToPath(new URL('../workflows/', import.meta.url));
}
