"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { extractFields } = require("../config.js");

const fixture = fs.readFileSync(path.join(__dirname, "costco-sample.txt"), "utf8");

test("Costco sample receipt parses correctly", () => {
  const result = extractFields(fixture);

  assert.equal(Number(result.subtotal), 760.28);
  assert.equal(Number(result.tax), 10.49);
  assert.equal(result.appNumber, "91660G");

  assert.equal(result.items.length, 12);
  const totalQty = result.items.reduce((sum, item) => sum + item.quantity, 0);
  assert.equal(totalQty, 62);
  assert.equal(result.itemsSoldCount, 62);
  assert.equal(result.itemCountCheck.matches, true);

  const byNumber = Object.fromEntries(result.items.map((item) => [item.itemNumber, item]));

  const expectedItems = [
    ["2037470", 3, 26.49, 79.47],
    ["1780981", 4, 19.99, 79.96],
    ["2027490", 4, 27.99, 111.96],
    ["1116038", 2, 12.69, 25.38],
    ["26584", 2, 9.49, 18.98],
    ["2024274", 8, 5.69, 45.52],
    ["1578129", 6, 15.29, 91.74],
    ["2041812", 12, 5.89, 70.68],
    ["2070434", 6, 4.79, 28.74],
    ["1927215", 1, 19.99, 19.99],
    ["2102368", 10, 9.99, 99.90],
    ["1403469", 4, 34.99, 139.96],
  ];

  for (const [itemNumber, quantity, costPer, totalPrice] of expectedItems) {
    const item = byNumber[itemNumber];
    assert.ok(item, `missing item ${itemNumber}`);
    assert.equal(item.quantity, quantity, `qty for ${itemNumber}`);
    assert.equal(item.costPer, costPer, `unit price for ${itemNumber}`);
    assert.equal(item.totalPrice, totalPrice, `total for ${itemNumber}`);
  }

  assert.equal(byNumber["2027490"].coupons.length, 1);
  assert.equal(byNumber["2027490"].coupons[0].totalPrice, 24.0);
  assert.equal(byNumber["2027490"].coupons[0].itemNumber, "2027490");

  assert.equal(byNumber["1403469"].coupons.length, 1);
  assert.equal(byNumber["1403469"].coupons[0].totalPrice, 28.0);
  assert.equal(byNumber["1403469"].coupons[0].itemNumber, "1403469");

  assert.equal(result.orphanCoupons.length, 0);

  assert.equal(result.moneyCheck.itemsTotal, 812.28);
  assert.equal(result.moneyCheck.couponsTotal, 52.0);
  assert.equal(result.moneyCheck.expected, 760.28);
  assert.equal(result.moneyCheck.matches, true);
});
