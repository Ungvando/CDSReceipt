/**
 * Field extraction config for OCR Form Filler — Costco receipt rules.
 *
 * Pure regex/string-matching, no LLM, no network. Edit the regexes below
 * to adjust extraction; edit extractItemsWithQuantities() if Costco
 * changes their line format.
 */

// SUBTOTAL followed by a decimal amount, e.g. "SUBTOTAL 123.45"
const SUBTOTAL_PATTERN = /SUBTOTAL\s+(\d+\.\d{2})/i;

// Line must START with "TAX" (so "TOTAL TAX" / mid-line "TAX" mentions don't match).
const TAX_PATTERN = /^\s*TAX\s+(\d+\.\d{2})/im;

/**
 * Item lines look like "E 1234567 ITEM NAME 12.99" ("E" is optional). A
 * quantity line sometimes appears directly above one, e.g. "2 @ 3.25",
 * meaning the item below was bought 2x at $3.25 each — costPer is derived
 * from totalPrice / quantity rather than trusting the unit price OCR'd
 * off that line directly. A single item with no preceding qty line
 * defaults to quantity 1.
 *
 * Coupon/discount lines ("E 0000123456/1234567 ITEM NAME 19.00-") are kept
 * as their own row, tagged isCoupon: true, with the discount amount as
 * both costPer and totalPrice, rather than being dropped.
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

function extractItemsWithQuantities(ocrText) {
  const lines = ocrText.split('\n').map(l => l.trim()).filter(Boolean);
  const items = [];
  let pendingQty = null;

  const qtyLineRegex = /^(\d)\s*[@8Bb]?\s*(\d{1,3}\.\d{1,2})$/;

  for (const line of lines) {
    const qtyMatch = line.match(qtyLineRegex);
    if (qtyMatch) {
      pendingQty = parseInt(qtyMatch[1], 10);
      continue;
    }

    const isDiscount = /0000\d*/.test(line);
    const priceMatch = line.match(/(\d+\.\d{2})\s*-?\s*A?$/);
    if (!priceMatch) continue;

    let itemNumber;
    if (isDiscount) {
      itemNumber = extractDiscountItemNumber(line);
    } else {
      itemNumber = extractItemNumberFromLine(line);
    }

    if (!itemNumber) {
      pendingQty = null;
      continue;
    }

    const totalPrice = parseFloat(priceMatch[1]);
    const qty = pendingQty || 1;
    const costPer = +(totalPrice / qty).toFixed(2);

    items.push({
      itemNumber,
      quantity: qty,
      costPer,
      totalPrice,
      isCoupon: isDiscount
    });
    pendingQty = null;
  }

  return items;
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

function validateItemCount(items, ocrItemsSoldCount) {
  const countedQty = items
    .filter(item => !item.isCoupon)
    .reduce((sum, item) => sum + item.quantity, 0);

  return {
    countedQty,
    ocrItemsSoldCount,
    matches: ocrItemsSoldCount !== null ? countedQty === ocrItemsSoldCount : null,
    needsManualInput: ocrItemsSoldCount === null
  };
}

function extractFields(ocrText) {
  const text = ocrText || "";

  const subtotalMatch = text.match(SUBTOTAL_PATTERN);
  const taxMatch = text.match(TAX_PATTERN);
  const items = extractItemsWithQuantities(text);
  const itemsSoldCount = extractItemsSoldCount(text);

  return {
    subtotal: subtotalMatch ? subtotalMatch[1] : null,
    tax: taxMatch ? taxMatch[1] : null,
    items,
    itemsSoldCount,
    itemCountCheck: validateItemCount(items, itemsSoldCount),
  };
}

// Drives popup.js's preview UI: order, labels, and field shape.
// isItemsTable fields hold an array of { itemNumber, quantity, costPer,
// totalPrice } objects rather than a single value.
const FIELD_DESCRIPTORS = [
  { key: "subtotal", label: "Subtotal", isList: false },
  { key: "tax", label: "Tax", isList: false },
  { key: "items", label: "Items", isItemsTable: true },
];

if (typeof window !== "undefined") {
  window.extractFields = extractFields;
  window.FIELD_DESCRIPTORS = FIELD_DESCRIPTORS;
  window.validateItemCount = validateItemCount;
}
