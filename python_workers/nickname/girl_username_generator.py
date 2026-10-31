# -*- coding: utf-8 -*-
"""离线女生网名生成器（仅使用 Python 标准库）。

直接运行：python girl_username_generator.py
生成 100 个：python girl_username_generator.py -n 100
指定风格：python girl_username_generator.py -n 30 -s 甜美
可复现：  python girl_username_generator.py -n 30 --seed 42
查看风格：python girl_username_generator.py --styles

也可以在其他 Python 代码里调用：
    from girl_username_generator import generate_names
    print(generate_names(20, style="混合"))

Node 侧通过 src/automation/nickname-generator.js 桥接调用（-I 隔离模式，
输出每行一个网名，便于进程间消费）。
"""

import argparse
import random

# 每个词库都经过语义分类，不能把所有汉字、词语无差别混合。
WORDS = {
    "nick": """
        阿梨 小满 乔乔 桃桃 阿宁 小雨 七七 小鱼 柚柚 小鹿 米米
        阿橙 橙子 阿柚 西西 小北 小禾 小夏 阿南 南南 露露
        阿暖 暖暖 小圆 阿枝 枝枝 小林 阿月 小月 月月 星星
        小栀 阿栀 栀栀 小晚 晚晚 阿言 小也 玖玖 初初 阿眠
        奶糖 阿芋 芋头 团团 饭团 米粒 奈奈 安安 小安 小乔
        茉茉 小溪 阿茶 茶茶 阿眠 小七 小叶 小舒 小乔 小麦
        小白 阿柒 小沐 沐沐 小舟 阿舟 栗栗 梨梨 小椰 阿棠
        棠棠 糯糯 小糯 阿秋 秋秋 圆圆 小羽 七喜 妮妮
        小艺 依依 沫沫 若若 宁宁 玖玖 软软 小葵 葵葵
    """.split(),
    "first_name": """
        小雨 小雅 小希 诗诗 晓晓 安然 初夏 沐晴 若溪 可可
        乐乐 晴晴 一一 安宁 沐沐 嘉嘉 知知 小妍 小意 小悠
        阿琳 小冉 小言 小婉 小清 小舒 小芊 小苏 小顾
    """.split(),
    "casual_tail": "呀 呢 啊 同学 小朋友 本人 日记 手记 的小窝".split(),
    "casual_state": "发呆 摸鱼 偷懒 散步 追剧 画画 看书 赖床 等下班 喝奶茶".split(),
    "casual_wish": "睡懒觉 吃火锅 喝奶茶 看日落 去看海 放个假 吃蛋糕 逛超市 见朋友 早点下班".split(),
    "casual_manner": "正在 还在 又在 偷偷".split(),
    "casual_object": "碎碎念 小日子 日常频道 晚安电台 小日记 快乐星球 生活记录 心情存档".split(),
    "casual_location": "被窝里 阳台上 海边 路上 梦里 云朵上 小角落".split(),
    "small_nickname": "阿梨 阿宁 小雨 小满 阿柚 七七 桃桃 小鹿 阿棠 晚晚 小乔 小鱼".split(),
    "warm_suffix": "呀 啦 呢 哦 诶".split(),

    "food": """
        桃子 草莓 橘子 樱桃 葡萄 荔枝 青提 蜜柚 柠檬 杏子
        蓝莓 芒果 牛奶 布丁 奶冻 奶酪 曲奇 甜筒 棉花糖
        小蛋糕 芋泥 麻薯 奶盖 泡芙 软糖 果冻 奶昔 可颂
        牛角包 糯米团 椰子 冰淇淋 草莓酱 芝士 饼干
    """.split(),
    "drink": "桃桃乌龙 葡萄冰茶 茉莉奶绿 蜜桃气泡水 椰乳拿铁 甜橙汽水 草莓牛乳 玫瑰奶茶 柚子茶 西柚苏打".split(),
    "cute_prefix": "糯糯 软软 甜甜 困困 香香 小小 一口 半糖 奶香 迷你".split(),
    "cute_suffix": "酱 啵啵 崽崽 罐头 星球 小铺 日记 泡泡 口袋".split(),
    "cute_pet": "小兔 小猫 小熊 小狗 小羊 小鹿 企鹅 小狐狸 小海豹 小仓鼠".split(),
    "cute_pet_action": "打盹 撒娇 睡觉 发呆 偷懒 打滚".split(),
    "cute_mood": "想喝奶茶 想吃蛋糕 想睡觉 不想起床 在吃零食 又困了".split(),
    "sugar_level": "半糖 微糖 三分糖 七分糖 少冰 常温".split(),
    "food_drink": "奶茶 果茶 可可 牛乳 拿铁 乌龙茶".split(),

    "season": "春天 夏天 秋天 冬天 初春 仲夏 初秋 深秋 初雪".split(),
    "warm_season": "春天 夏天 初春 仲夏 初夏 暮春".split(),
    "nature": "晚风 星星 月亮 云朵 山茶 花海 小岛 海风 落日 春雨 晨雾 山野 白露".split(),
    "gently_thing": "晚风 月光 星光 花香 海风 春雨 落日 云朵 山茶 小雪".split(),
    "soft_verb": "收藏 偷藏 等待 拾起 遇见 抱住 留住".split(),
    "soft_object": "晚风 星星 月亮 春天 夏天 落日 微光 一场雨 一束花".split(),
    "gentle_short": """
        南枝 晚樱 春眠 月白 初晴 晴川 知夏 云汐 清禾 白茶
        浅夏 予安 拾光 迟夏 南栀 晚棠 木槿 见月 青梨
        听雨 望舒 清欢 枕月 轻舟 林深 以南 予宁
    """.split(),
    "night_time": "夜里 凌晨 深夜 月下 晚安前".split(),
    "night_object": "月亮 星光 路灯 夜风 微光 萤火 星河".split(),
    "day_time": "清晨 午后 雨后 春日 夏日 周末 傍晚".split(),
    "day_object": "阳光 微风 云朵 山茶 树影 花香 绿荫 海风".split(),
    "slow_adverb": "慢慢 悄悄 轻轻 偷偷 认真".split(),
    "slow_action": "发光 长大 开心 生活 看海 等雨 散步".split(),

    "literary_short": """
        月见 山止 雾眠 听澜 未晚 云岫 枕书 南书 知白 青汐
        北屿 星野 云起 白昼 远山 见山 南乔 时雨 遥枝
        清昼 望月 春山 予书 照野 长夏 林间 诗尾
    """.split(),
    "literary_subject": "春天 夏天 秋日 山海 晚风 月亮 云朵 雾岛 海边 岁月".split(),
    "letter_to": "春天 月亮 山海 远方 晚风 夏夜 未来 自己 星星".split(),
    "journal_subject": "云朵 月亮 山海 春日 雨天 海边 晚风".split(),
    "literary_pair_a": "云 星 月 山 风 雨 花 海".split(),
    "literary_pair_b": "海 河 光 岛 月 雾 影 风".split(),
    "literary_verbs": "听风 看海 读诗 赏月 写信 赏花 等雨 望山".split(),
    "far_place": "南山 北岸 小岛 海边 山谷 山间 林间 远方".split(),
    "sea_place": "海边 小岛 海岸 灯塔旁 沙滩上".split(),
    "sea_action": "看海 听海风 等潮汐 看日落".split(),
    "land_place": "南山 山谷 山间 林间 花田".split(),
    "land_action": "听风 等雨 看花 散步 写诗".split(),
    "literary_image": "远山 旧梦 花影 月色 微光 风声 星光 云影 树影 春光".split(),
}

# 词库加载时去重（保持原顺序），避免重复词抬高某些组合的命中率。
WORDS = {key: list(dict.fromkeys(values)) for key, values in WORDS.items()}

# 模板按风格域分组：{槽位} 从对应词库随机取词。
# 命名原则：口语自然、长度 2~9 字、避免生硬拼接。
TEMPLATES = {
    "日常": [
        "{nick}",
        "{nick}{casual_tail}",
        "{nick}的{casual_object}",
        "{casual_manner}{casual_state}的{nick}",
        "在{casual_location}{casual_state}",
        "今天也想{casual_wish}",
        "{small_nickname}{warm_suffix}",
        "{first_name}{casual_tail}",
    ],
    "甜美": [
        "{cute_prefix}{food}",
        "{food}{cute_suffix}",
        "{cute_pet}{cute_pet_action}中",
        "{sugar_level}{food_drink}",
        "{drink}",
        "{cute_pet}和{food}",
        "{cute_prefix}的{cute_pet}",
        "{cute_mood}",
    ],
    "温柔": [
        "{gentle_short}",
        "{gently_thing}与{soft_object}",
        "{soft_verb}{soft_object}",
        "{night_time}的{night_object}",
        "{day_time}的{day_object}",
        "{slow_adverb}{slow_action}的{gentle_short}",
        "{warm_season}的{nature}",
        "{slow_adverb}{slow_action}",
    ],
    "文艺": [
        "{literary_short}",
        "{letter_to}来信",
        "{literary_image}",
        "{literary_pair_a}{literary_pair_b}",
        "{literary_image}与{literary_image}",
        "{night_time}{literary_image}",
        "{sea_place}{sea_action}",
        "{land_place}{land_action}",
        "{season}的{literary_image}",
    ],
}
# 混合 = 四个风格域全部参与。
TEMPLATES["混合"] = [t for style in ("日常", "甜美", "温柔", "文艺") for t in TEMPLATES[style]]

STYLE_ORDER = ["日常", "甜美", "温柔", "文艺", "混合"]


def generate_names(count=10, style="混合", seed=None, rng=None):
    """生成 count 个不重复网名；词库/模板耗尽时返回实际可得的最大数量。"""
    if style not in TEMPLATES:
        raise ValueError(f"未知风格: {style}（可选: {'/'.join(STYLE_ORDER)}）")
    if rng is None:
        rng = random.Random(seed)
    results = []
    seen = set()
    attempts = 0
    max_attempts = count * 200 + 2000
    while len(results) < count and attempts < max_attempts:
        attempts += 1
        template = rng.choice(TEMPLATES[style])
        try:
            name = template.format(**{k: rng.choice(v) for k, v in WORDS.items()})
        except (KeyError, IndexError):
            continue
        name = name.strip()
        if not name or name in seen:
            continue
        seen.add(name)
        results.append(name)
    return results


def list_styles():
    return {style: len(templates) for style, templates in TEMPLATES.items() if style != "混合"}


def main():
    parser = argparse.ArgumentParser(description="离线女生网名生成器（仅标准库）")
    parser.add_argument("-n", "--count", type=int, default=10, help="生成数量（默认 10）")
    parser.add_argument("-s", "--style", default="混合", help=f"风格（可选: {'/'.join(STYLE_ORDER)}）")
    parser.add_argument("--seed", type=int, default=None, help="随机种子（可复现）")
    parser.add_argument("--styles", action="store_true", help="查看可用风格后退出")
    args = parser.parse_args()

    if args.styles:
        for style, count in list_styles().items():
            print(f"{style}\t{count} 个模板")
        return

    for name in generate_names(args.count, style=args.style, seed=args.seed):
        print(name)


if __name__ == "__main__":
    main()
