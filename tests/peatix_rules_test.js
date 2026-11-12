#!/usr/bin/env node

const assert = require("assert");
const { screenEvent } = require("../scripts/peatix_crawler");
const {
  isNightEvent,
  isSingleDayEvent,
  placeLabel,
  priceLabel,
  relevanceScore,
  PREFERRED_COMPANY_TERMS,
  dedupeCandidates,
  eventSort,
} = require("../scripts/peatix_daily_top5");

function event(name, overrides = {}) {
  return {
    name,
    venueName: "テスト会場",
    address: "東京都渋谷区道玄坂1-1",
    organizerName: "",
    groupName: "",
    description: "",
    price: "",
    ...overrides,
  };
}

for (const name of [
  "異業種交流会",
  "街コン",
  "合コン",
  "会社員飲み会",
  "朝活キャリア交流",
  "婚活パーティー",
  "恋活カフェ会",
  "縁結び出会いカフェ会",
  "マッチング交流会",
  "新宿カフェ会",
]) {
  assert.strictEqual(screenEvent(event(name)).decision, "除外", `${name} should be excluded`);
}

assert.deepStrictEqual(
  [screenEvent(event("生成AI勉強会")).decision, screenEvent(event("生成AI勉強会")).priority],
  ["対象", "中"]
);
assert.strictEqual(
  screenEvent(event("大人の少人数交流会")).decision,
  "除外",
  "generic exchange-only events should be excluded"
);
assert.strictEqual(
  screenEvent(event("生成AI交流会")).decision,
  "対象",
  "professional-themed exchange events should remain eligible"
);
assert.strictEqual(
  screenEvent(event("生成AI勉強会", { venueName: "カフェ・ベローチェ新宿店" })).decision,
  "除外",
  "cafe venues should be excluded"
);
for (const name of [
  "経営者向け営業交流会",
  "45歳からのキャリア交流会",
  "50代からのキャリアを語る夜",
  "初心者向けポーカー交流会",
  "自転車について語る懇親会",
  "日本営業協会 大商談会",
  "年収1000万ドライバー営業勉強会",
]) {
  assert.strictEqual(screenEvent(event(name)).decision, "除外", `${name} should be excluded`);
}
assert.strictEqual(
  isNightEvent(event("夜イベント", { datetime: "2026-11-01T18:00:00+09:00" }), "2026-11-01"),
  true
);
assert.strictEqual(
  isNightEvent(event("昼イベント", { datetime: "2026-11-01T17:59:00+09:00" }), "2026-11-01"),
  false
);
assert.strictEqual(
  isNightEvent(event("深夜イベント", { datetime: "2026-11-01T23:00:00+09:00" }), "2026-11-01"),
  false
);
assert.strictEqual(isSingleDayEvent(event("単日", { days: 1 })), true);
assert.strictEqual(isSingleDayEvent(event("長期", { days: 29 })), false);
assert.strictEqual(
  isNightEvent(
    event("長期夜イベント", {
      datetime: "2026-11-01T18:00:00+09:00",
      days: 29,
      formattedDateTime: "日曜日 18:00 (29 日間)",
    }),
    "2026-11-01"
  ),
  false
);
assert.strictEqual(placeLabel(event("場所テスト")), "渋谷区");
assert.strictEqual(
  placeLabel(event("場所テスト", { address: "日本、東京都豊島区東池袋1-1" })),
  "豊島区"
);
assert.strictEqual(
  placeLabel(event("場所テスト", { address: "神奈川県横浜市中区山下町1-1" })),
  "横浜市中区"
);
assert.strictEqual(priceLabel(event("金額テスト", { price: "2500" })), "2,500円");
assert.strictEqual(priceLabel(event("無料テスト")), "0円");
assert.ok(
  relevanceScore(event("【20歳〜35歳限定】生成AIマーケティング勉強会")) >
    relevanceScore(event("ビジネス交流会"))
);
assert.ok(PREFERRED_COMPANY_TERMS.includes("Ubie"));
assert.ok(PREFERRED_COMPANY_TERMS.includes("LinkedIn"));
assert.ok(PREFERRED_COMPANY_TERMS.includes("サイボウズ"));
const firstChoice = event(
  "Ubie×Offers｜AI人事セミナー・交流会【参加無料・定員100名】",
  { organizerName: "Ubie株式会社" }
);
const ordinaryChoice = event("AI人事セミナー");
assert.ok(relevanceScore(firstChoice) > relevanceScore(ordinaryChoice) + 20);
assert.ok(
  relevanceScore(event("AIセミナー＋交流会")) > relevanceScore(event("AIセミナー")),
  "learning plus interaction should receive a combo bonus"
);
assert.strictEqual(
  [
    { event: ordinaryChoice, screening: { priority: "高" } },
    { event: firstChoice, screening: { priority: "中" } },
  ].sort(eventSort)[0].event,
  firstChoice,
  "first-choice score should outrank the legacy high/medium label"
);
assert.strictEqual(
  dedupeCandidates([
    { event: event("【20歳〜35歳限定】月1マーケ会") },
    { event: event("【20歳〜35歳限定】 月1マーケ会！") },
  ]).length,
  1
);

console.log("peatix rules: ok");
