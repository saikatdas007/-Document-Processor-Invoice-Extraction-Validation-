const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const XLSX = require("@e965/xlsx");
const { extractInvoiceFields } = require("./validation");

let tesseractWorkerPromise;
let embeddingPipelinePromise;

async function getTesseractWorker() {
  if (!tesseractWorkerPromise) {
    const cachePath = process.env.TESSERACT_CACHE_PATH ||
      path.resolve(__dirname, "../.cache/tesseract");
    await fs.mkdir(cachePath, { recursive: true });
    tesseractWorkerPromise = import("tesseract.js")
      .then(({ createWorker }) => createWorker(
        "eng",
        undefined,
        { cachePath },
      ))
      .catch((error) => {
        tesseractWorkerPromise = undefined;
        throw error;
      });
  }
  return tesseractWorkerPromise;
}

async function ocrImage(buffer, filename) {
  let prepared;
  try {
    const metadata = await sharp(buffer).metadata();
    const longestEdge = Math.max(metadata.width || 0, metadata.height || 0);
    const scale = longestEdge > 0 && longestEdge < 1200 ? Math.min(4, 1200 / longestEdge) : 1;
    prepared = await sharp(buffer)
      .greyscale()
      .normalize()
      .resize({
        width: Math.round((metadata.width || 1) * scale),
        height: Math.round((metadata.height || 1) * scale),
        fit: "fill",
      })
      .png()
      .toBuffer();
  } catch {
    const error = new Error(`Unable to read image ${path.basename(filename)}.`);
    error.status = 422;
    throw error;
  }

  let worker;
  try {
    worker = await getTesseractWorker();
  } catch (cause) {
    const error = new Error("Tesseract OCR is unavailable. Check network access or the configured OCR cache.");
    error.status = 503;
    error.cause = cause;
    throw error;
  }

  try {
    const { data } = await worker.recognize(prepared);
    return data.text || "";
  } catch (cause) {
    const error = new Error(`Tesseract OCR failed to process image ${path.basename(filename)}.`);
    error.status = 422;
    error.cause = cause;
    throw error;
  }
}

async function renderPdfPage(pdf, pageNumber) {
  const [{ createCanvas, DOMMatrix, ImageData, Path2D }, page] = await Promise.all([
    import("@napi-rs/canvas"),
    pdf.getPage(pageNumber),
  ]);
  globalThis.DOMMatrix ||= DOMMatrix;
  globalThis.ImageData ||= ImageData;
  globalThis.Path2D ||= Path2D;
  const viewport = page.getViewport({ scale: 2 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({
    canvas,
    canvasContext: canvas.getContext("2d"),
    viewport,
  }).promise;
  return canvas.toBuffer("image/png");
}

async function extractPdfText(buffer) {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdf = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      disableFontFace: true,
    }).promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ").trim();
      if (!text) {
        try {
          text = await ocrImage(await renderPdfPage(pdf, pageNumber), "scanned PDF");
        } catch (cause) {
          if (cause.status) throw cause;
          const error = new Error("Tesseract OCR must be available to extract scanned PDFs.");
          error.status = 503;
          error.cause = cause;
          throw error;
        }
      }
      if (text) pages.push(text);
    }
    await pdf.destroy();
    return pages.join("\n");
  } catch (error) {
    if (error.status) throw error;
    const wrapped = new Error("Unable to extract text from the uploaded PDF.");
    wrapped.status = 422;
    wrapped.cause = error;
    throw wrapped;
  }
}

async function extractTextFromFile(filePath, filename) {
  const extension = path.extname(filename).toLowerCase();
  const buffer = await fs.readFile(filePath);
  if (extension === ".pdf") return extractPdfText(buffer);
  if (extension === ".txt" || extension === ".csv") return buffer.toString("utf8");
  if ([".png", ".jpg", ".jpeg"].includes(extension)) return ocrImage(buffer, filename);
  if (extension === ".xlsx" || extension === ".xls") {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    return workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name];
      return `Sheet: ${name}\n${XLSX.utils.sheet_to_csv(sheet)}`;
    }).join("\n");
  }
  return `Uploaded document: ${path.basename(filename)}`;
}

async function encodeSemanticText(text) {
  if (!embeddingPipelinePromise) {
    embeddingPipelinePromise = import("@huggingface/transformers")
      .then(({ env, pipeline }) => {
        if (process.env.HF_HOME) env.cacheDir = process.env.HF_HOME;
        return pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
      })
      .catch((error) => {
        embeddingPipelinePromise = undefined;
        throw error;
      });
  }
  const extractor = await embeddingPipelinePromise;
  const result = await extractor(text, { pooling: "mean", normalize: false });
  return Array.from(result.data, Number);
}

async function closeWorkers() {
  if (tesseractWorkerPromise) {
    const worker = await tesseractWorkerPromise;
    await worker.terminate();
    tesseractWorkerPromise = undefined;
  }
}

module.exports = { closeWorkers, encodeSemanticText, extractInvoiceFields, extractTextFromFile };
