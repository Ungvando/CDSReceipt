"use strict";

/**
 * Popup controller: image intake -> lazy OCR -> field extraction -> fill.
 * Tesseract.js is only loaded (via a dynamically injected <script>) once
 * the user clicks "Extract Text", so the popup itself stays tiny on open.
 */

const dropZone = document.getElementById("drop-zone");
const dropZoneEmpty = document.getElementById("drop-zone-empty");
const fileInput = document.getElementById("file-input");
const previewImage = document.getElementById("preview-image");
const extractBtn = document.getElementById("extract-btn");
const clearBtn = document.getElementById("clear-btn");
const statusEl = document.getElementById("status");
const progressBar = document.getElementById("progress-bar");
const resultsSection = document.getElementById("results");
const rawTextEl = document.getElementById("raw-text");
const itemsSummaryEl = document.getElementById("items-summary");
const itemCountCheckEl = document.getElementById("item-count-check");
const fieldsListEl = document.getElementById("fields-list");
const fillBtn = document.getElementById("fill-btn");
const fillStatusEl = document.getElementById("fill-status");

let currentImageDataUrl = null; // data URL fed to Tesseract + <img> preview
let currentFileNameId = null; // uploaded filename, extension stripped
let currentFields = {}; // key -> { label, value, include }
let tesseractWorker = null;

// { items, countedQty, ocrItemsSoldCount, matches, currentValue } — see
// renderItemCountCheck(). currentValue is what's actually compared against
// countedQty; it starts out equal to ocrItemsSoldCount, but tracks the
// user's manual entry when the receipt didn't have one.
let itemCountState = null;

init();

function init() {
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) setImageFile(fileInput.files[0]);
  });

  dropZone.addEventListener("click", () => {
    if (!currentImageDataUrl) fileInput.click();
  });

  dropZone.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && !currentImageDataUrl) {
      e.preventDefault();
      fileInput.click();
    }
  });

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
  });

  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) setImageFile(file);
  });

  document.addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) setImageFile(file);
        break;
      }
    }
  });

  extractBtn.addEventListener("click", handleExtractClick);
  clearBtn.addEventListener("click", resetAll);
  fillBtn.addEventListener("click", handleFillClick);

  restoreLastResult();
}

function setImageFile(file) {
  currentFileNameId = stripExtension(file.name);

  const reader = new FileReader();
  reader.onload = () => {
    currentImageDataUrl = reader.result;
    previewImage.src = currentImageDataUrl;
    previewImage.hidden = false;
    dropZoneEmpty.hidden = true;
    extractBtn.disabled = false;
    setStatus("");
  };
  reader.onerror = () => setStatus("Could not read that image file.", true);
  reader.readAsDataURL(file);
}

// "32660G.jpg" -> "32660G". Pasted-from-clipboard images often have no
// meaningful filename (e.g. "image.png") — that's fine, it just produces
// a not-very-useful ID and the user can uncheck/edit it in the preview.
function stripExtension(filename) {
  const idx = filename.lastIndexOf(".");
  return idx > 0 ? filename.slice(0, idx) : filename;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function setFillStatus(message, isError = false) {
  fillStatusEl.textContent = message;
  fillStatusEl.classList.toggle("error", isError);
}

async function handleExtractClick() {
  if (!currentImageDataUrl) return;
  extractBtn.disabled = true;
  progressBar.hidden = false;
  progressBar.value = 0;
  setStatus("Loading OCR engine…");

  try {
    const text = await runOCR(currentImageDataUrl, (m) => {
      if (m.status) {
        const pct = typeof m.progress === "number" ? Math.round(m.progress * 100) : 0;
        progressBar.value = pct;
        setStatus(`${formatStatus(m.status)}… ${pct}%`);
      }
    });

    rawTextEl.value = text.trim();
    const rawResult = window.extractFields(text);
    currentFields = buildFieldsState(rawResult);
    if (currentFileNameId) {
      currentFields.fileNameId = {
        label: "Receipt Number (from filename)",
        value: currentFileNameId,
        include: true,
        isList: false,
      };
    }
    itemCountState = {
      items: rawResult.items,
      countedQty: rawResult.itemCountCheck.countedQty,
      ocrItemsSoldCount: rawResult.itemsSoldCount,
      matches: rawResult.itemCountCheck.matches,
      currentValue: rawResult.itemsSoldCount,
      voidCount: rawResult.voidCount,
      linesParsed: rawResult.linesParsed,
    };
    renderFields();
    resultsSection.hidden = false;
    setStatus("Done.");
    chrome.storage.local.set({
      lastRawText: text.trim(),
      lastFields: currentFields,
      lastItemCountState: itemCountState,
    });
  } catch (err) {
    console.error(err);
    setStatus(`OCR failed: ${err.message || err}`, true);
  } finally {
    progressBar.hidden = true;
    extractBtn.disabled = false;
  }
}

function formatStatus(status) {
  return status.replace(/\bocr\b/i, "OCR").replace(/^./, (c) => c.toUpperCase());
}

// ---- OCR (Tesseract.js, loaded lazily) ----------------------------------

function loadTesseractScript() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("lib/tesseract/tesseract.min.js");
    script.onload = () => resolve(window.Tesseract);
    script.onerror = () => reject(new Error("Failed to load OCR engine"));
    document.head.appendChild(script);
  });
}

async function getWorker(logger) {
  const Tesseract = await loadTesseractScript();
  if (tesseractWorker) return tesseractWorker;
  tesseractWorker = await Tesseract.createWorker("eng", 1, {
    workerPath: chrome.runtime.getURL("lib/tesseract/worker.min.js"),
    corePath: chrome.runtime.getURL("lib/tesseract/tesseract-core-lstm.wasm.js"),
    workerBlobURL: false,
    logger,
  });
  return tesseractWorker;
}

async function runOCR(imageDataUrl, onProgress) {
  const w = await getWorker(onProgress);
  const { data } = await w.recognize(imageDataUrl);
  return data.text;
}

// ---- Field extraction (Costco rules live in config.js) --------------------

// Wraps config.js's fixed-shape { subtotal, tax, items } result into the
// { label, value, include } state renderFields() and the fill payload
// expect. items (an array of { itemNumber, quantity, costPer, totalPrice })
// is expanded into one toggleable/editable row per item — see
// ITEM_ROW_VALUE_SEP for the edit-string <-> object round-trip format.
const ITEM_ROW_VALUE_SEP = ", ";

function buildFieldsState(rawResult) {
  const state = {};
  for (const desc of window.FIELD_DESCRIPTORS || []) {
    if (desc.isItemsTable) {
      const items = rawResult[desc.key] || [];
      items.forEach((item, i) => {
        const price = typeof item.costPer === "number" ? `$${item.costPer.toFixed(2)}` : "$?";
        const label = item.isCoupon
          ? `COUPON: Item ${i + 1}`
          : item.isFee
          ? `FEE: Item ${i + 1}`
          : `Item ${i + 1}`;
        state[`${desc.key}_${i}`] = {
          label,
          value: [item.itemNumber, `qty ${item.quantity}`, price].join(ITEM_ROW_VALUE_SEP),
          include: true,
          isItemRow: true,
          isCoupon: !!item.isCoupon,
          isFee: !!item.isFee,
        };
      });
      continue;
    }

    const raw = rawResult[desc.key];
    if (desc.isList) {
      if (!raw || !raw.length) continue;
      state[desc.key] = { label: desc.label, value: raw.join(", "), include: true, isList: true };
    } else {
      if (raw === null || raw === undefined || raw === "") continue;
      state[desc.key] = { label: desc.label, value: raw, include: true, isList: false };
    }
  }
  return state;
}

// "1812942, qty 2, $3.25" -> { itemNumber: "1812942", quantity: 2, costPer: 3.25 }
function parseItemRowValue(value) {
  const [itemNumber, qtyPart, costPart] = value.split(ITEM_ROW_VALUE_SEP).map((s) => s.trim());
  if (!itemNumber) return null;
  const quantity = parseInt((qtyPart || "").replace(/\D/g, ""), 10) || 1;
  const costPer = parseFloat((costPart || "").replace(/[^0-9.]/g, "")) || 0;
  return { itemNumber, quantity, costPer };
}

// ---- Fields UI ------------------------------------------------------------

function renderFields() {
  fieldsListEl.innerHTML = "";
  const keys = Object.keys(currentFields);

  if (!keys.length) {
    fieldsListEl.innerHTML = '<p class="empty-note">No fields matched. Edit the extraction rules in config.js, or fill in values manually below.</p>';
    itemsSummaryEl.hidden = true;
    fillBtn.disabled = true;
    return;
  }

  renderItemsSummary();
  renderItemCountCheck();

  for (const key of keys) {
    const field = currentFields[key];
    const row = document.createElement("div");
    row.className = field.isCoupon
      ? "field-row coupon-row"
      : field.isFee
      ? "field-row fee-row"
      : "field-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = field.include;
    checkbox.addEventListener("change", () => {
      currentFields[key].include = checkbox.checked;
    });

    const label = document.createElement("span");
    label.className = "field-label";
    label.textContent = field.label;
    label.title = field.label;

    const valueInput = document.createElement("input");
    valueInput.className = "field-value";
    valueInput.type = "text";
    valueInput.value = field.value;
    valueInput.addEventListener("input", () => {
      currentFields[key].value = valueInput.value;
    });

    row.append(checkbox, label, valueInput);
    fieldsListEl.appendChild(row);
  }

  fillBtn.disabled = false;
}

function renderItemsSummary() {
  const itemFields = Object.values(currentFields).filter((f) => f.isItemRow);
  if (!itemFields.length) {
    itemsSummaryEl.hidden = true;
    itemsSummaryEl.innerHTML = "";
    return;
  }
  const couponCount = itemFields.filter((f) => f.isCoupon).length;
  const feeCount = itemFields.filter((f) => f.isFee).length;
  const productCount = itemFields.length - couponCount - feeCount;

  const lines = [
    `Items found: ${itemFields.length} (${productCount} product${productCount === 1 ? "" : "s"}, ${couponCount} coupon${couponCount === 1 ? "" : "s"}, ${feeCount} fee${feeCount === 1 ? "" : "s"})`,
  ];

  if (itemCountState && typeof itemCountState.linesParsed === "number") {
    lines.push(`Parsed ${itemCountState.linesParsed} line${itemCountState.linesParsed === 1 ? "" : "s"}`);
  }

  if (itemCountState && itemCountState.voidCount) {
    lines.push(`VOID detected: ${itemCountState.voidCount} item pair${itemCountState.voidCount === 1 ? "" : "s"} removed`);
  }

  itemsSummaryEl.innerHTML = lines.map((line) => `<span>${line}</span>`).join("<br>");
  itemsSummaryEl.hidden = false;
}

// Cross-checks counted item quantities against the receipt's own printed
// "Items Sold" total. If the receipt didn't have one, shows an editable
// number input (pre-filled with the counted quantity) that re-runs
// validateItemCount() live as the user types.
function renderItemCountCheck() {
  itemCountCheckEl.innerHTML = "";

  if (!itemCountState) {
    itemCountCheckEl.hidden = true;
    return;
  }
  itemCountCheckEl.hidden = false;

  if (itemCountState.ocrItemsSoldCount === null) {
    // Default the manual entry to the counted quantity the first time this
    // renders (currentValue starts out null, mirroring ocrItemsSoldCount).
    if (itemCountState.currentValue === null || itemCountState.currentValue === undefined) {
      itemCountState.currentValue = itemCountState.countedQty;
    }

    const row = document.createElement("div");
    row.className = "manual-count-row";

    const label = document.createElement("label");
    label.className = "manual-count-label";
    label.htmlFor = "manual-items-sold";
    label.textContent = "Items Sold (not found on receipt — enter manually)";

    const input = document.createElement("input");
    input.type = "number";
    input.id = "manual-items-sold";
    input.className = "manual-count-input";
    input.min = "0";
    input.value = itemCountState.currentValue;
    input.addEventListener("input", () => {
      const parsed = parseInt(input.value, 10);
      itemCountState.currentValue = Number.isNaN(parsed) ? null : parsed;
      updateItemCountStatusLine();
    });

    row.append(label, input);
    itemCountCheckEl.appendChild(row);
  }

  const statusLine = document.createElement("p");
  statusLine.id = "item-count-status";
  itemCountCheckEl.appendChild(statusLine);
  updateItemCountStatusLine();
}

function updateItemCountStatusLine() {
  const statusLine = document.getElementById("item-count-status");
  if (!statusLine || !itemCountState) return;

  const result = window.validateItemCount(itemCountState.items, itemCountState.currentValue);

  if (result.matches === true) {
    statusLine.textContent = `✓ Items Sold: ${itemCountState.currentValue} matches counted quantity (${result.countedQty})`;
    statusLine.className = "item-count-status match";
  } else if (result.matches === false) {
    statusLine.textContent = `⚠ Items Sold says ${itemCountState.currentValue} but counted quantity is ${result.countedQty} — check items before filling`;
    statusLine.className = "item-count-status mismatch";
  } else {
    statusLine.textContent = `Enter a count to compare against counted quantity (${result.countedQty}).`;
    statusLine.className = "item-count-status neutral";
  }
}

// ---- Fill the active page's form ------------------------------------------

async function handleFillClick() {
  const payload = [];
  const items = [];

  for (const [key, field] of Object.entries(currentFields)) {
    if (!field.include || field.value.trim() === "") continue;

    if (field.isItemRow) {
      const item = parseItemRowValue(field.value);
      if (item) items.push(item);
      continue;
    }

    const value = field.isList
      ? field.value.split(",").map((v) => v.trim()).filter(Boolean)
      : field.value.trim();
    payload.push({ key, label: field.label, value });
  }

  if (items.length) {
    payload.push({ key: "items", label: "Items", value: items });
  }

  if (!payload.length) {
    setFillStatus("No fields selected to fill.", true);
    return;
  }

  fillBtn.disabled = true;
  setFillStatus("Filling form…");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("No active tab found.");

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "OCR_FORM_FILLER_FILL",
      fields: payload,
    });

    if (response && response.filled >= 0) {
      setFillStatus(`Filled ${response.filled} of ${payload.length} field(s).`);
    } else {
      setFillStatus("Form fill finished, but no confirmation was returned.");
    }
  } catch (err) {
    console.error(err);
    setFillStatus(`Could not fill form: ${err.message || err}`, true);
  } finally {
    fillBtn.disabled = false;
  }
}

// ---- Reset / restore --------------------------------------------------

function resetAll() {
  currentImageDataUrl = null;
  currentFileNameId = null;
  currentFields = {};
  itemCountState = null;
  fileInput.value = "";
  previewImage.hidden = true;
  previewImage.src = "";
  dropZoneEmpty.hidden = false;
  extractBtn.disabled = true;
  fillBtn.disabled = true;
  resultsSection.hidden = true;
  rawTextEl.value = "";
  fieldsListEl.innerHTML = "";
  itemsSummaryEl.hidden = true;
  itemCountCheckEl.hidden = true;
  itemCountCheckEl.innerHTML = "";
  setStatus("");
  setFillStatus("");
  progressBar.hidden = true;
  chrome.storage.local.remove(["lastRawText", "lastFields", "lastItemCountState"]);
}

function restoreLastResult() {
  chrome.storage.local.get(["lastRawText", "lastFields", "lastItemCountState"], (data) => {
    if (!data || !data.lastFields) return;
    rawTextEl.value = data.lastRawText || "";
    currentFields = data.lastFields;
    itemCountState = data.lastItemCountState || null;
    resultsSection.hidden = false;
    renderFields();
    setStatus("Restored last extraction. Upload a new image to redo OCR.");
  });
}
