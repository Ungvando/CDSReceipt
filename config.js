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

// CA REDEMP (container/deposit fee) lines print a placeholder item number
// like "2500000000" that isn't a real product/coupon reference — it's just
// padding. That fake number happens to contain "0000", so it would
// otherwise get misclassified as a coupon by the isDiscount check. OCR
// sometimes garbles "REDEMP" itself, so the label match is loose; the
// digit-run fallback catches cases where even that garbles away.
const CA_REDEMP_PATTERN = /CA\s*REDE/i;

function isFeeLine(line) {
  if (CA_REDEMP_PATTERN.test(line)) return true;
  const runs = line.match(/\d{9,10}/g) || [];
  return runs.some(r => /0{6,}$/.test(r));
}

// The separator between qty and unit price is nominally "@", but OCR reads
// it as all sorts of things depending on font/scan quality — seen in the
// wild: 8, B, b, Q, €. Worse, spaces sometimes collapse entirely, making a
// single greedy regex ambiguous: "5812.79" could be qty 58 + price 12.79 OR
// qty 5 + "8"(misread @) + 12.79, and "484.79" could be a stray
// running-total artifact or qty 4 @ 4.79. Rather than committing to one
// parse, every structurally plausible (qty, unitPrice) reading is collected
// and the winner is chosen later against the item line's total price —
// which is always available from the line below — via qty × unit ≈ total.
// A stray artifact line simply produces candidates that fail the math and
// gets ignored, so no anchoring tricks are needed to reject it up front.
const QTY_CANDIDATE_REGEXES = [
  /^(\d)\s*[@8BbQ€]\s+(\d{1,3}\.\d{1,2})\b/,   // 1-digit qty, spaced sep
  /^(\d{2})\s*[@8BbQ€]\s+(\d{1,3}\.\d{1,2})\b/, // 2-digit qty, spaced sep
  /^(\d)[@8BbQ€](\d{1,3}\.\d{1,2})\b/,          // collapsed, 1-digit qty + sep
  /^(\d{2})[@8BbQ€](\d{1,3}\.\d{1,2})\b/,       // collapsed, 2-digit qty + sep
  /^(\d)(\d{1,3}\.\d{1,2})\b/,                  // sep dropped, 1-digit qty
  /^(\d{2})(\d{1,3}\.\d{1,2})\b/                // sep dropped, 2-digit qty
];

function buildQtyCandidates(line) {
  const candidates = [];
  const seen = new Set();
  for (const regex of QTY_CANDIDATE_REGEXES) {
    const m = line.match(regex);
    if (!m) continue;
    const qty = parseInt(m[1], 10);
    const price = parseFloat(m[2]);
    if (!qty || !price) continue;
    const key = qty + '|' + price;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ qty, price, priceStr: m[2] });
  }
  return candidates.length ? candidates : null;
}

// Picks the candidate whose qty × unitPrice matches the item's total.
// Exact check first; then two OCR-tolerant checks against the true unit
// (totalPrice / qty, formatted to 2 decimals):
//   - prefix: OCR dropped the final decimal digit ("39.9" printed for 39.99)
//   - last-digit misread: OCR garbled only the final digit ("13.45" printed
//     for 13.49) — same length, all but the last character agree
// Returns null if nothing passes.
function resolveQtyCandidates(candidates, totalPrice) {
  const exact = candidates.filter(c => Math.abs(c.qty * c.price - totalPrice) < 0.02);
  if (exact.length) return exact[0].qty;

  const tolerant = candidates.filter(c => {
    const unit = (totalPrice / c.qty).toFixed(2);
    // Strip a leading zero OCR sometimes glues on (e.g. "013.45")
    const ocr = c.priceStr.replace(/^0(?=\d)/, '');
    if (unit.startsWith(ocr)) return true;
    return ocr.length === unit.length && ocr.slice(0, -1) === unit.slice(0, -1);
  });
  if (tolerant.length) return tolerant[0].qty;

  return null;
}

function extractItemsWithQuantities(ocrText) {
  const lines = ocrText.split('\n').map(l => l.trim()).filter(Boolean);
  const items = [];
  let pendingQtyCandidates = null;
  let pendingQtyRawLine = null;
  let skipNextItemLine = false;
  let voidCount = 0;

  for (const line of lines) {
    // VOID reverses the item printed directly above it, and is immediately
    // followed by the reversal line itself (e.g. the same item at a
    // negative price) — drop both rather than pushing either.
    if (/^VOID/i.test(line)) {
      items.pop();
      skipNextItemLine = true;
      voidCount++;
      pendingQtyCandidates = null;
      pendingQtyRawLine = null;
      continue;
    }

    const qtyCandidates = buildQtyCandidates(line);
    if (qtyCandidates) {
      pendingQtyCandidates = qtyCandidates;
      pendingQtyRawLine = line;
      continue;
    }

    const isFee = isFeeLine(line);
    const isDiscount = !isFee && /0000\d*/.test(line);
    const priceMatch = line.match(/(\d+\.\d{2})\s*(-)?\s*A?$/);
    if (!priceMatch) continue;

    let itemNumber;
    if (isFee) {
      // The item number printed on a fee line is a placeholder, not a real
      // reference — inherit the item it belongs to from whatever was
      // pushed last (a coupon row already stores the real referenced item
      // number, so no extra lookup is needed there).
      const lastEntry = items[items.length - 1];
      itemNumber = lastEntry ? lastEntry.itemNumber : null;
    } else if (isDiscount) {
      itemNumber = extractDiscountItemNumber(line);
    } else {
      itemNumber = extractItemNumberFromLine(line);
    }

    if (!itemNumber) {
      pendingQtyCandidates = null;
      pendingQtyRawLine = null;
      continue;
    }

    if (skipNextItemLine) {
      skipNextItemLine = false;
      pendingQtyCandidates = null;
      pendingQtyRawLine = null;
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
    if (!isFee && !isDiscount && isReversal) {
      const lastEntry = items[items.length - 1];
      if (lastEntry && !lastEntry.isCoupon && !lastEntry.isFee && lastEntry.totalPrice === totalPrice) {
        items.pop();
        voidCount++;
        pendingQtyCandidates = null;
        pendingQtyRawLine = null;
        continue;
      }
    }

    let qty = 1;
    if (pendingQtyCandidates) {
      const resolved = resolveQtyCandidates(pendingQtyCandidates, totalPrice);
      if (resolved) {
        qty = resolved;
      } else {
        console.warn(
          `OCR Form Filler: no qty candidate matched — qty line "${pendingQtyRawLine}", item line "${line}"; defaulting to qty 1`
        );
      }
    }
    const costPer = +(totalPrice / qty).toFixed(2);

    items.push({
      itemNumber,
      quantity: qty,
      costPer,
      totalPrice,
      isCoupon: isDiscount,
      isFee: isFee
    });
    pendingQtyCandidates = null;
    pendingQtyRawLine = null;
  }

  return { items, voidCount, linesParsed: lines.length };
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
    .filter(item => !item.isCoupon && !item.isFee)
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
  const { items, voidCount, linesParsed } = extractItemsWithQuantities(text);
  const itemsSoldCount = extractItemsSoldCount(text);

  return {
    subtotal: subtotalMatch ? subtotalMatch[1].replace(/,/g, "") : null,
    tax: taxMatch ? taxMatch[1] : null,
    items,
    itemsSoldCount,
    itemCountCheck: validateItemCount(items, itemsSoldCount),
    voidCount,
    linesParsed,
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
