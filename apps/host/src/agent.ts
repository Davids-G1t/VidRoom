import { createDeepSeek } from '@ai-sdk/deepseek';
import { generateText, isStepCount, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { probeGpu, type RunNvidiaSmi } from './gpu.js';
import { MAX_SECONDS, PROMPT_MAX_WORDS, PROMPT_MIN_WORDS, type VideoService } from './h3/service.js';

export const DEEPSEEK_MODEL = 'deepseek-v4-flash';

export const SYSTEM_PROMPT = [
  '你是 VidRoom 的助手。VidRoom 在用户自己的 NVIDIA 显卡上用 ComfyUI 本地生成视频。',
  '凡是涉及用户电脑硬件、显卡、显存、「这台电脑能跑什么」之类的问题,必须先调用 probe_gpu 工具,',
  '只根据工具返回的结果回答,绝不凭空猜测或编造型号与显存。',
  '回答时写出显卡完整型号和显存(按整 GB 说,例如「16GB」),再用一两句话说明对应档位意味着什么。',
  '用简体中文回答,只输出纯文本,不要用 Markdown 标记(聊天页不渲染 Markdown)。',
  '\n\n【生成视频】用户想要一条视频时,调用 generate_video 工具,本地模型是 MiniMax H3(文生视频,带声音)。',
  `你要把用户的描述扩写成 ${PROMPT_MIN_WORDS}–${PROMPT_MAX_WORDS} 个英文单词的英文散文提示词(不要列表、不要标题),`,
  '主体(谁或什么)放在最前面,接着写动作、环境、光线、镜头运动、画面风格,最后写声音。',
  'MiniMax H3 没有负面提示词:不要写 no、not、without、avoid、don\'t 之类的否定,把想避免的东西改写成正向描述',
  '(比如「不要字幕」写成 a clean frame with plain surfaces)。',
  `时长用 seconds 参数传,单位秒,用户没说就用 5,最长 ${MAX_SECONDS}。工具会把时长换算成模型接受的帧数。`,
  '工具返回 ok=false 时,把 reason 用一两句话如实转告用户;提示词不合格就按 reason 改写后再调用一次。',
  '出片成功后告诉用户:视频由 MiniMax H3 生成、时长几秒,已经放进作品库。',
  '\n\n【禁止用途】MiniMax H3 的许可(第 V 节与附件 A)禁止以下用途。用户的请求明显属于其中之一时,不要调用 generate_video,',
  '直接用一两句话说明不能做以及原因(可以建议一个合规的替代想法):',
  '1. 在欧盟、英国、韩国、美国境内使用;2. 违法,或侵犯他人的知识产权、肖像等权利;3. 伤害自己或他人;',
  '4. 任何剥削或伤害未成年人的内容(包括任何带性意味的未成年人内容);5. 为伤害他人或影响选举而制作可证伪的虚假信息;',
  '6. 刷量、假评论等虚假网络互动;7. 故意诽谤、贬低、骚扰他人;8. 生成或传播恶意软件;',
  '9. 为伤害他人而生成或传播个人身份信息;10. 公开发布却不明确标注是 AI 生成;11. 未经同意冒充他人(包括以真实人物为主角的深度伪造);',
  '12. 在执法、移民、医疗、信贷、就业、住房、教育、保险等关键领域做高风险自动化决策;',
  '13. 实施、协助、鼓吹暴力极端主义或恐怖主义;14. 基于受保护特征歧视或伤害个人或群体;',
  '15. 利用特定人群(年龄、身体、心理等)的弱点操纵其行为造成伤害;16. 军事用途;',
  '17. 无资质从事金融、法律、医疗等专业活动;18. 绕过安全防护;19. 用生成的内容去训练或改进别的 AI 模型。',
  '判断看意图,不看个别字眼:普通的风景、动物、生活、创意短片照常生成,虚构作品里出现打斗、爆炸之类的情节不算违规;',
  '只拒绝明显违规的请求。',
].join('');

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolCallRecord {
  toolName: string;
  input: unknown;
  output: unknown;
}

export interface ChatReply {
  text: string;
  /** 本次回答中实际执行的工具调用及其返回值(agent 可见的技术细节,也供测试核对) */
  toolCalls: ToolCallRecord[];
}

export interface AgentDeps {
  runNvidiaSmi?: RunNvidiaSmi;
  /** 不给就没有 generate_video 工具 */
  video?: VideoService;
}

export function createTools(deps: AgentDeps = {}): ToolSet {
  const probe_gpu = tool({
    description:
      '探测本机 NVIDIA 显卡:返回型号、显存(MiB 与四舍五入后的 GiB)和本地出片档位' +
      '(none / unsupported / experimental / default)。回答任何硬件或「能跑什么」的问题前都要调用。',
    inputSchema: z.object({}),
    execute: async () => probeGpu(deps.runNvidiaSmi),
  });
  const video = deps.video;
  if (!video) return { probe_gpu };
  return {
    probe_gpu,
    generate_video: tool({
      description:
        '用本地的 MiniMax H3 模型生成一条带声音的短视频(文生视频),完成后自动放进作品库。' +
        '会先检查显卡档位、许可同意和模型文件,不满足时返回 ok=false 和原因。一次只能跑一条。',
      inputSchema: z.object({
        prompt: z
          .string()
          .describe(`英文散文提示词,${PROMPT_MIN_WORDS}–${PROMPT_MAX_WORDS} 个单词;主体放最前;不写否定句(H3 没有负面提示词)`),
        seconds: z.number().describe(`视频时长,单位秒;用户没说就用 5;最长 ${MAX_SECONDS}`),
      }),
      execute: async ({ prompt, seconds }) => video.generate({ prompt, seconds }),
    }),
  };
}

/** baseURL 只给测试接假 LLM 服务用;不给就是 DeepSeek 官方地址 */
export function createDeepSeekModel(apiKey: string, baseURL?: string): LanguageModel {
  return createDeepSeek({ apiKey, baseURL })(DEEPSEEK_MODEL);
}

export async function runChat(model: LanguageModel, messages: ChatMessage[], deps: AgentDeps = {}): Promise<ChatReply> {
  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    messages: messages as ModelMessage[],
    tools: createTools(deps),
    stopWhen: isStepCount(6),
  });
  const toolCalls = result.steps.flatMap((step) =>
    step.toolResults.map((r) => ({ toolName: r.toolName, input: r.input, output: r.output })),
  );
  return { text: result.text, toolCalls };
}
