import {
  BarChart,
  Callout,
  ChartComparisonGrid,
  ChartContainer,
  H1,
  LineChart,
  MetricsGrid,
  PieChart,
  ReportSection,
  ReportShell,
  Stack,
  Table,
  Text,
  type MetricItem,
} from "qoder/canvas";

// —— 报告数据契约（由 scripts/lib/breakdown.mjs 产出，plugin 注入）——
interface CatRow {
  key: string;
  label: string;
  tokens: number;
  share: number;
}
interface ToolRow {
  tool: string;
  tokens: number;
  calls: number;
  /** 平均每次调用带来的重发 token；无调用记录时 null（不给 0） */
  perCall?: number | null;
  share: number;
}
interface FileRow {
  attr: string;
  label: string;
  kind: string;
  tool: string | null;
  selfTokens: number;
  reads: number;
  trips: number;
  billed: number;
  /** 单次读取的总代价（含此后每一程重发）；reads=0 时 null */
  perRead?: number | null;
  share: number;
}
interface ReqRow {
  index: number;
  time: string | null;
  ratio: number;
  inputTokens: number;
  /** 代理或转录任一有真值即非 null；两者都没则 null（不写 0） */
  outputTokens?: number | null;
  /** proxy=代理实测 / transcript-tokens=转录 input_tokens / transcript-ratio=转录 ratio×window */
  usageSource?: "proxy" | "transcript-tokens" | "transcript-ratio" | "transcript";
  credits: number;
  originalCredits: number;
  afterCompact: boolean;
}
interface CatChild {
  tool: string | null;
  label: string;
  kind: string | null;
  tokens: number;
  share: number;
  catShare: number;
  trips: number;
}
interface CatDetail {
  key: string;
  label: string;
  tokens: number;
  share: number;
  children: CatChild[];
}
interface SubagentRow {
  agentId: string;
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  roundTrips: number;
  billedInputTokens: number;
  peakContextRatio: number;
  credits: number;
  originalCredits: number;
  error: string | null;
}
interface SubagentTotals {
  roundTrips: number;
  billedInputTokens: number;
  credits: number;
  originalCredits: number;
}
interface Subagents {
  scanned: boolean;
  dir: string | null;
  /** 试过的候选目录；用于区分「真没子代理」与「路径没找对」。 */
  probedPaths?: string[];
  /** ok=已汇总 / no-dir=无子代理目录 / dir-empty=目录在但无 agent 文件 / no-usage=有文件但转录无 usage / error=读取抛错 */
  reason?: string;
  count: number;
  items: SubagentRow[];
  totals: SubagentTotals;
  combined: SubagentTotals;
}
/** 逐项可用性：报告里每个数字到底是模型上报的真值、按真值推导、回退默认、手工录入，还是本地根本没有。
 *  v2 旧报告没这个对象，故全部字段可选，读取时一律走默认值（旧报告只可能来自桌面端富转录）。 */
type Avail = "measured" | "derived" | "fallback" | "manual" | "unavailable";
interface Availability {
  credits?: Avail;
  roundTrips?: Avail;
  contextRatio?: Avail;
  tokens?: Avail;
  /** 输出 token：代理或转录 output_tokens 任一有真值即 measured */
  outputTokens?: Avail;
  /** 缓存命中 token：代理或转录 cache_read_input_tokens 任一有真值即 measured */
  cachedTokens?: Avail;
  categoryShare?: Avail;
  toolShare?: Avail;
  fileShare?: Avail;
  systemPrompt?: Avail;
  contextWindow?: Avail;
  compactions?: Avail;
  compactionCost?: Avail;
  model?: Avail;
  title?: Avail;
  toolCalls?: Avail;
  fileReads?: Avail;
  userTurns?: Avail;
  /** 用户压缩阈值：manual 覆盖 → manual；默认 200K → fallback */
  userContextLimit?: Avail;
}
/** 官方 UI 真值（手工录入，来自 .qoder-credits/overrides/<sessionId>.json）。
 *  IDE 端转录不含 usage，本地算不出 Credits，这是唯一的真值通道；绝不覆盖 totals，只并列展示。 */
interface ManualTruth {
  file?: string;
  credits: number | null;
  originalCredits: number | null;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMin: number | null;
  note: string | null;
  /** 手工锁定模型窗口（如 qwen3-max=1000000），优先于 runtime-config / 反推 / fallback */
  contextWindow?: number | null;
  /** 手工指定 Qoder 压缩触发阈值（默认 200000），驱动 peakUserAdvice */
  userContextLimit?: number | null;
  /** 本地 credits ÷ 官方真值。有子代理时拿 combined 比（官方 UI 扣费 = 主链 + 子代理），
   *  否则覆盖率会被系统性低估（实测 ca2f7834：主链比 0.46、combined 比 0.89）。 */
  localCoverage?: number | null;
  /** main=只比主链 / combined=比主链+子代理 */
  localScope?: "main" | "combined";
  /** 参与对账的本地 credits（按 localScope 取 totals.credits 或 subagents.combined.credits） */
  localCredits?: number | null;
}
/** 峰值占比的「该不该压」结论。阈值算在数据层（breakdown.mjs peakAdvice），
 *  这里只管展示——否则 Canvas 与终端各持一套阈值迟早走偏。tone 直接喂 Callout。 */
interface PeakAdvice {
  level: "low" | "mid" | "sweet" | "high" | "over";
  tone: "info" | "success" | "warning" | "danger";
  text: string;
}
/** 一次压缩 = 一笔普通模型调用（整份上下文当 prompt、摘要当 completion），是会话里单笔最贵的开销。
 *  pre/post 是客户端自估口径；proxy 是能在代理日志里唯一对上时回填的供应商实测值，对不上就 null。 */
interface CompactionEvent {
  index: number;
  at: string | null;
  trigger: string | null;
  preTokens: number | null;
  postTokens: number | null;
  messagesSummarized: number | null;
  /** 压缩后首轮的往返序号与实测输入 = 压缩把上下文压到的地板 */
  nextRequestIndex: number | null;
  nextInputTokens: number | null;
  savedTokens: number | null;
  /** 数据层归一后的生效值：有代理实测就用实测，否则是客户端自估。
   *  渲染端直接取这两个，别自己按 proxy 分支——否则会与合计的口径分叉。 */
  effectiveInputTokens?: number | null;
  effectiveOutputTokens?: number | null;
  proxy?: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number | null;
    ms: number | null;
    matchedBy: string;
  } | null;
}
interface CompactionCost {
  count: number;
  items: CompactionEvent[];
  /** measured = items 里有几笔拿到了供应商实测（其余为客户端自估） */
  totals: { preTokens: number; postTokens: number; savedTokens: number; measured?: number };
}
/** 链路健康度：代理覆盖率 + 最近记录时间 + 最近若干笔的三方归因计数。
 *  逐笔明细属于排障（CLI --request-log），报告只给一行结论。 */
interface LinkHealth {
  matched: number;
  requests: number;
  coverage: number;
  /** proxy / transcript-tokens / transcript-ratio / mixed / transcript（v3 旧报告）/ null */
  usageSource?: "proxy" | "transcript-tokens" | "transcript-ratio" | "mixed" | "transcript" | null;
  /** 三档拆分：代理实测 / 转录 input_tokens / 转录 ratio×window */
  breakdown?: { proxy: number; transcriptTokens: number; transcriptRatio: number };
  logRecords?: number;
  lastRecordAt?: string | null;
  /** 参与归因的最近笔数；0 = 运行中的代理是旧版或还没记到诊断 */
  recentRequests?: number;
  proxyErrors?: number | null;
  upstreamRejected?: number | null;
  aborted?: number | null;
  truncated?: number | null;
  noUsage?: number | null;
  slowestMs?: number | null;
  /** 被更新流量推翻的那条陈旧拉起失败记录；null = 没有 */
  supersededFailure?: { error: string; port?: number; at?: string | null } | null;
}
interface Report {
  schemaVersion: number;
  generatedAt: string;
  pluginVersion?: string;
  /** 转录来自哪一代客户端：桌面端富转录有 usage 真值，IDE 端精简转录没有。v2 旧报告无此字段。 */
  source?: "desktop-rich" | "ide-lite" | "unknown";
  /** usage 数字的来源：proxy=代理实测 / transcript-tokens=转录 input_tokens 真值 /
   *  transcript-ratio=转录 ratio×window 推导 / mixed=多档混合 / transcript=v3 旧报告兼容。无 usage 时 null。 */
  usageSource?: "proxy" | "transcript-tokens" | "transcript-ratio" | "mixed" | "transcript" | null;
  /** 可直接粘贴执行的插件入口命令（generate.mjs 用 proxy.mjs 的 selfCmd() 注入）。
   *  Windows 上是插件自带启动器的绝对路径，不要求用户装 Node；模板是静态文本，拿不到就只能硬编码。 */
  selfCmd?: string | null;
  /** 链路健康度一行结论（逐笔明细留给 CLI --request-log） */
  linkHealth?: LinkHealth | null;
  /** 代理 join 诊断（lib/proxylog.mjs）+ 配置/状态（generate.mjs 注入） */
  proxy?: {
    matched: number;
    requests: number;
    /** 三档拆分：代理实测 / 转录 input_tokens / 转录 ratio×window */
    breakdown?: { proxy: number; transcriptTokens: number; transcriptRatio: number };
    logPath?: string;
    logExists?: boolean;
    logRecords?: number;
    /** config.json 里 upstream 合法 = 用户已配置代理 */
    configured?: boolean;
    enabled?: boolean;
    port?: number;
    /** 最近一条代理记录的时间；null = 从无流量 */
    lastRecordAt?: string | null;
    /** 已配置但长期零流量（多半已改回官方模型）——软提示可 --stop-proxy */
    dormant?: boolean;
    /** 最近一次自动拉起失败（如端口被占）；ok 时为 null */
    status?: { error: string; port?: number; at?: string | null } | null;
    /** status 那条失败记录是否已被更新的流量推翻（代理在它之后还记到了流量）。
     *  status.json 只写不清，陈旧失败会把用户推去改本来正确的 Base URL，故必须判掉。 */
    statusSuperseded?: boolean;
  };
  availability?: Availability;
  manual?: ManualTruth | null;
  session: {
    id: string | null;
    title: string | null;
    /** custom-title / first-user / session-id —— 令产物文件名可解释 */
    titleSource?: string;
    model: string | null;
    /** runtime-config / manual / unavailable */
    modelSource?: string;
    cwd: string | null;
    turns: number;
    roundTrips: number;
    compactions: number;
    startedAt: string | null;
    endedAt: string | null;
  };
  context: {
    contextWindow: number;
    /** runtime-config=实测 / derived-from-usage=从 usage 反推 / manual=ManualTruth 手工锁定 /
     *  fallback=读不到静默回退 200000 / caller=调用方传入（旧枚举，兼容）。
     *  报告里每个 token 数字都要乘它，回退时必须标出来。 */
    contextWindowSource?: string;
    systemPromptTokens: number;
    netContextTokens: number;
    /** 峰值 = 当前窗口口径：自最近一次压缩起算，压缩边界处归零重新累积 */
    peakContextTokens: number;
    peakContextRatio: number;
    /** 本场历史峰值（跨压缩）；整场没压缩过时与上面相等 */
    peakSessionTokens?: number;
    peakSessionRatio?: number;
    /** 历史峰值是否值得单独交代（与当前窗口峰值相差 ≥1 个百分点），渲染端直接取用不再自判 */
    peakSessionNotable?: boolean;
    /** 峰值占比的「该不该压」结论（对模型窗口）；无有效占比时 null */
    peakAdvice?: PeakAdvice | null;
    /** 用户压缩阈值（Qoder 自动触发点），与模型窗口独立。默认 200000，ManualTruth 可覆盖 */
    userContextLimit?: number;
    /** default=内置 200K / manual=overrides 手写 / config=插件配置 / derived=实测反推 */
    userContextLimitSource?: "default" | "manual" | "config" | "derived";
    /** peakContextTokens ÷ userContextLimit */
    peakUserRatio?: number;
    /** 对用户阈值的「快自动压缩了吗」结论；与 peakAdvice 可矛盾（模型窗口未满但用户阈值已超） */
    peakUserAdvice?: PeakAdvice | null;
    /** v3.2 当前占用头条口径：段内单调递增 ⇒ 峰值≡当前，故以 netContextTokens 作头条，peak 退灰字 */
    currentContextTokens?: number;
    netUserRatio?: number;
    netUserAdvice?: PeakAdvice | null;
    netWindowRatio?: number;
    /** v3.2 自动压缩自校准：本场 trigger=auto 的实际触发点（无需外部配置）与「阈值是否被强制」判定 */
    observedAutoCompactions?: number;
    observedAutoTriggerTokens?: number | null;
    autoTriggerRatio?: number | null;
    thresholdNotEnforced?: boolean;
  };
  totals: {
    billedInputTokens: number;
    netContextTokens: number;
    peakContextTokens: number;
    amplification: number;
    attributedTokens: number;
    coverage: number;
    credits: number;
    originalCredits: number;
    /** 输出 token 总量：仅代理路径有真值，否则 0 且 availability.outputTokens=unavailable */
    outputTokens?: number;
    /** 供应商上下文缓存命中的那部分 prompt：仅代理路径有真值 */
    cachedTokens?: number;
    cachedTrips?: number;
    /** 缓存命中 ÷ 计费输入总量（全局实测约 91.5%：重复叠加的前缀正是缓存的命中对象） */
    cachedShare?: number;
    /** 两个不依赖 usage 的计数，IDE 端占比全缺时仍有可展示的真值 */
    toolCalls?: number;
    fileReads?: number;
  };
  /** credits 的分子到底覆盖了多少：与计费输入总量并排展示时，部分覆盖不说就等于把局部真值当全量。 */
  creditsCoverage?: {
    /** 真正累加进 totals.credits 的往返数 */
    trips: number;
    roundTrips: number;
    /** 这些往返的计费输入之和 */
    tokens: number;
    tokenShare: number;
    /** trips === roundTrips：全覆盖时不必再啰嗦覆盖范围 */
    full: boolean;
  };
  /** 压缩单笔成本（此前只显示「压缩 N 次」，而它是会话里单笔最贵的调用） */
  compactionCost?: CompactionCost;
  byCategory: CatRow[];
  byCategoryDetail: CatDetail[];
  byTool: ToolRow[];
  byFile: FileRow[];
  byRequest: ReqRow[];
  subagents?: Subagents;
  identity: { sumAttributed: number; billedInputTokens: number; absDiff: number; ok: boolean | null };
}

// 注入点：下一行的 REPORT 初值会被 render-canvas.mjs 按整行替换为真实报告 JSON。
const REPORT = {"schemaVersion":3.2,"generatedAt":"2026-11-01T13:15:21.104Z","source":"desktop-rich","usageSource":"transcript-ratio","availability":{"credits":"measured","roundTrips":"measured","contextRatio":"measured","tokens":"derived","outputTokens":"unavailable","cachedTokens":"unavailable","categoryShare":"derived","toolShare":"derived","fileShare":"derived","systemPrompt":"derived","contextWindow":"fallback","compactions":"measured","compactionCost":"measured","model":"measured","title":"measured","toolCalls":"measured","fileReads":"measured","userTurns":"measured","userContextLimit":"fallback"},"session":{"id":"65324523-7cef-42e4-a96e-def5ed6a42c6","title":"# 远程 Linux 服务器临时执行权限（供 A","titleSource":"first-user","model":"qfmodel","modelSource":"runtime-config","cwd":"D:\\AA-project\\自动化","turns":11,"roundTrips":211,"compactions":1,"startedAt":"2026-10-31T07:08:31.907Z","endedAt":"2026-11-01T13:15:20.748Z"},"context":{"contextWindow":200000,"contextWindowSource":"fallback","systemPromptTokens":23197,"netContextTokens":53295,"peakContextTokens":109042,"peakContextRatio":0.54521,"peakSessionTokens":166433,"peakSessionRatio":0.832165,"peakSessionNotable":true,"peakAdvice":{"level":"mid","tone":"info","text":"已过盈亏线（39%）但还没进性价比区间，压缩有净收益但不大；不急着压"},"userContextLimit":200000,"userContextLimitSource":"default","peakUserRatio":0.54521,"peakUserAdvice":{"level":"mid","tone":"info","text":"已过盈亏线（39%）但还没进性价比区间，压缩有净收益但不大；不急着压"},"currentContextTokens":53295,"netUserRatio":0.266475,"netUserAdvice":{"level":"low","tone":"info","text":"低于盈亏线（39%）。此时压缩在 token 上是亏的：省下的还不够付摘要输出加压缩后重读，别压"},"netWindowRatio":0.266475,"observedAutoCompactions":1,"observedAutoTriggerTokens":167090,"autoTriggerRatio":0.83545,"thresholdNotEnforced":false},"totals":{"billedInputTokens":19692025,"netContextTokens":53295,"peakContextTokens":109042,"amplification":369.49,"attributedTokens":19692025,"coverage":1,"credits":69.403,"originalCredits":69.403,"outputTokens":0,"cachedTokens":0,"cachedTrips":0,"cachedShare":0,"toolCalls":222,"fileReads":79},"creditsCoverage":{"trips":211,"roundTrips":211,"tokens":19692025,"tokenShare":0.9999999746090105,"full":true},"compactionCost":{"count":1,"items":[{"index":1,"at":"2026-10-31T07:53:33.061Z","trigger":"auto","preTokens":167090,"postTokens":5403,"messagesSummarized":447,"nextRequestIndex":120,"nextInputTokens":36411,"savedTokens":130679,"proxy":null,"effectiveInputTokens":167090,"effectiveOutputTokens":5403}],"totals":{"preTokens":167090,"postTokens":5403,"savedTokens":130679,"measured":0}},"proxy":{"matched":0,"requests":211,"breakdown":{"proxy":0,"transcriptTokens":0,"transcriptRatio":211},"logPath":"C:\\Users\\Administrator\\.qoder-credits-proxy\\usage.jsonl","logExists":false,"logRecords":0,"configured":false,"enabled":true,"port":49787,"lastRecordAt":null,"dormant":false,"status":null,"statusSuperseded":false},"byCategory":[{"key":"tool_result","label":"工具返回","tokens":3305483,"share":0.16785898866186302},{"key":"system","label":"系统提示词","tokens":4894567,"share":0.2485557986037495},{"key":"compact_summary","label":"压缩摘要","tokens":457887,"share":0.02325239047705372},{"key":"assistant_thinking","label":"模型思考","tokens":6253272,"share":0.3175535034622805},{"key":"assistant_tool_use","label":"工具调用","tokens":2087251,"share":0.10599471505083513},{"key":"assistant_text","label":"模型回复","tokens":277387,"share":0.014086235847775647},{"key":"user_input","label":"用户输入","tokens":682432,"share":0.034655248246116745},{"key":"attachment","label":"附件/技能","tokens":1733747,"share":0.08804309425933615}],"byCategoryDetail":[{"key":"tool_result","label":"工具返回","tokens":3305483,"share":0.16785898866186302,"children":[{"tool":"Bash","label":"（无路径）","kind":"shell","tokens":2016187,"share":0.10238596585849762,"catShare":0.6099522383322887,"trips":7818},{"tool":"Grep","label":"D:/AA-project/自动化","kind":"search","tokens":375856,"share":0.019086713355596155,"catShare":0.11370682921273069,"trips":257},{"tool":"Read","label":"docs/PROJECT-STRUCTURE.md","kind":"read","tokens":150781,"share":0.007656940894812491,"catShare":0.04561531649780588,"trips":81},{"tool":"Read","label":"C:/Users/Administrator/Desktop/frp-内网穿透/使用说明.txt","kind":"read","tokens":129857,"share":0.006594408201757499,"catShare":0.03928540410213806,"trips":115},{"tool":"Read","label":"src/server/http.js","kind":"read","tokens":125312,"share":0.006363567780108696,"catShare":0.037910199691048634,"trips":224},{"tool":"Grep","label":"src/server","kind":"search","tokens":68250,"share":0.0034658606239686184,"catShare":0.0206474532677561,"trips":151},{"tool":"Read","label":"src/server/manual-control.js","kind":"read","tokens":61278,"share":0.0031118184605172143,"catShare":0.018538289103991298,"trips":77},{"tool":"Read","label":"C:/Users/ADMINI~1/AppData/Local/Temp/qoder-cli-cn/D--AA-project----/65324523-7cef-42e4-a96e-def5ed6a42c6/tasks/b35od1yud.output","kind":"read","tokens":40034,"share":0.0020330030215197086,"catShare":0.012111374182141728,"trips":90},{"tool":"mcp_call","label":"（无路径）","kind":"other","tokens":29390,"share":0.0014924653244369082,"catShare":0.00889118501388893,"trips":243},{"tool":"Glob","label":"C:/Users/Administrator/Desktop/frp-内网穿透","kind":"search","tokens":25173,"share":0.0012783096365268506,"catShare":0.007615377923561135,"trips":116},{"tool":"Read","label":"C:/Users/Administrator/Desktop/frp-内网穿透/frpc-8188.toml","kind":"read","tokens":22100,"share":0.0011222877808155377,"catShare":0.006685896238039932,"trips":115},{"tool":"Read","label":"C:/Users/Administrator/.qoder-cn/projects/D--AA-project----/memory/MEMORY.md","kind":"read","tokens":20402,"share":0.0010360695561294334,"catShare":0.006172261398622526,"trips":92},{"tool":"Read","label":"C:/Users/Administrator/Desktop/frp-内网穿透/启动穿透.bat","kind":"read","tokens":19794,"share":0.0010051743607132398,"catShare":0.005988206939207015,"trips":95},{"tool":"Read","label":"C:/Users/Administrator/.qoder-cn/projects/D--AA-project----/memory/project-console-server-runtime.md","kind":"read","tokens":19612,"share":0.0009959451849772176,"catShare":0.005933225220267831,"trips":22},{"tool":"Read","label":"src/server/auth/service.js","kind":"read","tokens":17586,"share":0.0008930363393356702,"catShare":0.005320157987694137,"trips":48},{"tool":null,"label":"其他 41 项","kind":null,"tokens":183873,"share":0.009337422282150246,"catShare":0.05562658488881791,"trips":2987}]},{"key":"system","label":"系统提示词","tokens":4894567,"share":0.2485557986037495,"children":[]},{"key":"compact_summary","label":"压缩摘要","tokens":457887,"share":0.02325239047705372,"children":[]},{"key":"assistant_thinking","label":"模型思考","tokens":6253272,"share":0.3175535034622805,"children":[]},{"key":"assistant_tool_use","label":"工具调用","tokens":2087251,"share":0.10599471505083513,"children":[{"tool":"Bash","label":"（无路径）","kind":"shell","tokens":1314615,"share":0.06675877379882789,"catShare":0.6298311549477759,"trips":7818},{"tool":"Write","label":"C:/Users/Administrator/.qoder-cn/projects/D--AA-project----/memory/infra-frp-4318-https.md","kind":"write","tokens":92188,"share":0.004681467608142284,"catShare":0.04416699083437367,"trips":90},{"tool":"Write","label":"scripts/frp-4318/README.md","kind":"write","tokens":80398,"share":0.004082789397217117,"catShare":0.03851880157665416,"trips":66},{"tool":"Edit","label":"src/server/http.js","kind":"write","tokens":54722,"share":0.0027788691200204183,"catShare":0.026217053545430743,"trips":198},{"tool":"Write","label":"scripts/frp-4318/frpc4318.ps1","kind":"write","tokens":49745,"share":0.0025261268956421664,"catShare":0.023832574052683988,"trips":129},{"tool":"Write","label":"C:/Users/Administrator/Desktop/frp-内网穿透/frpc4318.ps1","kind":"write","tokens":40903,"share":0.0020771406053603767,"catShare":0.01959664313795437,"trips":96},{"tool":"Write","label":"C:/Users/Administrator/Desktop/frp-内网穿透/pki/frps.csr","kind":"write","tokens":37827,"share":0.0019209388510976755,"catShare":0.018122968208145022,"trips":103},{"tool":"Write","label":"C:/Users/Administrator/Desktop/frp-内网穿透/frpc-hkcn2-4318.toml","kind":"write","tokens":34368,"share":0.0017452637161424378,"catShare":0.016465572979798174,"trips":94},{"tool":"Write","label":"C:/Users/Administrator/Desktop/frp-内网穿透/启动4318穿透.bat","kind":"write","tokens":33042,"share":0.0016779408900090586,"catShare":0.015830420311091144,"trips":146},{"tool":"Write","label":"C:/Users/Administrator/AppData/Local/Temp/hkcn2-1-4318.nginx.conf","kind":"write","tokens":32094,"share":0.001629797481693912,"catShare":0.01537621456798351,"trips":83},{"tool":"Edit","label":"scripts/frp-4318/frpc4318.ps1","kind":"write","tokens":27506,"share":0.001396787042568991,"catShare":0.013177893274198538,"trips":60},{"tool":"Write","label":"scripts/frp-4318/启动4318穿透.bat","kind":"write","tokens":24478,"share":0.0012430420500132034,"catShare":0.011727396497240828,"trips":184},{"tool":"Edit","label":"scripts/frp-4318/README.md","kind":"write","tokens":21934,"share":0.0011138722183129692,"catShare":0.010508752420144301,"trips":44},{"tool":"Write","label":"scripts/frp-4318/frpc-hkcn2-4318.toml","kind":"write","tokens":21143,"share":0.0010737048856129905,"catShare":0.010129796425208946,"trips":76},{"tool":"Edit","label":"C:/Users/Administrator/.qoder-cn/projects/D--AA-project----/memory/infra-frp-4318-https.md","kind":"write","tokens":19680,"share":0.0009993999311911674,"catShare":0.00942877133743748,"trips":38},{"tool":null,"label":"其他 41 项","kind":null,"tokens":202607,"share":0.01028880055898264,"catShare":0.09706899588388088,"trips":3306}]},{"key":"assistant_text","label":"模型回复","tokens":277387,"share":0.014086235847775647,"children":[]},{"key":"user_input","label":"用户输入","tokens":682432,"share":0.034655248246116745,"children":[]},{"key":"attachment","label":"附件/技能","tokens":1733747,"share":0.08804309425933615,"children":[]}],"byTool":[{"tool":"Bash","tokens":3330802,"calls":132,"perCall":25233,"share":0.16914473965732613},{"tool":"Read","tokens":685874,"calls":23,"perCall":29821,"share":0.03483005678613016},{"tool":"Write","tokens":580211,"calls":31,"perCall":18716,"share":0.029464259894785936},{"tool":"Grep","tokens":506248,"calls":10,"perCall":50625,"share":0.02570829591377791},{"tool":"Edit","tokens":204805,"calls":14,"perCall":14629,"share":0.010400385186967284},{"tool":"mcp_call","tokens":35676,"calls":6,"perCall":5946,"share":0.00181172230650388},{"tool":"Glob","tokens":28549,"calls":1,"perCall":28549,"share":0.0014497901975243546},{"tool":"AskUserQuestion","tokens":10601,"calls":2,"perCall":5301,"share":0.0005383503898169923},{"tool":"TaskStop","tokens":9966,"calls":3,"perCall":3322,"share":0.0005061033798663463}],"byFile":[{"attr":"file:D:\\AA-project\\自动化","label":"D:/AA-project/自动化","kind":"search","tool":"Grep","selfTokens":4230,"reads":4,"trips":514,"billed":390757,"perRead":97689,"share":0.019843431549344932},{"attr":"file:D:\\AA-project\\自动化\\src\\server\\http.js","label":"src/server/http.js","kind":"read","tool":"Read","selfTokens":2130,"reads":7,"trips":1012,"billed":203480,"perRead":29069,"share":0.01033310373054609},{"attr":"file:D:\\AA-project\\自动化\\docs\\PROJECT-STRUCTURE.md","label":"docs/PROJECT-STRUCTURE.md","kind":"read","tool":"Read","selfTokens":1989,"reads":1,"trips":162,"billed":152235,"perRead":152235,"share":0.007730789563341138},{"attr":"file:C:\\Users\\Administrator\\Desktop\\frp-内网穿透\\使用说明.txt","label":"C:/Users/Administrator/Desktop/frp-内网穿透/使用说明.txt","kind":"read","tool":"Read","selfTokens":1644,"reads":2,"trips":248,"billed":142885,"perRead":71443,"share":0.007256007530466843},{"attr":"file:C:\\Users\\Administrator\\.qoder-cn\\projects\\D--AA-project----\\memory\\infra-frp-4318-https.md","label":"C:/Users/Administrator/.qoder-cn/projects/D--AA-project----/memory/infra-frp-4318-https.md","kind":"write","tool":"Write","selfTokens":1776,"reads":2,"trips":256,"billed":117540,"perRead":58770,"share":0.005968916085243341},{"attr":"file:D:\\AA-project\\自动化\\scripts\\frp-4318\\README.md","label":"scripts/frp-4318/README.md","kind":"write","tool":"Write","selfTokens":1902,"reads":2,"trips":220,"billed":106530,"perRead":53265,"share":0.0054098237863761936},{"attr":"file:D:\\AA-project\\自动化\\scripts\\frp-4318\\frpc4318.ps1","label":"scripts/frp-4318/frpc4318.ps1","kind":"write","tool":"Write","selfTokens":1418,"reads":3,"trips":378,"billed":84466,"perRead":28155,"share":0.004289326879264519},{"attr":"file:D:\\AA-project\\自动化\\src\\server","label":"src/server","kind":"search","tool":"Grep","selfTokens":747,"reads":2,"trips":302,"billed":75123,"perRead":37562,"share":0.0038149060747329324},{"attr":"file:D:\\AA-project\\自动化\\src\\server\\manual-control.js","label":"src/server/manual-control.js","kind":"read","tool":"Read","selfTokens":617,"reads":1,"trips":154,"billed":63651,"perRead":63651,"share":0.003232309747708958},{"attr":"file:C:\\Users\\Administrator\\Desktop\\frp-内网穿透\\frpc-hkcn2-4318.toml","label":"C:/Users/Administrator/Desktop/frp-内网穿透/frpc-hkcn2-4318.toml","kind":"write","tool":"Write","selfTokens":453,"reads":2,"trips":366,"billed":56312,"perRead":28156,"share":0.0028596183745847317},{"attr":"file:C:\\Users\\Administrator\\Desktop\\frp-内网穿透\\frpc4318.ps1","label":"C:/Users/Administrator/Desktop/frp-内网穿透/frpc4318.ps1","kind":"write","tool":"Write","selfTokens":1038,"reads":3,"trips":192,"billed":46390,"perRead":15463,"share":0.0023557943749329515},{"attr":"file:C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\qoder-cli-cn\\D--AA-project----\\65324523-7cef-42e4-a96e-def5ed6a42c6\\tasks\\b35od1yud.output","label":"C:/Users/ADMINI~1/AppData/Local/Temp/qoder-cli-cn/D--AA-project----/65324523-7cef-42e4-a96e-def5ed6a42c6/tasks/b35od1yud.output","kind":"read","tool":"Read","selfTokens":369,"reads":1,"trips":180,"billed":44630,"perRead":44630,"share":0.002266399138793875},{"attr":"file:C:\\Users\\Administrator\\Desktop\\frp-内网穿透\\pki\\frps.csr","label":"C:/Users/Administrator/Desktop/frp-内网穿透/pki/frps.csr","kind":"write","tool":"Write","selfTokens":316,"reads":1,"trips":206,"billed":43626,"perRead":43626,"share":0.0022153893319228667},{"attr":"file:C:\\Users\\Administrator\\.qoder-cn\\projects\\D--AA-project----\\memory\\MEMORY.md","label":"C:/Users/Administrator/.qoder-cn/projects/D--AA-project----/memory/MEMORY.md","kind":"read","tool":"Read","selfTokens":768,"reads":3,"trips":362,"billed":42369,"perRead":14123,"share":0.002151575068879155},{"attr":"file:C:\\Users\\Administrator\\Desktop\\frp-内网穿透\\启动4318穿透.bat","label":"C:/Users/Administrator/Desktop/frp-内网穿透/启动4318穿透.bat","kind":"write","tool":"Write","selfTokens":1110,"reads":5,"trips":292,"billed":42224,"perRead":8445,"share":0.002144197319103438},{"attr":"file:C:\\Users\\Administrator\\AppData\\Local\\Temp\\hkcn2-1-4318.nginx.conf","label":"C:/Users/Administrator/AppData/Local/Temp/hkcn2-1-4318.nginx.conf","kind":"write","tool":"Write","selfTokens":329,"reads":1,"trips":166,"billed":36663,"perRead":36663,"share":0.0018618172620739476},{"attr":"file:D:\\AA-project\\自动化\\scripts\\frp-4318\\启动4318穿透.bat","label":"scripts/frp-4318/启动4318穿透.bat","kind":"write","tool":"Write","selfTokens":558,"reads":3,"trips":368,"billed":32351,"perRead":10784,"share":0.00164283521425201},{"attr":"file:D:\\AA-project\\自动化\\package.json","label":"package.json","kind":"read","tool":"Read","selfTokens":447,"reads":3,"trips":414,"billed":29305,"perRead":9768,"share":0.001488158156249037},{"attr":"file:C:\\Users\\Administrator\\Desktop\\frp-内网穿透","label":"C:/Users/Administrator/Desktop/frp-内网穿透","kind":"search","tool":"Glob","selfTokens":186,"reads":1,"trips":232,"billed":28549,"perRead":28549,"share":0.0014497901975243546},{"attr":"file:C:\\Users\\Administrator\\.qoder-cn\\projects\\D--AA-project----\\memory\\project-console-server-runtime.md","label":"C:/Users/Administrator/.qoder-cn/projects/D--AA-project----/memory/project-console-server-runtime.md","kind":"read","tool":"Read","selfTokens":3247,"reads":4,"trips":86,"billed":25674,"perRead":6419,"share":0.0013037960894290935},{"attr":"file:C:\\Users\\Administrator\\Desktop\\frp-内网穿透\\frpc-8188.toml","label":"C:/Users/Administrator/Desktop/frp-内网穿透/frpc-8188.toml","kind":"read","tool":"Read","selfTokens":168,"reads":1,"trips":230,"billed":25606,"perRead":25606,"share":0.0013003058426000707},{"attr":"file:D:\\AA-project\\自动化\\scripts\\frp-4318\\frpc-hkcn2-4318.toml","label":"scripts/frp-4318/frpc-hkcn2-4318.toml","kind":"write","tool":"Write","selfTokens":334,"reads":1,"trips":152,"billed":24102,"perRead":24102,"share":0.001223950279162931},{"attr":"file:C:\\Users\\Administrator\\Desktop\\frp-内网穿透\\启动穿透.bat","label":"C:/Users/Administrator/Desktop/frp-内网穿透/启动穿透.bat","kind":"read","tool":"Read","selfTokens":181,"reads":1,"trips":190,"billed":23114,"perRead":23114,"share":0.0011737842534780408},{"attr":"file:D:\\AA-project\\自动化\\src\\server\\auth\\service.js","label":"src/server/auth/service.js","kind":"read","tool":"Read","selfTokens":937,"reads":2,"trips":96,"billed":18565,"perRead":9283,"share":0.0009427841451705023},{"attr":"file:C:\\Users\\Administrator\\Desktop\\frp-内网穿透\\停止4318穿透.bat","label":"C:/Users/Administrator/Desktop/frp-内网穿透/停止4318穿透.bat","kind":"write","tool":"Write","selfTokens":405,"reads":3,"trips":192,"billed":17127,"perRead":5709,"share":0.00086976698602188},{"attr":"file:D:\\AA-project\\自动化\\src","label":"src","kind":"search","tool":"Grep","selfTokens":152,"reads":1,"trips":156,"billed":15890,"perRead":15890,"share":0.0008069388964244307},{"attr":"file:C:\\Users\\Administrator\\Desktop\\frp-内网穿透\\开机自启-4318-安装.bat","label":"C:/Users/Administrator/Desktop/frp-内网穿透/开机自启-4318-安装.bat","kind":"write","tool":"Write","selfTokens":361,"reads":2,"trips":130,"billed":15632,"perRead":7816,"share":0.0007938433531381046},{"attr":"file:C:\\Users\\Administrator\\Desktop\\frp-内网穿透\\后台启动-4318.vbs","label":"C:/Users/Administrator/Desktop/frp-内网穿透/后台启动-4318.vbs","kind":"write","tool":"Write","selfTokens":293,"reads":2,"trips":150,"billed":14668,"perRead":7334,"share":0.0007448820054855481},{"attr":"file:D:\\AA-project\\自动化\\.gitignore","label":".gitignore","kind":"read","tool":"Read","selfTokens":202,"reads":2,"trips":286,"billed":13711,"perRead":6856,"share":0.0006962837829373507},{"attr":"file:C:\\Users\\Administrator\\Desktop\\frp-内网穿透\\取消开机自启-4318.bat","label":"C:/Users/Administrator/Desktop/frp-内网穿透/取消开机自启-4318.bat","kind":"write","tool":"Write","selfTokens":314,"reads":2,"trips":126,"billed":13198,"perRead":6599,"share":0.0006702013752406283},{"attr":"file:C:\\Users\\Administrator\\.qoder-cn\\projects\\D--AA-project----\\memory\\feedback-shared-worktree-commits.md","label":"C:/Users/Administrator/.qoder-cn/projects/D--AA-project----/memory/feedback-shared-worktree-commits.md","kind":"read","tool":"Read","selfTokens":989,"reads":1,"trips":20,"billed":13010,"perRead":13010,"share":0.0006606588253195119},{"attr":"file:C:\\Users\\Administrator\\Desktop\\frp-内网穿透\\后台启动.vbs","label":"C:/Users/Administrator/Desktop/frp-内网穿透/后台启动.vbs","kind":"read","tool":"Read","selfTokens":85,"reads":1,"trips":190,"billed":10855,"perRead":10855,"share":0.0005512246494233896},{"attr":"file:D:\\AA-project\\自动化\\scripts\\frp-4318\\停止4318穿透.bat","label":"scripts/frp-4318/停止4318穿透.bat","kind":"write","tool":"Write","selfTokens":127,"reads":1,"trips":146,"billed":8811,"perRead":8811,"share":0.0004474569075392173},{"attr":"file:D:\\AA-project\\自动化\\scripts\\frp-4318\\run-4318-hidden.vbs","label":"scripts/frp-4318/run-4318-hidden.vbs","kind":"write","tool":"Write","selfTokens":159,"reads":1,"trips":106,"billed":7944,"perRead":7944,"share":0.0004034300478028738},{"attr":"file:C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\qoder-cli-cn\\D--AA-project----\\65324523-7cef-42e4-a96e-def5ed6a42c6\\tasks\\bad0fic8m.output","label":"C:/Users/ADMINI~1/AppData/Local/Temp/qoder-cli-cn/D--AA-project----/65324523-7cef-42e4-a96e-def5ed6a42c6/tasks/bad0fic8m.output","kind":"read","tool":"Read","selfTokens":59,"reads":1,"trips":174,"billed":6896,"perRead":6896,"share":0.00035020188365031353},{"attr":"file:C:\\Users\\Administrator\\Desktop\\frp-内网穿透\\run-4318-hidden.vbs","label":"C:/Users/Administrator/Desktop/frp-内网穿透/run-4318-hidden.vbs","kind":"write","tool":"Write","selfTokens":134,"reads":1,"trips":46,"billed":4085,"perRead":4085,"share":0.00020742286049176502},{"attr":"file:C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\qoder-cli-cn\\D--AA-project----\\65324523-7cef-42e4-a96e-def5ed6a42c6\\tasks\\b0cnzuamj.output","label":"C:/Users/ADMINI~1/AppData/Local/Temp/qoder-cli-cn/D--AA-project----/65324523-7cef-42e4-a96e-def5ed6a42c6/tasks/b0cnzuamj.output","kind":"read","tool":"Read","selfTokens":60,"reads":1,"trips":78,"billed":3112,"perRead":3112,"share":0.0001580303888634419},{"attr":"file:D:\\AA-project\\自动化\\src\\server\\auth","label":"src/server/auth","kind":"search","tool":"Grep","selfTokens":115,"reads":1,"trips":52,"billed":2497,"perRead":2497,"share":0.00012680351697127125},{"attr":"file:C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\qoder-cli-cn\\D--AA-project----\\65324523-7cef-42e4-a96e-def5ed6a42c6\\tasks\\b34ulf98q.output","label":"C:/Users/ADMINI~1/AppData/Local/Temp/qoder-cli-cn/D--AA-project----/65324523-7cef-42e4-a96e-def5ed6a42c6/tasks/b34ulf98q.output","kind":"read","tool":"Read","selfTokens":60,"reads":1,"trips":36,"billed":1429,"perRead":1429,"share":0.00007256800080288818},{"attr":"file:C:\\Users\\Administrator\\.qoder-cn\\memory\\feedback-secret-transfer.md","label":"C:/Users/Administrator/.qoder-cn/memory/feedback-secret-transfer.md","kind":"read","tool":"Read","selfTokens":1134,"reads":2,"trips":2,"billed":675,"perRead":337,"share":0.000034264503891098134}],"byAttr":[{"attr":"assistant_thinking","tokens":6253272,"share":0.3175535034622805},{"attr":"system","tokens":4894567,"share":0.2485557986037495},{"attr":"tool_result|Bash","tokens":2016187,"share":0.10238596585849762},{"attr":"attachment","tokens":1733747,"share":0.08804309425933615},{"attr":"tool_use|Bash","tokens":1314615,"share":0.06675877379882789},{"attr":"user_input","tokens":682432,"share":0.034655248246116745},{"attr":"tool_result|Read","tokens":643029,"share":0.03265428316098911},{"attr":"tool_use|Write","tokens":502052,"share":0.025495183325588262},{"attr":"tool_result|Grep","tokens":475138,"share":0.02412846316806781},{"attr":"compact_summary","tokens":457887,"share":0.02325239047705372},{"attr":"assistant_text","tokens":277387,"share":0.014086235847775647},{"attr":"tool_use|Edit","tokens":177592,"share":0.009018471512938494},{"attr":"tool_result|Write","tokens":78159,"share":0.0039690765691976285},{"attr":"tool_use|Read","tokens":42845,"share":0.002175773625141011},{"attr":"tool_use|Grep","tokens":31110,"share":0.001579832745710131},{"attr":"tool_result|mcp_call","tokens":29390,"share":0.0014924653244369082},{"attr":"tool_result|Edit","tokens":27213,"share":0.0013819136740287957},{"attr":"tool_result|Glob","tokens":25173,"share":0.0012783096365268506},{"attr":"tool_result|TaskStop","tokens":9235,"share":0.0004689689815182572},{"attr":"tool_use|AskUserQuestion","tokens":8641,"share":0.0004388081012169545},{"attr":"tool_use|mcp_call","tokens":6287,"share":0.00031925698206697073},{"attr":"tool_use|Glob","tokens":3377,"share":0.00017148056099750426},{"attr":"tool_result|AskUserQuestion","tokens":1960,"share":0.00009954228860003786},{"attr":"tool_use|TaskStop","tokens":731,"share":0.00003713439834808922}],"byRequest":[{"index":1,"time":"15:08","ratio":0.151395,"inputTokens":30279,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.923,"originalCredits":0.923,"afterCompact":false},{"index":2,"time":"15:09","ratio":0.16209,"inputTokens":32418,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.167,"originalCredits":0.167,"afterCompact":false},{"index":3,"time":"15:09","ratio":0.166985,"inputTokens":33397,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.11,"originalCredits":0.11,"afterCompact":false},{"index":4,"time":"15:09","ratio":0.16876,"inputTokens":33752,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.092,"originalCredits":0.092,"afterCompact":false},{"index":5,"time":"15:09","ratio":0.175825,"inputTokens":35165,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.191,"originalCredits":0.191,"afterCompact":false},{"index":6,"time":"15:10","ratio":0.19388,"inputTokens":38776,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.234,"originalCredits":0.234,"afterCompact":false},{"index":7,"time":"15:10","ratio":0.20619,"inputTokens":41238,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.279,"originalCredits":0.279,"afterCompact":false},{"index":8,"time":"15:11","ratio":0.21757,"inputTokens":43514,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.196,"originalCredits":0.196,"afterCompact":false},{"index":9,"time":"15:11","ratio":0.221445,"inputTokens":44289,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.163,"originalCredits":0.163,"afterCompact":false},{"index":10,"time":"15:12","ratio":0.22776,"inputTokens":45552,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.293,"originalCredits":0.293,"afterCompact":false},{"index":11,"time":"15:13","ratio":0.244615,"inputTokens":48923,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.433,"originalCredits":0.433,"afterCompact":false},{"index":12,"time":"15:14","ratio":0.26765,"inputTokens":53530,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.368,"originalCredits":0.368,"afterCompact":false},{"index":13,"time":"15:15","ratio":0.280545,"inputTokens":56109,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.392,"originalCredits":0.392,"afterCompact":false},{"index":14,"time":"15:16","ratio":0.29785,"inputTokens":59570,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.386,"originalCredits":0.386,"afterCompact":false},{"index":15,"time":"15:16","ratio":0.31755,"inputTokens":63510,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.273,"originalCredits":0.273,"afterCompact":false},{"index":16,"time":"15:17","ratio":0.320415,"inputTokens":64083,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.209,"originalCredits":0.209,"afterCompact":false},{"index":17,"time":"15:17","ratio":0.325525,"inputTokens":65105,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.207,"originalCredits":0.207,"afterCompact":false},{"index":18,"time":"15:17","ratio":0.32873,"inputTokens":65746,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.181,"originalCredits":0.181,"afterCompact":false},{"index":19,"time":"15:17","ratio":0.33904,"inputTokens":67808,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.305,"originalCredits":0.305,"afterCompact":false},{"index":20,"time":"15:18","ratio":0.34827,"inputTokens":69654,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.223,"originalCredits":0.223,"afterCompact":false},{"index":21,"time":"15:18","ratio":0.36182,"inputTokens":72364,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.422,"originalCredits":0.422,"afterCompact":false},{"index":22,"time":"15:19","ratio":0.378685,"inputTokens":75737,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.273,"originalCredits":0.273,"afterCompact":false},{"index":23,"time":"15:19","ratio":0.38448,"inputTokens":76896,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.229,"originalCredits":0.229,"afterCompact":false},{"index":24,"time":"15:19","ratio":0.388785,"inputTokens":77757,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.23,"originalCredits":0.23,"afterCompact":false},{"index":25,"time":"15:19","ratio":0.393975,"inputTokens":78795,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.239,"originalCredits":0.239,"afterCompact":false},{"index":26,"time":"15:19","ratio":0.397445,"inputTokens":79489,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.204,"originalCredits":0.204,"afterCompact":false},{"index":27,"time":"15:20","ratio":0.39847,"inputTokens":79694,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.198,"originalCredits":0.198,"afterCompact":false},{"index":28,"time":"15:20","ratio":0.400335,"inputTokens":80067,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.21,"originalCredits":0.21,"afterCompact":false},{"index":29,"time":"15:20","ratio":0.4048,"inputTokens":80960,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.209,"originalCredits":0.209,"afterCompact":false},{"index":30,"time":"15:20","ratio":0.407275,"inputTokens":81455,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.212,"originalCredits":0.212,"afterCompact":false},{"index":31,"time":"15:20","ratio":0.40912,"inputTokens":81824,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.202,"originalCredits":0.202,"afterCompact":false},{"index":32,"time":"15:20","ratio":0.411655,"inputTokens":82331,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.207,"originalCredits":0.207,"afterCompact":false},{"index":33,"time":"15:20","ratio":0.41324,"inputTokens":82648,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.201,"originalCredits":0.201,"afterCompact":false},{"index":34,"time":"15:21","ratio":0.414595,"inputTokens":82919,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.212,"originalCredits":0.212,"afterCompact":false},{"index":35,"time":"15:21","ratio":0.419485,"inputTokens":83897,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.319,"originalCredits":0.319,"afterCompact":false},{"index":36,"time":"15:21","ratio":0.42857,"inputTokens":85714,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.287,"originalCredits":0.287,"afterCompact":false},{"index":37,"time":"15:22","ratio":0.433035,"inputTokens":86607,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.222,"originalCredits":0.222,"afterCompact":false},{"index":38,"time":"15:22","ratio":0.43858,"inputTokens":87716,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.318,"originalCredits":0.318,"afterCompact":false},{"index":39,"time":"15:22","ratio":0.44851,"inputTokens":89702,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.269,"originalCredits":0.269,"afterCompact":false},{"index":40,"time":"15:23","ratio":0.45029,"inputTokens":90058,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.225,"originalCredits":0.225,"afterCompact":false},{"index":41,"time":"15:23","ratio":0.47183,"inputTokens":94366,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.353,"originalCredits":0.353,"afterCompact":false},{"index":42,"time":"15:23","ratio":0.47543,"inputTokens":95086,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.24,"originalCredits":0.24,"afterCompact":false},{"index":43,"time":"15:23","ratio":0.48408,"inputTokens":96816,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.334,"originalCredits":0.334,"afterCompact":false},{"index":44,"time":"15:24","ratio":0.49245,"inputTokens":98490,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.382,"originalCredits":0.382,"afterCompact":false},{"index":45,"time":"15:24","ratio":0.50667,"inputTokens":101334,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.31,"originalCredits":0.31,"afterCompact":false},{"index":46,"time":"15:24","ratio":0.50997,"inputTokens":101994,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.258,"originalCredits":0.258,"afterCompact":false},{"index":47,"time":"15:24","ratio":0.512615,"inputTokens":102523,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.359,"originalCredits":0.359,"afterCompact":false},{"index":48,"time":"15:24","ratio":0.523145,"inputTokens":104629,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.292,"originalCredits":0.292,"afterCompact":false},{"index":49,"time":"15:25","ratio":0.525,"inputTokens":105000,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.256,"originalCredits":0.256,"afterCompact":false},{"index":50,"time":"15:25","ratio":0.527165,"inputTokens":105433,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.28,"originalCredits":0.28,"afterCompact":false},{"index":51,"time":"15:25","ratio":0.532705,"inputTokens":106541,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.326,"originalCredits":0.326,"afterCompact":false},{"index":52,"time":"15:25","ratio":0.53804,"inputTokens":107608,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.321,"originalCredits":0.321,"afterCompact":false},{"index":53,"time":"15:25","ratio":0.542805,"inputTokens":108561,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.276,"originalCredits":0.276,"afterCompact":false},{"index":54,"time":"15:26","ratio":0.54386,"inputTokens":108772,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.28,"originalCredits":0.28,"afterCompact":false},{"index":55,"time":"15:26","ratio":0.54682,"inputTokens":109364,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.278,"originalCredits":0.278,"afterCompact":false},{"index":56,"time":"15:26","ratio":0.54997,"inputTokens":109994,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.292,"originalCredits":0.292,"afterCompact":false},{"index":57,"time":"15:26","ratio":0.55281,"inputTokens":110562,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.272,"originalCredits":0.272,"afterCompact":false},{"index":58,"time":"15:27","ratio":0.55437,"inputTokens":110874,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.286,"originalCredits":0.286,"afterCompact":false},{"index":59,"time":"15:27","ratio":0.5577,"inputTokens":111540,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.312,"originalCredits":0.312,"afterCompact":false},{"index":60,"time":"15:28","ratio":0.561825,"inputTokens":112365,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.279,"originalCredits":0.279,"afterCompact":false},{"index":61,"time":"15:28","ratio":0.56342,"inputTokens":112684,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.265,"originalCredits":0.265,"afterCompact":false},{"index":62,"time":"15:28","ratio":0.565045,"inputTokens":113009,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.331,"originalCredits":0.331,"afterCompact":false},{"index":63,"time":"15:28","ratio":0.572025,"inputTokens":114405,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.302,"originalCredits":0.302,"afterCompact":false},{"index":64,"time":"15:28","ratio":0.57333,"inputTokens":114666,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.285,"originalCredits":0.285,"afterCompact":false},{"index":65,"time":"15:29","ratio":0.575475,"inputTokens":115095,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.284,"originalCredits":0.284,"afterCompact":false},{"index":66,"time":"15:30","ratio":0.58577,"inputTokens":117154,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.386,"originalCredits":0.386,"afterCompact":false},{"index":67,"time":"15:30","ratio":0.594955,"inputTokens":118991,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.334,"originalCredits":0.334,"afterCompact":false},{"index":68,"time":"15:30","ratio":0.59697,"inputTokens":119394,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.293,"originalCredits":0.293,"afterCompact":false},{"index":69,"time":"15:30","ratio":0.599625,"inputTokens":119925,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.323,"originalCredits":0.323,"afterCompact":false},{"index":70,"time":"15:31","ratio":0.604165,"inputTokens":120833,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.358,"originalCredits":0.358,"afterCompact":false},{"index":71,"time":"15:32","ratio":0.61177,"inputTokens":122354,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.537,"originalCredits":0.537,"afterCompact":false},{"index":72,"time":"15:32","ratio":0.63307,"inputTokens":126614,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.478,"originalCredits":0.478,"afterCompact":false},{"index":73,"time":"15:33","ratio":0.640715,"inputTokens":128143,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.368,"originalCredits":0.368,"afterCompact":false},{"index":74,"time":"15:33","ratio":0.644675,"inputTokens":128935,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.322,"originalCredits":0.322,"afterCompact":false},{"index":75,"time":"15:33","ratio":0.646255,"inputTokens":129251,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.316,"originalCredits":0.316,"afterCompact":false},{"index":76,"time":"15:33","ratio":0.648285,"inputTokens":129657,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.32,"originalCredits":0.32,"afterCompact":false},{"index":77,"time":"15:33","ratio":0.650345,"inputTokens":130069,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.314,"originalCredits":0.314,"afterCompact":false},{"index":78,"time":"15:33","ratio":0.651835,"inputTokens":130367,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.309,"originalCredits":0.309,"afterCompact":false},{"index":79,"time":"15:33","ratio":0.654755,"inputTokens":130951,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.317,"originalCredits":0.317,"afterCompact":false},{"index":80,"time":"15:36","ratio":0.65622,"inputTokens":131244,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.31,"originalCredits":0.31,"afterCompact":false},{"index":81,"time":"15:36","ratio":0.657335,"inputTokens":131467,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.308,"originalCredits":0.308,"afterCompact":false},{"index":82,"time":"15:36","ratio":0.65832,"inputTokens":131664,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.317,"originalCredits":0.317,"afterCompact":false},{"index":83,"time":"15:36","ratio":0.660005,"inputTokens":132001,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.318,"originalCredits":0.318,"afterCompact":false},{"index":84,"time":"15:37","ratio":0.6615,"inputTokens":132300,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.417,"originalCredits":0.417,"afterCompact":false},{"index":85,"time":"15:38","ratio":0.672345,"inputTokens":134469,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.394,"originalCredits":0.394,"afterCompact":false},{"index":86,"time":"15:38","ratio":0.67606,"inputTokens":135212,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.354,"originalCredits":0.354,"afterCompact":false},{"index":87,"time":"15:39","ratio":0.679725,"inputTokens":135945,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.369,"originalCredits":0.369,"afterCompact":false},{"index":88,"time":"15:39","ratio":0.68407,"inputTokens":136814,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.408,"originalCredits":0.408,"afterCompact":false},{"index":89,"time":"15:39","ratio":0.69116,"inputTokens":138232,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.38,"originalCredits":0.38,"afterCompact":false},{"index":90,"time":"15:40","ratio":0.6948,"inputTokens":138960,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.375,"originalCredits":0.375,"afterCompact":false},{"index":91,"time":"15:40","ratio":0.699825,"inputTokens":139965,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.434,"originalCredits":0.434,"afterCompact":false},{"index":92,"time":"15:40","ratio":0.708235,"inputTokens":141647,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.375,"originalCredits":0.375,"afterCompact":false},{"index":93,"time":"15:41","ratio":0.709935,"inputTokens":141987,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.389,"originalCredits":0.389,"afterCompact":false},{"index":94,"time":"15:41","ratio":0.716215,"inputTokens":143243,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.389,"originalCredits":0.389,"afterCompact":false},{"index":95,"time":"15:41","ratio":0.72021,"inputTokens":144042,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.361,"originalCredits":0.361,"afterCompact":false},{"index":96,"time":"15:42","ratio":0.722195,"inputTokens":144439,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.369,"originalCredits":0.369,"afterCompact":false},{"index":97,"time":"15:42","ratio":0.72564,"inputTokens":145128,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.369,"originalCredits":0.369,"afterCompact":false},{"index":98,"time":"15:42","ratio":0.7284,"inputTokens":145680,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.366,"originalCredits":0.366,"afterCompact":false},{"index":99,"time":"15:42","ratio":0.73214,"inputTokens":146428,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.365,"originalCredits":0.365,"afterCompact":false},{"index":100,"time":"15:43","ratio":0.74136,"inputTokens":148272,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.416,"originalCredits":0.416,"afterCompact":false},{"index":101,"time":"15:45","ratio":0.745355,"inputTokens":149071,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.377,"originalCredits":0.377,"afterCompact":false},{"index":102,"time":"15:46","ratio":0.747635,"inputTokens":149527,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.549,"originalCredits":0.549,"afterCompact":false},{"index":103,"time":"15:46","ratio":0.766675,"inputTokens":153335,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.464,"originalCredits":0.464,"afterCompact":false},{"index":104,"time":"15:46","ratio":0.769585,"inputTokens":153917,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.374,"originalCredits":0.374,"afterCompact":false},{"index":105,"time":"15:46","ratio":0.771305,"inputTokens":154261,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.362,"originalCredits":0.362,"afterCompact":false},{"index":106,"time":"15:47","ratio":0.772545,"inputTokens":154509,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.368,"originalCredits":0.368,"afterCompact":false},{"index":107,"time":"15:47","ratio":0.774285,"inputTokens":154857,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.383,"originalCredits":0.383,"afterCompact":false},{"index":108,"time":"15:47","ratio":0.777265,"inputTokens":155453,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.385,"originalCredits":0.385,"afterCompact":false},{"index":109,"time":"15:47","ratio":0.7859,"inputTokens":157180,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.425,"originalCredits":0.425,"afterCompact":false},{"index":110,"time":"15:48","ratio":0.79568,"inputTokens":159136,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.482,"originalCredits":0.482,"afterCompact":false},{"index":111,"time":"15:48","ratio":0.802455,"inputTokens":160491,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.422,"originalCredits":0.422,"afterCompact":false},{"index":112,"time":"15:49","ratio":0.80593,"inputTokens":161186,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.433,"originalCredits":0.433,"afterCompact":false},{"index":113,"time":"15:49","ratio":0.81099,"inputTokens":162198,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.415,"originalCredits":0.415,"afterCompact":false},{"index":114,"time":"15:50","ratio":0.814365,"inputTokens":162873,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.396,"originalCredits":0.396,"afterCompact":false},{"index":115,"time":"15:50","ratio":0.81599,"inputTokens":163198,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.378,"originalCredits":0.378,"afterCompact":false},{"index":116,"time":"15:50","ratio":0.817445,"inputTokens":163489,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.411,"originalCredits":0.411,"afterCompact":false},{"index":117,"time":"15:51","ratio":0.82101,"inputTokens":164202,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.401,"originalCredits":0.401,"afterCompact":false},{"index":118,"time":"15:51","ratio":0.82619,"inputTokens":165238,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.431,"originalCredits":0.431,"afterCompact":false},{"index":119,"time":"15:51","ratio":0.832165,"inputTokens":166433,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.43,"originalCredits":0.43,"afterCompact":false},{"index":120,"time":"15:53","ratio":0.182055,"inputTokens":36411,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.457,"originalCredits":0.457,"afterCompact":true},{"index":121,"time":"15:54","ratio":0.18395,"inputTokens":36790,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.167,"originalCredits":0.167,"afterCompact":false},{"index":122,"time":"15:54","ratio":0.190565,"inputTokens":38113,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.134,"originalCredits":0.134,"afterCompact":false},{"index":123,"time":"15:54","ratio":0.19358,"inputTokens":38716,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.119,"originalCredits":0.119,"afterCompact":false},{"index":124,"time":"15:54","ratio":0.196515,"inputTokens":39303,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.118,"originalCredits":0.118,"afterCompact":false},{"index":125,"time":"15:54","ratio":0.197985,"inputTokens":39597,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.105,"originalCredits":0.105,"afterCompact":false},{"index":126,"time":"15:54","ratio":0.198855,"inputTokens":39771,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.11,"originalCredits":0.11,"afterCompact":false},{"index":127,"time":"15:54","ratio":0.200505,"inputTokens":40101,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.117,"originalCredits":0.117,"afterCompact":false},{"index":128,"time":"15:55","ratio":0.203305,"inputTokens":40661,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.16,"originalCredits":0.16,"afterCompact":false},{"index":129,"time":"17:43","ratio":0.20923,"inputTokens":41846,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.207,"originalCredits":1.207,"afterCompact":false},{"index":130,"time":"17:43","ratio":0.224885,"inputTokens":44977,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.294,"originalCredits":0.294,"afterCompact":false},{"index":131,"time":"17:44","ratio":0.242945,"inputTokens":48589,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.243,"originalCredits":0.243,"afterCompact":false},{"index":132,"time":"17:46","ratio":0.247065,"inputTokens":49413,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.14,"originalCredits":0.14,"afterCompact":false},{"index":133,"time":"17:47","ratio":0.24793,"inputTokens":49586,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.305,"originalCredits":0.305,"afterCompact":false},{"index":134,"time":"17:47","ratio":0.269935,"inputTokens":53987,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.363,"originalCredits":0.363,"afterCompact":false},{"index":135,"time":"17:47","ratio":0.28308,"inputTokens":56616,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.218,"originalCredits":0.218,"afterCompact":false},{"index":136,"time":"17:47","ratio":0.285465,"inputTokens":57093,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.178,"originalCredits":0.178,"afterCompact":false},{"index":137,"time":"17:48","ratio":0.289055,"inputTokens":57811,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.182,"originalCredits":0.182,"afterCompact":false},{"index":138,"time":"17:48","ratio":0.29231,"inputTokens":58462,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.161,"originalCredits":0.161,"afterCompact":false},{"index":139,"time":"17:48","ratio":0.29378,"inputTokens":58756,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.141,"originalCredits":0.141,"afterCompact":false},{"index":140,"time":"17:48","ratio":0.29478,"inputTokens":58956,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.152,"originalCredits":0.152,"afterCompact":false},{"index":141,"time":"17:48","ratio":0.29633,"inputTokens":59266,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.144,"originalCredits":0.144,"afterCompact":false},{"index":142,"time":"17:48","ratio":0.29753,"inputTokens":59506,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.151,"originalCredits":0.151,"afterCompact":false},{"index":143,"time":"17:48","ratio":0.299515,"inputTokens":59903,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.177,"originalCredits":0.177,"afterCompact":false},{"index":144,"time":"17:48","ratio":0.302455,"inputTokens":60491,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.184,"originalCredits":0.184,"afterCompact":false},{"index":145,"time":"17:49","ratio":0.30654,"inputTokens":61308,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.253,"originalCredits":0.253,"afterCompact":false},{"index":146,"time":"17:49","ratio":0.314785,"inputTokens":62957,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.194,"originalCredits":0.194,"afterCompact":false},{"index":147,"time":"17:49","ratio":0.316135,"inputTokens":63227,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.157,"originalCredits":0.157,"afterCompact":false},{"index":148,"time":"17:51","ratio":0.317505,"inputTokens":63501,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.174,"originalCredits":0.174,"afterCompact":false},{"index":149,"time":"17:51","ratio":0.319995,"inputTokens":63999,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.224,"originalCredits":0.224,"afterCompact":false},{"index":150,"time":"17:52","ratio":0.326235,"inputTokens":65247,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.22,"originalCredits":0.22,"afterCompact":false},{"index":151,"time":"17:52","ratio":0.333525,"inputTokens":66705,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.292,"originalCredits":0.292,"afterCompact":false},{"index":152,"time":"17:52","ratio":0.342725,"inputTokens":68545,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.226,"originalCredits":0.226,"afterCompact":false},{"index":153,"time":"17:52","ratio":0.345245,"inputTokens":69049,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.183,"originalCredits":0.183,"afterCompact":false},{"index":154,"time":"17:52","ratio":0.34736,"inputTokens":69472,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.173,"originalCredits":0.173,"afterCompact":false},{"index":155,"time":"17:53","ratio":0.348795,"inputTokens":69759,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.222,"originalCredits":0.222,"afterCompact":false},{"index":156,"time":"17:53","ratio":0.35611,"inputTokens":71222,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.237,"originalCredits":0.237,"afterCompact":false},{"index":157,"time":"17:54","ratio":0.36172,"inputTokens":72344,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.39,"originalCredits":0.39,"afterCompact":false},{"index":158,"time":"17:54","ratio":0.37873,"inputTokens":75746,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.27,"originalCredits":0.27,"afterCompact":false},{"index":159,"time":"17:54","ratio":0.38025,"inputTokens":76050,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.191,"originalCredits":0.191,"afterCompact":false},{"index":160,"time":"17:54","ratio":0.382535,"inputTokens":76507,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.215,"originalCredits":0.215,"afterCompact":false},{"index":161,"time":"17:54","ratio":0.38562,"inputTokens":77124,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.207,"originalCredits":0.207,"afterCompact":false},{"index":162,"time":"17:55","ratio":0.388195,"inputTokens":77639,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.216,"originalCredits":0.216,"afterCompact":false},{"index":163,"time":"17:55","ratio":0.391655,"inputTokens":78331,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.237,"originalCredits":0.237,"afterCompact":false},{"index":164,"time":"17:55","ratio":0.397065,"inputTokens":79413,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.214,"originalCredits":0.214,"afterCompact":false},{"index":165,"time":"17:55","ratio":0.39829,"inputTokens":79658,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.196,"originalCredits":0.196,"afterCompact":false},{"index":166,"time":"17:55","ratio":0.401265,"inputTokens":80253,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.216,"originalCredits":0.216,"afterCompact":false},{"index":167,"time":"17:56","ratio":0.40357,"inputTokens":80714,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.272,"originalCredits":0.272,"afterCompact":false},{"index":168,"time":"17:56","ratio":0.41058,"inputTokens":82116,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.228,"originalCredits":0.228,"afterCompact":false},{"index":169,"time":"17:56","ratio":0.415195,"inputTokens":83039,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.24,"originalCredits":0.24,"afterCompact":false},{"index":170,"time":"17:56","ratio":0.419665,"inputTokens":83933,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.227,"originalCredits":0.227,"afterCompact":false},{"index":171,"time":"17:56","ratio":0.42333,"inputTokens":84666,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.214,"originalCredits":0.214,"afterCompact":false},{"index":172,"time":"17:56","ratio":0.42512,"inputTokens":85024,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.218,"originalCredits":0.218,"afterCompact":false},{"index":173,"time":"17:57","ratio":0.429725,"inputTokens":85945,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.27,"originalCredits":0.27,"afterCompact":false},{"index":174,"time":"17:57","ratio":0.43467,"inputTokens":86934,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.238,"originalCredits":0.238,"afterCompact":false},{"index":175,"time":"17:57","ratio":0.43684,"inputTokens":87368,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.264,"originalCredits":0.264,"afterCompact":false},{"index":176,"time":"03:05","ratio":0.442135,"inputTokens":88427,"outputTokens":null,"usageSource":"transcript-ratio","credits":2.474,"originalCredits":2.474,"afterCompact":false},{"index":177,"time":"03:05","ratio":0.444035,"inputTokens":88807,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.225,"originalCredits":0.225,"afterCompact":false},{"index":178,"time":"03:05","ratio":0.446365,"inputTokens":89273,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.225,"originalCredits":0.225,"afterCompact":false},{"index":179,"time":"03:05","ratio":0.448225,"inputTokens":89645,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.22,"originalCredits":0.22,"afterCompact":false},{"index":180,"time":"03:05","ratio":0.44941,"inputTokens":89882,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.226,"originalCredits":0.226,"afterCompact":false},{"index":181,"time":"03:07","ratio":0.451145,"inputTokens":90229,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.222,"originalCredits":0.222,"afterCompact":false},{"index":182,"time":"03:07","ratio":0.45723,"inputTokens":91446,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.242,"originalCredits":0.242,"afterCompact":false},{"index":183,"time":"03:07","ratio":0.460545,"inputTokens":92109,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.264,"originalCredits":0.264,"afterCompact":false},{"index":184,"time":"03:08","ratio":0.46448,"inputTokens":92896,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.255,"originalCredits":0.255,"afterCompact":false},{"index":185,"time":"03:08","ratio":0.46797,"inputTokens":93594,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.264,"originalCredits":0.264,"afterCompact":false},{"index":186,"time":"03:09","ratio":0.47157,"inputTokens":94314,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.249,"originalCredits":0.249,"afterCompact":false},{"index":187,"time":"03:09","ratio":0.474265,"inputTokens":94853,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.246,"originalCredits":0.246,"afterCompact":false},{"index":188,"time":"03:09","ratio":0.47634,"inputTokens":95268,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.245,"originalCredits":0.245,"afterCompact":false},{"index":189,"time":"03:09","ratio":0.478635,"inputTokens":95727,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.31,"originalCredits":0.31,"afterCompact":false},{"index":190,"time":"03:11","ratio":0.48652,"inputTokens":97304,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.306,"originalCredits":0.306,"afterCompact":false},{"index":191,"time":"03:11","ratio":0.492155,"inputTokens":98431,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.274,"originalCredits":0.274,"afterCompact":false},{"index":192,"time":"03:11","ratio":0.496315,"inputTokens":99263,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.259,"originalCredits":0.259,"afterCompact":false},{"index":193,"time":"03:11","ratio":0.50004,"inputTokens":100008,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.259,"originalCredits":0.259,"afterCompact":false},{"index":194,"time":"03:11","ratio":0.50167,"inputTokens":100334,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.279,"originalCredits":0.279,"afterCompact":false},{"index":195,"time":"03:28","ratio":0.50573,"inputTokens":101146,"outputTokens":null,"usageSource":"transcript-ratio","credits":2.922,"originalCredits":2.922,"afterCompact":false},{"index":196,"time":"03:28","ratio":0.516405,"inputTokens":103281,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.318,"originalCredits":0.318,"afterCompact":false},{"index":197,"time":"03:28","ratio":0.519445,"inputTokens":103889,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.295,"originalCredits":0.295,"afterCompact":false},{"index":198,"time":"03:28","ratio":0.52422,"inputTokens":104844,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.282,"originalCredits":0.282,"afterCompact":false},{"index":199,"time":"03:29","ratio":0.52847,"inputTokens":105694,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.289,"originalCredits":0.289,"afterCompact":false},{"index":200,"time":"03:29","ratio":0.536875,"inputTokens":107375,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.309,"originalCredits":0.309,"afterCompact":false},{"index":201,"time":"03:29","ratio":0.5395,"inputTokens":107900,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.293,"originalCredits":0.293,"afterCompact":false},{"index":202,"time":"03:29","ratio":0.54313,"inputTokens":108626,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.278,"originalCredits":0.278,"afterCompact":false},{"index":203,"time":"03:30","ratio":0.54521,"inputTokens":109042,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.283,"originalCredits":0.283,"afterCompact":false},{"index":204,"time":"21:12","ratio":0.26224,"inputTokens":52448,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.791,"originalCredits":1.791,"afterCompact":false},{"index":205,"time":"21:12","ratio":0.263115,"inputTokens":52623,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.55,"originalCredits":0.55,"afterCompact":false},{"index":206,"time":"21:12","ratio":0.263462,"inputTokens":52693,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.547,"originalCredits":0.547,"afterCompact":false},{"index":207,"time":"21:13","ratio":0.263725,"inputTokens":52745,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.552,"originalCredits":0.552,"afterCompact":false},{"index":208,"time":"21:13","ratio":0.264502,"inputTokens":52900,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.56,"originalCredits":0.56,"afterCompact":false},{"index":209,"time":"21:14","ratio":0.26514,"inputTokens":53028,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.549,"originalCredits":0.549,"afterCompact":false},{"index":210,"time":"21:14","ratio":0.265398,"inputTokens":53080,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.566,"originalCredits":0.566,"afterCompact":false},{"index":211,"time":"21:15","ratio":0.266475,"inputTokens":53295,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.566,"originalCredits":0.566,"afterCompact":false}],"identity":{"sumAttributed":19692025,"billedInputTokens":19692025,"absDiff":0,"ok":true},"pluginVersion":"2.7.4","selfCmd":"\"C:\\Users\\Administrator\\.qoder-cn\\plugins\\cache\\qoder-marketplace\\qoder-credits-inspector\\2.7.4\\bin\\credits-inspector.cmd\" cli","linkHealth":{"matched":0,"requests":211,"coverage":0,"usageSource":"transcript-ratio","breakdown":{"proxy":0,"transcriptTokens":0,"transcriptRatio":211},"logRecords":0,"lastRecordAt":null,"recentRequests":0,"proxyErrors":null,"clientAbort":null,"clientAbortMaxMs":null,"upstreamRejected":null,"aborted":null,"truncated":null,"noUsage":null,"slowestMs":null,"supersededFailure":null},"subagents":{"scanned":false,"dir":null,"probedPaths":["C:\\Users\\Administrator\\.qoder-cn\\projects\\D--AA-project----\\65324523-7cef-42e4-a96e-def5ed6a42c6\\subagents","C:\\Users\\Administrator\\.qoder-cn\\projects\\65324523-7cef-42e4-a96e-def5ed6a42c6\\subagents"],"reason":"no-dir","count":0,"items":[],"totals":{"roundTrips":0,"billedInputTokens":0,"credits":0,"originalCredits":0},"combined":{"roundTrips":211,"billedInputTokens":19692025,"credits":69.403,"originalCredits":69.403}},"manual":null,"artifacts":{"report":"report.json","canvas":"# 远程 Linux 服务器临时执行权限（供 A__65324523.canvas.tsx"}} as unknown as Report;

function human(n: number): string {
  if (!isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

function pct(x: number): string {
  return (x * 100).toFixed(1) + "%";
}

// —— 可用性口径：把 report.availability 翻成人话，并决定某个数字该显示值、「≈」还是「—」——
const AVAIL_LABEL: Record<string, string> = {
  measured: "实测",
  derived: "推导",
  fallback: "回退",
  manual: "手工",
  unavailable: "不可用",
};

const SOURCE_LABEL: Record<string, string> = {
  "desktop-rich": "桌面端富转录",
  "ide-lite": "IDE 端精简转录",
  unknown: "来源未知",
};

function availOf(av: Availability | undefined, key: keyof Availability, dflt: Avail = "measured"): Avail {
  return (av?.[key] as Avail | undefined) ?? dflt;
}

/** 段标题旁的性质标注：实测不标（默认就是实测），其余标出来。 */
function availTag(av: Availability | undefined, key: keyof Availability, dflt: Avail = "measured"): string {
  const v = availOf(av, key, dflt);
  return v === "measured" ? "" : `（${AVAIL_LABEL[v]}）`;
}

/** 不可用的量显示「—」而不是 0：IDE 端的 0 是「读不到」，不是「没发生」。 */
function orDash(
  v: number,
  av: Availability | undefined,
  key: keyof Availability,
  fmt: (n: number) => string = String
): string {
  return availOf(av, key) === "unavailable" ? "—" : fmt(v);
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "read":
      return "读取";
    case "write":
      return "写入";
    case "search":
      return "搜索";
    case "shell":
      return "命令";
    default:
      return "其他";
  }
}

function shortTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function SessionTokensReport() {
  if (!REPORT) {
    return (
      <ReportShell width="wide" ariaLabel="会话 token 消耗截析">
        <Stack gap="component">
          <H1>会话 token 消耗截析</H1>
          <Text tone="secondary">报告数据尚未注入。请在会话中触发一次 Stop 钩子，或运行 CLI 生成 report.json。</Text>
        </Stack>
      </ReportShell>
    );
  }

  const r = REPORT;
  const s = r.session;
  const c = r.context;
  const t = r.totals;
  const av = r.availability;
  const manual = r.manual ?? null;
  const sourceLabel = SOURCE_LABEL[r.source ?? "unknown"] ?? "来源未知";
  // 有没有 usage 决定整份报告是「真值/推导」还是「一律 —」。手工回填的 credits 不算有 usage，
  // 否则下面按 ratio 推导的图表会照画一堆 0。
  const hasUsage = availOf(av, "roundTrips") === "measured";
  const manualCredits = manual?.credits ?? null;

  // 报告里出现的命令一律用数据层注入的插件入口（Windows 上是自带启动器的绝对路径，免装 Node）。
  // 旧报告没有这个字段时回退原写法，不比改动前更差。
  const CLI = r.selfCmd || "node scripts/cli.mjs";

  // credits 覆盖范围：credits 与「计费输入总量」并排放在头部，读者一除就得到单价。
  // 混合会话里 credits 只来自转录路径的那几笔（实测某会话 413 笔里只有 1 笔带 credits），
  // 部分覆盖不说出来 = 把局部真值当全量展示。
  const cov = r.creditsCoverage ?? null;
  const covPartial = !!(cov && !cov.full && cov.roundTrips > 0);
  const covNote = covPartial ? ` · 仅覆盖 ${cov!.trips}/${cov!.roundTrips} 笔往返（占计费输入 ${pct(cov!.tokenShare)}）` : "";

  // 缓存命中：代理记录里一直带着 cachedTokens，此前采集了却从不呈现。
  const cachedMeasured = availOf(av, "cachedTokens") === "measured";
  const cachedText = cachedMeasured
    ? `输入 ${human(t.billedInputTokens)}，其中缓存命中 ${human(t.cachedTokens ?? 0)}（${pct(t.cachedShare ?? 0)}，${t.cachedTrips ?? 0} 笔往返带缓存）——供应商对重复叠加的前缀打折，故按 token 数的节省大于按计费的节省。`
    : "";

  // 代理告警只在「失败记录仍然成立」时才报：status.json 只写不清，陈旧失败会把用户推去改
  // 本来正确的 Base URL，越修越坏；而同一份报告里的 lastRecordAt / matched 是它在跑的硬证据。
  const proxyAlarm = r.proxy?.status && !r.proxy.statusSuperseded ? r.proxy.status : null;
  const proxyAlive = !proxyAlarm && (r.proxy?.logRecords ?? 0) > 0;

  // 官方 UI 一场会话扣费 = 主链 + 子代理，故有子代理时 headline 必须给 combined，否则比 UI 少一截
  const creditScope =
    r.subagents && r.subagents.count > 0
      ? {
          credits: r.subagents.combined.credits,
          note: `主链 ${t.credits} + 子代理 ${r.subagents.totals.credits} · 原始 ${r.subagents.combined.originalCredits}`,
        }
      : { credits: t.credits, note: `原始 ${t.originalCredits}（实测）` };

  const headline: MetricItem[] = [
    {
      label: "计费输入总量",
      value: hasUsage ? human(t.billedInputTokens) : "—",
      description: hasUsage
        ? availOf(av, "tokens") === "measured"
          ? `Σ prompt_tokens（实测真值）${covPartial ? ` · 覆盖全部 ${cov!.roundTrips} 笔往返` : ""}`
          : `Σ 上下文 × 往返${availTag(av, "tokens", "derived")}${covPartial ? ` · 覆盖全部 ${cov!.roundTrips} 笔往返` : ""}`
        : "转录无 usage",
    },
    {
      label: "当前上下文",
      value: hasUsage ? human(t.netContextTokens) : "—",
      description: hasUsage
        ? `峰值 ${pct(c.peakContextRatio)}${s.compactions ? "（压缩后起算）" : ""}`
        : "转录无 usage",
    },
    {
      label: "重发放大",
      value: hasUsage ? `${t.amplification}×` : "—",
      description: `往返 ${hasUsage ? `${s.roundTrips} 次` : "—"}`,
    },
    {
      label: "Credits",
      // 代理路径（自定义模型）token 是实测真值但 credits 无来源：hasUsage 为真也要显示「—」，
      // 否则 t.credits=0 会被读成「这次没花钱」。
      value:
        manualCredits != null
          ? `${manualCredits}`
          : hasUsage && availOf(av, "credits") !== "unavailable"
            ? `${creditScope.credits}`
            : "—",
      description:
        manualCredits != null
          ? `官方 UI 手工录入 · 本地 ${creditScope.credits}`
          : hasUsage && availOf(av, "credits") !== "unavailable"
            ? `${creditScope.note}${covNote}`
            : r.usageSource === "proxy" || r.usageSource === "transcript-tokens" || r.usageSource === "mixed"
              ? "自定义模型（BYOK）不经 Qoder 计费网关，无 credits 真值"
              : hasUsage
                ? "转录带 usage 但没有 credits 字段，本地无计费真值"
                : "本地不可用，见下方告警",
    },
  ];

  const pieData = r.byCategory.map((x) => ({ label: x.label, value: x.tokens }));

  // 系统提示词是报告里少数「用户能直接动」的一项：它每轮被完整重发，总量 = 每请求规模 × 往返数，
  // 而它的大小由装了多少插件与技能决定。占比小时不必啰嗦。
  const sysCat = r.byCategory.find((x) => x.key === "system");
  const sysNote =
    hasUsage && sysCat && sysCat.share >= 0.1
      ? ` 系统提示词占 ${pct(sysCat.share)}（${human(c.systemPromptTokens)}/请求 × ${s.roundTrips} 次往返 = ${human(sysCat.tokens)}）：它每轮都被完整重发，大小由你装了多少插件与技能决定，精简技能能直接压低这一项——本插件自己的技能描述也常驻在里面（约 170 token）。`
      : "";

  const tools = r.byTool.slice(0, 8);
  const toolCategories = tools.map((x) => x.tool);
  const toolSeries = [{ name: "重发 tokens", data: tools.map((x) => x.tokens) }];
  // 「单次」= 平均每次调用带来的重发 token。总量榜会埋掉次数少但每次极贵的工具：
  // 实测 Read 只 29 次却吃 335 万，单次是 Edit 的 2.6 倍。
  const toolRows = tools.map((x) => [
    x.tool,
    human(x.tokens),
    pct(x.share),
    String(x.calls),
    x.perCall == null ? "—" : human(x.perCall),
  ]);

  const files = r.byFile.slice(0, 20);
  const fileRows = files.map((f) => [
    f.label,
    kindLabel(f.kind),
    human(f.billed),
    pct(f.share),
    f.perRead == null ? "—" : human(f.perRead),
    String(f.trips),
    String(f.reads),
  ]);

  const byReq = r.byRequest ?? [];
  const reqLabels = byReq.map((x, i) => x.time || `#${x.index ?? i + 1}`);
  const reqInputs = byReq.map((x) => x.inputTokens);
  const reqCredits = byReq.map((x) => x.credits);
  // credits 只在覆盖全部往返时才画曲线：部分覆盖（BYOK 混合会话实测 413 笔里 1 笔有 credits）
  // 画出来是一地零，既读不出形状，还会暗示「其余往返没花钱」。
  const showCreditsChart = hasUsage && !covPartial && availOf(av, "credits") !== "unavailable";

  // 按类别下钻：类别小计行（accent/neutral）+ 其工具/文件明细行（default），用 rowTone 分组着色。
  const catDetail = r.byCategoryDetail ?? [];
  const detailRows: string[][] = [];
  const detailTones: ("accent" | "neutral" | "default")[] = [];
  for (const cc of catDetail) {
    const hasKids = cc.children.length > 0;
    detailRows.push([cc.label, "—", hasKids ? "小计" : "（整体，无工具/文件归属）", human(cc.tokens), pct(cc.share), "100%", "—"]);
    detailTones.push(hasKids ? "accent" : "neutral");
    for (const k of cc.children) {
      detailRows.push(["", k.tool || "—", k.label, human(k.tokens), pct(k.share), pct(k.catShare), String(k.trips)]);
      detailTones.push("default");
    }
  }

  // 子代理账：Agent 派发的子代理消耗不在主链里，单独一段呈现（无子代理则整段不渲染）。
  const sub = r.subagents;
  const subItems = sub?.items ?? [];
  const subRows: string[][] = [];
  const subTones: ("accent" | "default")[] = [];
  for (const a of subItems) {
    subRows.push([
      a.description || a.agentId,
      a.agentType || "—",
      String(a.roundTrips),
      human(a.billedInputTokens),
      pct(a.peakContextRatio),
      String(a.credits),
      String(a.originalCredits),
      a.error || "—",
    ]);
    subTones.push("default");
  }
  if (sub && subItems.length > 0) {
    subRows.push([
      "合计（主链 + 子代理）",
      "—",
      String(sub.combined.roundTrips),
      human(sub.combined.billedInputTokens),
      "—",
      String(sub.combined.credits),
      String(sub.combined.originalCredits),
      `主链 ${t.credits} / 子代理 ${sub.totals.credits}`,
    ]);
    subTones.push("accent");
  }

  // 压缩单笔成本：输入/摘要一律取数据层归一后的生效值（有代理实测就是实测，否则是客户端自估），
  // 并用「口径」列把两者分开——混着显示会让自估值被当成实测。
  const ccost = r.compactionCost;
  const ccItems = ccost?.items ?? [];
  const compactRows: string[][] = ccItems.map((e) => [
    `#${e.index}`,
    shortTime(e.at),
    e.trigger || "—",
    e.effectiveInputTokens == null ? "—" : human(e.effectiveInputTokens),
    e.effectiveOutputTokens == null ? "—" : human(e.effectiveOutputTokens),
    e.nextInputTokens == null ? "—" : human(e.nextInputTokens),
    e.savedTokens == null ? "—" : human(e.savedTokens),
    e.proxy && e.proxy.ms != null ? `${Math.round(e.proxy.ms / 1000)}s` : "—",
    e.proxy ? "实测" : "自估",
  ]);

  // IDE 端仅剩的真值：工具调用次数与文件读取次数（不依赖 usage，两种转录都写 tool_use 块）。
  const residueRows: string[][] = [];
  if (!hasUsage) {
    for (const x of r.byTool.filter((v) => v.calls > 0).sort((a, b) => b.calls - a.calls).slice(0, 15)) {
      residueRows.push([x.tool, "工具", String(x.calls), "—", "—"]);
    }
    for (const f of r.byFile.filter((v) => v.reads > 0).sort((a, b) => b.reads - a.reads).slice(0, 15)) {
      residueRows.push([f.label, kindLabel(f.kind), "—", String(f.reads), String(f.trips)]);
    }
  }

  // A1 三值：一次带 usage 的往返都没有时 0 <= max(2,0) 恒成立，会把「没数据」判成「校验通过」，
  // 故 breakdown.mjs 在 reqCount===0 时给 null；这里必须显示「不适用」而不是绿色通过。
  const identityText =
    r.identity.ok == null
      ? "恒等式 A1 不适用（本转录没有一次带 usage 的往返）。"
      : r.identity.ok
        ? `归因覆盖 ${pct(t.coverage)}${availTag(av, "categoryShare", "derived")}，恒等式 A1 通过（|Δ|=${r.identity.absDiff}）。`
        : `归因覆盖 ${pct(t.coverage)}，恒等式 A1 未通过（|Δ|=${r.identity.absDiff}）。`;
  // 窗口读不到时是静默回退的 200000，而所有 token 数字都乘它 —— 必须显式标 ≈ 与来源。
  const cwIsFallback = availOf(av, "contextWindow") === "fallback";
  const cwText = cwIsFallback ? `≈${human(c.contextWindow)}（回退值）` : human(c.contextWindow);
  // 当前占用头条：以最新上下文（currentContextTokens）为准；段内单调递增 ⇒ 旧版峰值与当前恒等，故合并为一条。
  const curCtx = c.currentContextTokens ?? c.peakContextTokens;
  const netAdv = c.netUserAdvice || c.peakUserAdvice || c.peakAdvice || null;
  const limitSrcLabel =
    c.userContextLimitSource === "manual" ? "手工"
    : c.userContextLimitSource === "config" ? "配置"
    : c.userContextLimitSource === "derived" ? "实测反推"
    : "默认";
  // 阈值来源非 manual/config/derived ⇒ 用的是内置兜底 200K，不是用户在 Qoder 设的真值，需显式提示如何改。
  const limitIsDefault = c.userContextLimitSource !== "manual" && c.userContextLimitSource !== "config" && c.userContextLimitSource !== "derived";
  // 上下文对比表：把旧版挤成一段小字的「界面显示 / 自动压缩实况 / 历史高点」拆成可扫读的行，无数据不占位。
  const ctxRows: string[][] = [];
  if (c.userContextLimit != null && Number.isFinite(c.contextWindow)) {
    ctxRows.push(
      c.contextWindow > c.userContextLimit
        ? ["Qoder 界面进度条", pct(c.netWindowRatio ?? c.peakContextRatio), `按模型物理窗口 ${cwText} 算，比你真实占比低约 ${(c.contextWindow / c.userContextLimit).toFixed(1)} 倍——界面显得偏空、有迷惑性，别信它`]
        : ["Qoder 界面进度条", pct(c.netWindowRatio ?? c.peakContextRatio), `按模型窗口 ${cwText} 算，与你实设上限一致，显示无偏差`],
    );
  }
  if (c.observedAutoCompactions != null && c.observedAutoCompactions > 0 && c.observedAutoTriggerTokens != null) {
    ctxRows.push(["自动压缩实况", `自动 ${c.observedAutoCompactions} 次`, `触发点在 ~${human(c.observedAutoTriggerTokens)}（窗口的 ${pct(c.autoTriggerRatio ?? 0)}）`]);
  } else if (s.compactions > 0) {
    ctxRows.push(["压缩实况", `手动 ${s.compactions} 次`, "本场未见自动压缩，均为你手动触发"]);
  }
  if (c.peakSessionNotable) {
    ctxRows.push(["压缩前历史高点", `${pct(c.peakSessionRatio ?? 0)}（${human(c.peakSessionTokens ?? 0)}）`, "本场曾达到的最高占用"]);
  }

  // 链路健康度：把 --request-log 的逐笔归因压成一行结论（明细属于排障，留在 CLI）。
  // 分两档：本会话确实走在代理链路上（proxy/mixed）才印「最近 N 笔」的失败统计与排障命令；
  // token 全来自转录的会话里，那些统计说的是别的会话，印成 warning + 命令是噪音，只留覆盖率与最近记录时间。
  // 纯官方模型用户从没配过代理，整行不渲染。
  const lhRaw = r.linkHealth ?? null;
  const lh = lhRaw && (r.proxy?.configured || lhRaw.matched > 0) ? lhRaw : null;
  const lhOnPath = !!lh && (lh.matched > 0 || lh.usageSource === "proxy" || lh.usageSource === "mixed");
  const lhErrors = lh ? lh.proxyErrors ?? 0 : 0;
  const lhBad = lhOnPath && lhErrors > 0;
  const lhTone: "info" | "warning" = lhBad ? "warning" : "info";
  // 三档拆分一行说清：代理实测 / 转录 input_tokens / 转录 ratio×window 各多少笔。
  // 旧报告（v3）无 breakdown 字段时退回到只报 matched。
  const lhBd = lh?.breakdown ?? null;
  const lhBdText = lhBd
    ? `拆分：代理 ${lhBd.proxy} 笔 · 转录 input_tokens ${lhBd.transcriptTokens} 笔 · 转录 ratio×窗口 ${lhBd.transcriptRatio} 笔`
    : "";
  const lhSrcNote = !lh
    ? ""
    : lh.usageSource === "proxy"
      ? "：全部为供应商实测"
      : lh.usageSource === "transcript-tokens"
        ? "：本会话 token 全来自转录 input_tokens（BYOK，代理未在链路上）"
        : lh.usageSource === "transcript-ratio"
          ? "：本会话 token 由 ratio×窗口推导（官方模型）"
          : lh.usageSource === "mixed"
            ? "：多源混合，以下拆分列为准"
            : lh.usageSource === "transcript"
              ? "：本会话 token 全部来自转录，代理不在链路上"
              : "";
  const lhText = !lh
    ? ""
    : [
        lh.requests > 0
          ? `代理覆盖 ${lh.matched}/${lh.requests} 笔往返（${pct(lh.coverage)}）${lhSrcNote}`
          : "本会话没有带 usage 的往返，代理无从覆盖",
        lhBdText,
        lh.lastRecordAt ? `代理最近记录 ${shortTime(lh.lastRecordAt)}` : proxyAlive ? "代理有记录但无时间戳" : "代理从未记到流量",
        lhOnPath && lh.recentRequests
          ? `最近 ${lh.recentRequests} 笔：代理失败 ${lh.proxyErrors} · 上游报错 ${lh.upstreamRejected} · 客户端提前断开 ${lh.aborted} · 成功但无 usage ${lh.noUsage}${
              lh.slowestMs != null ? ` · 最慢 ${Math.round(lh.slowestMs / 1000)}s` : ""
            }`
          : lhOnPath
            ? "请求诊断日志为空（运行中的代理是旧版，或还没记到）"
            : "",
        lhBad ? `有「代理失败」= 请求没出得去或代理自己抛了，跑 ${CLI} --request-log 看归因` : "",
        !lhOnPath && lhErrors > 0 ? `代理另有 ${lhErrors} 笔失败，属于走代理的那些会话` : "",
        lh.supersededFailure
          ? `${shortTime(lh.supersededFailure.at ?? null)} 那条「拉起失败（${lh.supersededFailure.error}）」已被之后的流量推翻，无需处理`
          : "",
      ]
        .filter(Boolean)
        .join("。") + "。";

  return (
    <ReportShell width="wide" ariaLabel="会话 token 消耗截析">
      <Stack gap="sectionCompact">
        <header>
          <Stack gap="component">
            <H1>会话 token 消耗截析</H1>
            <Text tone="secondary">
              {s.model || "未知模型"}
              {s.modelSource === "manual" ? "（手工录入）" : ""} · {sourceLabel} · 会话{" "}
              {String(s.id || "").slice(0, 8)}
              {s.title ? `「${s.title}」` : ""} · {shortTime(s.startedAt)} →{" "}
              {shortTime(s.endedAt)} · 压缩{" "}
              {availOf(av, "compactions") === "unavailable" ? "—" : `${s.compactions} 次`}
              {r.usageSource ? ` · usage 来源 ${
                r.usageSource === "proxy"
                  ? "代理实测"
                  : r.usageSource === "transcript-tokens"
                    ? "转录 input_tokens"
                    : r.usageSource === "transcript-ratio"
                      ? "转录 ratio×窗口"
                      : r.usageSource === "mixed"
                        ? "多源混合"
                        : "转录"
              }` : ""}
              {r.pluginVersion ? ` · v${r.pluginVersion}` : ""} · schema v{r.schemaVersion}
            </Text>
            <MetricsGrid variant="header" columns={4} items={headline} />
          </Stack>
        </header>

        {!hasUsage && r.source === "desktop-rich" && (
          <Callout tone="danger" title="本报告数值不可用：自定义模型（BYOK）不经 Qoder 计费网关">
            转录是桌面端富布局，但 assistant entry 里没有 message.usage——自定义模型（如千问
            tokenplan）的响应不经 Qoder 计费网关，credits / context_usage_ratio 无来源，提供商返回的
            usage 客户端也不落盘（已实测扫过 ~/.qoder-cn、~/.qoder、~/.qoder-cli 与 %APPDATA%\QoderCN）。
            本地补救（改一个配置文件即可，免装 Node、之后全自动）：编辑 {"`~/.qoder-credits-proxy/config.json`"}，
            把 {"`upstream`"} 填成你的供应商根地址（= Base URL 去掉结尾 /v1），再把自定义模型 Base URL 的 host:port
            换成 {`127.0.0.1:${r.proxy?.port ?? 49787}`}（路径保留），新开一个会话即自动拉起代理、按 message.id
            精确 join 出实测 token（credits 仍无真值）。装了 Node 也可用 {"`--setup-proxy`"} / {"`--check-proxy`"} 一步到位。
            手工回填通道同样可用：
            {"`.qoder-credits/overrides/<sessionId>.json`"}。
          </Callout>
        )}

        {!hasUsage && r.source !== "desktop-rich" && (
          <Callout tone="danger" title="本报告数值不可用：转录不含 message.usage">
            这是 {sourceLabel}（IDE 端客户端）。它的转录只写 session_meta / user / assistant / progress 四种 entry，
            message.usage 整个字段不存在，也不落到本地任何其它文件（已实测扫过 ~/.qoder-cn、~/.qoder、
            ~/.qoder-cli 与 %APPDATA%\QoderCN）。因此 Credits、token 与各类占比一律显示「—」而不是 0 ——
            0 会被误读成「这次没花钱」。真值只有官方 UI 有：把它填进{" "}
            {"`.qoder-credits/overrides/<sessionId>.json`"} 后重跑，上方会出现「官方 UI 真值」一段并与本地并列对账。
          </Callout>
        )}

        {manual && (
          <Callout tone="success" title="官方 UI 真值（手工录入，未覆盖任何本地数字）">
            Credits {manual.credits ?? "—"} · 原价 {manual.originalCredits ?? "—"}
            {manual.model ? ` · 模型 ${manual.model}` : ""}
            {manual.durationMin != null ? ` · 时长 ${manual.durationMin} min` : ""}
            {manual.startedAt ? ` · ${shortTime(manual.startedAt)}` : ""}
            {manual.localCoverage != null
              ? ` · 本地${manual.localScope === "combined" ? "合计（主链+子代理）" : "主链"} ${manual.localCredits ?? t.credits}，覆盖 ${pct(manual.localCoverage)}`
              : " · 本地无 usage，无法对账"}
            {manual.note ? `。备注：${manual.note}` : ""}
          </Callout>
        )}

        {sub && sub.count === 0 && sub.reason && sub.reason !== "no-dir" && (
          <Callout tone="warning" title={`子代理账未汇总（${sub.reason}）`}>
            探测过的候选目录：{(sub.probedPaths ?? []).join("  |  ") || "（无）"}
          </Callout>
        )}

        {proxyAlarm && (
          <Callout tone="warning" title={`代理自动启动失败（${proxyAlarm.error}）`}>
            {proxyAlarm.error === "EADDRINUSE"
              ? `端口 ${proxyAlarm.port ?? "—"} 被占用，自定义模型将无法对话。请换一个空闲端口重启代理：${CLI} --setup-proxy --port <新端口>，并把模型 Base URL 改成新端口。`
              : `代理未就绪（${proxyAlarm.error}），自定义模型可能无法对话。请运行 ${CLI} --check-proxy 查看链路状态。`}
          </Callout>
        )}

        {r.proxy?.dormant && !proxyAlarm && (
          <Callout tone="info" title="代理长期空闲">
            代理已配置但超过 14 天没有记录到流量（可能你已改回官方模型）。如不再使用自定义模型，可运行{" "}
            {CLI} --stop-proxy 停用代理；保留也不影响官方模型。
          </Callout>
        )}

        {cwIsFallback && (
          <Callout tone="warning" title="上下文窗口为回退值 200K（未从 runtime-config / usage 反推 / ManualTruth 拿到真值）">
            本会话所有以窗口为分母的占比与「峰值建议」都可能偏大，而绝对 token 数（已改以 S 真值为底）不受影响。
            建议在 {"`.qoder-credits/overrides/<sessionId>.json`"} 里手工填 {"`contextWindow`"}（如 qwen3-max=1000000），或等一笔带 input_tokens+ratio 的往返写入转录后自动反推生效。
          </Callout>
        )}

        {hasUsage && netAdv && c.userContextLimit != null && (
          <Stack gap="component">
            <Callout
              tone={netAdv.tone}
              title={`你真实的上下文占用 ${pct(c.netUserRatio ?? c.peakUserRatio ?? 0)}（${human(curCtx)} / 阈值 ${human(c.userContextLimit)}・${limitSrcLabel}）`}
            >
              {netAdv.text}
              {limitIsDefault && (
                <Text tone="secondary">
                  {` ⚙ 这里的 ${human(c.userContextLimit)} 是插件内置默认值，不是你在 Qoder「模型管理」里设的真实上限（插件读不到那个设置）。想按真实阈值算：在 ~/.qoder-credits-proxy/config.json 填 "userContextLimit": <你的上限>（对所有会话生效），或对本会话在 .qoder-credits/overrides/<会话id>.json 填同名字段，重跑报告即生效。`}
                </Text>
              )}
            </Callout>
            {ctxRows.length > 0 && (
              <Table
                headers={["对比口径", "数值", "说明"]}
                rows={ctxRows}
                density="compact"
              />
            )}
          </Stack>
        )}

        {c.thresholdNotEnforced && (
          <Callout tone="warning" title="⚠ 自动压缩不会在你设的阈值触发（本条最重要）">
            你的模型物理窗口是 {cwText}，Qoder 的自动压缩要等上下文涨到窗口 ~85%（≈{human(Math.round(c.contextWindow * 0.85))}）才触发；
            你在模型管理里设的 {human(c.userContextLimit)} 上限远在其下，永远不会触发自动压缩。
            请照上面「你真实的上下文占用」那条，到点自己手动压缩，别等它自动压。
          </Callout>
        )}

        {lh && (
          <Callout tone={lhTone} title="链路健康度">
            {lhText}
          </Callout>
        )}

        <Callout tone="info" title="度量口径">
          计费输入总量逐笔锁定真值（优先级：代理 promptTokens &gt; 转录 usage.input_tokens &gt; ratio{availTag(av, "contextRatio")} × {cwText}
          {cwIsFallback ? "，未拿到真窗口、全部 token 数字随之带 ≈" : ""}）；各类别/文件按块估算规模比例分摊
          {availTag(av, "categoryShare", "derived")}。{identityText}
          {cachedText ? ` ${cachedText}` : ""}
          {covPartial
            ? ` Credits 只来自 ${cov!.trips}/${cov!.roundTrips} 笔往返（占计费输入 ${pct(cov!.tokenShare)}），其余往返走代理实测、不经 Qoder 计费，故不要拿 Credits 去除以计费输入总量算单价。`
            : ""}
        </Callout>

        {byReq.length > 0 && (
          <ReportSection
            title="逐请求明细（每一次往返）"
            description={
              showCreditsChart
                ? "每个 round-trip 的真实输入规模与 credits；曲线骤降处为上下文压缩重置（顶部四项为会话累计，此处为每一次）"
                : `每个 round-trip 的真实输入规模；曲线骤降处为上下文压缩重置。credits 曲线未画：本会话只有 ${cov?.trips ?? 0}/${cov?.roundTrips ?? byReq.length} 笔往返带 credits（其余走代理实测、不经 Qoder 计费），画出来是一地零。`
            }
            meta={`${byReq.length} 次往返 · 压缩 ${orDash(s.compactions, av, "compactions")} 次`}
            divided
          >
            {showCreditsChart ? (
              <ChartComparisonGrid>
                <ChartContainer title="每次输入 tokens" ariaLabel="每次输入 tokens">
                  <LineChart
                    categories={reqLabels}
                    series={[{ name: "输入 tokens", data: reqInputs, tone: "info" }]}
                    height={220}
                    valueFormatter={human}
                    ariaLabel="每次请求输入 tokens"
                  />
                </ChartContainer>
                <ChartContainer title="每次 credits" ariaLabel="每次 credits">
                  <LineChart
                    categories={reqLabels}
                    series={[{ name: "credits", data: reqCredits, tone: "warning" }]}
                    height={220}
                    ariaLabel="每次请求 credits"
                  />
                </ChartContainer>
              </ChartComparisonGrid>
            ) : (
              <ChartContainer title="每次输入 tokens" ariaLabel="每次输入 tokens">
                <LineChart
                  categories={reqLabels}
                  series={[{ name: "输入 tokens", data: reqInputs, tone: "info" }]}
                  height={220}
                  valueFormatter={human}
                  ariaLabel="每次请求输入 tokens"
                />
              </ChartContainer>
            )}
          </ReportSection>
        )}

        {hasUsage && ccItems.length > 0 && (
          <ReportSection
            title="压缩单笔成本（会话里最贵的那几笔调用）"
            description="每次压缩本身就是一笔普通模型调用：整份上下文当 prompt 进去、摘要当 completion 出来。此前报告只显示「压缩 N 次」，把单笔最贵的开销藏成了一个计数。「省下」= 压缩前规模 − 压缩后首轮实测输入（地板）。口径列：实测=能在代理日志里唯一对上的供应商真值；自估=客户端在压缩边界里写的前后规模。"
            meta={`${ccItems.length} 次 · 输入累计 ${human(ccost?.totals.preTokens ?? 0)} · 摘要累计 ${human(ccost?.totals.postTokens ?? 0)} · 累计省下 ${human(ccost?.totals.savedTokens ?? 0)} · 其中 ${ccost?.totals.measured ?? 0} 笔为供应商实测`}
            divided
          >
            <Table
              headers={["第几次", "时刻", "触发", "输入", "摘要输出", "压缩后首轮", "省下", "耗时", "口径"]}
              rows={compactRows}
              density="compact"
              stickyHeader
            />
          </ReportSection>
        )}

        {sub && subItems.length > 0 && (
          <ReportSection
            title="子代理账（Agent 派发）"
            description="子代理的每次往返只写进它自己的独立转录，不计入上方主链任何数字；官方 UI 的一场会话扣费 = 主链 + 各子代理。"
            meta={`${subItems.length} 个子代理 · 主链 ${t.credits} + 子代理 ${sub.totals.credits} = 合计 ${sub.combined.credits} Credits`}
            divided
          >
            <Table
              headers={["子代理", "类型", "往返", "计费输入", "峰值占比", "Credits", "原价", "备注"]}
              rows={subRows}
              rowTone={subTones}
              density="compact"
              stickyHeader
            />
          </ReportSection>
        )}

        {hasUsage && r.byCategory.length > 0 && (
          <ReportSection
            title="按类别占比"
            description={`会话计费输入 token 在各来源间的分布（完整划分，占比之和 = 100%）${sysNote}`}
            meta={human(t.billedInputTokens) + ` tokens${availTag(av, "categoryShare", "derived")}`}
            divided
          >
            <ChartContainer ariaLabel="按类别占比">
              <PieChart donut data={pieData} centerLabel="计费输入" valueFormatter={human} />
            </ChartContainer>
          </ReportSection>
        )}

        {hasUsage && catDetail.length > 0 && (
          <ReportSection
            title="按类别下钻（工具 / 文件路径）"
            description="每个类别的消耗再拆到工具与具体文件/路径：工具返回、工具调用可精确到路径，其余类别为整体（无文件归属）。数值均为重发计费 token。"
            meta={`占总额=占计费输入总量 · 占本类=占该类别 · 程数=存活往返累计${availTag(av, "fileShare", "derived")}`}
            divided
          >
            <Table
              headers={["类别", "工具", "文件 / 路径", "重发 tokens", "占总额", "占本类", "程数"]}
              rows={detailRows}
              rowTone={detailTones}
              density="compact"
              stickyHeader
            />
          </ReportSection>
        )}

        {hasUsage && tools.length > 0 && (
          <ReportSection
            title="按工具占比"
            description="各工具相关内容（调用参数 + 返回）重发累计的计费 token 占比（仅工具相关块，非完整划分，占比之和 < 100%）。「单次」= 平均每次调用带来的重发 token：总量榜会把「次数少但每次极贵」的工具埋掉，这一列专门把它捞出来。"
            meta={`token 占比${availTag(av, "toolShare", "derived")} · 调用次数为实测`}
            divided
          >
            <Stack gap="component">
              <ChartContainer ariaLabel="按工具占比">
                <BarChart horizontal categories={toolCategories} series={toolSeries} valueFormatter={human} ariaLabel="按工具占比" />
              </ChartContainer>
              <Table
                headers={["工具", "重发 tokens", "占比", "调用", "单次"]}
                rows={toolRows}
                density="compact"
                stickyHeader
              />
            </Stack>
          </ReportSection>
        )}

        {hasUsage && fileRows.length > 0 && (
          <ReportSection
            title="按文件占比"
            description="精确到路径/文件名：内容随上下文被重复发送累计的计费 token 占比（Top 20，仅可归因文件的块）。「单次读取」= 这个文件平均每次被读取最终烧掉多少（含此后每一程的重发）——读一次就烧掉十几万的文件，在按总量排序的榜上毫不起眼。"
            meta={`程数=存活往返累计 · 读取=返回次数（实测）${availTag(av, "fileShare", "derived")}`}
            divided
          >
            <Table
              headers={["文件", "种类", "重发 tokens", "占比", "单次读取", "程数", "读取"]}
              rows={fileRows}
              density="compact"
              stickyHeader
            />
          </ReportSection>
        )}

        {!hasUsage && residueRows.length > 0 && (
          <ReportSection
            title="工具调用与文件读取（计数为实测）"
            description="占比与 token 一律不可用，但 tool_use 块两种转录都写，所以「谁被调了几次、谁被读了几次」仍是真值 —— IDE 端不是一无所有。"
            meta={`${t.toolCalls ?? 0} 次工具调用${availTag(av, "toolCalls")} · ${t.fileReads ?? 0} 次文件读取${availTag(av, "fileReads")} · ${s.turns} 轮对话`}
            divided
          >
            <Table
              headers={["工具 / 文件", "种类", "调用", "读取", "程数"]}
              rows={residueRows}
              density="compact"
              stickyHeader
            />
          </ReportSection>
        )}
      </Stack>
    </ReportShell>
  );
}
