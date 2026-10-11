// ============================================================
//  美股监控 · Cloudflare Workers 版
//  - Cron Triggers 每分钟触发（wrangler.toml 里配置）
//  - D1(SQLite) 存去重记录
//  - 数据源：华尔街见闻 + 美联储 RSS + SEC EDGAR
// ============================================================

const DEDUP_LOOKBACK = 1500;      // 每次载入内存的去重条数
const MAX_PUSH_PER_RUN = 12;      // 单轮上限：双机器人双发=24 个子请求，加抓取/翻译要留在 50 以内
const PUSH_INTERVAL_MS = 800;     // 推送间隔
const RETENTION_DAYS = 30;        // 去重记录保留天数
const TZ = "Asia/Shanghai";
const ET = "America/New_York";    // 美股时间：汇总窗口按它算（推送不做时段分级）

// 定时汇总（美东时间）
const DAILY_DIGEST_HOUR = 7;      // 每天 07:00 ET = 北京 19:00(夏令) / 20:00(冬令)
const WEEKEND_DIGEST_DOW = 0;     // 周日
const WEEKEND_DIGEST_HOUR = 19;   // 19:00 ET，夜盘开盘前后
const EVENT_MERGE_HOURS = 12;     // 同主体+同类型 12 小时内视为同一事件
const EVENT_MAX_PUSH = 2;         // 同一事件最多即时推 2 次（首报 + 1 次更新），其余交汇总
const OUTBOX_FOLD_THRESHOLD = 30; // 积压超过这个数，"一般"级转进汇总，不再单独打扰

function maxPushOf(env) {
  const n = Number(env.MAX_PUSH_PER_RUN);
  return n > 0 ? Math.min(n, 24) : MAX_PUSH_PER_RUN;
}

const URGENT_KEYWORDS = [
  "美联储加息", "美联储降息", "fed raises", "fed cuts", "fed hikes",
  "fomc statement", "fomc decision", "紧急降息", "emergency rate cut",
  "rate hike", "rate cut", "interest rate decision", "联邦基金利率", "federal funds rate",
  "circuit breaker", "熔断", "flash crash", "black swan", "市场崩盘", "暴跌熔断",
  "禁止做空", "short selling ban", "无限qe", "unlimited qe",
];

// 这些一律不推（广告 / 直播 / 无信息量的运营内容）
const NOISE_PATTERNS = [
  /直播/, /预约/, /回放/, /订阅/, /会员/, /打新/, /新股申购/, /广告/,
  /点击查看/, /扫码/, /加群/, /福利/, /抽奖/, /课程/, /开户/,
];

// SEC 文件类型说明：让披露类消息至少能看懂是什么
const SEC_DESC = {
  "8-K": "重大事项临时报告",
  "6-K": "境外发行人报告",
  "SC 13D": "持股超5%举牌/主动增持",
  "SC 13G": "被动持股披露",
  "425": "并购相关文件",
};

// ==================== 三字段分级（相关性 / 重要性 / 事实状态） ====================
// 设计原则：公司名单决定"跟你有没有关系"，事件决定"值不值得打扰你"。
// 三者分开判断，不再"命中关键词就当重要"。

// 全市场级事件：不受公司名单限制
const MARKET_WIDE = [
  "美联储", "federal reserve", "fomc", "议息", "降息", "加息", "联邦基金利率",
  "cpi", "核心cpi", "pce", "ppi", "非农", "失业率", "gdp", "ism", "零售销售", "初请失业金",
  "财政部", "国债", "美元指数", "vix", "熔断", "关税", "出口管制", "制裁",
  "财政部部长", "财长", "通胀", "衰退", "经济衰退",
];

// 关注行业（存储 / 半导体 / 数据中心）：实质事件才推，普通动态降级
const SECTOR_DEFAULT = "存储,nand,dram,hdd,硬盘,固态硬盘,ssd,hbm,闪存,内存,半导体,晶圆,芯片,数据中心,存储芯片,供给,产能扩张";

// ==================== 名单分层 ====================
// A 层 核心：WDC（唯一核心，财报/指引/并购/监管 = 重大，立刻推）
// B 层 持仓：其余个股，只有硬事件（财报、指引、评级、并购、人事、监管）才"重要"
// C 层 主题：ETF / 商品 / 加密货币 / 债券收益率，用主题词而不是公司名
//
// 重要：只写公司全名和中文别名，不写代码。新闻里出现的是公司名，不是代码。
// 更不能拿 NOW / BE / HUT / FIG / EL / PL / MP / TE / XE / NASA / DRAM 这类
// 单词型代码去匹配 —— "be"、"now"、"hut" 是英文常用词，会大量误命中。

const HOLDINGS_DEFAULT = [
  // 存储
  "micron technology", "micron", "美光", "seagate", "希捷", "sandisk", "闪迪",
  "sk hynix", "sk海力士", "海力士", "ase technology", "日月光",
  // 半导体 / 设备
  "taiwan semiconductor", "tsmc", "台积电", "nvidia", "英伟达", "broadcom", "博通",
  "advanced micro", "amd", "超微半导体", "intel", "英特尔", "qualcomm", "高通",
  "marvell technology", "marvell", "迈威尔", "arm holdings", "arm控股",
  "applied materials", "应用材料", "lam research", "泛林", "asml", "阿斯麦",
  "globalfoundries", "格芯", "amkor", "安靠", "axt",
  "credo technology", "astera labs", "astera", "lumentum", "coherent", "相干",
  "applied optoelectronics", "maxlinear", "poet technologies", "aehr test", "corning", "康宁",
  "cerebras", "nokia", "诺基亚",
  // AI 算力 / 数据中心
  "super micro", "supermicro", "超微电脑", "dell", "戴尔", "hewlett packard enterprise", "慧与",
  "ibm", "oracle", "甲骨文", "vertiv", "nebius", "coreweave", "applied digital",
  "iren", "hive digital", "cipher digital", "cipher mining", "riot platforms",
  "hut 8", "terawulf", "bitmine", "ciena",
  // 软件 / 互联网 / 金融
  "microsoft", "微软", "alphabet", "谷歌", "apple", "苹果", "amazon", "亚马逊",
  "meta platforms", "netflix", "奈飞", "tesla", "特斯拉", "palantir",
  "servicenow", "salesforce", "snowflake", "figma", "tempus ai",
  "reddit", "robinhood", "paypal", "coinbase", "microstrategy",
  "circle internet", "palo alto networks", "zscaler", "crowdstrike",
  "futu", "富途", "destiny tech100",
  // 航天 / 国防
  "rocket lab", "ast spacemobile", "spacex", "intuitive machines", "redwire",
  "red cat holdings", "ondas", "firefly aerospace", "planet labs", "tss inc",
  "iridium", "铱星",
  // 能源 / 核电 / 材料
  "bloom energy", "t1 energy", "x-energy", "nuscale", "oklo",
  "uranium energy", "energy fuels", "eos energy", "mp materials",
  "freeport-mcmoran", "自由港", "occidental petroleum", "西方石油", "frontline",
  // 医药 / 消费
  "eli lilly", "lilly", "礼来", "merck", "默沙东", "nurix therapeutics",
  "estee lauder", "雅诗兰黛", "kraft heinz", "卡夫亨氏",
  // 量子计算
  "ionq", "d-wave quantum", "rigetti",
];

// C 层主题：ETF / 商品 / 加密 / 债券收益率 —— 这些没有公司公告，只能按主题词监控
const THEME_DEFAULT = [
  "比特币", "bitcoin", "btc", "黄金", "金价", "白银", "银价",
  "原油", "wti", "油价", "美债收益率", "10年期美债", "十年期美债",
  "纳斯达克", "纳指", "vix", "波动率", "商业航天", "太空探索",
];

// 核心公司重大事件类型：命中即"重大"
const CORE_MAJOR_EVENTS = [
  "财报", "业绩", "季报", "年报", "指引", "业绩预告", "盈警", "盈喜", "预亏", "预增",
  "earnings", "guidance", "quarterly results", "financial results",
  "并购", "收购", "被收购", "acquir", "merger", "合并", "退市", "破产", "bankrupt",
  "裁员", "重组", "召回", "重大诉讼", "监管处罚", "反垄断处罚", "出口管制",
  "ceo", "cfo", "辞职", "卸任", "任命", "resign", "step down", "appoint",
  "8-k", "6-k", "sc 13d", "sc 13g", "10-k", "10-q",
];
// 核心公司"值得打扰"的事件（非财报级）：评级、订单、产品、融资、监管、人事、异动
const CORE_NOTABLE_EVENTS = [
  "评级", "目标价", "上调", "下调", "首次覆盖", "分析师",
  "订单", "加单", "砍单", "中标", "签约", "合作", "供应", "采购", "扩产", "产能",
  "融资", "募资", "投资", "入股", "回购", "分红", "增发", "配股",
  "发布", "推出", "上市", "量产", "交付", "出货",
  "监管", "诉讼", "罚款", "处罚", "调查", "反垄断", "合规", "禁令",
  "罢工", "停工", "工厂", "产线", "良率", "涨价", "提价",
  "异动", "大涨", "大跌", "创新高", "新低", "停牌",
];
// 全市场"值得打扰"的事件：利率/债市/政策/市场异动，不只是"跟美股沾边"
const MARKET_NOTABLE_EVENTS = [
  "利率决议", "议息", "褐皮书", "点阵图", "票委", "美联储主席", "fed发言", "讲话",
  "国债收益率", "标售", "债务上限", "财政赤字", "政府关门", "关门风险",
  // 注意：不放裸"制裁/禁令"——地缘政治表态（如"对俄制裁"）不是市场事件，会误判
  "关税", "出口管制", "贸易政策", "贸易战", "反垄断", "芯片管制",
  "熔断", "vix", "暴跌", "大涨", "创新高", "纪录新高", "流动性", "美元指数",
  "衰退", "经济数据", "初请", "pmi", "ism",
];

// 行业级重要事件：供给、价格、政策这类会传导到个股的
const SECTOR_MAJOR_EVENTS = [
  "涨价", "提价", "降价", "缺货", "供给中断", "停产", "减产", "断供", "扩产",
  "出口管制", "限制出口", "许可证", "关税", "制裁", "反垄断", "调查",
  "订单", "中标", "大单", "产能", "缺芯", "库存",
];

// 宏观数据的"首次发布"必须和预告/回顾/评论区分开：
// 出现"前瞻/预览/点评/解读/回顾/即将公布"就不是数据发布本身
const PREVIEW_WORDS = ["前瞻", "预览", "预告", "展望", "预测", "点评", "解读", "评论",
                       "回顾", "即将公布", "下周", "本周关注", "市场预期本周", "待公布",
                       "preview", "outlook", "forecast", "what to expect", "commentary"];
const MACRO_INDICATORS = ["cpi", "核心cpi", "pce", "ppi", "非农", "失业率", "gdp", "ism",
                          "零售销售", "初请失业金", "消费者信心", "密歇根", "工业产出",
                          "利率决议", "联邦基金利率", "点阵图"];

// 事实状态：官方披露 / 媒体（或公关稿）报道 / 未证实 / 更正
const RUMOR_PATTERNS = [/据.{0,8}知情人士/, /消息人士/, /报道称/, /据报道/, /援引/, /传闻/,
                        /reportedly/i, /people familiar/i, /according to sources/i];
const CORRECTION_PATTERNS = [/更正/, /此前.{0,6}有误/, /予以否认/, /辟谣/, /声明不实/,
                             /correction/i, /denies/i, /denied/i, /clarif/i];

// 名单匹配改正则 + 结果缓存：原来每条新闻要遍历 200+ 个公司名做 includes。
//
// word=true 时按"整词"匹配（只给公司名 / 行业 / 主题 / 宏观指标这类专有名词名单用）。
// 裸子串匹配会这样误命中：持仓里的 "futu" 命中 "Stock futures"、宏观词 "ism" 命中
// "workaholism"。社交源里全是这种随意英文，误报会直接刷屏。
// 中文没有词边界，仍走子串分支。
//
// 事件关键词名单（CORE_MAJOR_EVENTS 等）必须保持子串匹配：里面有 "acquir" / "resign" /
// "appoint" 这类靠前缀命中 "acquires" / "resigned" / "appointed" 的词，加尾部边界会失效。
const _reCache = new WeakMap();      // 子串匹配
const _reCacheW = new WeakMap();     // 整词匹配
function listRe(arr, word) {
  const cache = word ? _reCacheW : _reCache;
  let re = cache.get(arr);          // 直接用数组对象做 key（WeakMap），省掉每次 join 长名单
  if (re === undefined) {
    const parts = arr.filter(Boolean)
      .map((k) => {
        const raw = String(k);
        const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (!word || !/^[\x20-\x7E]+$/.test(raw)) return esc;
        return `(?<![a-z0-9])${esc}(?![a-z0-9])`;
      })
      .sort((a, b) => b.length - a.length);      // 长词优先，避免 "amd" 抢先命中 "advanced micro"
    re = parts.length ? new RegExp(parts.join("|")) : null;
    cache.set(arr, re);
  }
  return re;
}
function hitAny(text, arr, word) {
  const re = listRe(arr, word);
  return !!re && re.test(text);
}
// 返回真正命中的那个词（用于确定事件主体），没命中返回 ""
function hitWhich(text, arr, word) {
  const re = listRe(arr, word);
  if (!re) return "";
  const m = String(text).match(re);
  return m ? m[0] : "";
}
function hitRe(text, arr) { return arr.some((p) => p.test(text)); }

// 相关性：只在"标题主体"上认定核心公司/行业；正文顺带提到的降级为"提及"，
// 避免"文章提到英伟达"就被当成英伟达的大事（你的设计里明确要求区分这一点）
function relevanceOf(it, core, sector, holdings, theme) {
  const title = (it.title || "").toLowerCase();
  const full = `${title} ${it.content || ""}`.toLowerCase();
  // 这些是专有名词名单，全部走整词匹配（见 listRe 的说明）：
  // "futu" 不该命中 "futures"，"ism" 不该命中 "workaholism"
  if (hitAny(title, core, true)) return "核心公司";
  if (hitAny(title, holdings, true)) return "持仓公司";
  if (hitAny(title, sector, true)) return "关注行业";
  if (hitAny(title, theme, true)) return "持仓主题";
  if (hitAny(title, MARKET_WIDE, true)) return "全市场";
  // 正文才提到 → 不是事件主体，降级
  if (hitAny(full, core, true) || hitAny(full, holdings, true)) return "提及";
  if (hitAny(full, sector, true) || hitAny(full, theme, true)) return "关注行业";
  if (hitAny(full, MARKET_WIDE, true)) return "全市场";
  return "";
}

// 事实状态
function factStatusOf(text, it) {
  if (hitRe(text, CORRECTION_PATTERNS)) return "更正/否认";
  if (hitRe(text, RUMOR_PATTERNS)) return "未证实（媒体报道）";
  const s = it.source || "";
  if (/SEC|Federal Reserve|NVIDIA IR|BLS/.test(s)) return "官方披露";
  if (/PR Newswire|GlobeNewswire/.test(s)) return "公司新闻稿";
  // 社交/社区：帖子是线索和情绪，不是已证实的新闻，必须和上面两类分开标，
  // 否则一条散户猜测会和 SEC 披露一样显示成可信来源
  if (/Reddit|Mastodon|Bluesky|YouTube/.test(s)) return "未证实（社区/社交）";
  return "媒体报道";
}

// 重要性：重大 / 重要 / 一般 / ""（不推）
function importanceOf(it, text, rel) {
  // 重大只在"标题主体"上认定：正文里顺带出现"业绩/裁员"不能把一条传闻抬成重大
  const tl = (it.title || "").toLowerCase();
  if (hitAny(tl, URGENT_KEYWORDS)) return "重大";
  const isMacroRelease = hitAny(tl, MACRO_INDICATORS) && /\d/.test(tl)
    && !hitAny(tl, PREVIEW_WORDS);
  if (rel === "全市场" && isMacroRelease) return "重大";
  if (rel === "核心公司" && hitAny(tl, CORE_MAJOR_EVENTS)) return "重大";
  if (rel === "核心公司" && hitAny(text, CORE_NOTABLE_EVENTS)) return "重要";
  // B 层持仓：只有硬事件才"重要"（财报/指引/并购/人事/监管 + 评级调整），普通动态降级
  if (rel === "持仓公司" && (hitAny(tl, CORE_MAJOR_EVENTS) || hitAny(tl, RATING_KEYWORDS))) return "重要";
  // C 层主题：只有异常波动才"重要"（比特币/黄金/原油/美债收益率 的日常涨跌走一般级）
  if (rel === "持仓主题" && hitAny(tl, ["熔断", "创新高", "历史新高", "纪录", "暴跌", "暴涨", "崩", "闪崩"])) return "重要";
  if (rel === "关注行业" && hitAny(text, SECTOR_MAJOR_EVENTS)) return "重要";
  if (rel === "全市场" && hitAny(text, MARKET_NOTABLE_EVENTS)) return "重要";
  // 正文顺带提到核心公司：只有真出了大事才算重要，否则降级
  if (rel === "提及" && hitAny(text, CORE_MAJOR_EVENTS)) return "重要";
  if (isSubstantive(it)) return "一般";
  return "";
}

// "为什么推给你"：把判断依据写清楚，方便你事后核对我有没有乱推
function impactReasonOf(rel, it, text) {
  if (rel === "核心公司") {
    if (hitAny(text, CORE_MAJOR_EVENTS)) return "核心关注公司 · 涉及财报/指引/重大经营或监管变化";
    return "核心关注公司 · 一般动态";
  }
  if (rel === "关注行业") return "关注行业（存储/半导体/数据中心）· 可能传导到个股";
  if (rel === "全市场") return "全市场事件 · 不受公司名单限制";
  if (rel === "持仓公司") return "持仓/关注个股 · 命中硬事件（财报、指引、评级、并购、人事、监管）";
  if (rel === "持仓主题") return "持仓主题（ETF/商品/加密/债券收益率）· 按主题词监控";
  if (rel === "提及") return "正文提及关注公司/行业，非事件主体（降级处理）";
  return "";
}

// 只有"有实际信息量"的条目才推 —— 挡掉"仅一个标题+链接"的裸披露
function isSubstantive(it) {
  const t = (it.title || "").trim();
  const c = (it.content || "").trim();
  if (NOISE_PATTERNS.some((p) => p.test(t))) return false;
  if (c.length >= 20) return true;                                  // 有正文摘要
  if (/[\u4e00-\u9fff]/.test(t) && t.length >= 12) return true;     // 中文快讯：标题即内容
  // 英文新闻稿：很多公司 IR feed 的 <description> 是空的 CDATA（AMD / Intel 实测就是这样），
  // 只能靠标题判断。原来这条要求"标题必须含数字"，结果
  // "Microchip Technology Acquires VORAGO Technologies" 这种真收购因为标题里没有数字，
  // 被当成空内容丢掉。收购/合并/分拆这类公司动作本身就是实质事件，不该再要求数字。
  if (/(acquir|acquisition|merger|merges|merge|divest|divestiture|spin-?off|bankrupt|resign|recall|lawsuit|sues|sued|buyback|buy back|dividend|stake)/i.test(t)) return true;
  if (/\d/.test(t) && /(beat|miss|surge|jump|plunge|slump|rise|fall|cut|raise|guidance|earnings|revenue|profit|warn|halt|approve|fine|financial results)/i.test(t)) return true;
  return false;
}

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/html, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowCn() {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(new Date()).replace(/\//g, "-");
}

function isEnglish(text) {
  if (!text) return false;
  const alpha = (text.match(/[A-Za-z]/g) || []).length;
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return alpha > 0 && alpha > chinese * 2;
}

async function hashTitle(title) {
  const s = title.toLowerCase().replace(/\s+/g, " ").trim();
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// 利率/加息降息概率（CME FedWatch、点阵图、利率期货定价等）
// 分析师评级 / 目标价调整
const RATING_KEYWORDS = [
  "上调评级", "下调评级", "评级上调", "评级下调", "维持评级", "首次覆盖", "恢复覆盖",
  "上调目标价", "下调目标价", "目标价", "买入评级", "卖出评级", "增持", "减持", "中性评级",
  "跑赢大盘", "跑输大盘", "看好评级", "强烈买入", "分析师上调", "分析师下调",
  "upgrade", "downgrade", "price target", "overweight", "underweight", "outperform",
  "underperform", "buy rating", "sell rating", "neutral rating", "analyst",
];

// 财报 / 业绩 / 指引
// ==================== 数据源 ====================

async function fetchWallstreet(env) {
  const items = [];
  const channels = (env.WALLSTREET_CHANNELS || "us-stock-channel").split(",");
  for (const ch of channels) {
    try {
      const url = `https://api-one.wallstcn.com/apiv1/content/lives?channel=${encodeURIComponent(ch.trim())}&client=pc&limit=30`;
      const r = await fetch(url, { headers: { ...HEADERS, Referer: "https://wallstreetcn.com/" } });
      if (!r.ok) continue;
      const data = await r.json();
      for (const it of (data?.data?.items || []).slice(0, 30)) {
        const title = it.title || it.content_text || "";
        const content = it.content_text || it.content || "";
        if (title && title.length > 6) {
          items.push({
            title: title.slice(0, 200),
            content: content && content !== title ? content.slice(0, 500) : "",
            link: `https://wallstreetcn.com/livenews/item/${it.id || ""}`,
            published: it.display_time ? isoOf(new Date(it.display_time * 1000).toISOString()) : "",
            source: "华尔街见闻", alwaysPush: true,
          });
        }
      }
    } catch (e) { /* 单源失败不影响整体 */ }
  }
  return items;
}

// 很多 RSS 把内容包在 CDATA 里（<![CDATA[...]]>），不剥掉会连标签一起当成正文
const entChr = (n) => {
  try { return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ""; }
  catch (e) { return ""; }
};

// 去标签 + 还原 HTML 实体。实体不还原的话，MarketWatch 这类源的标题会原样带出转义码
// （实测是 "We&#x2019;re about to get..."，推到群里就是一坨乱码）
const stripTags = (s) => String(s || "")
  .replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "")
  // 先还原实体、再去标签：RSS 里的正文经常是转义过的 HTML（Mastodon 的 <description>
  // 整段是 &lt;p&gt;...）。反过来做的话，转义码被还原成真标签时标签已经去完了，
  // 结果正文里留下一堆 <p> <a href=...> 残渣。
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => entChr(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => entChr(parseInt(d, 10)))
  .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g,
    (m) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'", "&nbsp;": " " }[m.toLowerCase()] || m))
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim();

// 美联储两个 feed 分开拉：新闻稿（含利率决议）和官员讲话是两类不同的东西，
// 分级规则、失效判断都要分别看，混在一个源里没法分别观测。
// ③ SEC 披露的唯一身份：CIK + accession。
// 同一份文件从"全局最新"和"按公司查"两条路径进来时，标题可能不同（一个带公司名、一个带表单号），
// 但 accession 必然相同 —— 用它做去重指纹才不会重复打扰。
function accessionOf(link) {
  const m = String(link || "").match(/\/Archives\/edgar\/data\/\d+\/([0-9]{10}-?[0-9]{2}-?[0-9]{6}|\d{18})/);
  return m ? m[1] : "";
}

// ⑨ 全局 SEC 源挂掉时的兜底：按核心公司分批轮转查询。
// 平时不跑（全局源一次就能覆盖所有观察公司，再按公司查只会造成重复推送）；
// 只在全局源确认失败时启用，避免整轮静默漏掉披露。
function secRotateBatch(watch, minute) {
  const size = 4;
  if (!watch.length) return [];
  if (watch.length <= size) return watch;
  const start = (Math.floor(minute / 3) * size) % watch.length;
  const out = [];
  for (let i = 0; i < size; i++) out.push(watch[(start + i) % watch.length]);
  return out;
}

// 注意两点（都是实测出来的）：
// 1) 按公司查询的 atom 里 entry 的 <title> 只是 "8-K - Current report"，
//    不含公司名（公司名只在"全局最新"那个 feed 里有）。所以这里用"查询时用的公司名"作主体。
// 2) SEC 的 company= 名称搜索并不总是命中：western digital / nvidia / micron technology / tesla
//    能返回数据，apple / ford / pfizer / bank of america 返回 0 条。
//    所以这条兜底是"尽力而为"，不是完整覆盖 —— 全局源才是主力。
async function fetchSecByCompany(env, names) {
  const items = [];
  const ua = env.SEC_USER_AGENT || "USStockMonitor/1.0 (admin@example.com)";
  // 3) 这条路径查的是"该公司最近 5 份 8-K"，可能是一个月前甚至一年前的旧文件。
  //    兜底的目的是补上"刚刚漏掉的披露"，所以只认 24 小时内的，旧文件一律不要 ——
  //    否则一启用就刷出一堆过期披露，全是假警报。
  const maxAgeH = Number(env.SEC_FAILOVER_MAX_AGE_HOURS || 24);
  const cutoff = Date.now() - maxAgeH * 3600 * 1000;
  for (const name of names) {
    try {
      const url = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany"
        + `&company=${encodeURIComponent(name)}&type=8-K&dateb=&owner=include&count=5&output=atom`;
      const r = await fetch(url, { headers: { ...HEADERS, "User-Agent": ua } });
      if (!r.ok) continue;
      const text = await r.text();
      for (const e of (text.match(/<entry>[\s\S]*?<\/entry>/g) || [])) {
        const date = (e.match(/<filing-date>([\s\S]*?)<\/filing-date>/) || [])[1] || "";
        const href = (e.match(/<filing-href>([\s\S]*?)<\/filing-href>/) || [])[1] || "";
        const desc = (e.match(/<items-desc>([\s\S]*?)<\/items-desc>/) || [])[1] || "";
        // 时效闸门：超过 cutoff 的旧披露直接丢弃
        // 解析不出日期的一律丢弃（fail-closed）。原来是 isFinite(filed) && filed < cutoff，
        // 日期缺失时会 falls through 放行 —— 兜底路径上"不确定新鲜"就该当成不新鲜，
        // 否则 SEC 一挂就刷出一堆连时间都没有的旧披露。
        const filed = Date.parse(String(date).trim());
        if (!isFinite(filed) || filed < cutoff) continue;
        let link = href.trim();
        if (link.startsWith("/")) link = "https://www.sec.gov" + link;
        if (!link) continue;
        items.push({
          title: `[SEC 8-K] ${name}`,
          content: `${desc ? `披露项 ${desc.trim()} · ` : ""}披露时间 ${date.trim()}（全局源失败，按公司轮换兜底）`,
          published: isoOf(date.trim()),
          link, source: "SEC EDGAR",
        });
      }
    } catch (e) { /* 单个公司失败不影响其他 */ }
  }
  return items;
}

async function fetchFedFeed(url, label, limit) {
  const items = [];
  const r = await fetch(url, { headers: HEADERS });
  const text = await r.text();
  const blocks = text.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const b of blocks.slice(0, limit)) {
    const t = b.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const d = b.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);
    const l = b.match(/<link>(.*?)<\/link>/);
    // 不同 feed 的时间标签不一样：RSS 用 pubDate，Atom/dc 用 dc:date / published
    const p = b.match(/<pubDate>(.*?)<\/pubDate>/)
      || b.match(/<dc:date>(.*?)<\/dc:date>/)
      || b.match(/<published>(.*?)<\/published>/);
    if (!t) continue;
    items.push({
      title: `[Fed${label}] ` + stripTags(t[1]).trim(),
      content: d ? stripTags(d[1]).trim().slice(0, 300) : "",
      link: l ? l[1].trim() : "",
      published: isoOf(p ? p[1].trim() : ""),
      source: label === "讲话" ? "美联储-讲话" : "美联储-新闻稿",
      alwaysPush: true,
    });
  }
  return items;
}

async function fetchFed() {
  try {
    return await fetchFedFeed("https://www.federalreserve.gov/feeds/press_all.xml", "新闻稿", 10);
  } catch (e) { return []; }
}

async function fetchFedSpeeches() {
  try {
    return await fetchFedFeed("https://www.federalreserve.gov/feeds/speeches.xml", "讲话", 8);
  } catch (e) { return []; }
}

async function fetchSec(env) {
  const items = [];
  // 观察名单：只有这些公司的披露才推，否则 8-K 里几百家陌生公司的裸链接全是噪音
  const watch = (env.SEC_WATCH_COMPANIES || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const types = (env.SEC_FORM_TYPES || "8-K").split(",");
  const perType = Number(env.SEC_PER_TYPE || 15);
  const ua = env.SEC_USER_AGENT || "USStockMonitor/1.0 (admin@example.com)";
  for (const form of types) {
    try {
      const url = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent"
        + `&type=${encodeURIComponent(form.trim())}&output=atom&count=${perType}&owner=include`;
      const r = await fetch(url, { headers: { ...HEADERS, "User-Agent": ua } });
      if (!r.ok) continue;
      const text = await r.text();
      const entries = text.match(/<entry>[\s\S]*?<\/entry>/g) || [];
      for (const e of entries) {
        const t = e.match(/<title>([\s\S]*?)<\/title>/);
        const l = e.match(/<link[^>]*href="([^"]+)"/);
        const u = e.match(/<updated>([\s\S]*?)<\/updated>/);
        if (!t) continue;
        const raw = t[1].replace(/\s+/g, " ").trim();
        const company = raw.includes(" - ") ? raw.split(" - ").slice(1).join(" - ").trim() : raw;
        let link = l ? l[1] : "";
        if (link.startsWith("/")) link = "https://www.sec.gov" + link;
        // 不在观察名单里的公司直接丢弃（watch 为空则不过滤）
        if (watch.length && !watch.some((k) => company.toLowerCase().includes(k))) continue;
        const form2 = form.trim();
        const desc = SEC_DESC[form2] || "披露文件";
        // 8-K/6-K 的标题只有公司名，推出来就是"一条链接+某某公司披露"，看完不知道发生了什么，
        // 所以除非标题本身命中关键词，否则不推；举牌(13D/13G)、并购(425)本身有明确含义，照常推
        const meaningful = ["SC 13D", "SC 13G", "425"].includes(form2);
        items.push({
          title: `[SEC ${form2}] ${company}`,
          content: `${desc}${u ? ` · 披露时间 ${u[1].trim()}` : ""}`,
          published: isoOf(u ? u[1].trim() : ""),
          link, source: "SEC EDGAR", alwaysPush: meaningful,
        });
        if (items.length >= 60) return items;
      }
    } catch (e) { /* ignore */ }
  }
  return items;
}

// ==================== 新增源：新闻稿 / 官方 IR / 宏观数据 ====================

// 通用 RSS 解析（PR Newswire、GlobeNewswire、NVIDIA IR、BLS、Census 都是 RSS/XML）
function parseRssItems(text, { source, prefix = "", limit = 15, alwaysPush = false, press = false }) {
  const out = [];
  // RSS 用 <item>，Atom 用 <entry>，两种都得认。BLS 的 cpi/empsit/ppi/jolts 四个 feed
  // 文件后缀是 .rss，实际返回的却是 Atom —— 只认 <item> 的话它们会静默返回 0 条，
  // 而 HTTP 状态是 200，看上去"源很健康"，其实一条都没拿到。这种假健康最难发现。
  // 标签上可能带属性：BEA 的 feed 是 <item name="GDP">，只匹配裸 <item> 会一条都拿不到
  // （它 HTTP 200、<item> 计数 48，但 parsed=0 —— 又是一次"假健康"）
  const blocks = (text.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/g) || [])
    .concat(text.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/g) || []);
  for (const b of blocks.slice(0, limit)) {
    const t = b.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    // 正文：RSS 的 <description>，Atom 的 <content> / <summary>
    const d = b.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)
           || b.match(/<content>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content>/)
           || b.match(/<summary>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/summary>/);
    // 链接：RSS 是 <link>url</link>，Atom 是自闭合的 <link href="url"/> —— 结构不同，别漏
    const l = b.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/)
           || b.match(/<link[^>]*\shref=["']([^"']+)["']/);
    // 时间：RSS 的 <pubDate>，Atom 的 <published>（退回 <updated>）
    const p = b.match(/<pubDate>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/)
           || b.match(/<published>([\s\S]*?)<\/published>/)
           || b.match(/<updated>([\s\S]*?)<\/updated>/);
    // 有些 feed 的条目压根没有 <title>（Mastodon 就是这样，只有 guid / link / pubDate / description）。
    // 不回退的话整源 20 条全被"没标题"跳过 —— HTTP 200 却一条都拿不到，又是一次"假健康"。
    const title = (t ? stripTags(t[1]) : "") || stripTags(d ? d[1] : "").slice(0, 120);
    if (!title) continue;
    out.push({
      title: prefix + title,
      content: d ? stripTags(d[1]).trim().slice(0, 300) : "",
      link: l ? l[1].trim() : "",
      published: isoOf(p ? p[1].trim() : ""),
      source,
      alwaysPush,
      press,   // 新闻稿类：不能只靠"公司名"放行，必须命中财报/合作/评级等信号
    });
  }
  return out;
}

let FEED_LOG = [];   // 诊断用：记录每个源的 HTTP 状态，预览接口会返回

// 时效闸门：RSS / Atom / JSON API 返回的都是"历史窗口"，不是今日新增。
// BLS 的 CPI feed 常年挂着过去十几期的发布，新接入的源一上来会把整个历史窗口当新闻灌进来，
// 全是假警报。抽成函数是为了让非 RSS 的源（Bluesky 是 JSON）也能用同一道闸门。
function freshOnly(items, maxAgeHours) {
  const h = Number(maxAgeHours || 0);
  if (h <= 0) return items;
  const cutoff = Date.now() - h * 3600 * 1000;
  return items.filter((it) => {
    // 拿不到发布时间的一律不要：宁可漏，也不能把没日期的旧内容当成新的推
    if (!it.published) return false;
    const t = Date.parse(String(it.published).replace(" ", "T") + "Z");
    return !isNaN(t) && t >= cutoff;
  });
}

// 实测：BLS 把 Feedfetcher-Google 这个 UA 直接拉黑（403），换成 Feedly / NewsBlur 就返回 200。
// 所以别用 Google 那个，改用通用阅读器 UA。
const FEED_UA = "Feedly/1.0 (+http://www.feedly.com/fetcher.html)";

async function fetchOnce(url, ua) {
  const r = await fetch(url, {
    headers: { ...HEADERS, "User-Agent": ua || HEADERS["User-Agent"],
               Accept: "application/rss+xml,application/xml,text/xml,*/*" },
  });
  return { r, txt: await r.text() };
}

async function fetchFeed(url, opts, ua) {
  try {
    let { r, txt } = await fetchOnce(url, ua);
    // 站点偶尔只认某一种 UA：PR Newswire 从云厂商 IP 请求时会返回 404 + 184KB 的反爬页，
    // 但换阅读器 UA 就正常。所以失败时换另一个 UA 再试一次 —— 只有失败才多发这一条请求，健康时不额外消耗。
    if (r.status >= 400) {
      const alt = (ua || HEADERS["User-Agent"]) === FEED_UA ? HEADERS["User-Agent"] : FEED_UA;
      const again = await fetchOnce(url, alt);
      if (again.r.ok) { r = again.r; txt = again.txt; }
    }
    let items = r.ok ? parseRssItems(txt, opts) : [];
    const rawN = items.length;
    const blocks = (txt.match(/<item[\s>]/g) || []).length;
    const entries = (txt.match(/<entry[\s>]/g) || []).length;
    items = freshOnly(items, opts.maxAgeHours);
    FEED_LOG.push({
      url: url.replace(/^https?:\/\//, "").slice(0, 55),
      status: r.status,
      len: txt.length,
      blocks, entries, parsed: rawN, kept: items.length,
    });
    return items;
  } catch (e) {
    FEED_LOG.push({ url: url.replace(/^https?:\/\//, "").slice(0, 55), status: "ERR",
                    err: String(e && e.message || e).slice(0, 90) });
    return [];
  }
}

// PR Newswire：公司财报、并购、融资、订单、产品发布
async function fetchPr(env) {
  const feeds = (env.PR_FEEDS
    || "https://www.prnewswire.com/rss/news-releases-list.rss,https://www.prnewswire.com/rss/earnings-news/earnings-news-list.rss")
    .split(",");
  const items = [];
  for (const u of feeds) {
    // 实测：主 feed（news-releases-list）从云厂商 IP 用浏览器 UA 会返回 404 + 反爬页，
    // 用阅读器 UA 才是 200。直接把阅读器 UA 设为首选，省掉每次失败重试的那条请求。
    items.push(...(await fetchFeed(u.trim(), { source: "PR Newswire", limit: 12, press: true }, FEED_UA)));
  }
  return items;
}

// GlobeNewswire：另一批上市公司的公告（财报、增发、合作）
async function fetchGlobe(env) {
  const feeds = (env.GLOBE_FEEDS
    || "https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies")
    .split(",");
  const items = [];
  for (const u of feeds) {
    // GlobeNewswire 的 WAF 会挡掉普通浏览器 UA，换成 RSS 阅读器 UA
    items.push(...(await fetchFeed(u.trim(), { source: "GlobeNewswire", limit: 12, press: true }, FEED_UA)));
  }
  return items;
}

// NVIDIA 投资者关系（想加别的公司 IR，往 NVIDIA_FEEDS 里加即可，逗号分隔）
async function fetchNvidia(env) {
  const feeds = (env.NVIDIA_FEEDS || "https://nvidianews.nvidia.com/releases.xml").split(",");
  const items = [];
  for (const u of feeds) {
    items.push(...(await fetchFeed(u.trim(), { source: "NVIDIA IR", prefix: "[NVIDIA] ", limit: 10, press: true })));
  }
  return items;
}

// 通用多 feed 抓取：env 里逗号分隔，支持 "url|[前缀]" 给不同站点加不同标题前缀。
// 前缀不是装饰：AMD 的公告标题里未必出现 "AMD" 三个字，没有前缀就匹配不到关注公司，
// 会被相关性过滤当成无关内容丢掉。
async function fetchFeeds(env, key, def, opts) {
  const list = (env[key] || def).split(",").map((s) => s.trim()).filter(Boolean);
  const items = [];
  for (const u of list) {
    const [rawUrl, prefix] = u.split("|");
    const p = (prefix || "").trim();
    // opts.ua 允许单独指定 UA：Reddit 见到阅读器 UA 直接 429，只认浏览器 UA（实测）
    items.push(...(await fetchFeed(rawUrl.trim(), {
      ...opts,
      prefix: p ? p + " " : (opts.prefix || ""),
    }, opts.ua || FEED_UA)));
  }
  return items;
}

// MarketWatch（道琼斯官方 feed）：美股、市场、财经头条。
// 实测 mw_topstories 里塞的是个人理财专栏（"我是68岁寡妇、该不该买30年国债"这类），
// 10 条里只有 2-3 条跟市场有关，接了基本没用。RSSMarketsMain（WSJ 市场版）才是真美股内容，
// mw_bulletins 是快讯，两个一起用。
async function fetchMarketWatch(env) {
  return fetchFeeds(env, "MW_FEEDS",
    "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain,"
    + "https://feeds.content.dowjones.io/public/rss/mw_bulletins",
    { source: "MarketWatch", limit: 12, maxAgeHours: 72 });
}

// Newswire.com：企业新闻稿。它和 PR Newswire 是两个不同渠道，内容不重叠，不是重复接入
async function fetchNewswire(env) {
  return fetchFeeds(env, "NEWSWIRE_FEEDS", "https://www.newswire.com/newsroom/rss",
    { source: "Newswire.com", limit: 12, press: true, maxAgeHours: 72 });
}

// 公司一手公告：AMD / Intel / Apple / Microchip 的投资者关系页。
// 窗口放宽到 7 天：这几家发公告不频繁，卡 72 小时容易整周都刷不到东西。
async function fetchCompanyIR(env) {
  return fetchFeeds(env, "IR_FEEDS",
    "https://ir.amd.com/news-events/press-releases/rss|[AMD],"
    + "https://www.intc.com/news-events/press-releases/rss|[Intel],"
    + "https://www.apple.com/newsroom/rss-feed.rss|[Apple],"
    + "https://ir.microchip.com/news-events/press-releases/rss|[Microchip]",
    { source: "公司IR", limit: 10, press: true, maxAgeHours: 168 });
}

// Google 官方博客：AI、云、产品。这是公司博客，不能当 Alphabet 的财务披露源用
async function fetchGoogleBlog(env) {
  return fetchFeeds(env, "GBLOG_FEEDS", "https://blog.google/rss/",
    { source: "Google 博客", limit: 10, maxAgeHours: 72 });
}

// Nasdaq 停复牌。官方免费订阅，要求查询频率不超过每分钟一次（我们 6 分钟一次，安全）。
// 这里刻意不开 alwaysPush：停牌每天几十起，全推就是噪音。走相关性过滤，只留你关注的公司。
async function fetchNasdaqHalts(env) {
  return fetchFeeds(env, "NASDAQ_FEEDS", "https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts",
    { source: "Nasdaq 停复牌", limit: 20, maxAgeHours: 24 });
}

// FTC 美国联邦贸易委员会：反垄断、并购审查、监管执法
async function fetchFtc(env) {
  return fetchFeeds(env, "FTC_FEEDS", "https://www.ftc.gov/feeds/press-release.xml",
    { source: "FTC", limit: 10, maxAgeHours: 72 });
}

// DOL 美国劳工部：劳工政策与执法。和个股关联弱，靠相关性过滤筛，不开 alwaysPush
async function fetchDol(env) {
  return fetchFeeds(env, "DOL_FEEDS", "https://www.dol.gov/rss/releases.xml",
    { source: "DOL", limit: 10, maxAgeHours: 72 });
}

// BEA 美国经济分析局：GDP、个人收入与消费。宏观事件，直接放行
async function fetchBea(env) {
  return fetchFeeds(env, "BEA_FEEDS", "https://apps.bea.gov/rss/rss.xml",
    { source: "BEA", prefix: "[BEA] ", limit: 12, alwaysPush: true, maxAgeHours: 72 });
}

// EIA 美国能源署：能源数据与报告发布。注意这不是原油库存数值接口，只是发布通知
async function fetchEia(env) {
  return fetchFeeds(env, "EIA_FEEDS",
    "https://www.eia.gov/rss/press_rss.xml,https://www.eia.gov/about/new/WNtest3.php",
    { source: "EIA", prefix: "[EIA] ", limit: 12, maxAgeHours: 72 });
}

// 美国劳工统计局：CPI / 非农 / PPI / JOLTS 四个专项。
// 这四个文件后缀叫 .rss，实际返回的是 Atom（<entry>），靠 parseRssItems 里的 Atom 分支解析。
// 不再用 bls_latest.rss —— 那个 feed 里只有一条"指标看板"常设页，不是事件，天天推一样的废话。
async function fetchBls(env) {
  return fetchFeeds(env, "BLS_FEEDS",
    "https://www.bls.gov/feed/cpi.rss,https://www.bls.gov/feed/empsit.rss,"
    + "https://www.bls.gov/feed/ppi.rss,https://www.bls.gov/feed/jolts.rss",
    { source: "BLS", prefix: "[BLS] ", limit: 6, alwaysPush: true, maxAgeHours: 72 });
}

// ==================== 社交 / 社区源 ====================
// 这些源是"线索和情绪"，不是已证实的新闻。所以：
//   1) 一律不给 alwaysPush，靠相关性过滤，命不中关注范围就不打扰；
//   2) 标题带平台与账号前缀，factStatusOf 会标成"未证实（社区/社交）"，和官方披露区分开。

// Reddit：个股讨论与散户情绪。返回的是 Atom（<entry>），parseRssItems 的 Atom 分支能解析。
// 必须用浏览器 UA —— 阅读器 UA 实测直接 429。
async function fetchReddit(env) {
  const subs = (env.REDDIT_SUBS || "stocks,investing,options,wallstreetbets").split(",")
    .map((s) => s.trim()).filter(Boolean);
  // Reddit 对云厂商 IP 限流很凶：实测一轮连拉 4 个版，前两个 200、后两个直接 429。
  // 改成每轮只拉一个版、按轮换位轮着来，请求量降到 1/4，各版轮流覆盖（4 个版约 24 分钟一轮）。
  // 还必须是浏览器 UA —— 阅读器 UA 实测 429。
  const pick = subs[Math.floor(new Date().getUTCMinutes() / 6) % subs.length];
  return fetchFeed(`https://www.reddit.com/r/${pick}/new/.rss`,
    { source: "Reddit", prefix: `[r/${pick}] `, limit: 12, maxAgeHours: 24 },
    HEADERS["User-Agent"]);
}

// Mastodon：按标签订阅。标签比账号好用于这种场景 —— 不需要猜账号，
// 直接盯关键词（nvidia / semiconductor），命中就说明有人在讨论你关注的东西。
async function fetchMastodon(env) {
  const tags = (env.MASTODON_TAGS || "nvidia,semiconductor").split(",")
    .map((s) => s.trim().toLowerCase()).filter(Boolean);
  const items = [];
  for (const t of tags) {
    items.push(...(await fetchFeed(`https://mastodon.social/tags/${encodeURIComponent(t)}.rss`,
      { source: "Mastodon", prefix: "[Mastodon] ", limit: 10, maxAgeHours: 48 })));
  }
  return items;
}

// YouTube：频道视频 Atom。注意它只给"发了什么视频"的标题，不会把视频内容转成文字新闻。
async function fetchYouTube(env) {
  const ids = (env.YT_CHANNELS || "UCIALMKvObZNtJ6AmdCLP7Lg").split(",")
    .map((s) => s.trim()).filter(Boolean);
  const items = [];
  for (const id of ids) {
    items.push(...(await fetchFeed(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`,
      { source: "YouTube", prefix: "[YouTube] ", limit: 10, maxAgeHours: 72 })));
  }
  return items;
}

// Bluesky：公开 AppView，按账号读最新帖子，无需 Key。
// 注意不能用 searchPosts（实测 403，需要鉴权），只能按账号拉，所以监控对象必须写具体 handle。
async function fetchBluesky(env) {
  const actors = (env.BSKY_ACTORS || "cnbc.com,bloomberg.com,reuters.com").split(",")
    .map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const a of actors) {
    const url = "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed"
      + `?actor=${encodeURIComponent(a)}&limit=15`;
    try {
      const r = await fetch(url, { headers: { ...HEADERS, Accept: "application/json" } });
      const txt = await r.text();
      let j = null;
      try { j = JSON.parse(txt); } catch (e) { j = null; }
      const feed = (j && Array.isArray(j.feed)) ? j.feed : [];
      const got = [];
      for (const f of feed) {
        const post = (f && f.post) || {};
        const rec = post.record || {};
        const text = String(rec.text || "").replace(/\s+/g, " ").trim();
        if (!text) continue;
        const handle = (post.author && post.author.handle) || a;
        // at://did:xxx/app.bsky.feed.post/<rkey> → 取最后一段拼出可点的网页链接
        const rkey = String(post.uri || "").split("/").pop();
        got.push({
          title: `[Bluesky @${handle}] ${text.slice(0, 140)}`,
          content: text.slice(0, 300),
          link: rkey ? `https://bsky.app/profile/${handle}/post/${rkey}`
                     : `https://bsky.app/profile/${handle}`,
          published: isoOf(rec.createdAt || ""),
          source: "Bluesky",
          alwaysPush: false,
          press: false,
        });
      }
      const kept = freshOnly(got, 48);
      FEED_LOG.push({ url: "bsky/" + a, status: r.status, len: txt.length,
                      blocks: 0, entries: feed.length, parsed: got.length, kept: kept.length });
      out.push(...kept);
    } catch (e) {
      FEED_LOG.push({ url: "bsky/" + a, status: "ERR",
                      err: String((e && e.message) || e).slice(0, 90) });
    }
  }
  return out;
}

// ==================== 翻译 & 推送 ====================

async function translate(text) {
  if (!text || !isEnglish(text)) return text;
  try {
    const url = "https://translate.googleapis.com/translate_a/single"
      + `?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(text.slice(0, 500))}`;
    const r = await fetch(url, { headers: HEADERS });
    const data = await r.json();
    return (data[0] || []).map((x) => x[0]).filter(Boolean).join("");
  } catch (e) { return text; }
}

// 批量翻译：把所有文本合并成极少数请求。
// Cloudflare 免费版单次调用限 50 个子请求，逐条翻译会直接超限。
async function translateBatch(texts) {
  const out = [];
  let batch = [], len = 0;
  const flush = async () => {
    if (!batch.length) return;
    try {
      const body = batch.map((t) => "q=" + encodeURIComponent(t)).join("&");
      const r = await fetch("https://translate.googleapis.com/translate_a/t?client=gtx&sl=en&tl=zh-CN",
        { method: "POST", headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" }, body });
      const data = await r.json();
      let arr = Array.isArray(data) ? data : [data];
      arr = arr.map((x) => (Array.isArray(x) ? x[0] : String(x ?? "")));
      while (arr.length < batch.length) arr.push("");
      out.push(...arr.slice(0, batch.length));
    } catch (e) {
      out.push(...batch.map(() => ""));   // 翻译失败回退空串 → 推送时用原文
    }
    batch = []; len = 0;
  };
  for (const t of texts) {
    const s = t.slice(0, 400);
    if (len + s.length > 3500 || batch.length >= 15) await flush();
    batch.push(s); len += s.length;
  }
  await flush();
  return out;
}

// ==================== 利好 / 利空判定 ====================

// 强信号（3 分）：预期对比、评级调整、财报暴雷这类，一条就能定性
const STRONG_BULL = [
  "超预期", "超出预期", "高于预期", "好于预期", "强于预期", "优于预期", "超市场预期",
  "beat", "tops estimates", "above estimates", "raises guidance", "上调指引",
  "上调评级", "上调目标价", "评级上调", "增持评级", "买入评级", "强烈买入", "跑赢大盘", "重申买入",
  "扭亏为盈", "创新高", "回购", "分红", "派息", "降息", "减税",
  // 光看"降息"二字会误判（"降息预期降温"其实是利空），所以预期方向单独列
  "降息预期升温", "降息预期增强", "降息押注", "加大降息", "降息概率上升", "加息预期降温",
];
const STRONG_BEAR = [
  "不及预期", "低于预期", "差于预期", "弱于预期", "逊于预期", "不及市场预期",
  "miss", "misses estimates", "below estimates", "cuts guidance", "下调指引",
  "下调评级", "下调目标价", "评级下调", "减持评级", "卖出评级", "跑输大盘",
  "亏损", "巨亏", "盈警", "预亏", "裁员", "破产", "退市", "召回", "加息", "增税",
  "降息预期降温", "降息预期回落", "降息押注减少", "加息预期升温", "加息押注", "降息概率下降",
];
// 宏观数据的"高低"方向是反的，必须分开判断：
// 通胀类（CPI/PPI/PCE）低 = 降息预期升温 = 利好股市；就业/GDP/零售类高 = 经济强 = 利好
const INFLATION_KEYS = ["cpi", "ppi", "pce", "通胀", "inflation", "物价指数"];
const GROWTH_KEYS = ["非农", "失业金", "失业率", "payroll", "jobless", "gdp", "零售销售",
                     "ism", "pmi", "消费者信心", "密歇根", "耐用品订单", "工业产出", "新屋开工"];
const EXPECT_KEYS = ["低于预期", "不及预期", "差于预期", "弱于预期", "逊于预期", "不及市场预期",
                     "高于预期", "超预期", "超出预期", "好于预期", "强于预期", "优于预期", "超市场预期"];

// 弱信号（1 分）：单独出现不足以定性，要凑够 2 个才算数
const WEAK_BULL = ["合作", "签署", "签约", "达成", "中标", "拿下", "订单", "扩产", "获批", "批准",
                   "增长", "上涨", "反弹", "复苏", "盈利", "加速", "收涨", "走高", "拉升", "涨幅",
                   "突破", "强劲", "乐观", "利好"];
const WEAK_BEAR = ["风险", "警告", "调查", "诉讼", "罚款", "关税", "制裁", "限制", "削减",
                   "延迟", "推迟", "暂停", "下跌", "下滑", "走弱", "担忧", "抛售", "收跌", "走低",
                   "跌幅", "跌破", "新低", "疲软", "放缓", "承压", "利空"];

// 判断利好/利空：强信号一条定性，弱信号要凑够，避免"削减赤字"这类被误判成利空
function judgeBias(text) {
  const t = (text || "").toLowerCase();
  const hit = (arr) => arr.filter((k) => t.includes(k));
  let sb = hit(STRONG_BULL), sbe = hit(STRONG_BEAR);
  const wb = hit(WEAK_BULL), wbe = hit(WEAK_BEAR);

  // 宏观数据：按"通胀看低、增长看高"重新定性，并剔除会误判的通用预期词
  const isInf = INFLATION_KEYS.some((k) => t.includes(k));
  const isGrow = GROWTH_KEYS.some((k) => t.includes(k));
  let note = "";
  if (isInf || isGrow) {
    sb = sb.filter((k) => !EXPECT_KEYS.includes(k));
    sbe = sbe.filter((k) => !EXPECT_KEYS.includes(k));
    if (isInf && (t.includes("低于预期") || t.includes("不及预期") || t.includes("弱于预期"))) {
      sb.push("通胀低于预期"); note = "通胀降温 → 降息预期升温";
    } else if (isInf && (t.includes("高于预期") || t.includes("超预期"))) {
      sbe.push("通胀高于预期"); note = "通胀超预期 → 降息预期降温";
    } else if (isGrow && (t.includes("高于预期") || t.includes("超预期"))) {
      sb.push("数据超预期"); note = "经济数据强于预期";
    } else if (isGrow && (t.includes("低于预期") || t.includes("不及预期"))) {
      sbe.push("数据不及预期"); note = "经济数据弱于预期";
    }
  }
  // 涨跌幅："标普期货涨0.65%"、"跌2.3%" 这类直接给方向（最多算 2 分，避免盖过强信号）
  const up = (t.match(/涨\s*[\d.]+%|涨超[\d.]+%|上涨[\d.]+%/g) || []).length;
  const down = (t.match(/跌\s*[\d.]+%|跌超[\d.]+%|下跌[\d.]+%/g) || []).length;
  const bull = sb.length * 3 + wb.length + Math.min(up, 2);
  const bear = sbe.length * 3 + wbe.length + Math.min(down, 2);
  const score = bull - bear;
  const all = [...sb, ...wb, ...sbe, ...wbe];
  const bullHit = [...sb, ...wb, up ? `涨幅${up}处` : ""].filter(Boolean);
  const bearHit = [...sbe, ...wbe, down ? `跌幅${down}处` : ""].filter(Boolean);
  if (note) { if (score > 0) bullHit.unshift(note); else if (score < 0) bearHit.unshift(note); }
  if (score >= 2 && bull >= 2) return { tag: "📈利好", hit: bullHit.slice(0, 3).join("、"), score };
  if (score <= -2 && bear >= 2) return { tag: "📉利空", hit: bearHit.slice(0, 3).join("、"), score };
  if (bull >= 2 && bear >= 2) return { tag: "⚖️多空交织", hit: all.slice(0, 4).join("、"), score };
  return { tag: "➖中性", hit: "", score };
}

// 预期对比（严格口径版）：
// 必须同指标 + 同口径（同比/环比、总体/核心、GAAP/调整后）才做量化对比；
// 口径冲突或拿不到可核验数字时，只如实说"据该报道高于/低于预期"，绝不硬算。
function expectationVerdict(text) {
  const raw = (text || "").replace(/\s+/g, "");
  if (!raw) return "";

  const isMom = /环比|mom|month-?over-?month/i.test(raw);
  const isYoy = /同比|yoy|year-?over-?year/i.test(raw);
  if (isMom && isYoy) return "口径不一致（同时出现同比与环比）→ 不做量化对比";

  const scope = [];
  if (/核心|core/i.test(raw)) scope.push("核心口径");
  if (isYoy) scope.push("同比");
  if (isMom) scope.push("环比");
  if (/调整后|adjusted|non-?gaap/i.test(raw)) scope.push("调整后");

  const metric = ["cpi", "pce", "ppi", "非农", "失业率", "gdp", "ism", "零售销售", "初请失业金",
    "消费者信心", "密歇根", "工业产出"].find((k) => raw.includes(k))
    || (/营收|revenue/i.test(raw) ? "营收" : "")
    || (/eps|每股/i.test(raw) ? "EPS" : "");

  const bearWords = /不及预期|低于预期|差于预期|弱于预期|逊于预期|miss/i;
  const bullWords = /超预期|超出预期|高于预期|好于预期|强于预期|优于预期|beat|tops/i;
  const qualitative = bearWords.test(raw) ? "不及预期" : (bullWords.test(raw) ? "高于预期" : "");

  const em = raw.match(/预期[^0-9\-]{0,4}(-?\d+(?:\.\d+)?)%/);
  if (!em) {
    if (qualitative) return `据该报道${qualitative}（原文无可核验数字，未做量化对比）`;
    return "";
  }
  const idx = raw.indexOf(em[0]);
  const before = raw.slice(Math.max(0, idx - 30), idx);
  const nums = [...before.matchAll(/(-?\d+(?:\.\d+)?)%/g)].map((m) => parseFloat(m[1]));
  if (!nums.length) {
    return qualitative ? `据该报道${qualitative}（预期值已识别，实际值无法定位，未做对比）` : "";
  }
  const actual = nums[nums.length - 1];
  const exp = parseFloat(em[1]);
  if (!isFinite(actual) || !isFinite(exp) || actual === exp) return "";

  const diff = (actual - exp).toFixed(1);
  const dir = actual > exp ? "高于预期" : "低于预期";
  const tag = scope.length ? `（${scope.join("/")}）` : "（口径未标明）";
  return `${metric ? metric + " " : ""}实际 ${actual}% vs 预期 ${exp}% ${tag} → **${dir}**（${actual > exp ? "+" : ""}${diff} 个百分点）`;
}

// 抽取带数字的关键句（预期值、同比、涨跌幅这类），最多 2 条
function pickDataPoints(text) {
  const s = (text || "").replace(/\s+/g, " ");
  if (!s) return [];
  const parts = s.split(/[。;；\n！!]/).map((x) => x.trim()).filter((x) => x.length > 4);
  const hits = parts.filter((p) => /\d/.test(p)
    && /[%％]|预期|同比|环比|亿美元|万亿|个基点|基点|bps|倍|增长|下降|上涨|下跌|涨|跌/.test(p));
  return hits.slice(0, 2).map((x) => x.slice(0, 70));
}

// 通用发送：把一段 markdown 文本推到所有机器人。
// 主机器人（第一个）送达即算成功，避免一个号挂掉导致反复重推刷爆另一个号。
async function pushText(env, text) {
  const hooks = getHooks(env);
  if (!hooks.length) return { ok: false, hooks: "" };
  if (env.DRY_RUN === "1") {
    console.log(`[DRY_RUN] ${String(text).slice(0, 200)}`);
    return { ok: true, hooks: "dry_run" };
  }
  const results = await Promise.all(hooks.map(async (h) => {
    try {
      const r = await fetch(h, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "markdown", markdown: { content: text } }),
      });
      const j = await r.json();
      return { ok: j.errcode === 0, err: j.errmsg };
    } catch (e) {
      return { ok: false, err: String(e) };
    }
  }));
  return {
    ok: results[0].ok,
    hooks: results.map((r, i) => `${i + 1}:${r.ok ? "ok" : "fail"}`).join(","),
  };
}

async function sendWecom(env, item, level) {
  const imp = item.importance || "一般";
  const emoji = { 重大: "🔴", 重要: "🟠", 一般: "🟢" }[imp] || "🟢";
  const title = item.zhTitle || item.title;              // 批量预翻译结果，无则用原文
  const content = item.content ? (item.zhContent ?? item.content) : "";

  // 用最终中文文本判定方向 + 抽取数据
  const bias = judgeBias(`${title} ${content}`);
  const verdict = expectationVerdict(content || title);
  const points = pickDataPoints(content || title);

  // 机器初判，且允许"暂不判断"——不强行给每条贴利好/利空
  const impactLine = bias.tag === "➖中性"
    ? "暂不判断（未识别到明确方向信号）"
    : `${bias.tag} · 机器初判，股价反应未核实${bias.hit ? `；依据：${bias.hit}` : ""}`;

  const relText = item.relevance || "其他";
  const mid = item.subject ? `｜${prettySubject(item.subject)}` : "";
  const etype = item.etype ? `｜${item.etype}` : "";
  // 同一事件的后续进展单独标注，避免被当成全新事件重复刷屏
  const upd = item.kind === "update"
    ? `\n**更新**：这是「${prettySubject(item.subject) || "该事件"}」的第 ${item.hits || 2} 条相关报道（已合并，非新事件）\n`
    : "";
  // 抓不到正文时明确说明，不拿残缺内容充数
  const bodyMissing = !content && imp === "重大";
  const body = bodyMissing
    ? `${title}\n（正文解析中，暂无摘要；先看来源）`
    : (content && content !== title ? `${title}\n${content}` : title);

  // 发布时间同时给美东和北京：美股看 ET，你这边看北京时间
  const pubLine = item.published
    ? `${item.published} UTC（美东 ${etStr(new Date(item.published + "Z"))}｜北京 ${cnStr(new Date(item.published + "Z"))}）`
    : "来源未提供（不拿抓取时间冒充）";

  // 测试数据必须有明显标记：凡是链接指向 example.com 的都是我自己灌的假数据
  const testMark = /example\.(com|org)/i.test(item.link || "") ? "🧪 **测试数据（非真实消息）**\n" : "";

  const text = `${testMark}${emoji} ${imp}｜${relText}${mid}${etype}\n\n`
    + `**发生了什么**：${body}\n`
    + upd + "\n"
    + (item.impact ? `**为什么推给你**：${item.impact}\n` : "")
    + `**可能影响**：${impactLine}\n`
    + `**事实状态**：${item.factStatus || "媒体报道"}\n`
    + (verdict ? `\n> 对比预期：${verdict}\n` : "")
    + (points.length ? `> 关键数据：${points.join(" ｜ ")}\n` : "")
    + (bias.hit ? `> 信号：${bias.hit}\n` : "")
    + `\n原文：${item.link || "（无）"}\n`
    + `发布：${pubLine}\n`
    + `发现：${etStr(new Date())} ET（北京 ${cnStr(new Date())}）`;

  return await pushText(env, text);
}

// 支持多个机器人：WECOM_WEBHOOK_URLS 用英文逗号分隔，兼容单个 WECOM_WEBHOOK_URL
function getHooks(env) {
  const raw = (env.WECOM_WEBHOOK_URLS || env.WECOM_WEBHOOK_URL || "").replace(/\uFEFF/g, "");
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// 连通性自检：GET /test 会向所有机器人发一条测试消息
async function sendTest(env) {
  const hooks = getHooks(env);
  if (!hooks.length) return { error: "未配置任何 webhook" };
  const text = `✅ **监控机器人已连通**\n\nCloudflare Workers 运行正常，消息将同时推送到 ${hooks.length} 个企业微信机器人。\n\n\`${nowCn()}\``;
  const results = await Promise.all(hooks.map(async (h) => {
    try {
      const r = await fetch(h, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "markdown", markdown: { content: text } }),
      });
      const j = await r.json();
      return { tail: h.slice(-8), ok: j.errcode === 0, err: j.errmsg };
    } catch (e) {
      return { tail: h.slice(-8), ok: false, err: String(e) };
    }
  }));

  // 再发一条"格式示例"：拿当前真实的一条，展示 利好/利空 + 关键数据 的新样式
  let demo = null;
  try {
    const list = await previewItems(env);
    // 挑一条有方向或有数据的，展示效果更直观
    const s = list.find((x) => x.bias !== "➖中性")
      || list.find((x) => (x.data || []).length)
      || list[0];
    if (s) {
      demo = { level: s.level, bias: s.bias, title: s.zhTitle };
      await sleep(1500);   // 避开企业微信 20 条/分钟限流
      await sendWecom(env, {
        title: s.zhTitle, zhTitle: s.zhTitle,
        content: s.zhContent, zhContent: s.zhContent,
        relevance: s.relevance, importance: s.level, factStatus: s.factStatus,
        impact: s.impact, published: s.published,
        link: "（以上为格式示例，非真实推送）",
      }, s.level);
    }
  } catch (e) { demo = { error: String(e) }; }

  return { hooks: hooks.length, results, demo };
}

// ==================== 去重（D1） ====================

async function loadDedup(env) {
  try {
    const { results } = await env.DB.prepare(
      "SELECT hash FROM news_dedup ORDER BY rowid DESC LIMIT ?"
    ).bind(DEDUP_LOOKBACK).all();
    return new Set(results.map((r) => r.hash));
  } catch (e) {
    return new Set();   // 去重不可用时不阻断推送，宁可重复也不丢消息
  }
}

async function saveDedup(env, hashes) {
  if (!hashes.length) return;
  const stmts = hashes.map((h) =>
    env.DB.prepare("INSERT OR IGNORE INTO news_dedup (hash) VALUES (?)").bind(h));
  for (let i = 0; i < stmts.length; i += 50) {
    await env.DB.batch(stmts.slice(i, i + 50));
  }
}

async function pruneDedup(env) {
  await env.DB.prepare(
    "DELETE FROM news_dedup WHERE created_at < datetime('now', ?)"
  ).bind(`-${RETENTION_DAYS} days`).run();
}

// ==================== 观测记录（P0） ====================
// 目的：漏报能查、源失效能发现、延迟能度量。全部写失败也不影响推送。

const ts = (d = new Date()) => d.toISOString().slice(0, 19).replace("T", " ");

// 来源给的发布时间；解析不出来就返回空 —— 不拿抓取时间冒充发布时间
function isoOf(s) {
  if (!s) return "";
  try {
    // pubDate 常被 CDATA 包裹（如 <![CDATA[Thu, 8 Oct 2026 08:30:00 GMT]]>），
    // 不剥掉会解析成 Invalid Date，导致所有 RSS 源都拿不到发布时间
    const clean = String(s).replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
    const d = new Date(clean);
    if (isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 16).replace("T", " ");
  } catch (e) { return ""; }
}

// 连续失败太多次的源（如被 WAF 封死的 GlobeNewswire/BLS）自动停拉，
// 不再每轮浪费子请求预算；源恢复了会被重新记录，但这里只做单向停用。
const DISABLE_STREAK = 50;

// 每个源的访问方式与轮询频率：写进 source_status，源失效时能一眼看出"这源本来该多久拉一次"
const SOURCE_META = {
  "华尔街见闻":    { mode: "api/json", interval: "1min" },
  "美联储-新闻稿": { mode: "rss",      interval: "1min" },
  "美联储-讲话":   { mode: "rss",      interval: "3min" },
  "SEC EDGAR":     { mode: "atom",     interval: "3min" },
  "SEC-按公司轮换": { mode: "atom",     interval: "onfail" },   // 仅全局源失败时启用
  "PR Newswire":   { mode: "rss",      interval: "6min" },
  "GlobeNewswire": { mode: "rss",      interval: "6min" },
  "NVIDIA IR":     { mode: "rss",      interval: "6min" },
  "BLS":           { mode: "atom",     interval: "6min" },   // cpi/empsit/ppi/jolts：后缀 .rss 实为 Atom
  "MarketWatch":   { mode: "rss",      interval: "6min" },
  "Newswire.com":  { mode: "rss",      interval: "6min" },
  "公司IR":        { mode: "rss",      interval: "6min" },   // AMD / Intel / Apple / Microchip
  "Google 博客":   { mode: "rss",      interval: "6min" },
  "Nasdaq 停复牌": { mode: "rss",      interval: "6min" },
  "FTC":           { mode: "rss",      interval: "6min" },
  "DOL":           { mode: "rss",      interval: "6min" },
  "BEA":           { mode: "rss",      interval: "6min" },
  "EIA":           { mode: "rss",      interval: "6min" },
  "Reddit":        { mode: "atom",     interval: "6min" },    // r/*/new/.rss 返回 Atom
  "Mastodon":      { mode: "rss",      interval: "6min" },
  "YouTube":       { mode: "atom",     interval: "6min" },
  "Bluesky":       { mode: "api/json", interval: "6min" },
};

async function sourceStats(env) {
  try {
    const { results } = await env.DB.prepare(
      "SELECT source, ok, fail_streak FROM source_status"
    ).all();
    const off = new Set(), ok = new Map();
    for (const r of results || []) {
      if ((r.fail_streak || 0) >= DISABLE_STREAK) off.add(r.source);
      ok.set(r.source, r.ok === 1);
    }
    return { off, ok };
  } catch (e) { return { off: new Set(), ok: new Map() }; }
}

// 源健康度：请求成功但没新闻不算故障，请求失败才算（fail_streak 累加）
async function withSource(env, name, fn) {
  const before = FEED_LOG.length;
  let items = [];
  try {
    items = (await fn()) || [];
  } catch (e) {
    await recordSource(env, name, false, 0, String(e && e.message || e).slice(0, 80));
    return [];
  }
  const seg = FEED_LOG.slice(before);
  const bad = (s) => s.status === "ERR" || (typeof s.status === "number" && s.status >= 400);
  // 只有"该源所有请求都失败"才算故障。用 some() 的话，一个多 feed 的源（如 PR Newswire
  // 有新闻稿+财报两个）只要其中一个抽风，就会每轮累加 fail_streak，攒够 50 次整源被永久停用
  // —— 明明另一个 feed 还在正常供稿。改成 every()：部分失败只是降级，不算故障。
  const failed = seg.length > 0 && seg.every(bad);
  const badList = seg.filter(bad).map((s) => s.status);
  const note = failed ? String(badList[0] ?? "")
    : (badList.length ? `部分失败 ${badList.join(",")}` : "");
  await recordSource(env, name, !failed, items.length, note);
  return items;
}

async function recordSource(env, source, ok, count, note) {
  try {
    const now = ts();
    const meta = SOURCE_META[source] || { mode: "", interval: "" };
    await env.DB.prepare(
      `INSERT INTO source_status (source, ok, items, fail_streak, last_try_at, last_ok_at, last_content_at, note, mode, interval)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(source) DO UPDATE SET
         ok = excluded.ok,
         items = excluded.items,
         mode = excluded.mode,
         interval = excluded.interval,
         fail_streak = CASE WHEN excluded.ok = 1 THEN 0 ELSE source_status.fail_streak + 1 END,
         last_try_at = excluded.last_try_at,
         last_ok_at = CASE WHEN excluded.ok = 1 THEN excluded.last_try_at ELSE source_status.last_ok_at END,
         last_content_at = CASE WHEN excluded.items > 0 THEN excluded.last_try_at ELSE source_status.last_content_at END,
         note = excluded.note`
    ).bind(source, ok ? 1 : 0, count || 0, ok ? 0 : 1, now, ok ? now : null,
           count > 0 ? now : null, note || "", meta.mode, meta.interval).run();
  } catch (e) { /* 观测失败不阻断推送 */ }
}

// ⑩ 事实准确率自检：能自动验的只有"自洽性"——主体、时间、来源域名对不对得上。
// 数字与口径的真实性无法自动校验，只能靠人工抽查，这里不做假装。
const SOURCE_DOMAIN = {
  "华尔街见闻": "wallstreetcn.com",
  "美联储-新闻稿": "federalreserve.gov",
  "美联储-讲话": "federalreserve.gov",
  "SEC EDGAR": "sec.gov",
  "PR Newswire": "prnewswire.com",
  "GlobeNewswire": "globenewswire.com",
  "NVIDIA IR": "nvidianews.nvidia.com",
  "BLS": "bls.gov",
};

function factCheck(it, foundAt) {
  const issues = [];
  const title = (it.title || "").toLowerCase();
  const subjectOk = !it.subject || title.includes(String(it.subject).toLowerCase());
  if (!subjectOk) issues.push("主体未出现在标题中");

  let timeOk = true;
  if (!it.published) { issues.push("来源未提供发布时间"); timeOk = false; }
  else {
    const p = Date.parse(it.published + "Z"), f = Date.parse(foundAt + "Z");
    if (isFinite(p) && isFinite(f) && p > f + 300000) { issues.push("发布时间晚于发现时间"); timeOk = false; }
    else if (isFinite(p) && isFinite(f) && f - p > 7 * 86400000) { issues.push("发布时间距今超过7天"); timeOk = false; }
  }

  const dom = SOURCE_DOMAIN[it.source];
  let sourceOk = true;
  if (!it.link) { issues.push("无原文链接"); sourceOk = false; }
  else if (dom && !String(it.link).toLowerCase().includes(dom)) { issues.push(`链接域名与来源「${it.source}」不符`); sourceOk = false; }

  return { subjectOk, timeOk, sourceOk, ok: issues.length === 0, issues };
}

async function recordFactCheck(env, fp, it, foundAt) {
  const c = factCheck(it, foundAt);
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO fact_check (fp,subject,subject_ok,time_ok,source_ok,issues,checked_at)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(fp, it.subject || "", c.subjectOk ? 1 : 0, c.timeOk ? 1 : 0, c.sourceOk ? 1 : 0,
           c.issues.join("；"), ts()).run();
  } catch (e) { }
  return c;
}

// 被过滤的内容：用来抽查"没推给你的"，比只看推送更容易发现漏报
async function recordDropped(env, rows) {
  if (!rows || !rows.length) return;
  const stmts = rows.slice(0, 30).map(([fp, title, source, reason]) =>
    env.DB.prepare("INSERT OR IGNORE INTO dropped (fp,title,source,reason) VALUES (?,?,?,?)")
      .bind(fp, String(title || "").slice(0, 180), source || "", reason));
  try { for (let i = 0; i < stmts.length; i += 25) await env.DB.batch(stmts.slice(i, i + 25)); } catch (e) { }
}

// ==================== 美东时间 ====================
// 汇总时段全部按美东时间算，自动跟随夏令时（不写死 -5/-4）。
// 注：ET 只用于汇总窗口；推送没有做"盘前盘后分级"，任何时段的重大事件都会即时推送。

function tzParts(tz, d) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d);
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return { y: g("year"), mo: g("month"), d: g("day"), h: g("hour"), mi: g("minute"), s: g("second") };
}

function tzOffsetMs(tz, d) {
  const p = tzParts(tz, d);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - d.getTime();
}

// 把"美东当地 Y/M/D H:M"换算成真实的 UTC 时刻
function etToDate(y, mo, d, h = 0, mi = 0, s = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  return new Date(guess - tzOffsetMs(ET, new Date(guess)));
}

const utcStr = (d) => d.toISOString().slice(0, 19).replace("T", " ");
const pad2 = (n) => String(n).padStart(2, "0");
const etStr = (d) => {
  const p = tzParts(ET, d);
  return `${pad2(p.mo)}/${pad2(p.d)} ${pad2(p.h)}:${pad2(p.mi)}`;
};
const cnStr = (d) => {
  const p = tzParts(TZ, d);
  return `${pad2(p.mo)}/${pad2(p.d)} ${pad2(p.h)}:${pad2(p.mi)}`;
};

// ==================== 事件化（以事件为中心） ====================
// 同一主体 + 同一事件类型 = 同一个事件。合并同源报道、记录版本、限制重复打扰。

const SUBJECT_MACRO = ["cpi", "pce", "ppi", "非农", "失业率", "gdp", "ism", "零售销售",
  "初请失业金", "消费者信心", "密歇根", "工业产出", "联邦基金利率", "点阵图", "褐皮书",
  "国债收益率", "美债收益率", "通胀"];

const ETYPE_RULES = [
  // 美联储自己的新闻稿/讲话一律算货币政策口径，标题常常只有演讲名（如 "Cook, The Dual Mandate..."）
  ["货币政策", /\[fed|美联储|议息|利率决议|降息|加息|fomc|点阵图|褐皮书|联邦基金利率|fed funds|rate cut|rate hike|货币政策/],
  ["宏观数据", /cpi|pce|ppi|非农|失业率|gdp|ism|零售销售|初请失业金|消费者信心|密歇根|工业产出|pmi|经济数据/],
  ["业绩指引", /指引|guidance|业绩预告|盈警|盈喜|预亏|预增|下调.*预期|上调.*预期/],
  ["财报业绩", /财报|业绩|季报|年报|earnings|quarterly results|financial results|营收|净利|eps/],
  ["评级调整", /评级|目标价|upgrade|downgrade|price target|首次覆盖|分析师/],
  ["并购重组", /并购|收购|被收购|acquir|merger|退市|破产|重组|拆分/],
  ["人事变动", /ceo|cfo|辞职|卸任|任命|resign|step down|appoint|裁员|罢工/],
  ["监管诉讼", /监管|诉讼|罚款|处罚|调查|反垄断|出口管制|禁令|制裁|关税|许可证|合规/],
  ["融资回购", /融资|募资|增发|配股|ipo|回购|分红|派息|buyback|dividend/],
  ["订单合作", /订单|签约|合作|中标|供应|采购|扩产|产能|备忘录|partnership|agreement|contract|deal/],
  ["产品发布", /发布|推出|量产|交付|出货|新品|上市/],
  ["披露文件", /8-k|6-k|sc 13d|sc 13g|10-k|10-q/],
  ["股价异动", /异动|大涨|大跌|暴涨|暴跌|创新高|新低|熔断|停牌|闪崩/],
];

// 主体只在标题上认定：正文顺带提到的公司不能当事件主体
function subjectOf(title, core, HOLD, THEME) {
  const t = (title || "").toLowerCase();
  // 按优先级依次试：核心公司 > 持仓 > 宏观指标 > 主题
  return hitWhich(t, core, true) || hitWhich(t, HOLD, true)
      || hitWhich(t, SUBJECT_MACRO, true) || hitWhich(t, THEME, true) || "";
}

function eventTypeOf(text) {
  for (const [name, re] of ETYPE_RULES) if (re.test(text)) return name;
  return "其他动态";
}

// 没有识别出主体时不强行合并：用标题片段做 key，几乎不会撞车
async function eventKeyOf(it, subject, etype) {
  const base = subject ? `${subject}|${etype}` : `raw|${(it.title || "").toLowerCase().slice(0, 40)}`;
  return (await hashTitle(base)).slice(0, 16);
}

const LEVEL_RANK = { 重大: 0, 重要: 1, 一般: 2 };
const maxLevel = (a, b) => (LEVEL_RANK[a] ?? 9) <= (LEVEL_RANK[b] ?? 9) ? a : b;

// 主体显示名：名单里存的是小写别名，直接印出来不好看（wdc / micron），映射成中文或大写
const PRETTY_SUBJECT = {
  wdc: "西部数据", "western digital": "西部数据", micron: "美光", "micron technology": "美光",
  seagate: "希捷", sandisk: "闪迪", "sk hynix": "SK海力士",
  nvidia: "英伟达", tsmc: "台积电", "taiwan semiconductor": "台积电", intel: "英特尔",
  amd: "AMD", "advanced micro": "AMD", broadcom: "博通", qualcomm: "高通", arm: "ARM",
  "arm holdings": "ARM", "super micro": "超微电脑", dell: "戴尔", apple: "苹果",
  microsoft: "微软", alphabet: "谷歌", amazon: "亚马逊", "meta platforms": "Meta",
  netflix: "奈飞", tesla: "特斯拉", palantir: "Palantir", coinbase: "Coinbase",
  cpi: "CPI", pce: "PCE", ppi: "PPI", gdp: "GDP", ism: "ISM", 非农: "非农", 失业率: "失业率",
  "初请失业金": "初请失业金", "零售销售": "零售销售", "联邦基金利率": "联邦基金利率",
  "点阵图": "点阵图", "国债收益率": "美债收益率", "美债收益率": "美债收益率",
  比特币: "比特币", 黄金: "黄金", 原油: "原油",
};
function prettySubject(s) {
  if (!s) return "";
  const k = String(s).toLowerCase();
  if (PRETTY_SUBJECT[k]) return PRETTY_SUBJECT[k];
  return /^[a-z0-9 .\-]{1,6}$/.test(k) ? s.toUpperCase() : s;
}

// ==================== 事件表 / 流水 / 队列（D1） ====================

async function upsertEvent(env, ev) {
  try {
    const row = await env.DB.prepare(
      "SELECT hits, versions, pushed, last_title, level, last_seen FROM events WHERE ekey = ?"
    ).bind(ev.ekey).first();
    // 超过合并窗口的旧事件：主体+类型相同也不再算同一件事
    // （否则 WDC 十月的指引和明年一月的指引会被当成一个事件，新事件被误判成"更新"）
    if (row && row.last_seen
        && Date.parse(row.last_seen + "Z") < Date.now() - EVENT_MERGE_HOURS * 3600 * 1000) {
      await env.DB.prepare(
        `UPDATE events SET title=?, last_title=?, level=?, relevance=?, fact_status=?,
                first_seen=?, last_seen=?, last_link=?, hits=1, versions=1, pushed=0 WHERE ekey=?`
      ).bind(ev.title, ev.title, ev.level, ev.relevance, ev.factStatus, ev.now, ev.now, ev.link, ev.ekey).run();
      return { isNew: true, hits: 1, versions: 1, pushed: 0, prevLevel: "" };
    }
    if (!row) {
      await env.DB.prepare(
        `INSERT INTO events (ekey,subject,etype,title,last_title,level,relevance,fact_status,first_seen,last_seen,hits,versions,pushed,last_link)
         VALUES (?,?,?,?,?,?,?,?,?,?,1,1,0,?)`
      ).bind(ev.ekey, ev.subject, ev.etype, ev.title, ev.title, ev.level, ev.relevance,
             ev.factStatus, ev.now, ev.now, ev.link).run();
      return { isNew: true, hits: 1, versions: 1, pushed: 0, prevLevel: "" };
    }
    // 标题发生实质变化（不是简单的互相包含）才算一个新版本
    const prev = row.last_title || "";
    const changed = !!prev && ev.title !== prev && !ev.title.includes(prev) && !prev.includes(ev.title);
    await env.DB.prepare(
      `UPDATE events SET last_title=?, level=?, relevance=?, fact_status=?, last_seen=?, last_link=?,
              hits = hits + 1, versions = versions + ?
       WHERE ekey = ?`
    ).bind(ev.title, maxLevel(row.level, ev.level), ev.relevance, ev.factStatus,
           ev.now, ev.link, changed ? 1 : 0, ev.ekey).run();
    return { isNew: false, hits: row.hits + 1, versions: row.versions + (changed ? 1 : 0),
             pushed: row.pushed || 0, prevLevel: row.level || "" };
  } catch (e) {
    return { isNew: true, hits: 1, versions: 1, pushed: 0, prevLevel: "" };
  }
}

async function recordItemsLog(env, rows) {
  if (!rows || !rows.length) return;
  try {
    const stmts = rows.map((r) => env.DB.prepare(
      `INSERT OR IGNORE INTO items_log
       (fp,ekey,title,content,zh_title,zh_content,source,link,level,relevance,fact_status,impact,bias,subject,etype,accession,published_at,found_at,pushed)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(r.fp, r.ekey, String(r.title || "").slice(0, 300), String(r.content || "").slice(0, 800),
           r.zhTitle || "", r.zhContent || "", r.source || "", r.link || "", r.level || "",
           r.relevance || "", r.factStatus || "", r.impact || "", r.bias || "", r.subject || "",
           r.etype || "", r.accession || "", r.published || null, r.foundAt, r.pushed ? 1 : 0));
    for (let i = 0; i < stmts.length; i += 25) await env.DB.batch(stmts.slice(i, i + 25));
  } catch (e) { /* 留档失败不阻断推送 */ }
}

async function enqueue(env, rows) {
  if (!rows || !rows.length) return;
  try {
    const stmts = rows.map((r) => env.DB.prepare(
      `INSERT INTO outbox (kind,ekey,fp,level,payload,status,created_at,next_try_at) VALUES (?,?,?,?,?,'pending',?,?)`
    ).bind(r.kind, r.ekey, r.fp, r.level, JSON.stringify(r.payload), r.now, r.now));
    for (let i = 0; i < stmts.length; i += 25) await env.DB.batch(stmts.slice(i, i + 25));
  } catch (e) { }
}

async function markItemPushed(env, fp, zhTitle = "", zhContent = "") {
  try {
    await env.DB.prepare("UPDATE items_log SET pushed = 1, zh_title = ?, zh_content = ? WHERE fp = ?")
      .bind(zhTitle, zhContent, fp).run();
  } catch (e) { }
}

// ==================== 发送（与采集分离） ====================
// 只从 outbox 取 pending 发送：失败留在队列重试，积压过多转进汇总。

async function dispatchOutbox(env, limit) {
  const stats = { picked: 0, sent: 0, failed: 0, folded: 0, untranslated: 0 };
  const now = ts();

  // 积压保护：待发太多时，除最新 5 条外"一般"级全部转汇总，不再逐条打扰
  try {
    const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'").first();
    if (cnt && cnt.n > OUTBOX_FOLD_THRESHOLD) {
      const r = await env.DB.prepare(
        `UPDATE outbox SET status = 'folded' WHERE status = 'pending' AND level = '一般'
         AND id NOT IN (SELECT id FROM outbox WHERE status = 'pending' AND level = '一般' ORDER BY id DESC LIMIT 5)`
      ).run();
      stats.folded = r?.meta?.changes ?? r?.changes ?? 0;
    }
  } catch (e) { }

  let rows = [];
  try {
    ({ results: rows } = await env.DB.prepare(
      `SELECT * FROM outbox WHERE status = 'pending' AND (next_try_at IS NULL OR next_try_at <= ?)
       ORDER BY CASE level WHEN '重大' THEN 0 WHEN '重要' THEN 1 ELSE 2 END, id ASC LIMIT ?`
    ).bind(now, limit).all());
  } catch (e) { return stats; }
  if (!rows.length) return stats;
  stats.picked = rows.length;

  // 批量预翻译本批（1-2 个子请求）
  const texts = [];
  for (const row of rows) {
    let it = null;
    try { it = JSON.parse(row.payload); } catch (e) { }
    if (!it) continue;
    row._it = it;
    if (isEnglish(it.title)) texts.push(it.title);
    if (it.content && isEnglish(it.content)) texts.push(it.content);
  }
  const tr = texts.length ? await translateBatch(texts) : [];
  let ti = 0;
  for (const row of rows) {
    const it = row._it;
    if (!it) continue;
    if (isEnglish(it.title)) it.zhTitle = tr[ti++] || "";
    if (it.content && isEnglish(it.content)) it.zhContent = tr[ti++] ?? "";
    row.usable = (!isEnglish(it.title) || !!it.zhTitle)
      && (!it.content || !isEnglish(it.content) || !!it.zhContent);
  }

  for (const row of rows) {
    const it = row._it;
    if (!it) continue;
    if (!row.usable) {
      stats.untranslated++;              // 翻译没出来就先不发，留队列下轮重试
      continue;
    }
    const r = await sendWecom(env, it, row.level);
    const tries = (row.tries || 0) + 1;
    try {
      if (r && r.ok) {
        await env.DB.prepare(
          "UPDATE outbox SET status='sent', sent_at=?, tries=?, hooks_ok=? WHERE id=?"
        ).bind(ts(), tries, r.hooks || "", row.id).run();
        await env.DB.prepare("UPDATE events SET pushed = pushed + 1 WHERE ekey = ?").bind(row.ekey).run();
        await markItemPushed(env, row.fp, it.zhTitle || "", it.zhContent || "");
        const fc = await recordFactCheck(env, row.fp, it, row.created_at);
        if (!fc.ok) stats.factIssues = (stats.factIssues || 0) + 1;
        stats.sent++;
      } else if (tries >= 5) {
        await env.DB.prepare(
          "UPDATE outbox SET status='failed', tries=?, hooks_ok=? WHERE id=?"
        ).bind(tries, (r && r.hooks) || "", row.id).run();
        stats.failed++;
      } else {
        const delayMin = Math.min(2 ** tries, 30);
        await env.DB.prepare(
          "UPDATE outbox SET tries=?, next_try_at=datetime('now', ?) WHERE id=?"
        ).bind(tries, `+${delayMin} minutes`, row.id).run();
        stats.failed++;
      }
    } catch (e) { }
    await sleep(PUSH_INTERVAL_MS);
  }
  return stats;
}

// ==================== 定时汇总 ====================

async function digestSent(env, slot) {
  try {
    const r = await env.DB.prepare("SELECT slot FROM digests WHERE slot = ?").bind(slot).first();
    return !!r;
  } catch (e) { return false; }
}

// 窗口起点：daily=昨天 16:00 ET（收盘）→ 现在；weekend=最近一个周五 16:00 ET → 现在
function digestWindow(kind, now) {
  const e = tzParts(ET, now);
  // 直接在"美东日历"上做日期加减：e 是美东当地日期，
  // 不能再过一遍 UTC→ET 转换，否则会被时区偏移带偏一天。
  const etDay = (backDays) => {
    const d = new Date(Date.UTC(e.y, e.mo - 1, e.d - backDays));
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
  };
  if (kind === "weekend") {
    const dow = new Date(Date.UTC(e.y, e.mo - 1, e.d)).getUTCDay();   // 0=周日
    let back = (dow - 5 + 7) % 7;                                     // 周日→2，周六→1，周五→0
    if (back === 0 && e.h < 16) back = 7;                             // 周五收盘前，取上周五
    const f = etDay(back);
    return { start: etToDate(f.y, f.mo, f.d, 16, 0, 0), label: "周五盘后 → 周日夜盘", title: "周末速览", icon: "🏖" };
  }
  const y = etDay(1);
  return { start: etToDate(y.y, y.mo, y.d, 16, 0, 0), label: "昨日盘后 → 今晨盘前", title: "隔夜速览", icon: "🌙" };
}

async function buildDigest(env, kind) {
  const now = new Date();
  const w = digestWindow(kind, now);
  const from = utcStr(w.start);
  const to = utcStr(now);

  let rows = [];
  try {
    ({ results: rows } = await env.DB.prepare(
      `SELECT * FROM items_log WHERE found_at >= ? AND found_at <= ?
       ORDER BY CASE level WHEN '重大' THEN 0 WHEN '重要' THEN 1 ELSE 2 END, found_at DESC`
    ).bind(from, to).all());
  } catch (e) { rows = []; }

  let droppedN = 0;
  try {
    const d = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM dropped WHERE created_at >= ? AND created_at <= ?"
    ).bind(from, to).first();
    droppedN = d?.n || 0;
  } catch (e) { }

  // 同一事件合并：只出一条，标注相关条数
  const byKey = new Map();
  for (const r of rows) {
    const k = r.ekey || r.fp;
    if (!byKey.has(k)) byKey.set(k, { ...r, n: 1 });
    else byKey.get(k).n++;
  }
  const uniq = [...byKey.values()];

  // 只翻译会出现在报告里的条目
  const show = uniq.slice(0, 40);
  const texts = [];
  for (const o of show) if (isEnglish(o.title)) texts.push(o.title);
  const tr = texts.length ? await translateBatch(texts) : [];
  let ti = 0;
  for (const o of show) {
    o.dispTitle = isEnglish(o.title) ? (tr[ti++] || o.title) : o.title;
  }

  const major = uniq.filter((x) => x.level === "重大");
  const imp = uniq.filter((x) => x.level === "重要");
  const rest = uniq.filter((x) => x.level !== "重大" && x.level !== "重要");

  // 情绪：来自已入库的机器初判，只做计数不装作结论
  const bull = uniq.filter((x) => (x.bias || "").includes("利好")).length;
  const bear = uniq.filter((x) => (x.bias || "").includes("利空")).length;
  const mood = bull + bear === 0 ? "无明显方向信号"
    : (bull > bear * 1.5 ? "偏多" : bear > bull * 1.5 ? "偏空" : "多空交织");

  const clip = (s, n) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  };
  // 每行带美东时间：睡觉时发生的事，时间顺序是关键信息
  const line = (o) => {
    const t = o.found_at ? tzParts(ET, new Date(o.found_at + "Z")) : null;
    const time = t ? `${pad2(t.h)}:${pad2(t.mi)} ` : "";
    const subj = o.subject ? `${clip(prettySubject(o.subject), 10)}｜` : "";
    const more = o.n > 1 ? `（${o.n} 条相关）` : "";
    // 已经即时推送过的标出来，免得你以为"这条怎么又发一遍"
    const seen = o.pushed == 1 ? "（已推）" : "";
    return `· ${time}${subj}${clip(o.dispTitle, 52)}${more}${seen}`;
  };

  const L = [];
  L.push(`${w.icon} **${w.title}｜${etStr(now)} ET（北京 ${cnStr(now)}）**`);
  L.push(`窗口：${etStr(w.start)} → ${etStr(now)} ET（${w.label}）`);
  L.push("");

  if (!uniq.length) {
    L.push("**一句话**：这段时间内没有进入监控范围的消息。");
    L.push("");
    L.push(`期间过滤掉 ${droppedN} 条噪音/无关内容。`);
  } else {
    const head = major.length
      ? `${major.length} 条重大、${imp.length} 条重要；最值得看：${clip(major[0].dispTitle, 40)}`
      : (imp.length ? `没有重大事件，${imp.length} 条重要；最值得看：${clip(imp[0].dispTitle, 40)}`
                    : `无重大/重要事件，${rest.length} 条一般动态`);
    L.push(`**一句话**：${head}`);
    L.push(`**情绪**（机器初判，仅供参考）：${mood}｜利好 ${bull} / 利空 ${bear}`);
    L.push("");

    if (major.length) {
      L.push(`**■ 必须知道（${major.length}）**`);
      for (const o of major.slice(0, 8)) L.push(line(o));
      L.push("");
    }
    if (imp.length) {
      L.push(`**■ 重要（${imp.length}）**`);
      for (const o of imp.slice(0, 10)) L.push(line(o));
      L.push("");
    }
    const macro = rest.filter((x) => x.relevance === "全市场" || /货币政策|宏观数据/.test(x.etype || ""));
    if (macro.length) {
      L.push(`**■ 宏观 / 政策（${macro.length}）**`);
      for (const o of macro.slice(0, 8)) L.push(line(o));
      L.push("");
    }
    const comp = rest.filter((x) => !macro.includes(x));
    if (comp.length) {
      L.push(`**■ 公司 / 行业（${comp.length}）**`);
      for (const o of comp.slice(0, 8)) L.push(line(o));
      if (comp.length > 8) L.push(`（其余 ${comp.length - 8} 条已折叠）`);
      L.push("");
    }
    L.push(`共 ${uniq.length} 条（原始 ${rows.length} 条合并同名事件）｜期间过滤 ${droppedN} 条`);
  }

  let text = L.join("\n");
  if (text.length > 3600) text = text.slice(0, 3550) + "\n…（已截断，完整流水见 /audit）";
  return { text, items: uniq.length, from, to };
}

async function sendDigest(env, kind, slot) {
  const d = await buildDigest(env, kind);
  const r = await pushText(env, d.text);
  // 推送失败绝不能记账：一旦记进 digests，digestSent 就永远返回 true，
  // 这个时段的汇总再也不会重试 —— 等于被永久吞掉。不记账，下一分钟 cron 会再试。
  if (!r.ok) return { kind, slot, items: d.items, hooks: r.hooks, ok: false };
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO digests (slot,kind,window_from,window_to,items,hooks_ok,sent_at) VALUES (?,?,?,?,?,?,?)`
    ).bind(slot, kind, d.from, d.to, d.items, r.hooks || "", ts()).run();
  } catch (e) { }
  return { kind, slot, items: d.items, hooks: r.hooks, ok: true };
}

// 每分钟检查一次；错过整点会补发（当天/当周只发一次）
async function maybeDigest(env) {
  const e = tzParts(ET, new Date());
  const date = `${e.y}-${pad2(e.mo)}-${pad2(e.d)}`;
  const out = [];
  const dailyHour = Number(env.DAILY_DIGEST_HOUR ?? DAILY_DIGEST_HOUR);
  const weekendHour = Number(env.WEEKEND_DIGEST_HOUR ?? WEEKEND_DIGEST_HOUR);

  if (e.h >= dailyHour) {
    const slot = `${date}-daily`;
    if (!(await digestSent(env, slot))) out.push(await sendDigest(env, "daily", slot));
  }
  if (e.h >= weekendHour) {
    const dow = new Date(Date.UTC(e.y, e.mo - 1, e.d)).getUTCDay();
    if (dow === WEEKEND_DIGEST_DOW) {
      const slot = `${date}-weekend`;
      if (!(await digestSent(env, slot))) out.push(await sendDigest(env, "weekend", slot));
    }
  }
  return out;
}

// ==================== 主流程 ====================

async function runMonitor(env, all = false) {
  const stats = { total: 0, urgent: 0, important: 0, general: 0, pushed: 0, skipped: 0 };
  if (!getHooks(env).length) return { error: "未配置 webhook（wrangler secret put WECOM_WEBHOOK_URLS）" };

  const seen = await loadDedup(env);
  // 源分组轮转：免费版单次调用限 50 个子请求，不能每分钟把 13 个源全拉一遍。
  // 华尔街见闻 + 美联储每分钟都拉（主力源），其余三组按分钟轮流。
  const m = new Date().getUTCMinutes();
  const { off, ok } = await sourceStats(env);
  if (off.size) stats.disabled = [...off];
  const run = (name, fn) => (off.has(name) ? [] : withSource(env, name, fn));

  // ⑨ 分级轮询：核心源每分钟；官方披露与讲话每 3 分钟；行业/新闻稿平台每 6 分钟。
  // 免费版单次调用只有 50 个子请求，全量每分钟拉会把预算吃光。
  const due = {
    "SEC EDGAR":     all || m % 3 === 0,
    "美联储-讲话":   all || m % 3 === 1,
    "PR Newswire":   all || m % 6 === 2,
    "GlobeNewswire": all || m % 6 === 2,
    "NVIDIA IR":     all || m % 6 === 5,
    // 新增源按分钟打散到 6 个槽位，避免某一分钟把 50 个子请求预算吃光
    "MarketWatch":   all || m % 6 === 0,
    "公司IR":        all || m % 6 === 1,
    "Newswire.com":  all || m % 6 === 2,
    "Nasdaq 停复牌": all || m % 6 === 3,
    "FTC":           all || m % 6 === 3,
    "BEA":           all || m % 6 === 4,
    "BLS":           all || m % 6 === 4,
    "Google 博客":   all || m % 6 === 5,
    "DOL":           all || m % 6 === 5,
    "EIA":           all || m % 6 === 5,
    // 社交源同样打散：Reddit 一次要拉 4 个版，单独占一个槽位
    "Reddit":        all || m % 6 === 0,
    "Mastodon":      all || m % 6 === 1,
    "Bluesky":       all || m % 6 === 2,
    "YouTube":       all || m % 6 === 3,
  };
  stats.group = Object.keys(due).filter((k) => due[k]).join(",") || "-";

  const items = [
    ...(await run("华尔街见闻", () => fetchWallstreet(env))),
    ...(await run("美联储-新闻稿", () => fetchFed())),
  ];
  if (due["美联储-讲话"]) items.push(...(await run("美联储-讲话", () => fetchFedSpeeches())));
  if (due["SEC EDGAR"]) {
    const got = await run("SEC EDGAR", () => fetchSec(env));
    items.push(...got);
    // 全局源确认失败（而不是"确实没有新披露"）时，按核心公司轮转兜底，
    // 否则这一轮会静悄悄漏掉披露 —— 静默失败比报错更坑
    if (ok.get("SEC EDGAR") === false) {
      // 兜底只轮转"你真正关心的公司"，不按观察名单字母序抽（那会抽到迪士尼、波音这类无关的）
      const watch = (env.SEC_CORE_ROTATE
        || "western digital,nvidia,micron technology,tesla,amd,intel,broadcom,apple")
        .split(",").map((s) => s.trim()).filter(Boolean);
      const batch = secRotateBatch(watch, m);
      if (batch.length) {
        items.push(...(await withSource(env, "SEC-按公司轮换", () => fetchSecByCompany(env, batch))));
        stats.secFailover = batch;
      }
    }
  }
  if (due["PR Newswire"]) items.push(...(await run("PR Newswire", () => fetchPr(env))));
  if (due["GlobeNewswire"]) items.push(...(await run("GlobeNewswire", () => fetchGlobe(env))));
  if (due["NVIDIA IR"]) items.push(...(await run("NVIDIA IR", () => fetchNvidia(env))));
  // 人口普查局已停用：内容和美股关联度太低（推出来都是无用统计）
  if (due["BLS"]) items.push(...(await run("BLS", () => fetchBls(env))));
  if (due["MarketWatch"]) items.push(...(await run("MarketWatch", () => fetchMarketWatch(env))));
  if (due["公司IR"]) items.push(...(await run("公司IR", () => fetchCompanyIR(env))));
  if (due["Newswire.com"]) items.push(...(await run("Newswire.com", () => fetchNewswire(env))));
  if (due["Nasdaq 停复牌"]) items.push(...(await run("Nasdaq 停复牌", () => fetchNasdaqHalts(env))));
  if (due["FTC"]) items.push(...(await run("FTC", () => fetchFtc(env))));
  if (due["BEA"]) items.push(...(await run("BEA", () => fetchBea(env))));
  if (due["Google 博客"]) items.push(...(await run("Google 博客", () => fetchGoogleBlog(env))));
  if (due["DOL"]) items.push(...(await run("DOL", () => fetchDol(env))));
  if (due["EIA"]) items.push(...(await run("EIA", () => fetchEia(env))));
  if (due["Reddit"]) items.push(...(await run("Reddit", () => fetchReddit(env))));
  if (due["Mastodon"]) items.push(...(await run("Mastodon", () => fetchMastodon(env))));
  if (due["Bluesky"]) items.push(...(await run("Bluesky", () => fetchBluesky(env))));
  if (due["YouTube"]) items.push(...(await run("YouTube", () => fetchYouTube(env))));
  stats.total = items.length;
  stats.bySource = items.reduce((a, it) => { a[it.source] = (a[it.source] || 0) + 1; return a; }, {});

  const userWatch = (env.WATCH_KEYWORDS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  // 核心关注公司（等你的名单；现在沿用旧 FOCUS_COMPANIES 占位）
  const core = (env.CORE_COMPANIES || env.FOCUS_COMPANIES || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).concat(userWatch);
  const sector = (env.SECTOR_KEYWORDS || SECTOR_DEFAULT)
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  // B 层持仓 / C 层主题：wrangler.toml 里可覆盖，留空则用代码里的默认名单
  const holdings = (env.HOLDINGS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const theme = (env.THEME_KEYWORDS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const HOLD = holdings.length ? holdings : HOLDINGS_DEFAULT;
  const THEME = theme.length ? theme : THEME_DEFAULT;

  const candidates = [];
  const drops = [];
  const now = ts();
  for (const it of items) {
    if (!it.title || it.title.length < 8) { stats.skipped++; continue; }
    // SEC 文件用 accession 做指纹：同一份文件从不同路径进来不会重复推送
    const acc = it.source === "SEC EDGAR" ? accessionOf(it.link) : "";
    const fp = await hashTitle(acc ? `sec:${acc}` : it.title);
    it.accession = acc;
    if (seen.has(fp)) { stats.dup = (stats.dup || 0) + 1; stats.skipped++; continue; }
    const full = `${it.title || ""} ${it.content || ""}`.toLowerCase();

    // 1) 噪声 / 无实质内容
    if (!isSubstantive(it)) { drops.push([fp, it.title, it.source, "noise_or_empty"]); stats.noisy = (stats.noisy || 0) + 1; stats.skipped++; continue; }
    // 2) 相关性：跟你的关注范围无关
    const rel = relevanceOf(it, core, sector, HOLD, THEME);
    if (!rel) { drops.push([fp, it.title, it.source, "no_relevance"]); stats.noRel = (stats.noRel || 0) + 1; stats.skipped++; continue; }
    // 3) 重要性：没有值得打扰你的事件
    const imp = importanceOf(it, full, rel);
    if (!imp) { drops.push([fp, it.title, it.source, "no_event"]); stats.noEvent = (stats.noEvent || 0) + 1; stats.skipped++; continue; }
    // 4) 门槛：重大/重要直接推；"一般"必须有方向或有数据，否则进不了即时推送
    const bias = judgeBias(full);
    const hasData = !!expectationVerdict(full) || pickDataPoints(it.content || it.title).length > 0;
    // 信号弱（一般级 + 中性 + 没有可核验数据）：不够格打扰你，但也不该丢掉 ——
    // 改成留档进汇总，只是不即时推送。原来这里直接 continue 丢弃，汇总里一条都看不到，
    // 真漏报了也没人发现。你要的是"信息越多越好"，那就都进汇总，由你自己扫一眼。
    const weak = imp === "一般" && bias.tag === "➖中性" && !hasData;
    if (weak) stats.noSignal = (stats.noSignal || 0) + 1;

    // 5) 事件化：提取主体与事件类型 → 同源合并
    const subject = subjectOf(it.title, core, HOLD, THEME);
    const etype = eventTypeOf(full);
    const ekey = await eventKeyOf(it, subject, etype);
    it.relevance = rel;
    it.importance = imp;
    it.factStatus = factStatusOf(full, it);
    it.impact = impactReasonOf(rel, it, full);
    it.subject = subject;
    it.etype = etype;

    const ev = await upsertEvent(env, {
      ekey, subject, etype, title: it.title, level: imp, relevance: rel,
      factStatus: it.factStatus, link: it.link || "", now,
    });

    // 6) 决定提醒方式：新事件立刻报；同事件已有报道则只发一次更新；再往后交给汇总
    let kind = "alert";
    if (!ev.isNew) {
      if (ev.pushed >= EVENT_MAX_PUSH) kind = "fold";        // 已刷过，只留档
      else kind = "update";
    }
    if (weak) kind = "fold";   // 信号弱：只进汇总，不即时推送（不占用打扰额度）
    it.kind = kind;
    it.hits = ev.hits;

    stats[imp] = (stats[imp] || 0) + 1;
    candidates.push({ it, fp, ekey, level: imp, bias, rel, kind, subject, etype, acc });
  }
  await recordDropped(env, drops);

  // 排序：重大 > 重要 > 一般；同级里核心公司优先，再按来源发布时间倒序（新的先推）
  const order = { 重大: 0, 重要: 1, 一般: 2 };
  const relOrder = { 核心公司: 0, 持仓公司: 1, 关注行业: 2, 持仓主题: 3, 全市场: 4, 提及: 5 };
  candidates.sort((a, b) => {
    if (order[a.level] !== order[b.level]) return order[a.level] - order[b.level];
    if (relOrder[a.rel] !== relOrder[b.rel]) return relOrder[a.rel] - relOrder[b.rel];
    return String(b.it.published || "").localeCompare(String(a.it.published || ""));
  });

  // 全部留档：就算这一轮不推送，也会进汇总报告（防漏报的兜底）
  await recordItemsLog(env, candidates.map((c) => ({
    fp: c.fp, ekey: c.ekey, title: c.it.title, content: c.it.content, source: c.it.source,
    link: c.it.link, level: c.level, relevance: c.it.relevance, factStatus: c.it.factStatus,
    impact: c.it.impact, bias: c.bias.tag, subject: c.subject, etype: c.etype, accession: c.acc,
    published: c.it.published || null, foundAt: now, pushed: 0,
  })));

  // 入队：采集到此结束，发不出去由队列负责重试
  const queue = candidates.filter((c) => c.kind !== "fold").map((c) => ({
    kind: c.kind, ekey: c.ekey, fp: c.fp, level: c.level, payload: c.it, now,
  }));
  await enqueue(env, queue);
  stats.queued = queue.length;
  stats.foldedToDigest = candidates.length - queue.length;

  // 写去重：留档成功就算处理过，重复抓取不会污染事件计数
  const pending = candidates.map((c) => c.fp);
  await saveDedup(env, pending);
  if (new Date().getUTCMinutes() === 0) await pruneDedup(env);

  // 发送（独立阶段，含上一轮失败重试）
  stats.dispatch = await dispatchOutbox(env, maxPushOf(env));
  stats.pushed = stats.dispatch.sent;

  // 到点就发汇总（美东 07:00 每日 / 周日 19:00 周末）
  try { stats.digests = await maybeDigest(env); } catch (e) { stats.digestError = String(e); }

  stats.dedupTotal = seen.size + pending.length;
  return stats;
}

// 预览：跑一遍过滤规则，列出"哪些会被推出去"，不真推送、不受去重影响。
// 用来调规则，避免改完还得靠刷群看效果。GET /run?preview=1
async function previewItems(env) {
  FEED_LOG = [];
  // 预览时拉全部源（不推送，不涉及子请求上限问题）
  const items = [
    ...(await fetchWallstreet(env)),
    ...(await fetchFed()),
    ...(await fetchSec(env)),
    ...(await fetchPr(env)),
    ...(await fetchGlobe(env)),
    ...(await fetchNvidia(env)),
    ...(await fetchBls(env)),
    ...(await fetchMarketWatch(env)),
    ...(await fetchCompanyIR(env)),
    ...(await fetchNewswire(env)),
    ...(await fetchNasdaqHalts(env)),
    ...(await fetchFtc(env)),
    ...(await fetchBea(env)),
    ...(await fetchGoogleBlog(env)),
    ...(await fetchDol(env)),
    ...(await fetchEia(env)),
    ...(await fetchReddit(env)),
    ...(await fetchMastodon(env)),
    ...(await fetchBluesky(env)),
    ...(await fetchYouTube(env)),
  ];
  const userWatch = (env.WATCH_KEYWORDS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const core = (env.CORE_COMPANIES || env.FOCUS_COMPANIES || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).concat(userWatch);
  const sector = (env.SECTOR_KEYWORDS || SECTOR_DEFAULT)
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  // B 层持仓 / C 层主题：wrangler.toml 里可覆盖，留空则用代码里的默认名单
  const holdings = (env.HOLDINGS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const theme = (env.THEME_KEYWORDS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const HOLD = holdings.length ? holdings : HOLDINGS_DEFAULT;
  const THEME = theme.length ? theme : THEME_DEFAULT;
  const out = [];
  // 记录被淘汰的条目和原因：预览的意义就是"调规则"，只给通过的样本的话，
  // 某个源一条都不出时根本看不出是卡在哪一步（噪声？不相关？没事件？信号弱？）
  const drops = [];
  const drop = (it, reason) => drops.push({ source: it.source, reason, title: (it.title || "").slice(0, 90) });
  for (const it of items) {
    if (!it.title || it.title.length < 8) { drop(it, "title_too_short"); continue; }
    if (!isSubstantive(it)) { drop(it, "noise_or_empty"); continue; }
    const full = `${it.title || ""} ${it.content || ""}`.toLowerCase();
    const rel = relevanceOf(it, core, sector, HOLD, THEME);
    if (!rel) { drop(it, "no_relevance"); continue; }
    const imp = importanceOf(it, full, rel);
    if (!imp) { drop(it, "no_event"); continue; }
    const bias = judgeBias(full);
    const hasData = !!expectationVerdict(full) || pickDataPoints(it.content || it.title).length > 0;
    if (imp === "一般" && bias.tag === "➖中性" && !hasData) { drop(it, "no_signal"); continue; }
    const subj = subjectOf(it.title, core, HOLD, THEME);
    const ety = eventTypeOf(full);
    out.push({
      level: imp, relevance: rel, factStatus: factStatusOf(full, it), impact: impactReasonOf(rel, it, full),
      bias: bias.tag, title: it.title, content: (it.content || "").slice(0, 100),
      source: it.source, published: it.published || "",
      subject: subj, etype: ety, ekey: await eventKeyOf(it, subj, ety),
    });
  }
  const order = { 重大: 0, 重要: 1, 一般: 2 };
  out.sort((a, b) => order[a.level] - order[b.level]);

  // 把样本翻译成中文，预览里直接看最终会显示成什么样（不推送）
  const top = out.slice(0, 30);
  const texts = [];
  for (const o of top) {
    if (isEnglish(o.title)) texts.push(o.title);
    if (isEnglish(o.content || "")) texts.push(o.content);
  }
  const tr = await translateBatch(texts);
  let i = 0;
  for (const o of top) {
    o.zhTitle = isEnglish(o.title) ? (tr[i++] || "(翻译失败)") : o.title;
    o.zhContent = isEnglish(o.content || "") ? (tr[i++] ?? o.content) : (o.content || "");
    o.bias = judgeBias(`${o.zhTitle} ${o.zhContent}`).tag;      // 预览里也能看到利好/利空判定
    o.verdict = expectationVerdict(o.zhContent || o.zhTitle);   // 实际 vs 预期
    o.data = pickDataPoints(o.zhContent || o.zhTitle);
    delete o.content;
  }
  // 挂在数组上返回：另一个调用点（/test 里的格式示例）是把返回值当数组用的，不能改返回类型
  out.drops = drops;
  out.processed = items.length;
  return out;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMonitor(env));
  },

  // 手动触发与排查：GET /run?token=xxx （设置了 RUN_TOKEN 时必须带 token）
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/test") {
      return Response.json(await sendTest(env));
    }
    // 抽查接口：漏报检查（被过滤的）、源健康度、延迟。GET /audit
    if (url.pathname === "/audit") {
      const q = async (sql, ...b) => {
        try { return (await env.DB.prepare(sql).bind(...b).all()).results || []; } catch (e) { return []; }
      };
      const sources = await q("SELECT source, mode, interval, ok, items, fail_streak, last_ok_at, last_content_at, note FROM source_status");
      const facts = await q("SELECT fp, subject, subject_ok, time_ok, source_ok, issues, checked_at FROM fact_check ORDER BY checked_at DESC LIMIT 30");
      const factBad = await q("SELECT COUNT(*) AS n FROM fact_check WHERE subject_ok = 0 OR time_ok = 0 OR source_ok = 0");
      const dropped = await q("SELECT title, source, reason, created_at FROM dropped ORDER BY created_at DESC LIMIT 40");
      const byReason = await q("SELECT reason, COUNT(*) AS n FROM dropped GROUP BY reason ORDER BY n DESC");
      const rows = await q("SELECT level, subject, etype, source, published_at, found_at, pushed FROM items_log ORDER BY found_at DESC LIMIT 40");
      const evs = await q("SELECT ekey, subject, etype, level, hits, versions, pushed, first_seen, last_seen FROM events ORDER BY last_seen DESC LIMIT 20");
      const box = await q("SELECT status, COUNT(*) AS n FROM outbox GROUP BY status");
      const dgs = await q("SELECT slot, kind, items, hooks_ok, sent_at FROM digests ORDER BY sent_at DESC LIMIT 10");
      const sec = (a, b) => {
        if (!a || !b) return null;
        const d = (new Date(b + "Z") - new Date(a + "Z")) / 1000;
        return isNaN(d) ? null : Math.round(d);
      };
      const latency = rows.map((r) => ({ level: r.level, 发布到发现: sec(r.published_at, r.found_at), pushed: r.pushed }));
      const sent = await q("SELECT created_at, sent_at FROM outbox WHERE status='sent' ORDER BY sent_at DESC LIMIT 40");
      const queue = sent.map((r) => sec(r.created_at, r.sent_at)).filter((x) => x !== null).sort((a, b) => a - b);
      const pub = latency.filter((x) => x.发布到发现 !== null).map((x) => x.发布到发现).sort((a, b) => a - b);
      const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null);
      return Response.json({
        sources,
        droppedSample: dropped,
        droppedByReason: byReason,
        events: evs,
        outbox: box,
        digests: dgs,
        factCheck: { 有问题条数: factBad?.[0]?.n ?? 0, 样本: facts },
        latency: {
          samples: latency.length,
          发布到发现_中位: pct(pub, 0.5), 发布到发现_最慢: pub[pub.length - 1] ?? null,
          入队到送达_中位: pct(queue, 0.5), 入队到送达_最慢: queue[queue.length - 1] ?? null,
        },
        recent: rows.slice(0, 15),
      });
    }
    // 汇总报告：GET /digest?kind=daily|weekend （加 &send=1 才真发，否则只预览）
    if (url.pathname === "/digest") {
      const kind = url.searchParams.get("kind") === "weekend" ? "weekend" : "daily";
      const d = await buildDigest(env, kind);
      if (url.searchParams.get("send") === "1") {
        const e = tzParts(ET, new Date());
        const slot = `${e.y}-${pad2(e.mo)}-${pad2(e.d)}-${kind}`;
        return Response.json(await sendDigest(env, kind, slot));
      }
      return new Response(d.text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname !== "/run") {
      return new Response("US Market Monitor is running. Use /run to trigger manually.", { status: 200 });
    }
    if (env.RUN_TOKEN && url.searchParams.get("token") !== env.RUN_TOKEN) {
      return new Response("Forbidden", { status: 403 });
    }
    if (url.searchParams.get("preview") === "1") {
      const list = await previewItems(env);
      const bySource = list.reduce((a, x) => { a[x.source] = (a[x.source] || 0) + 1; return a; }, {});
      const drops = list.drops || [];
      const dropByReason = drops.reduce((a, d) => { a[d.reason] = (a[d.reason] || 0) + 1; return a; }, {});
      const dropBySource = drops.reduce((a, d) => { a[d.source] = (a[d.source] || 0) + 1; return a; }, {});
      return Response.json({ processed: list.processed, passed: list.length, dropCount: drops.length,
                             bySource, dropByReason, dropBySource,
                             feeds: FEED_LOG, sample: list.slice(0, 30) });
    }
    const stats = await runMonitor(env, true);   // 手动触发：拉全部源
    return Response.json(stats);
  },
};
