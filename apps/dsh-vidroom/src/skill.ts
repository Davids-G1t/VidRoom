/**
 * 插件随包发的技能:告诉模型 VidRoom 这个插件能干什么、什么时候用、
 * 用之前要确认什么。宿主没有 skills 服务时静默跳过。
 */

export const VIDROOM_SKILL = {
  name: 'dsh-vidroom',
  source: 'runtime',
  description:
    'VidRoom 插件:用本机 ComfyUI 上的 MiniMax H3 出片(MiniMax H3 是本地文生视频模型,一张 N 卡跑,出片带声音);也能把一条本地参考片拆成镜头结构,写成可重跑的工程文件,逐步改成片。用户说「出一段视频」「用本地 H3 出片」「复刻这条爆款」「按工程文件出片」「改第二段文案」时用它。',
  whenToUse:
    '用户要用本机显卡生成视频(而不是云端 API)、要照一条参考片做同款、要改既有工程里的镜头/文案/样式、要问本机 H3 能不能跑、或者要看工作流库里有什么的时候。',
  content: `# VidRoom 插件(本地 H3 出片 / 复刻一条爆款)

本插件只做三件事:提交一次 MiniMax H3 文生视频、列/读/跑内置工作流、把一条参考片拆成工程再按工程出片。
桌面壳、ComfyUI 的启停、聊天都由宿主负责,**不要**在回答里替宿主安排这些。

## 工具

- \`vidroom_generate\`:一次出片。参数 \`topic\`(提示词,必填)、\`seconds\`(秒,默认 5)、\`megapixels\`(默认 0.4)、\`aspect\`(默认 "16:9")、\`seed\`(可选,复现用)。
- \`vidroom_workflows\`:\`action: list\` 列内置工作流;\`action: read { slug }\` 读某份 SKILL.md 原文;\`action: run { slug, topic, seconds?, megapixels?, aspect? }\` 按工作流跑。
- \`vidroom_reference\`:登记本地参考片(只读本机文件,给它 URL 而不给本地文件会被拒)。
- \`vidroom_project\`:看/改工程 —— \`inspect\`(修订号、哈希、计数)、\`patch\`(白名单 JSON Patch,改前先 inspect 拿 baseHash)、\`create\`。
- \`vidroom_plan\`:只算不做 —— 输出施工图、复用几个候选、要新生成几条、预算与缺项;\`target=candidates\` 或 \`final\`。
- \`vidroom_render\`:按冻结的计划真跑 —— \`mode=generate-missing\` 出候选,\`mode=compose\` 合成成片;回来的是 \`runId\`。
- \`vidroom_job\`:按 \`runId\` 查这一轮的状态、逐镜头结果与回执。
- \`vidroom_align_words\`:按词给某段配音校订时序(词窗 → 帧),回来顺便编译字幕/特效。
- \`vidroom_candidates\` / \`vidroom_assets\`:找已经生成的候选、列工程依赖的素材(有没有缺件)。
- \`vidroom_variants\`:一次调用批量做变体(\`action=plan\` 先看、\`action=run\` 才跑),一条失败不影响别人。
- \`vidroom_h3\`:H3 适配面 —— \`capabilities\`(参数域、工作流哈希、本机就绪没)、\`run\`(显式参数跑一次)、\`status\`(按 promptId 查真实状态)。

## 复刻一条爆款怎么走

1. \`vidroom_reference\` 登记本地参考片 → 拿 \`shotCandidates\` 与 \`requiredAnnotations\`。
2. 人工确认参考分析(景别/节奏/字幕版式/音色描述都是**人工录入**)→ \`vidroom_project action=patch\` 写进 \`analysis\`。
3. 写目标镜头与文案/词 → \`vidroom_plan target=candidates\` 看要生成几条、要多少预算。
4. \`vidroom_render mode=generate-missing\` 出候选(本机 GPU,串行);②3 里说几条就投几条,同一个配方只投一次。
5. 选定候选、录/选配音、\`vidroom_align_words\` 校订词时序 → \`vidroom_plan target=final\` → \`vidroom_render mode=compose\` 合出 MP4。
6. 要批量试风格就 \`vidroom_variants\`;每次改动只有受影响的部分重做。

要逐步的命令、参数样例与常见报错,读随包的 \`references/batch2-pipeline.md\`(**点名才读**,别默念进来)。

## 用之前先知道

1. **先看机器状态**:\`vidroom_h3 action: capabilities\`(或 \`vidroom_workflows action: list\` 里的 \`env\`)会带回 ComfyUI 地址、显存、准入结论和本机就绪情况。显存不到 24 GiB 时 H3 是实验档,默认被拦 —— 这不是故障,要用户打开插件配置 \`allowExperimental\`。
2. **出片是分钟级**:一次 5 秒片在 16 GiB 显卡上要几分钟,别把超时设短;\`seconds\` 上限 15 秒(362 帧是官方训练覆盖的上界)。
3. **秒数会被吸附**:H3 只吃 17k+5 帧(5、22、39、…、362),说 7 秒会给 175 帧(7.29 秒);回报里以实际帧数为准。
4. **别自己编尺寸**:\`aspect\` 只认 1:1、2:3、3:2、3:4、4:3、9:16、16:9、21:9;宽高由像素预算乘以长宽比算出来,并对齐到 32 的倍数。
5. **失败时看原文**:ComfyUI 的报错(缺模型、显存不足、节点报错)会原样带回,照着报错说,别猜。
6. **工程文件是唯一的真身**:要改东西就 \`vidroom_project action=patch\`(白名单:文案、提示词、种子、显式选候选、样式),不要另写一份 JSON。改词/改音轨/改裁切会让词锚失效,这时必须重新 \`vidroom_align_words\`,不能拿旧秒数顶(会回 \`ALIGNMENT_REQUIRED\`)。
7. **一切都在本机**:工程与素材全在本机目录里,参考链接只当文字存档,不下载、不外发、不分享;别提议上传或调云端模型。

## 和面板的关系

工作流库里有什么、资产有多少、哪一轮在跑,面板上都看得到:列工作流、看 SKILL.md 原文、点运行、
看资产与队列、直接在页面里回放素材(路由 \`GET /vidroom/media?path=…&asset=runs/<runId>/final.mp4\`)。
用户在网页上点运行和模型调工具走的是同一条 runner。`,
};
