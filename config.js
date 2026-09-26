/**
 * Field extraction config for OCR Form Filler — Costco receipt rules.
 *
 * Pure regex/string-matching, no LLM, no network. Edit the regexes below
 * to adjust extraction; edit extractItemsWithQuantities() if Costco
 * changes their line format.
 */

// SUBTOTAL followed by a decimal amount, e.g. "SUBTOTAL 123.45" or
// "SUBTOTAL 1,322.24" (optional thousands comma).
const SUBTOTAL_PATTERN = /SUBTOTAL\s+(\d{1,3}(?:,\d{3})*\.\d{2})/i;

// Line must START with "TAX" (so "TOTAL TAX" / a tax-rate breakdown line
// like "A 10.500% TOTAL TAX 10.49" don't match — only the standalone
// "TAX 10.49" line does).
const TAX_PATTERN = /^\s*TAX\s+(\d+\.\d{2})/im;

// "App#: 91660G" (credit card approval code). Tolerant of OCR variants:
// "App# :", "Rpp#" (A misread as R), "APP #" (space before "#").
const APP_NUMBER_PATTERN = /[AR]pp\s*#\s*:?\s*([A-Z0-9]{4,10})/i;

/**
 * Item lines look like "E 1234567 ITEM NAME 12.99" ("E" is optional, and
 * does NOT decide quantity — it's just a tax-category marker Costco prints
 * on some lines). A quantity line sometimes appears directly above one,
 * e.g. "2 @ 3.25", meaning the item/coupon below was bought 2x at $3.25
 * each. A line with no preceding qty line defaults to quantity 1 with the
 * unit price equal to the line's total.
 *
 * Coupon lines ("E 0000123456 /1234567 19.00-") reference another item's
 * number rather than being an item themselves — they're attached to that
 * item as a discount (see extractItemsWithQuantities) and excluded from
 * the items array entirely, so they never count toward item-count checks.
 *
 * Item numbers are extracted by grabbing the last 6-7 digits of a 5+ digit
 * run rather than front-anchoring — Costco item numbers are always max 7
 * digits, so if OCR prepends stray noise onto the front of the run,
 * counting from the back is more reliable than counting from the front.
 */
function extractItemNumberFromLine(line) {
  // Grab the leading run of digits (possibly preceded by stray OCR noise/E)
  const digitRunMatch = line.match(/(\d{5,})/); // at least 5 digits to avoid qty/price noise
  if (!digitRunMatch) return null;

  const digitRun = digitRunMatch[1];

  // Costco item numbers are max 7 digits — count from the BACK, not the front,
  // in case OCR prepended garbage onto the front of the run
  const itemNumber = digitRun.length > 7
    ? digitRun.slice(-7)
    : digitRun;

  return itemNumber;
}

// Discount/coupon lines reference another item's number, but OCR
// sometimes misreads the "/" separator as "7" (or drops it), so splitting
// on a literal "/" silently fails and drops the whole row. Scanning the
// line for every 5+ digit run and picking the first one that isn't the
// "0000..." discount-code prefix doesn't depend on "/" surviving OCR at all.
function extractDiscountItemNumber(line) {
  const runs = line.match(/\d{5,}/g) || [];
  const candidate = runs.find(r => !r.startsWith('0000'));
  if (!candidate) return null;
  return candidate.length > 7 ? candidate.slice(-7) : candidate;
}

// A coupon line is "E 0000xxxxxx /ITEMNUMBER amount-": an optional "E",
// then a discount code starting with "0000", then (loosely) a slash and
// the item number it discounts, then the amount with a trailing "-".
// Both halves are checked independently (rather than one combined regex)
// so OCR noise in the middle — a garbled/missing "/" — doesn't stop the
// line from being recognized as a coupon at all.
const COUPON_PREFIX_PATTERN = /^E?\s*0000\d{2,}/i;
const TRAILING_DISCOUNT_PATTERN = /(\d+\.\d{2})\s*-\s*$/;

function isCouponLine(line) {
  return COUPON_PREFIX_PATTERN.test(line) && TRAILING_DISCOUNT_PATTERN.test(line);
}

// CA REDEMP (container/deposit fee) lines print a placeholder item number
// like "2500000000" that isn't a real product/coupon reference — it's just
// padding. OCR sometimes garbles "REDEMP" itself, so the label match is
// loose; the digit-run fallback catches cases where even that garbles away.
const CA_REDEMP_PATTERN = /CA\s*REDE/i;

function isFeeLine(line) {
  if (CA_REDEMP_PATTERN.test(line)) return true;
  const runs = line.match(/\d{9,10}/g) || [];
  return runs.some(r => /0{6,}$/.test(r));
}

// The separator between qty and unit price is nominally "@", but OCR reads
// it as all sorts of things depending on font/scan quality — seen in the
// wild: 8, B, e, Q, €.
const QTY_LINE_PATTERN = /^(\d{1,2})\s*[@8BeQ€]\s*(\d{1,3}\.\d{2})\b/;

function extractItemsWithQuantities(ocrText) {
  const lines = ocrText.split('\n').map(l => l.trim()).filter(Boolean);
  const items = [];
  const orphanCoupons = []; // coupons whose referenced item number wasn't found
  let pendingQty = null; // { qty, unitPrice } from a "N @ price" line, applies to the next item/coupon line
  let skipNextItemLine = false;
  let voidCount = 0;

  // Attaches to the most recently seen item with a matching number (coupons
  // normally follow the item they discount, so scanning from the end finds
  // the right one even if the same item number appears more than once).
  function attachCoupon(targetItemNumber, coupon) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].itemNumber === targetItemNumber) {
        items[i].coupons.push(coupon);
        return;
      }
    }
    orphanCoupons.push(coupon);
  }

  for (const line of lines) {
    // VOID reverses the item printed directly above it, and is immediately
    // followed by the reversal line itself (e.g. the same item at a
    // negative price) — drop both rather than pushing either.
    if (/^VOID/i.test(line)) {
      items.pop();
      skipNextItemLine = true;
      voidCount++;
      pendingQty = null;
      continue;
    }

    const qtyMatch = line.match(QTY_LINE_PATTERN);
    if (qtyMatch) {
      pendingQty = { qty: parseInt(qtyMatch[1], 10), unitPrice: parseFloat(qtyMatch[2]) };
      continue;
    }

    if (isCouponLine(line)) {
      const targetItemNumber = extractDiscountItemNumber(line);
      const amountMatch = line.match(TRAILING_DISCOUNT_PATTERN);
      if (!targetItemNumber || !amountMatch) {
        pendingQty = null;
        continue;
      }
      const totalPrice = parseFloat(amountMatch[1]);
      const quantity = pendingQty ? pendingQty.qty : 1;
      const costPer = pendingQty ? pendingQty.unitPrice : totalPrice;
      attachCoupon(targetItemNumber, {
        itemNumber: targetItemNumber,
        quantity,
        costPer,
        totalPrice,
      });
      pendingQty = null;
      continue;
    }

    const isFee = isFeeLine(line);
    const priceMatch = line.match(/(\d+\.\d{2})\s*(-)?\s*A?$/);
    if (!priceMatch) continue;

    let itemNumber;
    if (isFee) {
      // The item number printed on a fee line is a placeholder, not a real
      // reference — inherit the item it belongs to from whatever was
      // pushed last.
      const lastEntry = items[items.length - 1];
      itemNumber = lastEntry ? lastEntry.itemNumber : null;
    } else {
      itemNumber = extractItemNumberFromLine(line);
    }

    if (!itemNumber) {
      pendingQty = null;
      continue;
    }

    if (skipNextItemLine) {
      skipNextItemLine = false;
      pendingQty = null;
      continue;
    }

    const totalPrice = parseFloat(priceMatch[1]);
    const isReversal = !!priceMatch[2];

    // Fallback for a VOID pair whose literal "VOID" marker didn't survive
    // OCR: a plain product line immediately followed by another plain
    // product line at the same total price with a trailing "-" is a
    // reversal of the one just pushed. Matched on price rather than item
    // number, since OCR noise that garbles a leading digit (dropping the
    // "VOID" text is exactly the kind of scan quality that also does this)
    // can make the two lines' item numbers disagree even though they're
    // the same physical line item.
    if (!isFee && isReversal) {
      const lastEntry = items[items.length - 1];
      if (lastEntry && !lastEntry.isFee && lastEntry.totalPrice === totalPrice) {
        items.pop();
        voidCount++;
        pendingQty = null;
        continue;
      }
    }

    // If a quantity line came right before this one, qty = N and unit
    // price = that line's price. Otherwise qty = 1 and unit price = total.
    // The "E" prefix plays no part in this decision.
    const quantity = pendingQty ? pendingQty.qty : 1;
    const costPer = pendingQty ? pendingQty.unitPrice : totalPrice;

    items.push({
      itemNumber,
      quantity,
      costPer,
      totalPrice,
      isFee,
      coupons: [],
    });
    pendingQty = null;
  }

  return { items, orphanCoupons, voidCount, linesParsed: lines.length };
}

// Costco receipts print a self-reported total unit count in the footer,
// either "Items Sold: N" or "TOTAL NUMBER OF ITEMS SOLD = N" — comparing
// it against the sum of extracted quantities catches missed/misparsed
// item lines before the user fills a form with bad data.
function extractItemsSoldCount(ocrText) {
  // Try both patterns Costco receipts use
  const patterns = [
    /Items?\s+Sold:?\s*(\d+)/i,
    /TOTAL\s+NUMBER\s+OF\s+ITEMS\s+SOLD\s*=\s*(\d+)/i
  ];

  for (const pattern of patterns) {
    const match = ocrText.match(pattern);
    if (match) return parseInt(match[1], 10);
  }

  return null; // not found — user will need to enter manually
}

// Coupons are never in `items` (they live in item.coupons), so this only
// needs to exclude fee/CRV lines from the quantity sum.
function validateItemCount(items, ocrItemsSoldCount) {
  const countedQty = items
    .filter(item => !item.isFee)
    .reduce((sum, item) => sum + item.quantity, 0);

  return {
    countedQty,
    ocrItemsSoldCount,
    matches: ocrItemsSoldCount !== null ? countedQty === ocrItemsSoldCount : null,
    needsManualInput: ocrItemsSoldCount === null,
  };
}

// Sum of item totals minus coupon amounts should equal the receipt's
// printed SUBTOTAL — a cross-check independent of the item-count check,
// catching cases where a line was misparsed but the count still happened
// to line up (or vice versa).
function validateMoneyCheck(items, subtotal) {
  const subtotalNum = subtotal === null || subtotal === undefined || subtotal === "" ? null : parseFloat(subtotal);

  let itemsTotal = 0;
  let couponsTotal = 0;
  for (const item of items) {
    itemsTotal += item.totalPrice;
    for (const coupon of item.coupons || []) {
      couponsTotal += coupon.totalPrice;
    }
  }
  itemsTotal = +itemsTotal.toFixed(2);
  couponsTotal = +couponsTotal.toFixed(2);
  const expected = +(itemsTotal - couponsTotal).toFixed(2);

  if (subtotalNum === null || Number.isNaN(subtotalNum)) {
    return { itemsTotal, couponsTotal, expected, subtotal: null, difference: null, matches: null };
  }

  const difference = +(expected - subtotalNum).toFixed(2);
  return {
    itemsTotal,
    couponsTotal,
    expected,
    subtotal: subtotalNum,
    difference,
    matches: Math.abs(difference) < 0.02,
  };
}

function extractFields(ocrText) {
  const text = ocrText || "";

  const subtotalMatch = text.match(SUBTOTAL_PATTERN);
  const taxMatch = text.match(TAX_PATTERN);
  const appNumberMatch = text.match(APP_NUMBER_PATTERN);
  const { items, orphanCoupons, voidCount, linesParsed } = extractItemsWithQuantities(text);
  const itemsSoldCount = extractItemsSoldCount(text);
  const subtotal = subtotalMatch ? subtotalMatch[1].replace(/,/g, "") : null;

  return {
    subtotal,
    tax: taxMatch ? taxMatch[1] : null,
    appNumber: appNumberMatch ? appNumberMatch[1] : null,
    items,
    orphanCoupons,
    itemsSoldCount,
    itemCountCheck: validateItemCount(items, itemsSoldCount),
    moneyCheck: validateMoneyCheck(items, subtotal),
    voidCount,
    linesParsed,
  };
}

// Drives popup.js's preview UI: order, labels, and field shape.
// isItemsTable fields hold an array of { itemNumber, quantity, costPer,
// totalPrice, coupons } objects rather than a single value.
const FIELD_DESCRIPTORS = [
  { key: "subtotal", label: "Subtotal", isList: false },
  { key: "tax", label: "Tax", isList: false },
  { key: "appNumber", label: "App #", isList: false },
  { key: "items", label: "Items", isItemsTable: true },
];

if (typeof window !== "undefined") {
  window.extractFields = extractFields;
  window.FIELD_DESCRIPTORS = FIELD_DESCRIPTORS;
  window.validateItemCount = validateItemCount;
  window.validateMoneyCheck = validateMoneyCheck;
}

// Node (tests) doesn't define `window` — export the same surface via
// CommonJS so tests/parse.test.js can `require()` this file directly.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { extractFields, FIELD_DESCRIPTORS, validateItemCount, validateMoneyCheck };
}
