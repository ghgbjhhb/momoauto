'use strict';

/**
 * 离线女生网名随机生成器（纯 JS，无外部依赖）。
 * 词库按风格分库、按语义分类，模板加权组合，避免机械拼接。
 */

const WORDS = {
    nick: "阿梨 小满 乔乔 桃桃 阿宁 小雨 七七 小鱼 柚柚 小鹿 米米 阿橙 橙子 阿柚 西西 小北 小禾 小夏 阿南 南南 露露 阿暖 暖暖 小圆 阿枝 枝枝 小林 阿月 小月 月月 星星 小栀 阿栀 栀栀 小晚 晚晚 阿言 小也 玖玖 初初 阿眠 奶糖 阿芋 芋头 团团 饭团 米粒 奈奈 安安 小安 小乔 茉茉 小溪 阿茶 茶茶 阿眠 小七 小叶 小舒 小乔 小麦 小白 阿柒 小沐 沐沐 小舟 阿舟 栗栗 梨梨 小椰 阿棠 棠棠 糯糯 小糯 阿秋 秋秋 圆圆 小羽 七喜 妮妮 小艺 依依 沫沫 若若 宁宁 玖玖 软软 小葵 葵葵".split(/\s+/),
    first_name: "小雨 小雅 小希 诗诗 晓晓 安然 初夏 沐晴 若溪 可可 乐乐 晴晴 一一 安宁 沐沐 嘉嘉 知知 小妍 小意 小悠 阿琳 小冉 小言 小婉 小清 小舒 小芊 小苏 小顾".split(/\s+/),
    casual_tail: "呀 呢 啊 同学 小朋友 本人 日记 手记 的小窝".split(/\s+/),
    casual_state: "发呆 摸鱼 偷懒 散步 追剧 画画 看书 赖床 等下班 喝奶茶".split(/\s+/),
    casual_wish: "睡懒觉 吃火锅 喝奶茶 看日落 去看海 放个假 吃蛋糕 逛超市 见朋友 早点下班".split(/\s+/),
    casual_manner: "正在 还在 又在 偷偷".split(/\s+/),
    casual_object: "碎碎念 小日子 日常频道 晚安电台 小日记 快乐星球 生活记录 心情存档".split(/\s+/),
    casual_location: "被窝里 阳台上 海边 路上 梦里 云朵上 小角落".split(/\s+/),
    small_nickname: "阿梨 阿宁 小雨 小满 阿柚 七七 桃桃 小鹿 阿棠 晚晚 小乔 小鱼".split(/\s+/),
    warm_suffix: "呀 啦 呢 哦 诶".split(/\s+/),

    food: "桃子 草莓 橘子 樱桃 葡萄 荔枝 青提 蜜柚 柠檬 杏子 蓝莓 芒果 牛奶 布丁 奶冻 奶酪 曲奇 甜筒 棉花糖 小蛋糕 芋泥 麻薯 奶盖 泡芙 软糖 果冻 奶昔 可颂 牛角包 糯米团 椰子 冰淇淋 草莓酱 芝士 饼干".split(/\s+/),
    drink: "桃桃乌龙 葡萄冰茶 茉莉奶绿 蜜桃气泡水 椰乳拿铁 甜橙汽水 草莓牛乳 玫瑰奶茶 柚子茶 西柚苏打".split(/\s+/),
    cute_prefix: "糯糯 软软 甜甜 困困 香香 小小 一口 半糖 奶香 迷你".split(/\s+/),
    cute_suffix: "酱 啵啵 崽崽 罐头 星球 小铺 日记 泡泡 口袋".split(/\s+/),
    cute_pet: "小兔 小猫 小熊 小狗 小羊 小鹿 企鹅 小狐狸 小海豹 小仓鼠".split(/\s+/),
    cute_pet_action: "打盹 撒娇 睡觉 发呆 偷懒 打滚".split(/\s+/),
    cute_mood: "想喝奶茶 想吃蛋糕 想睡觉 不想起床 在吃零食 又困了".split(/\s+/),
    sugar_level: "半糖 微糖 三分糖 七分糖 少冰 常温".split(/\s+/),
    food_drink: "奶茶 果茶 可可 牛乳 拿铁 乌龙茶".split(/\s+/),

    season: "春天 夏天 秋天 冬天 初春 仲夏 初秋 深秋 初雪".split(/\s+/),
    warm_season: "春天 夏天 初春 仲夏 初夏 暮春".split(/\s+/),
    nature: "晚风 星星 月亮 云朵 山茶 花海 小岛 海风 落日 春雨 晨雾 山野 白露".split(/\s+/),
    gently_thing: "晚风 月光 星光 花香 海风 春雨 落日 云朵 山茶 小雪".split(/\s+/),
    soft_verb: "收藏 偷藏 等待 拾起 遇见 抱住 留住".split(/\s+/),
    soft_object: "晚风 星星 月亮 春天 夏天 落日 微光 一场雨 一束花".split(/\s+/),
    gentle_short: "南枝 晚樱 春眠 月白 初晴 晴川 知夏 云汐 清禾 白茶 浅夏 予安 拾光 迟夏 南栀 晚棠 木槿 见月 青梨 听雨 望舒 清欢 枕月 轻舟 林深 以南 予宁".split(/\s+/),
    night_time: "夜里 凌晨 深夜 月下 晚安前".split(/\s+/),
    night_object: "月亮 星光 路灯 夜风 微光 萤火 星河".split(/\s+/),
    day_time: "清晨 午后 雨后 春日 夏日 周末 傍晚".split(/\s+/),
    day_object: "阳光 微风 云朵 山茶 树影 花香 绿荫 海风".split(/\s+/),
    slow_adverb: "慢慢 悄悄 轻轻 偷偷 认真".split(/\s+/),
    slow_action: "发光 长大 开心 生活 看海 等雨 散步".split(/\s+/),

    literary_short: "月见 山止 雾眠 听澜 未晚 云岫 枕书 南书 知白 青汐 北屿 星野 云起 白昼 远山 见山 南乔 时雨 遥枝 清昼 望月 春山 予书 照野 长夏 林间 诗尾".split(/\s+/),
    literary_subject: "春天 夏天 秋日 山海 晚风 月亮 云朵 雾岛 海边 岁月".split(/\s+/),
    letter_to: "春天 月亮 山海 远方 晚风 夏夜 未来 自己 星星".split(/\s+/),
    journal_subject: "云朵 月亮 山海 春日 雨天 海边 晚风".split(/\s+/),
    literary_pair_a: "云 星 月 山 风 雨 花 海".split(/\s+/),
    literary_pair_b: "海 河 光 岛 月 雾 影 风".split(/\s+/),
    literary_verbs: "听风 看海 读诗 赏月 写信 赏花 等雨 望山".split(/\s+/),
    far_place: "南山 北岸 小岛 海边 山谷 山间 林间 远方".split(/\s+/),
    sea_place: "海边 小岛 海岸 灯塔旁 沙滩上".split(/\s+/),
    sea_action: "看海 听海风 等潮汐 看日落".split(/\s+/),
    land_place: "南山 山谷 山间 林间 花田".split(/\s+/),
    land_action: "听风 等雨 看花 散步 写诗".split(/\s+/),
    literary_image: "远山 旧梦 花影 月色 微光 风声 星光 云影 树影 春光".split(/\s+/),
    soft_journal_tail: "日记 手记 小札 碎碎念 晚安 小窝".split(/\s+/),
    gentle_verb: "发光 盛开 散步 吹风 长大 看海".split(/\s+/),
    gentle_time: "今晚 明天 周末 春日 午后 夏日 清晨".split(/\s+/),
    gentle_wish: "早点睡 去散步 看日落 晒太阳 看海 赏花 写信 吹晚风".split(/\s+/),
    literary_tail: "来信 手记 诗集 备忘录 随笔 小札".split(/\s+/),

    cool_short: "北岛 北岸 雾屿 深蓝 灰白 无声 晚舟 白夜 雾眠 寂川 冷月 深海 南渡 寒枝 夜航 无岸 迟暮 落潮 霜序 听雪 静川 青灰 暮雪 空山 白昼 秋岚".split(/\s+/),
    cool_pair_weather: "雾 雨 月 夜".split(/\s+/),
    fall_weather: "雨 雪 月".split(/\s+/),
    fall_place: "北岸 南枝 旧城 山谷 林间 山巅".split(/\s+/),
    cool_item: "回音 旧信 微光 回忆 倒影 余温 日落 月色 风声 海风 白噪音 梦境 晚安 沉默 星光".split(/\s+/),
    cool_place: "北岸 南枝 孤岛 深海 林间 山谷 旧城 海面".split(/\s+/),
    cool_scene: "雾中 雨夜 雪后 夜里 月下 海边 林间".split(/\s+/),
    cool_action: "听雨 看海 等雪 独行 失眠 写信 沉默".split(/\s+/),
    cool_tail: "无声 未眠 不语 来信 有雾 入夜".split(/\s+/),
    cool_color: "深蓝 浅灰 雾白 冷白 青黑 银灰".split(/\s+/),

    fun_food: "薯条 布丁 奶茶 芝士 饭团 麻薯 甜筒 香菜 土豆 草莓".split(/\s+/),
    fun_fate: "跑路了 失踪了 逃跑了 罢工了 掉线了 睡着了".split(/\s+/),
    fun_activity: "上班 上学 起床 出门 洗头 营业 社交 早起".split(/\s+/),
    fun_status: "摸鱼中 发呆中 加载中 装睡中 充电中 失眠中 放空中 思考人生".split(/\s+/),
    fun_creature: "困困小猫 暴躁小熊 迷路企鹅 摆烂小狗 偷懒海豹 发呆小羊".split(/\s+/),
    fun_nickname: "人类观察员 摸鱼选手 睡觉冠军 熬夜选手 低电量少女 奶茶品鉴员 赖床研究员 不想营业本人 快乐废物 头脑空空星人 拖延症患者 小猫代理人".split(/\s+/),
    fun_excuse: "我只是路过 我什么都不知道 我要下班 我还没睡醒 不是本人 我很忙但没事干".split(/\s+/),
    fun_adv: "偷偷 正在 还在 一直在 又在".split(/\s+/),
    fun_verb: "摸鱼 发呆 偷懒 装睡 赖床 吃零食 看热闹".split(/\s+/),

    retro_short: "晚棠 南笺 青禾 知意 初棠 云笺 青黛 如许 书瑶 晚照 予棠 清词 见欢 枝意 旧梦 竹眠 南音 砚秋 听澜 念初 令仪 余欢 栖月 昭昭".split(/\s+/),
    retro_flower: "海棠 玉兰 山茶 栀子 桃花 梨花 桂花".split(/\s+/),
    retro_scene: "月下 江南 庭前 雨巷 山间 旧巷".split(/\s+/),
    retro_action: "听雨 赏月 看花 煮茶 等风 写诗".split(/\s+/),
    retro_tail: "小记 旧事 来信 手札 花笺 随笔".split(/\s+/),
    retro_place: "庭前 江南 旧巷 长街 山间 院里 雨巷 城南".split(/\s+/),

    english: "momo coco nana lulu luna yuki kiki yoyo nino mimi riri may mia ella aria yuna milo noah nini soso lily".split(/\s+/),
    english_tail: "daily notes diary here little mood days".split(/\s+/),
    en_digits: "07 11 17 21 27 77 99".split(/\s+/),
    en_cn_tail: "日记 小窝 碎碎念 日常 来信".split(/\s+/),
    minimal_word: "阿梨 初七 木木 小也 北北 小满 七喜 一一 妮妮 小鱼 无恙 见月 小鹿 可可 七喜 柒柒 小九 阿宁 予安 星野 子沐 南枝 苏苏 暖暖 玖玖 安安".split(/\s+/),
    minimal_single: "梨 柚 沐 七 九 夏 宁 棠 南 栀 鹿 禾 枝 冉 安 乔 予".split(/\s+/),
    minimal_digit: "7 9 11 17 77 99".split(/\s+/),
    mature_short: "简宁 未央 如初 知安 南知 南音 若宁 听澜 晚宁 见素 予安 清欢 安然 亦舒 沉香 迟夏 梧桐 初晴 暮青 微澜 晚亭 予清 清禾 知微 林听 望舒".split(/\s+/),
    mature_tail: "慢生活 日常 手记 小记 生活志 随笔 碎碎念".split(/\s+/),
    mature_mood: "顺其自然 随遇而安 慢慢来 刚刚好 不慌不忙 一切随缘 保持热爱 慢一点也好".split(/\s+/),
    mature_scene: "一杯清茶 半盏清欢 人间烟火 山间晚风 午后阳光 雨后晴天 四时有序".split(/\s+/),
    mature_theme: "生活 时光 日子 日落 晚风 花开 四季".split(/\s+/),
    mature_place: "路上 海边 山间 城市里 小院里".split(/\s+/),
    mature_act: "散步 看展 看书 听雨 喝茶 看日落".split(/\s+/),
    game_short: "别抢我蓝 摸鱼上分中 今天不排位 辅助不背锅 只会奶队友 不想开麦 打野别抓我 泉水散步员 队友别急 我先苟一下".split(/\s+/),
    game_action: "开麦 排位 上分 打野 补刀 开团 带节奏".split(/\s+/),
    game_role: "辅助 中单 法师 射手 奶妈 打野".split(/\s+/),
    game_state: "在线 等队友 蹲草里 偷偷上分 加载中 挂机喝水 练英雄".split(/\s+/),
};

for (const key of Object.keys(WORDS)) WORDS[key] = [...new Set(WORDS[key])];

// (权重, 模板)。少量直出简短昵称，更多用符合中文口语的组合句式；风格单独分库。
const RULES = {
    日常: [
        [35, "{nick}"], [14, "{first_name}"],
        [10, "是{nick}呀"], [8, "这里是{nick}"],
        [9, "{nick}{casual_tail}"], [6, "{nick}的{casual_object}"],
        [8, "{nick}{casual_manner}{casual_state}"],
        [7, "{nick}今天想{casual_wish}"],
        [5, "{nick}在{casual_location}"],
        [5, "{small_nickname}{warm_suffix}"],
    ],
    甜美: [
        [16, "{food}"], [9, "{drink}"],
        [10, "{cute_prefix}{food}"],
        [13, "{food}{cute_suffix}"],
        [9, "{cute_pet}{cute_suffix}"],
        [12, "{cute_pet}在{cute_pet_action}"],
        [10, "{nick}{cute_mood}"],
        [10, "{sugar_level}{food_drink}"],
        [8, "{food}和{food_drink}"],
        [5, "{cute_prefix}{cute_pet}"],
    ],
    温柔: [
        [27, "{gentle_short}"],
        [10, "{season}来信"],
        [8, "{nature}来信"],
        [11, "{soft_verb}{soft_object}"],
        [9, "{day_time}的{day_object}"],
        [9, "{night_time}的{night_object}"],
        [10, "{slow_adverb}{slow_action}"],
        [9, "{season}有{gently_thing}"],
        [7, "把{soft_object}装进口袋"],
        [12, "{nick}的{gently_thing}"],
        [10, "{gentle_short}的{soft_journal_tail}"],
        [7, "{gentle_time}想{gentle_wish}"],
        [9, "{gentle_short}呀"],
    ],
    文艺: [
        [22, "{literary_short}"],
        [12, "{literary_subject}{literary_tail}"],
        [10, "写给{letter_to}的信"],
        [10, "{journal_subject}手记"],
        [10, "{literary_pair_a}与{literary_pair_b}"],
        [9, "在{sea_place}{sea_action}"],
        [9, "在{land_place}{land_action}"],
        [8, "{warm_season}的{day_object}"],
        [8, "{letter_to}的慢日记"],
        [8, "关于{literary_subject}"],
        [12, "{literary_short}的{literary_tail}"],
        [9, "{nick}的{literary_tail}"],
        [9, "{literary_subject}寄来{soft_object}"],
        [8, "{literary_image}落在{far_place}"],
        [10, "{far_place}的{literary_image}"],
    ],
    清冷: [
        [31, "{cool_short}"],
        [12, "{fall_weather}落{fall_place}"],
        [9, "{cool_scene}{cool_action}"],
        [11, "{cool_place}{cool_tail}"],
        [8, "{cool_color}来信"],
        [7, "{cool_pair_weather}与{cool_place}"],
        [8, "{cool_scene}未眠"],
        [8, "{cool_place}的夜"],
        [13, "{cool_short}的{cool_item}"],
        [12, "{cool_place}的{cool_item}"],
        [10, "{night_time}的{cool_item}"],
        [9, "{cool_color}的{cool_item}"],
        [8, "{cool_short}{cool_tail}"],
    ],
    搞怪: [
        [17, "{fun_nickname}"],
        [16, "今天不想{fun_activity}"],
        [10, "{nick}不想{fun_activity}"],
        [13, "{fun_food}{fun_fate}"],
        [11, "{fun_creature}"],
        [12, "{fun_status}"],
        [8, "{fun_excuse}"],
        [10, "{fun_adv}{fun_verb}"],
        [7, "{nick}{fun_status}"],
    ],
    复古: [
        [30, "{retro_short}"],
        [14, "{retro_flower}{retro_tail}"],
        [13, "{retro_scene}{retro_action}"],
        [11, "{retro_flower}未眠"],
        [10, "{retro_scene}来信"],
        [9, "{retro_flower}与月"],
        [12, "{retro_short}{retro_tail}"],
        [12, "{retro_short}的{retro_tail}"],
        [10, "{retro_short}与{retro_flower}"],
        [10, "{retro_flower}落{retro_place}"],
        [7, "{retro_scene}的{retro_flower}"],
        [8, "{retro_short}在{retro_place}"],
        [7, "{first_name}的{retro_tail}"],
    ],
    英文: [
        [37, "{english}"],
        [13, "{english}_{en_digits}"],
        [10, "{english}.{en_digits}"],
        [12, "little.{english}"],
        [12, "{english}.{english_tail}"],
        [10, "{english}{en_cn_tail}"],
        [12, "{english}_{english}"],
        [12, "{english}.{english}"],
        [6, "{english}{en_digits}"],
        [4, "{english}.{english_tail}.{en_digits}"],
    ],
    极简: [
        [50, "{minimal_word}"],
        [14, "{minimal_single}"],
        [10, "阿{minimal_single}"],
        [9, "小{minimal_single}"],
        [7, "{minimal_single}{minimal_single}"],
        [6, "{minimal_word}{minimal_digit}"],
        [4, "{minimal_word}_"],
    ],
    成熟: [
        [27, "{mature_short}"],
        [18, "{mature_mood}"],
        [14, "{mature_scene}"],
        [15, "{mature_short}的{mature_tail}"],
        [11, "{mature_theme}刚刚好"],
        [10, "{mature_short}与{mature_theme}"],
        [9, "{mature_scene}手记"],
        [8, "{mature_short}{mature_tail}"],
        [8, "{mature_short}慢慢来"],
        [9, "{mature_short}在{mature_place}"],
        [9, "{mature_short}今天{mature_act}"],
    ],
    游戏: [
        [22, "{game_short}"],
        [15, "{nick}不想{game_action}"],
        [15, "{nick}{game_state}"],
        [12, "{nick}只会{game_role}"],
        [11, "今天不想{game_action}"],
        [10, "{game_role}不背锅"],
        [8, "{game_role}正在{game_action}"],
    ],
};

// 混合模式：接近社交平台常见昵称的分布，而非各风格等概率。
const STYLE_WEIGHTS = {
    日常: 30, 甜美: 17, 温柔: 13, 文艺: 9, 清冷: 7,
    搞怪: 8, 复古: 4, 英文: 3, 极简: 3, 成熟: 3, 游戏: 3,
};

const ALIASES = {
    mix: "混合", all: "混合", random: "混合",
    daily: "日常", cute: "甜美", gentle: "温柔",
    literary: "文艺", cool: "清冷", funny: "搞怪",
    retro: "复古", english: "英文", minimal: "极简", mature: "成熟", gaming: "游戏",
};

const TEMPLATE_FIELDS = new Map();
for (const rules of Object.values(RULES)) {
    for (const [, template] of rules) {
        if (!TEMPLATE_FIELDS.has(template)) {
            TEMPLATE_FIELDS.set(template, [...template.matchAll(/\{(\w+)\}/g)].map(([, f]) => f));
        }
    }
}

function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
}

function weightedPick(pairs) {
    let r = Math.random() * pairs.reduce((sum, [weight]) => sum + weight, 0);
    for (const [weight, value] of pairs) {
        r -= weight;
        if (r < 0) return value;
    }
    return pairs[pairs.length - 1][1];
}

function makeOne(style) {
    const chosen = style === "混合" ? weightedPick(Object.entries(STYLE_WEIGHTS).map(([name, weight]) => [weight, name])) : style;
    const template = weightedPick(RULES[chosen]);
    const parts = {};
    for (const field of TEMPLATE_FIELDS.get(template)) parts[field] = pick(WORDS[field]);
    return template.replace(/\{(\w+)\}/g, (_, field) => parts[field]);
}

function naturalEnough(name) {
    if (name.length < 2 || name.length > 14) return false;
    if (/\s/.test(name) || name.includes("偷偷偷")) return false;
    // 如："月与月"；防意外拼接重复字串，不过滤本来就自然的叠字昵称
    if (/^(.)与\1$/.test(name) || /(.{2,})\1/.test(name) || /^([a-z]+)[._]\1$/.test(name)) return false;
    return true;
}

/**
 * 随机生成一批不重复的女生网名。
 * @param {object} [options]
 * @param {number} [options.count=1] 生成数量
 * @param {string} [options.style='混合'] 风格: 混合/日常/甜美/温柔/文艺/清冷/搞怪/复古/英文/极简/成熟/游戏
 * @returns {string[]}
 */
function generateGirlNicknames({ count = 1, style = "混合" } = {}) {
    const chosenStyle = typeof style === "string" ? (ALIASES[style.toLowerCase()] ?? style) : style;
    if (chosenStyle !== "混合" && !RULES[chosenStyle]) {
        throw new Error(`不支持的风格：${style}；可选：混合、${Object.keys(RULES).join("、")}`);
    }
    const names = [];
    const seen = new Set();
    const maxAttempts = Math.min(300000, Math.max(300, count * 30));
    for (let i = 0; i < maxAttempts && names.length < count; i++) {
        const name = makeOne(chosenStyle);
        if (!seen.has(name) && naturalEnough(name)) {
            seen.add(name);
            names.push(name);
        }
    }
    return names;
}

/** 随机生成一个女生网名。 */
function generateGirlNickname(options = {}) {
    return generateGirlNicknames({ ...options, count: 1 })[0];
}

/**
 * 网名取值：留空即离线随机生成，显式指定则原样使用。
 * @param {string} [setting] 命令行 / 环境变量传入的网名
 * @param {string} [style='混合'] 生成风格
 * @returns {string} 最终网名
 */
function resolveGirlNickname(setting, style = "混合") {
    const raw = String(setting ?? "").trim();
    return raw || generateGirlNickname({ style });
}

module.exports = { generateGirlNickname, generateGirlNicknames, resolveGirlNickname };
