# Invoice Extraction Evaluation

- **Run date:** 2026-11-03
- **Dataset:** `1000+ PDF_Invoice_Folder`
- **Command:** `python evaluate.py`
- **Scope:** Local PDF text extraction, local structured-field parsing, and invoice validation. This does not measure OpenAI-assisted extraction.

## OpenAI / LLM availability note

An earlier live OpenAI connectivity test returned HTTP 429. This can indicate a rate limit or that the OpenAI project has insufficient quota/credits; the account's billing balance was not verified, so the exact cause is unknown. The live test was not repeated for this local evaluation. These results do not depend on OpenAI and were not affected by that response. OpenAI-assisted extraction should be re-tested when the project quota and rate limits permit.

## Results

| Metric | Measured result |
|---|---:|
| PDFs evaluated | 1,007 |
| Documents with a total extracted | 1,007 / 1,007 (100.00%) |
| Documents passing required-field validation | 992 / 1,007 (98.51%) |
| Flagged for manual review | 15 / 1,007 (1.49%) |
| Labeled field matches | 5,982 / 6,012 (99.50%) |
| Exact match across all labeled fields | 992 / 992 fully labeled documents (100.00%) |
| Total extraction and evaluation time | 69.067 seconds |
| Average time per PDF | 0.0686 seconds |

### Per-field accuracy

| Field | Correct / labeled | Accuracy |
|---|---:|---:|
| Invoice number | 992 / 1,007 | 98.51% |
| Customer name | 992 / 1,007 | 98.51% |
| Supplier name | 992 / 992 | 100.00% |
| Invoice date | 1,007 / 1,007 | 100.00% |
| Subtotal | 992 / 992 | 100.00% |
| Total | 1,007 / 1,007 | 100.00% |

## Method and limitations

- The evaluator uses customer names and invoice numbers in the filenames as labels, and labeled values printed in the PDF for other fields. This is a useful corpus consistency check, not an independently curated benchmark.
- The 15 flagged documents have no extractable customer or invoice number in their PDF text and are treated as incomplete/manual-review documents. Their filenames contain names and numbers, but those values are not present in the document body.
- All 1,007 documents had a total value parsed; a zero total in an otherwise blank template counts as a parsed total, not proof of a complete invoice.
- The exact-document accuracy denominator is the 992 documents with all six labels available; the 100% result does not include the 15 incomplete templates.
- Runtime depends on hardware and should be treated as a single-run measurement, not a latency guarantee.
