/**
 * dsh-vidroom 的插件入口(宿主侧)。
 *
 * 只做三件事:注册工具(出片/工作流库;第 2 批的工程面默认不进聊天,`chatTools` 打开才注册)、
 * 挂面板用的同源路由、把随包技能告诉宿主。桌面壳、ComfyUI 的启停、聊天都是宿主的事,这边不碰。
 *
 * 为什么工程工具默认不注册:第 2 批硬边界是工程内容不进云端对话,而聊天工具的入参与返回都会进
 * 宿主 LLM 上下文。插件读不出宿主的 LLM 配在哪,所以默认走本地面板/路由,由部署的人确认后才开 (`chatTools`)。
 */

import { createVidroomRuntime } from './runtime.js';
import { registerVidroomTools, type HostContext } from './tools.js';
import { registerVidroomProjectTools } from './project-tools.js';
import { mountVidroomRoutes, type WebServerService } from './routes.js';
import { readConfig } from './config.js';
import { RunRegistry } from './runs.js';
import { VIDROOM_SKILL } from './skill.js';
import { errorMessage } from './http.js';

export { Config } from './config.js';
export { AI_GENERATED_TAG, buildH3Prompt } from './h3.js';
export { H3_FPS, framesForSeconds, snapFrames } from './frames.js';
export { resolutionFor } from './resolution.js';
export { parseSkill, listWorkflows } from './library.js';
export { runWorkflow } from './runner.js';
export { createVidroomRuntime } from './runtime.js';
export { registerVidroomProjectTools } from './project-tools.js';
export { readProject, applyPatch } from './project-io.js';
export { buildPlan } from './plan.js';
export { renderProject } from './render.js';

export const name = 'dsh-vidroom';

/** 插件要的宿主服务:工具注册表。 */
export const inject = ['tools'];

/** 拿到 webServer 的那层 Context 要什么。 */
interface WebContext {
  webServer: WebServerService;
  effect(callback: () => unknown, label?: string): void;
}

/** 把随包技能交给宿主;宿主没有 skills 服务就别硬塞。 */
function registerSkill(ctx: HostContext): () => void {
  const skills = ctx.get('skills') as { register?: (definition: unknown) => unknown } | undefined;
  const register = skills?.register;
  if (typeof register !== 'function') return () => {};
  try {
    const dispose = register.call(skills, VIDROOM_SKILL);
    return typeof dispose === 'function' ? (dispose as () => void) : () => {};
  } catch (error) {
    console.warn(`[dsh-vidroom] 技能注册失败(不影响出片):${errorMessage(error)}`);
    return () => {};
  }
}

/** 插件入口。 */
export function apply(ctx: HostContext, entryConfig: unknown = {}): void {
  const config = readConfig(entryConfig as Record<string, unknown>);
  const runtime = createVidroomRuntime(config, new RunRegistry());

  ctx.effect(() => {
    const disposers = [
      ...registerVidroomTools(ctx, runtime),
      // 工程面默认不进聊天(参考片/文案/音轨/工程内容都不许进云端对话),见 config.chatTools。
      ...(config.chatTools ? registerVidroomProjectTools(ctx, runtime) : []),
    ];
    disposers.push(registerSkill(ctx));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'dsh-vidroom: tools');

  ctx.inject<WebContext>(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposers = mountVidroomRoutes({ webServer: webCtx.webServer }, runtime);
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'dsh-vidroom: panel routes');
  });
}
