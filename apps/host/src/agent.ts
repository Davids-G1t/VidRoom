import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { generateText, isStepCount, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import type { CloudService } from './cloud/service.js';
import { VIDEO_MAX_SECONDS, VIDEO_MIN_SECONDS } from './cloud/pricing.js';
import type { VideoEditor } from './ffmpeg/editor.js';
import { probeGpu, withForcedTier, type RunNvidiaSmi } from './gpu.js';
import { MAX_SECONDS, PROMPT_MAX_WORDS, PROMPT_MIN_WORDS, type VideoService } from './h3/service.js';
import type { LlmProvider } from './llm-provider.js';
import type { MotionService } from './motion/service.js';
import { SaveWorkflowInputSchema, type WorkflowStore } from './workflows/skill.js';
import {
  MOTION_MAX_SECONDS,
  MOTION_MIN_SECONDS,
  MOTION_STYLES,
  STYLE_LABELS,
  SUBTITLE_MAX_CHARS,
  TITLE_MAX_CHARS,
} from './motion/storyboard.js';

export const DEEPSEEK_MODEL = 'deepseek-v4-flash';
export const ANTHROPIC_MODEL = 'claude-opus-5-5';
export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1';


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
  '17. 无资质从事金融、法律、医疗等专业活动;18. 绕过安全防护;19. 违背其他国家或地区的社会、伦理、道德标准;',
  '20. 用生成的内容去训练或改进别的 AI 模型。',
  '判断看意图,不看个别字眼:普通的风景、动物、生活、创意短片照常生成,虚构作品里出现打斗、爆炸之类的情节不算违规;',
  '只拒绝明显违规的请求。',
  '\n\n【剪辑】作品库里的视频可以剪切(trim_video)、拼接(concat_videos)、烧字幕(add_subtitle),都按视频 id 操作,',
  '结果作为新的一条放进作品库,原片不动。用户说「这条」「刚才那条」而你不知道 id 时,先调 list_videos,默认取最新的一条。',
  '一句话里有多步(比如「剪成前 2 秒再加字幕」)就按顺序调用,后一步用前一步返回的新 id。',
  '时间都用秒;「前 2 秒」就是 start=0、end=2。字幕是烧进画面的文字,不是可开关的字幕轨。',
  '工具返回 ok=false 时把 reason 如实转告;成功后告诉用户新视频的时长,以及 note 里提到的注意事项。',
  '\n\n【代码渲染】开场动画、标题卡、片头片尾这类以文字为主的动效,调用 render_motion 工具:它用代码(HyperFrames)渲染,',
  '不用 AI 模型、不占显卡,也不受上面 MiniMax H3 许可的限制。从用户的话里取出标题(title)和可选的副标题(subtitle),',
  `时长用 seconds(${MOTION_MIN_SECONDS}–${MOTION_MAX_SECONDS} 秒,用户没说就用 10),`,
  `风格用 style:${MOTION_STYLES.map((s) => `${s}=${STYLE_LABELS[s]}`).join(',')};用户没指定就用 gradient。`,
  '工具会自己拆分镜、渲染、做交付前自检(时长、冻帧、联系表),再放进作品库。',
  '成功后告诉用户:这条是代码渲染的(不是 AI 生成)、风格、时长和分镜;ok=false 时如实转告 reason。',
  '\n\n【云端生成】本机不能出片时(probe_gpu 返回的档位是 none 或 unsupported),或者用户明说要用云端时，',
  '用 cloud_generate_video(视频)或 cloud_generate_image(图片)。云端工具**只算价钱，不发请求**，',
  '返回 { status: "needs_confirmation", estimateText }。把 estimateText 原样告诉用户，并说确认后才会计费，',
  '等他在页面上点确认——你没有「确认/付款」的工具，也不要替他点。',
  '绝不能说你已经生成完了;也不能把估价说成已经花掉的钱。',
  '返回 status="error" 时把 reason 如实转告(没配 key 就指引他去设置页填)。',
  '云端生成**不能**存进工作流(花钱那一步必须用户本人在估价卡上点确认),所以它不在 save_workflow 允许的步骤里。',
  '云端提示词用中文写清楚主体、动作、环境、镜头就行(万相与 Seedream 都懂中文)，不用像 MiniMax H3 那样写成英文散文。',
  '\n\n【保存工作流】用户表达「以后都这样做」「保存这个流程」等意图时,如果你刚刚实际调用过工具完成一串步骤,调用 save_workflow。',
  '保存时把刚才实际做过的工具步骤写进 steps;和本次具体主题相关的参数改成 {{topic}},上一步输出用 {{步骤id.字段}} 引用。',
  '不要猜测不存在的步骤;不要靠关键词表判断用户意图,按整句话的意图决定是否保存。',
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
  /** 不给就没有剪辑工具(list_videos / trim_video / concat_videos / add_subtitle) */
  editor?: VideoEditor;
  /** 不给就没有 render_motion 工具 */
  motion?: MotionService;
  /** 不给就没有 save_workflow 工具 */
  workflows?: WorkflowStore;
  /** 不给就没有 cloud_generate_video / cloud_generate_image 工具 */
  cloud?: CloudService;
  /** 用户在设置里选了「不用本机显卡」→ probe_gpu 的档位按 none 报 */
  forceNoLocalGpu?: boolean;
}

function motionTool(motion: MotionService): ToolSet {
  return {
    render_motion: tool({
      description:
        '用代码(HyperFrames + 无头浏览器逐帧截图 + ffmpeg)渲染一条文字动效视频,比如开场动画、标题卡。' +
        '不用 AI 模型、不占显卡。先按标题/副标题/时长拆分镜,渲染后做交付前自检,通过才放进作品库。一次只跑一条。',
      inputSchema: z.object({
        title: z.string().min(1).max(TITLE_MAX_CHARS).describe(`标题,最多 ${TITLE_MAX_CHARS} 个字`),
        subtitle: z.string().max(SUBTITLE_MAX_CHARS).optional().describe('副标题,可选'),
        seconds: z.number().describe(`时长,秒,${MOTION_MIN_SECONDS}–${MOTION_MAX_SECONDS};用户没说就用 10`),
        style: z.enum(MOTION_STYLES).default('gradient').describe(MOTION_STYLES.map((s) => `${s}=${STYLE_LABELS[s]}`).join(';')),
      }),
      execute: async ({ title, subtitle, seconds, style }) => motion.render({ title, subtitle, seconds, style }),
    }),
  };
}

function workflowTool(workflows: WorkflowStore): ToolSet {
  return {
    save_workflow: tool({
      description:
        '把刚才实际做过的一套工具步骤保存成一个 VidRoom 工作流(SKILL.md)。用户说以后都这么做、保存这个流程时使用。' +
        '只收本机工具;云端生成(cloud_generate_video / cloud_generate_image)不在可保存的步骤里 —— 花钱那一步要用户本人确认。',
      inputSchema: SaveWorkflowInputSchema,
      execute: async (input) => workflows.saveWorkflow(input),
    }),
  };
}

function cloudTools(cloud: CloudService): ToolSet {
  /** 估价失败(参数不合格)也不要抛给模型,返回一条能说给用户听的原因 */
  const attempt = <T>(fn: () => T) => {
    try {
      return { status: 'needs_confirmation' as const, ...fn() };
    } catch (err) {
      return { status: 'error' as const, reason: err instanceof Error ? err.message : String(err) };
    }
  };
  return {
    cloud_generate_video: tool({
      description:
        '云端(阿里云百炼通义万相)生成一条带声音的短视频。**只算价钱并返回估价,不发请求、不花钱**;' +
        '用户必须在页面的估价卡上点确认,才会真的生成。返回 { status: "needs_confirmation", estimateText, estimateCents, request }。',
      inputSchema: z.object({
        prompt: z.string().describe('中文提示词:主体、动作、环境、镜头'),
        seconds: z.number().describe(`时长,秒,${VIDEO_MIN_SECONDS}–${VIDEO_MAX_SECONDS};用户没说就用 5`),
        resolution: z.enum(['720p', '1080p']).default('720p').describe('清晰度,默认 720p(1080p 更贵)'),
      }),
      execute: async (input) => attempt(() => cloud.estimateVideo(input)),
    }),
    cloud_generate_image: tool({
      description:
        '云端(火山方舟 Seedream)生成一张图片。**只算价钱并返回估价,不发请求、不花钱**;用户点确认后才生成。' +
        '返回 { status: "needs_confirmation", estimateText, estimateCents, request }。',
      inputSchema: z.object({
        prompt: z.string().describe('中文提示词'),
      }),
      execute: async (input) => attempt(() => cloud.estimateImage(input)),
    }),
  };
}

function editTools(editor: VideoEditor): ToolSet {
  const id = z.string().describe('作品库里的视频 id(从 list_videos 或上一步工具结果里拿)');
  return {
    list_videos: tool({
      description: '列出作品库里的视频(最新的在前,最多 20 条):id、时长、生成时间、提示词开头、是否由剪辑得到。',
      inputSchema: z.object({}),
      execute: async () => editor.list(),
    }),
    trim_video: tool({
      description:
        '把一条视频剪出 [start, end) 这一段,存成新视频。起点落在关键帧上时直接流复制(快),' +
        '否则重新编码以保证剪得准(慢一些)。',
      inputSchema: z.object({
        video_id: id,
        start: z.number().min(0).describe('起点,秒'),
        end: z.number().positive().describe('终点,秒;超过视频长度按视频结尾算'),
      }),
      execute: async ({ video_id, start, end }) => editor.trim(video_id, start, end),
    }),
    concat_videos: tool({
      description: '按给定顺序把两条或更多视频首尾拼成一条新视频。尺寸或帧率不一致时统一成第一条的规格。',
      inputSchema: z.object({ video_ids: z.array(z.string()).min(2).describe('按播放顺序排列的视频 id') }),
      execute: async ({ video_ids }) => editor.concat(video_ids),
    }),
    add_subtitle: tool({
      description: '把一行文字烧进视频画面(任何播放器都能看到),存成新视频。文字不宜太长,需要换行时用 \\n。',
      inputSchema: z.object({
        video_id: id,
        text: z.string().min(1).max(200).describe('字幕文字'),
        position: z.enum(['bottom', 'top', 'center']).default('bottom').describe('位置,默认底部'),
      }),
      execute: async ({ video_id, text, position }) => editor.subtitle(video_id, text, position),
    }),
  };
}

export function createTools(deps: AgentDeps = {}): ToolSet {
  const probe_gpu = tool({
    description:
      '探测本机 NVIDIA 显卡:返回型号、显存(MiB 与四舍五入后的 GiB)和本地出片档位' +
      '(none / unsupported / experimental / default)。回答任何硬件或「能跑什么」的问题前都要调用。',
    inputSchema: z.object({}),
    execute: async () => withForcedTier(await probeGpu(deps.runNvidiaSmi), deps.forceNoLocalGpu === true),
  });
  const edit = deps.editor ? editTools(deps.editor) : {};
  const motion = deps.motion ? motionTool(deps.motion) : {};
  const workflows = deps.workflows ? workflowTool(deps.workflows) : {};
  const cloud = deps.cloud ? cloudTools(deps.cloud) : {};
  const video = deps.video;
  if (!video) return { probe_gpu, ...edit, ...motion, ...workflows, ...cloud };
  return {
    probe_gpu,
    ...edit,
    ...motion,
    ...workflows,
    ...cloud,
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

/**
 * baseURL 只给测试接假 Anthropic 服务用。不给时**显式**写官方地址:@ai-sdk/anthropic 在 baseURL 为空时会去读
 * 环境变量 ANTHROPIC_BASE_URL,不能让继承来的环境变量把带 key 的请求改道。
 */
export function createAnthropicModel(apiKey: string, baseURL?: string): LanguageModel {
  return createAnthropic({ apiKey, baseURL: baseURL || ANTHROPIC_API_URL })(ANTHROPIC_MODEL);
}

export function createModel(provider: LlmProvider, apiKey: string, baseURL?: string): LanguageModel {
  return provider === 'anthropic' ? createAnthropicModel(apiKey, baseURL) : createDeepSeekModel(apiKey, baseURL);
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
