"use strict";

/**
 * Injected on demand (via chrome.scripting.executeScript) when the user
 * clicks "Fill Form" in the popup. Scans the active page's form controls,
 * matches them against the OCR-extracted fields, and fills them in a way
 * that framework-driven inputs (React/Vue/etc.) will actually notice.
 *
 * chrome.scripting.executeScript re-injects this file into the SAME page
 * context on every "Fill Form" click, and top-level const/let/function
 * declarations collide with the previous injection's on re-run ("Identifier
 * 'X' has already been declared"). Everything lives inside this guard so a
 * second injection is a safe no-op.
 */
if (!window.__receiptFillerInjected) {
  window.__receiptFillerInjected = true;

  // Which page-input name/id/placeholder/label/formcontrolname terms count
  // as a match for each extracted field. Edit/extend freely. subtotal/tax/
  // fileNameId match keys extractFields() returns directly in config.js;
  // itemNumber/quantity/costPer are the three per-row columns pulled out of
  // its `items` array by fillItemRows() below.
  //
  // costPer: confirmed from real DOM that the Angular form uses
  // formcontrolname="cost" (not "costPer") — "cost" is listed first since
  // it's the confirmed exact value; the rest are fallbacks for other pages.
  const FIELD_INPUT_MAP = {
    subtotal: ["subtotal", "sub_total", "sub-total"],
    tax: ["tax"],
    fileNameId: ["receipt_number", "receiptnumber", "receipt#", "receiptno"],
    itemNumber: ["item_number", "itemnumber", "sku"],
    quantity: ["units", "unitslbs", "units_lbs", "qty", "quantity"],
    costPer: ["cost", "costper", "cost_per", "price_per", "unitcost"],
  };

  const LOG_PREFIX = "[OCR Form Filler]";

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "OCR_FORM_FILLER_FILL") {
      const filled = fillForm(message.fields || []);
      sendResponse({ filled });
    }
  });

  function fillForm(fields) {
    // content scripts don't have the "tabs" permission, so chrome.tabs.query
    // isn't available here — window.location.href is the reliable way to
    // confirm which page this injection actually landed on.
    console.log(`${LOG_PREFIX} fillForm() running on:`, window.location.href);

    if (!fields.length) return 0;

    const inputs = getFillableInputs(); // also sets cachedFillRoot, see getActiveModalRoot()
    if (cachedFillRoot === document) {
      console.warn(`${LOG_PREFIX} No modal container found — filling against full page, results may be wrong.`);
    }

    const usedInputs = new Set();
    let filledCount = 0;

    // Scalar fields (subtotal, tax, fileNameId): one best-scoring input each.
    for (const field of fields) {
      if (field.key === "items" || Array.isArray(field.value)) continue;
      const terms = [field.key, field.label, ...(FIELD_INPUT_MAP[field.key] || [])].filter(Boolean);
      const matches = findField(field.key, terms, inputs, usedInputs);
      const best = matches[0];
      if (!best) continue;
      if (tryFill(best.el, field.value, field.key)) {
        filledCount++;
        usedInputs.add(best.el);
      }
    }

    const itemsField = fields.find((f) => f.key === "items");
    if (itemsField && Array.isArray(itemsField.value) && itemsField.value.length) {
      filledCount += fillItemRows(itemsField.value, inputs, usedInputs);
    }

    return filledCount;
  }

  function tryFill(el, value, key) {
    try {
      return fillElement(el, value) !== false;
    } catch (err) {
      console.warn(`${LOG_PREFIX} failed to fill field`, key, err);
      return false;
    }
  }

  // Each item row has THREE fields to fill (Item Number, Units/lbs, Cost
  // Per) — never Subtotal/Tax Amount/Total cost, which are disabled and
  // recompute automatically once units+costPer are set (and are already
  // excluded from `inputs` by getFillableInputs' !el.disabled filter). For
  // each column we collect every matching input across the form/modal, sort
  // them into DOM order, and zip them against the parsed rows positionally
  // — this lines up correctly with a repeating row/formArray layout without
  // needing to detect row-container boundaries.
  function fillItemRows(items, inputs, usedInputs) {
    // Print every row's values before touching the DOM, so a bad value
    // (e.g. quantity showing up as "6.00" instead of "6") can be traced
    // back to extraction (config.js) vs. the DOM-fill step below.
    console.log(
      `${LOG_PREFIX} fillItemRows: ${items.length} row(s) about to be filled:`,
      items.map((it) => ({ itemNumber: it.itemNumber, quantity: it.quantity, costPer: it.costPer }))
    );

    let filledCount = 0;

    const columns = [
      { field: "itemNumber", key: "itemNumber" },
      { field: "quantity", key: "quantity" },
      { field: "costPer", key: "costPer" },
    ];

    for (const { field, key } of columns) {
      const terms = [key, ...(FIELD_INPUT_MAP[key] || [])];
      const matches = findField(key, terms, inputs, usedInputs);
      if (!matches.length) continue;

      const inDomOrder = sortByDomOrder(matches.map((m) => m.el));
      for (let i = 0; i < inDomOrder.length && i < items.length; i++) {
        // String(), not toFixed() — quantity is a plain integer and
        // costPer is already rounded to 2dp back in config.js, so no
        // formatting belongs here; it would just risk reformatting one
        // of them incorrectly.
        const value = String(items[i][field]);
        if (tryFill(inDomOrder[i], value, key)) {
          filledCount++;
          usedInputs.add(inDomOrder[i]);
          console.log(`${LOG_PREFIX} fillItemRows: row ${i} "${key}" = "${value}" ->`, truncateOuterHTML(inDomOrder[i]));
        }
      }
    }

    return filledCount;
  }

  function sortByDomOrder(els) {
    return [...els].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  // ---- Locating candidate inputs --------------------------------------------

  // Cached per fillForm() call (see getFillableInputs) so getLabelText()
  // doesn't have to re-run the modal lookup for every candidate input.
  let cachedFillRoot = null;

  // If a modal/dialog is open, scope every query to it instead of the whole
  // document — otherwise matching can land on a hidden duplicate field
  // behind the modal, or on an unrelated same-named field elsewhere on the
  // page. Falls back to `document` when nothing modal-like is open.
  function getActiveModalRoot() {
    const candidateSelectors = [
      ".modal.show", // Bootstrap-style
      '[role="dialog"]', // ARIA modal
      ".modal-content",
      ".cdk-overlay-container", // Angular Material
      ".p-dialog", // PrimeNG
    ];

    for (const selector of candidateSelectors) {
      const el = document.querySelector(selector);
      if (el && isVisible(el)) {
        console.log(`${LOG_PREFIX} getActiveModalRoot(): matched "${selector}"`, truncateOuterHTML(el, 150));
        return el;
      }
    }

    console.warn(`${LOG_PREFIX} getActiveModalRoot(): no modal container found — filling against full page, results may be wrong.`);
    return document;
  }

  function getFillableInputs() {
    cachedFillRoot = getActiveModalRoot();
    const inputSelector =
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="reset"]):not([type="file"]):not([type="password"]):not([type="checkbox"]):not([type="radio"])';
    const all = cachedFillRoot.querySelectorAll(`${inputSelector}, textarea, select`);
    return [...all].filter((el) => isVisible(el) && !el.disabled && !el.readOnly);
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  // ---- Matching fields to inputs ---------------------------------------------

  // Logged wrapper around getScoredMatches(). There's no fixed CSS-selector
  // list per field here (unlike a hand-rolled findField(selectorList)) —
  // every candidate input is scored against alias terms instead — so what
  // gets logged is the winning element (and score) rather than "which
  // selector matched". Called from both fillForm() (scalar fields, which
  // only use matches[0]) and fillItemRows() (item columns, which use the
  // full list) so this is the one place to look when a field lands on the
  // wrong element.
  function findField(fieldKey, terms, inputs, usedInputs) {
    const matches = getScoredMatches(terms, inputs, usedInputs);

    if (!matches.length) {
      console.warn(`${LOG_PREFIX} findField("${fieldKey}"): NO MATCH — terms tried:`, terms);
      return matches;
    }

    const best = matches[0];
    console.log(`${LOG_PREFIX} findField("${fieldKey}"): best match (score ${best.score})`, truncateOuterHTML(best.el));
    if (matches.length > 1) {
      console.log(
        `${LOG_PREFIX} findField("${fieldKey}"): ${matches.length - 1} other candidate(s) also scored > 0:`,
        matches.slice(1).map((m) => ({ score: m.score, el: truncateOuterHTML(m.el) }))
      );
    }
    return matches;
  }

  function truncateOuterHTML(el, max = 200) {
    const html = (el && el.outerHTML) || "";
    return html.length > max ? html.slice(0, max) + "…" : html;
  }

  function getScoredMatches(terms, inputs, usedInputs) {
    const scored = [];
    for (const el of inputs) {
      if (usedInputs.has(el)) continue;
      const score = scoreCandidate(el, terms);
      if (score > 0) scored.push({ el, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  function scoreCandidate(el, terms) {
    const idBlob = normalize(el.id);
    const nameBlob = normalize(el.name);
    // formcontrolname gets its own exact-match check (same tier as id/name)
    // rather than only counting toward the fuzzy substring blob below —
    // it's the most reliable identifier on an Angular reactive form, more
    // so than `name`, which is often auto-generated/indexed per row (e.g.
    // name="scan_03") and shouldn't be trusted as a selector on its own.
    const formControlNameBlob = normalize(el.getAttribute("formcontrolname"));
    const blob = normalize(getIdentifierString(el));

    let score = 0;
    for (const term of terms) {
      const t = normalize(term);
      if (!t || t.length < 2) continue;
      if (idBlob === t || nameBlob === t || formControlNameBlob === t) {
        score = Math.max(score, 100 + t.length);
      } else if (blob.includes(t)) {
        score = Math.max(score, 50 + t.length);
      } else if (blob.length >= 3 && t.includes(blob)) {
        score = Math.max(score, 20 + blob.length);
      }
    }
    return score;
  }

  function getIdentifierString(el) {
    const parts = [
      el.id,
      el.name,
      el.getAttribute("placeholder"),
      el.getAttribute("aria-label"),
      el.getAttribute("autocomplete"),
      // Angular reactive forms tag controls with formcontrolname instead of
      // (or in addition to) name/id — without this, Angular apps that only
      // set formcontrolname would never score a match.
      el.getAttribute("formcontrolname"),
      getLabelText(el),
    ];
    return parts.filter(Boolean).join(" ");
  }

  function getLabelText(el) {
    let text = "";
    if (el.labels && el.labels.length) {
      text += [...el.labels].map((l) => l.textContent).join(" ");
    }
    if (el.id) {
      const root = cachedFillRoot || document;
      const forLabel = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (forLabel) text += " " + forLabel.textContent;
    }
    const closestLabel = el.closest("label");
    if (closestLabel) text += " " + closestLabel.textContent;
    return text;
  }

  function normalize(str) {
    return (str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  // ---- Filling & event dispatch ----------------------------------------------

  function fillElement(el, value) {
    if (el.tagName === "SELECT") return fillSelect(el, value);
    if (isAngularControl(el)) return fillAngularInput(el, value);
    return fillTextLike(el, value);
  }

  // Angular reactive forms (formControlName) and template-driven forms
  // (ngModel, which Angular mirrors onto the DOM as ng-reflect-* in dev
  // builds) pick up value changes from native 'input'/'change' events, not
  // from keyboard simulation — the extra keydown/keyup pair fillTextLike
  // sends for autocomplete widgets is unnecessary noise here and blur is
  // what actually marks the control ng-touched and runs validators.
  function isAngularControl(el) {
    return el.hasAttribute("formcontrolname") || el.hasAttribute("ng-reflect-name");
  }

  function fillAngularInput(input, value) {
    input.focus();
    setNativeValue(input, value); // same safe setter used elsewhere; equivalent to input.value = value here
    dispatchEvents(input, ["input", "change"]);
    input.blur(); // triggers ng-touched, runs validation
    return true;
  }

  function fillSelect(select, value) {
    const normalized = normalize(value);
    const options = [...select.options];
    let match =
      options.find((o) => normalize(o.value) === normalized || normalize(o.textContent) === normalized) ||
      options.find((o) => normalize(o.textContent).includes(normalized) && normalized.length >= 2) ||
      options.find((o) => normalized.includes(normalize(o.textContent)) && normalize(o.textContent).length >= 2);

    if (!match) return false;

    select.focus();
    setNativeValue(select, match.value);
    dispatchEvents(select, ["input", "change"]);
    select.blur();
    return true;
  }

  // Handles plain text inputs as well as autocomplete/combobox-style widgets:
  // focus first, set the value through the native setter (so React/Vue see
  // it), then fire keydown/input/change/keyup like a real keystroke would,
  // so listeners bound to keyboard events (common in autocomplete widgets)
  // also fire, not just ones bound to `input`.
  function fillTextLike(el, value) {
    el.focus();
    setNativeValue(el, value);

    const keyInit = { bubbles: true, cancelable: true, key: value.slice(-1) || "" };
    el.dispatchEvent(new KeyboardEvent("keydown", keyInit));
    dispatchEvents(el, ["input"]);
    el.dispatchEvent(new KeyboardEvent("keyup", keyInit));
    dispatchEvents(el, ["change"]);

    el.blur();
    return true;
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  function dispatchEvents(el, eventNames) {
    for (const name of eventNames) {
      el.dispatchEvent(new Event(name, { bubbles: true }));
    }
  }
}
