const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

let pdfParse = null;
try {
  pdfParse = require('pdf-parse');
} catch {
  pdfParse = null;
}

const app = express();
const PORT = 4000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));

const uploadsDir = path.join(__dirname, 'uploads');
const documentsFile = path.join(__dirname, 'documents.json');
const fieldsFile = path.join(__dirname, 'documentFields.json');
const auditFile = path.join(__dirname, 'documentAudit.json');
const textFile = path.join(__dirname, 'documentText.json');

function ensureFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
  }
}

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

ensureFile(documentsFile, []);
ensureFile(fieldsFile, {});
ensureFile(auditFile, {});
ensureFile(textFile, {});

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readDocuments() {
  return readJson(documentsFile, []).map(enrichDocument);
}

function writeDocuments(documents) {
  writeJson(documentsFile, documents.map(enrichDocument));
}

function readFields() {
  return readJson(fieldsFile, {});
}

function writeFields(fields) {
  writeJson(fieldsFile, fields);
}

function readAudit() {
  return readJson(auditFile, {});
}

function writeAudit(audit) {
  writeJson(auditFile, audit);
}

function readTextStore() {
  return readJson(textFile, {});
}

function writeTextStore(textStore) {
  writeJson(textFile, textStore);
}

function getTextRecord(documentId) {
  return readTextStore()[documentId] || null;
}

function addAudit(documentId, action, message, actor = 'Aperture Flow') {
  const audit = readAudit();
  const entry = {
    id: uuidv4(),
    documentId,
    action,
    message,
    actor,
    createdAt: new Date().toISOString(),
  };

  audit[documentId] = [entry, ...(audit[documentId] || [])].slice(0, 50);
  writeAudit(audit);
  return entry;
}

function money(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : '0.00';
}

function seededNumber(seed, min, max) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }

  const normalised = Math.abs(hash % 10000) / 10000;
  return min + (normalised * (max - min));
}

function titleCase(value) {
  return String(value || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\.[^/.]+$/, '')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function inferSupplier(originalFileName) {
  const name = titleCase(originalFileName || 'Unknown Supplier');

  const knownSuppliers = [
    'BMW Group UK',
    'Mercedes-Benz UK',
    'Stapletons Tyres',
    'Auto Parts Direct',
    'JLR Parts Distribution',
    'Volkswagen Group',
  ];

  const lower = name.toLowerCase();
  const match = knownSuppliers.find((supplier) => lower.includes(supplier.toLowerCase().split(' ')[0]));

  return match || name.split(' ').slice(0, 3).join(' ') || 'Pending supplier match';
}

function enrichDocument(document) {
  const documentId = document.documentId || uuidv4();
  const originalFileName = document.originalFileName || 'uploaded-document.pdf';
  const seed = `${documentId}-${originalFileName}`;
  const net = Number(document.netAmount ?? seededNumber(seed, 120, 4800));
  const vat = Number(document.vatAmount ?? net * 0.2);
  const gross = Number(document.grossAmount ?? net + vat);
  const textRecord = getTextRecord(documentId);

  return {
    documentId,
    originalFileName,
    savedFileName: document.savedFileName || originalFileName,
    status: document.status || 'Received',
    stage: document.stage || document.status || 'Received',
    uploadedAt: document.uploadedAt || new Date().toISOString(),
    documentType: document.documentType || inferDocumentType(originalFileName),
    supplierName: document.supplierName || inferSupplier(originalFileName),
    invoiceNumber: document.invoiceNumber || inferInvoiceNumber(documentId, originalFileName),
    invoiceDate: document.invoiceDate || new Date().toISOString().slice(0, 10),
    company: document.company || 'Awaiting company match',
    source: document.source || 'Manual Capture',
    currency: document.currency || 'GBP',
    netAmount: money(net),
    vatAmount: money(vat),
    grossAmount: money(gross),
    confidence: Number(document.confidence ?? stageConfidence(document.stage || document.status || 'Received')),
    priority: document.priority || inferPriority(gross),
    pages: document.pages || 1,
    validationStatus: document.validationStatus || inferValidationStatus(document.status || 'Received'),
    rawTextAvailable: Boolean(textRecord?.text),
    rawTextCharacters: textRecord?.characterCount || 0,
    extractionEngine: textRecord?.engine || 'field-patterns-v1',
  };
}

function inferDocumentType(fileName) {
  const lower = (fileName || '').toLowerCase();

  if (lower.includes('credit')) return 'Credit Note';
  if (lower.includes('statement')) return 'Statement';
  if (lower.includes('po') || lower.includes('purchase')) return 'Purchase Order';
  if (lower.includes('remit')) return 'Remittance';

  return 'Invoice';
}

function inferInvoiceNumber(documentId, fileName) {
  const match = (fileName || '').match(/(?:inv|invoice|cn|po)[-_ ]?([a-z0-9-]+)/i);
  if (match?.[1]) return match[1].replace(/\.[^/.]+$/, '').toUpperCase();
  return `AF-${documentId.slice(0, 8).toUpperCase()}`;
}

function inferPriority(grossAmount) {
  if (Number(grossAmount) > 5000) return 'High';
  if (Number(grossAmount) < 500) return 'Low';
  return 'Normal';
}

function inferValidationStatus(status) {
  if (['Approved', 'Completed'].includes(status)) return 'Passed';
  if (['Rejected', 'Failed', 'Exception'].includes(status)) return 'Failed';
  if (['Needs validation', 'Validation'].includes(status)) return 'Review';
  return 'Pending';
}

function stageConfidence(stage) {
  switch (stage) {
    case 'Approved': return 100;
    case 'Validation': return 84;
    case 'Extraction': return 76;
    case 'Classification': return 62;
    case 'OCR': return 48;
    case 'Queued': return 22;
    case 'Received': return 12;
    default: return 35;
  }
}

function generateFields(document) {
  const textRecord = getTextRecord(document.documentId);

  if (textRecord?.text) {
    return generateFieldsFromText(document, textRecord.text);
  }

  const poMissing = Number(document.documentId.replace(/[^0-9]/g, '').slice(-1) || 0) % 3 === 0;

  return [
    field(document, 'supplierName', 'Supplier', document.supplierName, 94, true, 1, 12, 14, 46, 5, 'simulated-extraction'),
    field(document, 'invoiceNumber', 'Invoice Number', document.invoiceNumber, 97, true, 1, 68, 18, 20, 4, 'simulated-extraction'),
    field(document, 'invoiceDate', 'Invoice Date', document.invoiceDate, 91, true, 1, 68, 25, 18, 4, 'simulated-extraction'),
    field(document, 'documentType', 'Document Type', document.documentType, 89, true, 1, 12, 22, 24, 4, 'simulated-extraction'),
    field(document, 'company', 'Company', document.company, document.company === 'Awaiting company match' ? 63 : 88, true, 1, 12, 30, 42, 5, 'simulated-extraction'),
    field(document, 'poNumber', 'PO Number', poMissing ? '' : `PO-${document.documentId.slice(0, 6).toUpperCase()}`, poMissing ? 0 : 83, false, 1, 68, 33, 20, 4, 'simulated-extraction'),
    field(document, 'netAmount', 'Net Amount', document.netAmount, 92, true, 1, 68, 70, 16, 4, 'simulated-extraction'),
    field(document, 'vatAmount', 'VAT Amount', document.vatAmount, 78, true, 1, 68, 77, 16, 4, 'simulated-extraction'),
    field(document, 'grossAmount', 'Gross Total', document.grossAmount, 95, true, 1, 68, 84, 16, 5, 'simulated-extraction'),
  ];
}

function generateFieldsFromText(document, text) {
  const extracted = extractInvoiceValues(text, document);

  return [
    field(document, 'supplierName', 'Supplier', extracted.supplierName.value, extracted.supplierName.confidence, true, 1, 10, 12, 48, 5, 'pdf-text-extraction'),
    field(document, 'invoiceNumber', 'Invoice Number', extracted.invoiceNumber.value, extracted.invoiceNumber.confidence, true, 1, 66, 17, 23, 4, 'pdf-text-extraction'),
    field(document, 'invoiceDate', 'Invoice Date', extracted.invoiceDate.value, extracted.invoiceDate.confidence, true, 1, 66, 24, 23, 4, 'pdf-text-extraction'),
    field(document, 'documentType', 'Document Type', extracted.documentType.value, extracted.documentType.confidence, true, 1, 10, 22, 28, 4, 'pdf-text-extraction'),
    field(document, 'company', 'Company', extracted.company.value, extracted.company.confidence, true, 1, 10, 30, 44, 5, 'pdf-text-extraction'),
    field(document, 'poNumber', 'PO Number', extracted.poNumber.value, extracted.poNumber.confidence, false, 1, 66, 32, 23, 4, 'pdf-text-extraction'),
    field(document, 'netAmount', 'Net Amount', extracted.netAmount.value, extracted.netAmount.confidence, true, 1, 66, 69, 18, 4, 'pdf-text-extraction'),
    field(document, 'vatAmount', 'VAT Amount', extracted.vatAmount.value, extracted.vatAmount.confidence, true, 1, 66, 76, 18, 4, 'pdf-text-extraction'),
    field(document, 'grossAmount', 'Gross Total', extracted.grossAmount.value, extracted.grossAmount.confidence, true, 1, 66, 84, 18, 5, 'pdf-text-extraction'),
  ];
}

function field(document, fieldName, label, value, confidence, required, page, x, y, width, height, source = 'field-patterns-v1') {
  return {
    id: `${document.documentId}-${fieldName}`,
    documentId: document.documentId,
    fieldName,
    label,
    fieldValue: String(value ?? ''),
    confidence,
    page,
    x,
    y,
    width,
    height,
    required,
    validated: confidence >= 85 && String(value ?? '').length > 0,
    source,
  };
}

function getDocumentOr404(documentId, res) {
  const documents = readDocuments();
  const document = documents.find((item) => item.documentId === documentId);

  if (!document) {
    res.status(404).json({ message: 'Document not found' });
    return null;
  }

  return { documents, document };
}

function upsertDocument(updatedDocument) {
  const documents = readDocuments();
  const index = documents.findIndex((document) => document.documentId === updatedDocument.documentId);

  if (index >= 0) {
    documents[index] = enrichDocument(updatedDocument);
  } else {
    documents.push(enrichDocument(updatedDocument));
  }

  writeDocuments(documents);
  return documents[index >= 0 ? index : documents.length - 1];
}

function normaliseText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function compactText(text) {
  return String(text || '').replace(/[\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanValue(value) {
  return String(value || '').replace(/^[\s:：#-]+/, '').replace(/[\s|]+$/, '').trim();
}

function matchValue(text, patterns) {
  const compact = compactText(text);

  for (const pattern of patterns) {
    const match = compact.match(pattern);
    if (match?.[1]) {
      return cleanValue(match[1]);
    }
  }

  return '';
}

function cleanAmount(value) {
  const cleaned = String(value || '').replace(/[^0-9.,-]/g, '').replace(/,/g, '');
  const numberValue = Number(cleaned);
  return Number.isFinite(numberValue) ? numberValue.toFixed(2) : '';
}

function extractAmount(text, labelPatterns) {
  const lines = normaliseText(text).split('\n').map((line) => line.trim()).filter(Boolean);
  const amountRegex = /(?:£|\$)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+(?:\.[0-9]{2}))/g;

  for (const label of labelPatterns) {
    const lineRegex = new RegExp(label, 'i');
    const line = lines.find((candidate) => lineRegex.test(candidate));

    const matchingLines = lines.filter((candidate) => lineRegex.test(candidate));
    for (const matchingLine of matchingLines) {
      const matches = [...matchingLine.matchAll(amountRegex)];
      if (matches.length) return cleanAmount(matches[matches.length - 1][1]);
    }
  }

  const compact = compactText(text);
  const amountPattern = '(?:£|\\$)?\\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\\.[0-9]{2})|[0-9]+(?:\\.[0-9]{2})?)';

  for (const label of labelPatterns) {
    const regex = new RegExp(`${label}[^0-9£$-]{0,30}${amountPattern}`, 'i');
    const match = compact.match(regex);
    if (match?.[1]) return cleanAmount(match[1]);
  }

  return '';
}

function toIsoDate(value) {
  const raw = cleanValue(value);
  const slash = raw.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);

  if (slash) {
    const day = slash[1].padStart(2, '0');
    const month = slash[2].padStart(2, '0');
    const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
    return `${year}-${month}-${day}`;
  }

  const iso = raw.match(/^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;

  return raw;
}

function extractDate(text) {
  const value = matchValue(text, [
    /(?:invoice\s*date|date\s*of\s*invoice|tax\s*date|document\s*date)\s*[:#-]?\s*(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4})/i,
    /(?:invoice\s*date|date\s*of\s*invoice|tax\s*date|document\s*date)\s*[:#-]?\s*(\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2})/i,
    /(?:invoice\s*date|date\s*of\s*invoice|tax\s*date|document\s*date)\s*[:#-]?\s*([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i,
    /(?:invoice\s*date|date\s*of\s*invoice|tax\s*date|document\s*date)\s*[:#-]?\s*(\d{1,2}\s+[A-Z][a-z]+\s+\d{4})/i,
  ]);

  if (!value) return '';

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);

  return toIsoDate(value);
}

function firstMeaningfulSupplierLine(text, fallback) {
  const lines = normaliseText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 24);

  const fromIndex = lines.findIndex((line) => /^from:?$/i.test(line));
  if (fromIndex >= 0) {
    const fromSupplier = lines.slice(fromIndex + 1).find((line) => /[a-z]/i.test(line) && line.length >= 3);
    if (fromSupplier) return fromSupplier;
  }

  const blacklist = [
    'invoice', 'tax invoice', 'credit note', 'statement', 'remittance', 'purchase order',
    'vat number', 'invoice number', 'page ', 'date ', 'total ', 'amount ', 'customer ',
    'payment is due', 'thanks for choosing', 'from:', 'to:',
  ];

  const candidate = lines.find((line) => {
    const lower = line.toLowerCase();
    if (line.length < 3 || line.length > 80) return false;
    if (/^\d+$/.test(line)) return false;
    if (blacklist.some((word) => lower.includes(word))) return false;
    return /[a-z]/i.test(line);
  });

  return candidate || fallback;
}

function extractInvoiceValues(text, document) {
  const invoiceNumber = matchValue(text, [
    /(?:invoice\s*(?:number|no\.?|#|ref)|inv\s*(?:number|no\.?|#|ref))\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_.-]{2,})/i,
    /(?:document\s*(?:number|no\.?|ref))\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_.-]{2,})/i,
    /\b(INV[-_ ]?[A-Z0-9-]{3,})\b/i,
  ]);

  const poNumber = matchValue(text, [
    /(?:purchase\s*order|po\s*(?:number|no\.?|#)?|order\s*(?:number|no\.?|#)?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_.-]{2,})/i,
  ]);

  const invoiceDate = extractDate(text);
  let netAmount = extractAmount(text, ['net\\s*(?:amount|total)?', 'subtotal', 'sub\\s*total', 'goods\\s*total']);
  let vatAmount = extractAmount(text, ['vat\\s*(?:amount|total)?', 'tax\\s*(?:amount|total)?']);
  let grossAmount = extractAmount(text, ['gross\\s*(?:amount|total)?', 'grand\\s*total', 'invoice\\s*total', 'total\\s*due', 'amount\\s*due', 'total\\s*amount']);

  if (!grossAmount && netAmount && vatAmount) {
    grossAmount = money(Number(netAmount) + Number(vatAmount));
  }

  if (!vatAmount && netAmount && grossAmount) {
    vatAmount = money(Number(grossAmount) - Number(netAmount));
  }

  if (!netAmount && vatAmount && grossAmount) {
    netAmount = money(Number(grossAmount) - Number(vatAmount));
  }

  const supplierName = firstMeaningfulSupplierLine(text, document.supplierName || inferSupplier(document.originalFileName));
  const documentType = /credit\s*note/i.test(text) ? 'Credit Note' : document.documentType || 'Invoice';

  return {
    supplierName: { value: supplierName, confidence: supplierName === document.supplierName ? 68 : 86 },
    invoiceNumber: { value: invoiceNumber || document.invoiceNumber || '', confidence: invoiceNumber ? 94 : 56 },
    invoiceDate: { value: invoiceDate || document.invoiceDate || '', confidence: invoiceDate ? 91 : 52 },
    documentType: { value: documentType, confidence: /credit\s*note|invoice|statement|purchase\s*order/i.test(text) ? 89 : 70 },
    company: { value: document.company || 'Awaiting company match', confidence: document.company && document.company !== 'Awaiting company match' ? 82 : 48 },
    poNumber: { value: poNumber, confidence: poNumber ? 84 : 0 },
    netAmount: { value: netAmount || document.netAmount || '', confidence: netAmount ? 88 : 50 },
    vatAmount: { value: vatAmount || document.vatAmount || '', confidence: vatAmount ? 86 : 48 },
    grossAmount: { value: grossAmount || document.grossAmount || '', confidence: grossAmount ? 92 : 54 },
  };
}

function binaryPdfTextFallback(buffer) {
  return buffer
    .toString('latin1')
    .replace(/\0/g, ' ')
    .replace(/\\r|\\n/g, '\n')
    .replace(/[^\x09\x0A\x0D\x20-\x7E£]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 12000);
}

async function extractTextFromFile(filePath, originalFileName) {
  const ext = path.extname(originalFileName || filePath).toLowerCase();

  if (ext !== '.pdf') {
    return {
      text: '',
      engine: 'unsupported-file-type',
      warning: 'Text extraction v1 currently supports PDF files. Image OCR will be added later.',
    };
  }

  const buffer = fs.readFileSync(filePath);

  if (pdfParse) {
    try {
      const parsed = await pdfParse(buffer);
      return {
        text: normaliseText(parsed.text || ''),
        pages: parsed.numpages || 1,
        engine: 'pdf-parse',
        warning: null,
      };
    } catch (error) {
      return {
        text: binaryPdfTextFallback(buffer),
        pages: 1,
        engine: 'binary-pdf-fallback',
        warning: `pdf-parse could not read this PDF: ${error.message}`,
      };
    }
  }

  return {
    text: binaryPdfTextFallback(buffer),
    pages: 1,
    engine: 'binary-pdf-fallback',
    warning: 'Install backend dependencies to enable full PDF text extraction.',
  };
}

async function runExtractionForDocument(document) {
  const filePath = path.join(uploadsDir, document.savedFileName);

  if (!fs.existsSync(filePath)) {
    return {
      document,
      fields: generateFields(document),
      textRecord: null,
      validation: validateDocument(document, generateFields(document)),
    };
  }

  const extraction = await extractTextFromFile(filePath, document.originalFileName);
  const textStore = readTextStore();
  const textRecord = {
    documentId: document.documentId,
    text: extraction.text || '',
    engine: extraction.engine,
    warning: extraction.warning,
    extractedAt: new Date().toISOString(),
    characterCount: extraction.text?.length || 0,
    wordCount: extraction.text ? extraction.text.split(/\s+/).filter(Boolean).length : 0,
  };

  textStore[document.documentId] = textRecord;
  writeTextStore(textStore);

  const extractedValues = extractInvoiceValues(textRecord.text, document);
  const extractedDocument = enrichDocument({
    ...document,
    pages: extraction.pages || document.pages || 1,
    documentType: extractedValues.documentType.value || document.documentType,
    supplierName: extractedValues.supplierName.value || document.supplierName,
    invoiceNumber: extractedValues.invoiceNumber.value || document.invoiceNumber,
    invoiceDate: extractedValues.invoiceDate.value || document.invoiceDate,
    company: extractedValues.company.value || document.company,
    netAmount: extractedValues.netAmount.value || document.netAmount,
    vatAmount: extractedValues.vatAmount.value || document.vatAmount,
    grossAmount: extractedValues.grossAmount.value || document.grossAmount,
  });

  const fields = generateFieldsFromText(extractedDocument, textRecord.text);
  const validation = validateDocument(extractedDocument, fields);

  return { document: extractedDocument, fields, textRecord, validation };
}

function numericAmount(value) {
  const parsed = Number(String(value || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function validateDocument(document, fields) {
  const byName = Object.fromEntries((fields || []).map((fieldItem) => [fieldItem.fieldName, fieldItem]));
  const checks = [];

  ['supplierName', 'invoiceNumber', 'invoiceDate', 'netAmount', 'vatAmount', 'grossAmount'].forEach((fieldName) => {
    const fieldItem = byName[fieldName];
    checks.push({
      id: `required-${fieldName}`,
      label: `${fieldItem?.label || fieldName} present`,
      status: fieldItem?.fieldValue ? 'passed' : 'failed',
      message: fieldItem?.fieldValue ? 'Required value captured.' : 'Required value is missing.',
    });
  });

  const net = numericAmount(byName.netAmount?.fieldValue);
  const vat = numericAmount(byName.vatAmount?.fieldValue);
  const gross = numericAmount(byName.grossAmount?.fieldValue);

  if (net !== null && vat !== null && gross !== null) {
    const difference = Math.abs((net + vat) - gross);
    checks.push({
      id: 'totals-match',
      label: 'Net + VAT = Gross',
      status: difference <= 0.02 ? 'passed' : 'failed',
      message: difference <= 0.02
        ? 'Financial totals reconcile.'
        : `Totals are out by £${difference.toFixed(2)}.`,
    });
  } else {
    checks.push({
      id: 'totals-match',
      label: 'Net + VAT = Gross',
      status: 'warning',
      message: 'Cannot confirm totals until all amount fields are present.',
    });
  }

  const lowConfidenceCount = (fields || []).filter((fieldItem) => fieldItem.fieldValue && Number(fieldItem.confidence) < 80).length;
  checks.push({
    id: 'confidence-threshold',
    label: 'Confidence threshold',
    status: lowConfidenceCount === 0 ? 'passed' : 'warning',
    message: lowConfidenceCount === 0
      ? 'All captured values meet the initial confidence threshold.'
      : `${lowConfidenceCount} captured field${lowConfidenceCount > 1 ? 's are' : ' is'} below 80%.`,
  });

  const documents = readDocuments();
  const duplicate = documents.find((item) => (
    item.documentId !== document.documentId
    && item.invoiceNumber
    && item.supplierName
    && item.invoiceNumber === document.invoiceNumber
    && item.supplierName === document.supplierName
  ));

  checks.push({
    id: 'duplicate-check',
    label: 'Duplicate invoice check',
    status: duplicate ? 'failed' : 'passed',
    message: duplicate ? `Possible duplicate: ${duplicate.originalFileName}` : 'No duplicate found in the local register.',
  });

  const po = byName.poNumber?.fieldValue;
  checks.push({
    id: 'po-check',
    label: 'Purchase order reference',
    status: po ? 'passed' : 'warning',
    message: po ? 'PO reference captured.' : 'PO reference not found. This may still be valid for non-PO invoices.',
  });

  return checks;
}

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const documentId = uuidv4();
    req.documentId = documentId;
    const ext = path.extname(file.originalname) || '.bin';
    cb(null, `${documentId}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.get('/', (req, res) => {
  res.json({ name: 'Aperture Flow backend', status: 'running' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'online', checkedAt: new Date().toISOString() });
});

app.get('/documents', (req, res) => {
  const documents = readDocuments().sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json(documents);
});

app.get('/documents/:id', (req, res) => {
  const result = getDocumentOr404(req.params.id, res);
  if (!result) return;
  res.json(result.document);
});

app.get('/documents/:id/file', (req, res) => {
  const result = getDocumentOr404(req.params.id, res);
  if (!result) return;

  const filePath = path.join(uploadsDir, result.document.savedFileName);

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ message: 'File not found' });
    return;
  }

  res.sendFile(filePath);
});

app.get('/documents/:id/text', (req, res) => {
  const result = getDocumentOr404(req.params.id, res);
  if (!result) return;

  const textRecord = getTextRecord(result.document.documentId);

  res.json(textRecord || {
    documentId: result.document.documentId,
    text: '',
    engine: 'not-run',
    warning: 'Text extraction has not been run for this document yet.',
    extractedAt: null,
    characterCount: 0,
    wordCount: 0,
  });
});

app.get('/documents/:id/validation', (req, res) => {
  const result = getDocumentOr404(req.params.id, res);
  if (!result) return;

  const allFields = readFields();
  const fields = allFields[result.document.documentId] || generateFields(result.document);
  res.json(validateDocument(result.document, fields));
});

app.get('/documents/:id/fields', (req, res) => {
  const result = getDocumentOr404(req.params.id, res);
  if (!result) return;

  const allFields = readFields();
  if (!allFields[result.document.documentId]) {
    allFields[result.document.documentId] = generateFields(result.document);
    writeFields(allFields);
  }

  res.json(allFields[result.document.documentId]);
});

app.put('/documents/:id/fields', (req, res) => {
  const result = getDocumentOr404(req.params.id, res);
  if (!result) return;

  const incomingFields = Array.isArray(req.body.fields) ? req.body.fields : [];
  const allFields = readFields();
  const now = new Date().toISOString();

  allFields[result.document.documentId] = incomingFields.map((incomingField) => ({
    ...incomingField,
    documentId: result.document.documentId,
    editedBy: req.body.editedBy || 'Validation User',
    editedDate: now,
    validated: Boolean(incomingField.fieldValue) && Number(incomingField.confidence || 0) >= 70,
  }));

  const document = {
    ...result.document,
    stage: result.document.stage === 'Approved' ? 'Approved' : 'Validation',
    status: result.document.status === 'Approved' ? 'Approved' : 'Needs validation',
    confidence: calculateDocumentConfidence(allFields[result.document.documentId]),
    validationStatus: 'Review',
  };

  const savedDocument = upsertDocument(applyFieldsToDocument(document, allFields[result.document.documentId]));
  writeFields(allFields);
  addAudit(savedDocument.documentId, 'Fields saved', 'Extracted field values were updated and saved.', req.body.editedBy || 'Validation User');

  res.json({ document: savedDocument, fields: allFields[result.document.documentId] });
});

app.get('/documents/:id/audit', (req, res) => {
  const result = getDocumentOr404(req.params.id, res);
  if (!result) return;

  const audit = readAudit();
  res.json(audit[result.document.documentId] || []);
});

app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ message: 'No file uploaded' });
    return;
  }

  try {
    const initialDocument = enrichDocument({
      documentId: req.documentId,
      originalFileName: req.file.originalname,
      savedFileName: req.file.filename,
      status: 'Received',
      stage: 'Received',
      source: 'Manual Capture',
      uploadedAt: new Date().toISOString(),
    });

    const extraction = await runExtractionForDocument(initialDocument);
    const document = enrichDocument({
      ...extraction.document,
      status: extraction.textRecord?.text ? 'Extraction' : 'Received',
      stage: extraction.textRecord?.text ? 'Extraction' : 'Received',
      confidence: calculateDocumentConfidence(extraction.fields),
      validationStatus: 'Pending',
    });

    const documents = readDocuments();
    documents.push(document);
    writeDocuments(documents);

    const allFields = readFields();
    allFields[document.documentId] = extraction.fields;
    writeFields(allFields);

    addAudit(document.documentId, 'Captured', `Document ${document.originalFileName} was captured from Manual Capture.`);
    addAudit(
      document.documentId,
      'Text extraction',
      extraction.textRecord?.text
        ? `Raw PDF text extracted using ${extraction.textRecord.engine}. ${extraction.textRecord.wordCount} words captured.`
        : (extraction.textRecord?.warning || 'Text extraction produced no readable text.'),
    );

    res.json(document);
  } catch (error) {
    res.status(500).json({ message: `Upload failed: ${error.message}` });
  }
});

app.post('/process/:id', async (req, res) => {
  const result = getDocumentOr404(req.params.id, res);
  if (!result) return;

  const stages = ['Received', 'Queued', 'OCR', 'Classification', 'Extraction', 'Validation'];
  const currentStage = result.document.stage || 'Received';
  const currentIndex = stages.indexOf(currentStage);
  const nextStage = currentIndex >= 0 && currentIndex < stages.length - 1
    ? stages[currentIndex + 1]
    : 'Validation';

  const allFields = readFields();
  let fields = allFields[result.document.documentId] || generateFields(result.document);
  let documentForSave = result.document;

  if (nextStage === 'OCR' || nextStage === 'Extraction' || nextStage === 'Validation') {
    const extraction = await runExtractionForDocument(result.document);
    fields = extraction.fields;
    documentForSave = extraction.document;
  }

  if (nextStage === 'Classification' && !allFields[result.document.documentId]) {
    fields = generateFields(result.document).map((fieldItem) => ({
      ...fieldItem,
      confidence: Math.max(0, Math.round(fieldItem.confidence * 0.65)),
      validated: false,
    }));
  }

  allFields[result.document.documentId] = fields;
  writeFields(allFields);

  const updatedDocument = upsertDocument({
    ...applyFieldsToDocument(documentForSave, fields),
    stage: nextStage,
    status: nextStage === 'Validation' ? 'Needs validation' : nextStage,
    confidence: nextStage === 'Validation'
      ? calculateDocumentConfidence(fields)
      : Math.max(stageConfidence(nextStage), calculateDocumentConfidence(fields) - 12),
    validationStatus: nextStage === 'Validation' ? 'Review' : 'Pending',
  });

  addAudit(updatedDocument.documentId, 'Processed', `Document advanced to ${updatedDocument.stage}.`);
  res.json(updatedDocument);
});

app.post('/documents/:id/extract', async (req, res) => {
  const result = getDocumentOr404(req.params.id, res);
  if (!result) return;

  const extraction = await runExtractionForDocument(result.document);
  const fields = extraction.fields;
  const allFields = readFields();
  allFields[result.document.documentId] = fields;
  writeFields(allFields);

  const updatedDocument = upsertDocument({
    ...applyFieldsToDocument(extraction.document, fields),
    stage: 'Validation',
    status: 'Needs validation',
    confidence: calculateDocumentConfidence(fields),
    validationStatus: 'Review',
  });

  addAudit(
    updatedDocument.documentId,
    'Extraction rerun',
    extraction.textRecord?.text
      ? `Field extraction rerun from ${extraction.textRecord.wordCount} words of PDF text.`
      : 'Field extraction rerun, but no readable PDF text was found.',
    req.body.requestedBy || 'Validation User',
  );

  res.json({ document: updatedDocument, fields, text: extraction.textRecord, validation: validateDocument(updatedDocument, fields) });
});

app.post('/documents/:id/reprocess', (req, res) => {
  const result = getDocumentOr404(req.params.id, res);
  if (!result) return;

  const updatedDocument = upsertDocument({
    ...result.document,
    status: 'Queued',
    stage: 'Queued',
    confidence: 22,
    validationStatus: 'Pending',
  });

  const allFields = readFields();
  allFields[updatedDocument.documentId] = generateFields(updatedDocument).map((fieldItem) => ({
    ...fieldItem,
    confidence: Math.max(0, Math.round(fieldItem.confidence * 0.5)),
    validated: false,
  }));
  writeFields(allFields);

  addAudit(updatedDocument.documentId, 'Reprocess requested', 'Document was returned to the processing queue.');
  res.json({ document: updatedDocument, fields: allFields[updatedDocument.documentId] });
});

app.post('/documents/:id/approve', (req, res) => {
  const result = getDocumentOr404(req.params.id, res);
  if (!result) return;

  const allFields = readFields();
  const fields = (allFields[result.document.documentId] || generateFields(result.document)).map((fieldItem) => ({
    ...fieldItem,
    validated: true,
    editedBy: req.body.approvedBy || 'Validation User',
    editedDate: new Date().toISOString(),
  }));

  allFields[result.document.documentId] = fields;
  writeFields(allFields);

  const updatedDocument = upsertDocument({
    ...applyFieldsToDocument(result.document, fields),
    status: 'Approved',
    stage: 'Approved',
    confidence: 100,
    validationStatus: 'Passed',
  });

  addAudit(updatedDocument.documentId, 'Approved', 'Document was approved for ERP posting.', req.body.approvedBy || 'Validation User');
  res.json({ document: updatedDocument, fields });
});

app.post('/documents/:id/reject', (req, res) => {
  const result = getDocumentOr404(req.params.id, res);
  if (!result) return;

  const updatedDocument = upsertDocument({
    ...result.document,
    status: 'Rejected',
    stage: 'Exception',
    validationStatus: 'Failed',
  });

  addAudit(updatedDocument.documentId, 'Rejected', req.body.reason || 'Document was rejected during validation.', req.body.rejectedBy || 'Validation User');
  res.json({ document: updatedDocument });
});

app.post('/documents/:id/exception', (req, res) => {
  const result = getDocumentOr404(req.params.id, res);
  if (!result) return;

  const updatedDocument = upsertDocument({
    ...result.document,
    status: 'Exception',
    stage: 'Exception',
    validationStatus: 'Review',
  });

  addAudit(updatedDocument.documentId, 'Sent to exception', req.body.reason || 'Document requires exception handling.', req.body.sentBy || 'Validation User');
  res.json({ document: updatedDocument });
});

function calculateDocumentConfidence(fields) {
  if (!fields?.length) return 0;
  const average = fields.reduce((sum, fieldItem) => sum + Number(fieldItem.confidence || 0), 0) / fields.length;
  return Math.round(average);
}

function applyFieldsToDocument(document, fields) {
  const byName = Object.fromEntries((fields || []).map((fieldItem) => [fieldItem.fieldName, fieldItem.fieldValue]));

  return enrichDocument({
    ...document,
    supplierName: byName.supplierName || document.supplierName,
    invoiceNumber: byName.invoiceNumber || document.invoiceNumber,
    invoiceDate: byName.invoiceDate || document.invoiceDate,
    documentType: byName.documentType || document.documentType,
    company: byName.company || document.company,
    netAmount: byName.netAmount || document.netAmount,
    vatAmount: byName.vatAmount || document.vatAmount,
    grossAmount: byName.grossAmount || document.grossAmount,
  });
}

app.listen(PORT, () => {
  console.log(`Aperture Flow backend running on http://localhost:${PORT}`);
});
