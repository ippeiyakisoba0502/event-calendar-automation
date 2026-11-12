#!/usr/bin/env node

const assert = require("assert");
const { screenEvent } = require("../scripts/peatix_crawler");
const { isNightEvent, placeLabel, priceLabel } = require("../scripts/peatix_daily_top5");

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
]) {
  assert.strictEqual(screenEvent(event(name)).decision, "除外", `${name} should be excluded`);
}

assert.deepStrictEqual(
  [screenEvent(event("生成AI勉強会")).decision, screenEvent(event("生成AI勉強会")).priority],
  ["対象", "中"]
);
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
assert.strictEqual(placeLabel(event("場所テスト")), "渋谷区");
assert.strictEqual(priceLabel(event("金額テスト", { price: "2500" })), "2,500円");
assert.strictEqual(priceLabel(event("無料テスト")), "0円");

console.log("peatix rules: ok");
