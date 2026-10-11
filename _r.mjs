import { judgeBias, expectationVerdict, pickDataPoints } from "./src/_t.mjs";
const cases = [
  ["CPI低于预期", "美国9月CPI同比升3.0%，市场预期3.1%，前值2.9%；核心CPI同比升3.2%，预期3.3%。数据公布后交易员加大对美联储11月降息的押注"],
  ["CPI高于预期", "美国9月CPI同比升3.4%，高于预期3.1%，前值2.9%，通胀反弹令降息预期降温"],
  ["非农不及预期", "美国9月非农就业人数增加15万人，低于预期的18万人，失业率升至4.3%"],
  ["股指期货上涨", "周五纽约尾盘，标普500股指期货最终涨0.65%，道指期货涨0.92%，纳斯达克100股指期货涨1.10%"],
  ["AI风险警告", "法拉利董事长看好AI，但警告称AI供需错配可能对市场构成风险，对AI如何变现仍存疑虑"],
  ["无信息量", "谷歌正在测试新版Gemini 4，代号Carbon"],
];
for (const [n, t] of cases) {
  const b = judgeBias(t);
  console.log(n.padEnd(12), b.tag, "| score", b.score, "|", b.hit, "|", expectationVerdict(t));
}