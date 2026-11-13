// Chinese, Japanese and Korean share one block of Han characters, drawn differently in each. A web font
// cannot tell them apart, so the text is tagged with a language and the CSS puts that language's font first.

const KANA = /[぀-ヿ]/;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const HAN = /[一-鿿]/;
// Simplified forms that Japanese does not use.
const HANS = /[们这说对时为过还没么爱梦风飞乐欢泪伤谁给让话语请问间门东车马鸟龙岁远边尘亲见觉观记许诗谢难离电红绿蓝银钱长开关听书华无丽义习乡买卖产从众优伟传儿兴写军农决净凤击则刚创动务胜劳势单卫历厅发变吗园围图团块坏场处备复够头夺奋妈孙实审宠宽寻导层屿岛币帅师带帮广庆应废弃张弹归忆忧怀态总恶惊惯愿战戏执扩扫抢护报拥择挥损摇摆显晓暂术杀权极构标样桥检楼气汉汤沟泽洁济润涩渐满灭灵热烧爷牺猎现琐环疗睁确种积穷竞笔简类粮纪纯纸线练组细终经结绕绘统继绪续缘缠网罗罚罢联聪肤脑脸舰艺节苍药获萝虽补装规览计认讨训议讲论设访证评识诉词译试该详诱读课调谈谊谣谱财责败货质贵贺资赏赐赞赢赶趋跃轨转轮软轻载辆辈辉达迁运进违连迟适选逊递逻遗邮邻释钟钢铁铜错锁镜闪闭闲闻阔队阳阴阵阶际陆陈险随隐雾韩页顶项顺须顾顿颗题颜额飘饭饮饱饰馆驱验骑骗鱼鲜鸡齐]/;
// Traditional forms that differ from the Japanese ones, and Cantonese particles.
const HANT = /[們這嗎沒麼說裡妳學國會來對體點變戀聲樂歡淚氣單讓聽寫歲邊關轉嘅咗唔喺冇佢啲嘢]/;
// Everyday Chinese words written the same in both scripts and absent from Japanese.
const CHINESE = /[你她很呢吧啊哪怎]/;

/** Language of a piece of text, for the `lang` attribute; undefined when the script does not say. */
export function langOf(...texts: (string | null | undefined)[]): string | undefined {
  const s = texts.join(' ');
  if (KANA.test(s)) return 'ja';
  if (HANGUL.test(s)) return 'ko';
  if (!HAN.test(s)) return undefined;
  if (HANS.test(s)) return 'zh-Hans';
  if (HANT.test(s)) return 'zh-Hant';
  if (CHINESE.test(s)) return 'zh-Hans';
  return undefined;
}
