function validateInvoice(invoiceData) {
  const issues = [];
  const mandatoryFields = [
    "invoice_number",
    "invoice_date",
    "supplier_name",
    "customer_name",
    "subtotal",
    "total",
  ];

  for (const field of mandatoryFields) {
    if (invoiceData[field] === null || invoiceData[field] === undefined || invoiceData[field] === "") {
      issues.push(`Missing mandatory field: ${field}`);
    }
  }

  const numericValues = {};
  for (const field of ["subtotal", "total"]) {
    const value = invoiceData[field];
    if (value === null || value === undefined || value === "") continue;
    const numericValue = typeof value === "string" && !value.trim() ? Number.NaN : Number(value);
    if (Number.isNaN(numericValue)) {
      issues.push(`${field[0].toUpperCase()}${field.slice(1)} must be numeric.`);
      continue;
    }
    if (!Number.isFinite(numericValue)) {
      issues.push(`${field[0].toUpperCase()}${field.slice(1)} must be finite.`);
      continue;
    }
    numericValues[field] = numericValue;
  }

  if (
    numericValues.total !== undefined &&
    numericValues.subtotal !== undefined &&
    numericValues.total <= 0 &&
    numericValues.subtotal > 0
  ) {
    issues.push("Suspicious total amount: Total is zero or negative while subtotal is positive.");
  }

  return {
    status: issues.length === 0 ? "VALID" : "FLAGGED FOR MANUAL REVIEW",
    issues,
    data: invoiceData,
  };
}

function extractInvoiceFields(text) {
  const extracted = {
    invoice_number: null,
    invoice_date: null,
    supplier_name: null,
    customer_name: null,
    subtotal: null,
    tax: 0,
    total: null,
    currency: "USD",
    line_items: [],
  };
  let match = text.match(
    /\b(?:invoice|inv\.?)\s*(?:number|no\.?|#|id)\s*[:#-]?\s*([A-Z0-9]+(?:[-/][A-Z0-9]+)*)/i,
  );
  if (!match) match = text.match(/^\s*#\s*([A-Z0-9]+(?:[-/][A-Z0-9]+)*)/m);
  if (match) extracted.invoice_number = match[1];

  match = text.match(
    /\b(?:invoice\s+)?date\s*:?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2})/i,
  );
  if (match) extracted.invoice_date = match[1].trim();

  const findLabeledValue = (labels) => {
    const labeled = text.match(new RegExp(`^\\s*(?:${labels})\\s*:?\\s*(.*)$`, "im"));
    if (!labeled) return null;
    let value = labeled[1].split(/\s+Ship To\s*:/i, 1)[0].trim();
    if (value && !["ship to", "bill to"].includes(value.toLowerCase().replace(/:$/, "").trim())) {
      return value;
    }
    for (const line of text.slice(labeled.index + labeled[0].length).split(/\r?\n/)) {
      value = line.trim();
      if (value && !value.includes(":") && !/^(?:Ship To|Bill To)\b/i.test(value)) return value;
    }
    return null;
  };

  extracted.supplier_name = findLabeledValue("(?:supplier|vendor|seller|from)");
  if (!extracted.supplier_name) {
    const header = text.split(/^\s*Bill\s*To\b/im, 1)[0];
    for (const line of header.split(/\r?\n/)) {
      const candidate = line.replace(/\bINVOICE\b/gi, "").trim().replace(/^[ #:]+|[ #:]+$/g, "");
      if (
        !candidate ||
        /^(?:date|invoice|order|ship\s+to)\b/i.test(candidate) ||
        /^#?\s*\d+(?:[-/]\d+)*$/.test(candidate)
      ) {
        continue;
      }
      extracted.supplier_name = candidate;
      break;
    }
  }

  match = text.match(/^\s*Customer\s+Name:\s*(.+?)\s*$/im);
  let customerName = match ? match[1].trim() : findLabeledValue("(?:bill\\s*to|billed\\s*to|customer|invoice\\s*to)");
  if (customerName) {
    customerName = customerName.replace(/\s+\d{5}(?:-\d{4})?\b.*$/, "").trim().replace(/^[ ,]+|[ ,]+$/g, "");
    if (
      !["ship to", "bill to", "balance due"].includes(customerName.toLowerCase()) &&
      !/^(?:ship\s*to|bill\s*to|balance\s+due|subtotal|grand\s+total|total)\s*:/i.test(customerName)
    ) {
      extracted.customer_name = customerName || null;
    }
  }

  const amount = String.raw`\$?\s*(-?[\d,]+(?:\.\d{1,2})?)`;
  match = text.match(new RegExp(String.raw`\bsubtotal\b\s*:?\s*${amount}`, "i"));
  if (match) extracted.subtotal = Number(match[1].replace(/,/g, ""));
  match = text.match(new RegExp(String.raw`\b(?:grand\s+total|balance\s+due|total)\b\s*:?\s*${amount}`, "i"));
  if (match) extracted.total = Number(match[1].replace(/,/g, ""));

  const itemPattern = /^\s*(.+?)\s+\d+(?:\.\d+)?\s+\$?([\d,]+(?:\.\d{1,2})?)\s+\$?([\d,]+(?:\.\d{1,2})?)\s*$/gm;
  for (const item of text.matchAll(itemPattern)) {
    extracted.line_items.push({
      product_name: item[1].trim(),
      amount: Number(item[3].replace(/,/g, "")),
    });
  }
  return extracted;
}

function extractDocumentData(text) {
  if (!text.trim()) return { error: "Document text is empty." };
  const data = extractInvoiceFields(text);
  if (data.total === null) return { error: "Could not extract an invoice total." };
  return data;
}

module.exports = { extractDocumentData, extractInvoiceFields, validateInvoice };
