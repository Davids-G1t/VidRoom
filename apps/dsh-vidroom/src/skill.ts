/**
 * 插件随包发的技能:告诉模型 VidRoom 这个插件能干什么、什么时候用、
 * 用之前要确认什么。宿主没有 skills 服务时静默跳过。
 */

export const VIDROOM_SKILL = {
  name: 'dsh-vidroom',
  source: 'runtime',
  description:
    'VidRoom 插件:用本机 ComfyUI 上的 MiniMax H3 出片(MiniMax H3 是本地文生视频模型,一张 N 卡跑,出片带声音),以及内置工作流库的列举、读原文、运行。用户说「出一段视频」「用本地 H3 出片」「跑某个工作流」时用它。',
  whenToUse:
    '用户要用本机显卡生成视频(而不是云端 API)、要按某个内置工作流出片、要问本机 H3 能不能跑、或者要看工作流库里有什么的时候。',
  content: `# VidRoom 插件(本地 H3 出片)

本插件只做三件事:提交一次 MiniMax H3 文生视频、列/读/跑内置工作流、把产物地址给回对话框。
桌面壳、ComfyUI 的启停、聊天都由宿主负责,**不要**在回答里替宿主安排这些。

## 工具

- \`vidroom_generate\`:一次出片。参数 \`topic\`(提示词,必填)、\`seconds\`(秒,默认 5)、\`megapixels\`(默认 0.4)、\`aspect\`(默认 "16:9")、\`seed\`(可选,复现用)。
- \`vidroom_workflows\`:\`action: list\` 列内置工作流;\`action: read { slug }\` 读某份 SKILL.md 原文;\`action: run { slug, topic, seconds?, megapixels?, aspect? }\` 按工作流跑。

## 用之前先知道

1. **先看机器状态**:\`vidroom_workflows action: list\` 会带回 \`env\`(ComfyUI 地址、显存、准入结论)。显存不到 24 GiB 时 H3 是实验档,默认被拦 —— 这不是故障,要用户打开插件配置 \`allowExperimental\`。
2. **出片是分钟级**:一次 5 秒片在 16 GiB 显卡上要几分钟,别把超时设短;\`seconds\` 上限 15 秒(362 帧是官方训练覆盖的上界)。
3. **秒数会被吸附**:H3 只吃 17k+5 帧(5、22、39、…、362),说 7 秒会给 169 帧(7.04 秒);回报里以实际帧数为准。
4. **别自己编尺寸**:\`aspect\` 只认 1:1、2:3、3:2、3:4、4:3、9:16、16:9、21:9;宽高由像素预算乘以长宽比算出来,并对齐到 32 的倍数。
5. **失败时看原文**:ComfyUI 的报错(缺模型、显存不足、节点报错)会原样带回,照着报错说,别猜。

## 和面板的关系

工作流库里有什么,面板上就有同样的东西:列内置工作流、看 SKILL.md 原文、点运行。
用户在网页上点运行和模型调 \`vidroom_workflows action: run\` 走的是同一条 runner。`,
};
