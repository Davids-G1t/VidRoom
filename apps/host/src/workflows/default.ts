import { workflowToSkillSource, type SaveWorkflowInput } from './skill.js';

export const DEFAULT_WORKFLOW_ID = 'topic-to-video';

export const DEFAULT_WORKFLOW: SaveWorkflowInput = {
  name: DEFAULT_WORKFLOW_ID,
  title: '默认工作流',
  description: '一句主题 → 文案和 3 个分镜 → 3 段 73 帧回放出片 → 拼接 → 烧字幕',
  steps: [
    { id: 'script', tool: 'write_script', args: { shots: 3 } },
    { id: 'shots', tool: 'generate_video', each: '{{script.shots}}', args: { prompt: '{{item.prompt}}', seconds: 3 } },
    { id: 'joined', tool: 'concat_videos', args: { video_ids: '{{shots.ids}}' } },
    { id: 'final', tool: 'add_subtitle', args: { video_id: '{{joined.id}}', text: '{{script.caption}}' } },
  ],
};

/** 默认工作流必须能被 esbuild 单文件打包,所以把 SKILL.md 文本内嵌在源码里,启动时再物化到数据目录。 */
export const DEFAULT_WORKFLOW_SKILL = workflowToSkillSource({
  ...DEFAULT_WORKFLOW,
  builtin: true,
  body: `# 默认工作流\n\n输入一句主题后,VidRoom 先让 LLM 写一行字幕文案和 3 个分镜提示词;再用 MiniMax H3 本地出片各生成 3 秒短片(3 秒会吸附到 73 帧);最后把 3 段拼成一条 MP4,并把文案烧成字幕。\n\n本批在开发机用假 LLM 和假 ComfyUI 回放样片跑通流程;真 H3 出片留到第 7 批。`,
});
