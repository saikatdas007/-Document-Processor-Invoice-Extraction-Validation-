import argparse
import re
from collections import Counter
from pathlib import Path
from time import perf_counter

from extractor import extract_text_from_file
from processor import extract_document_data
from validator import validate_invoice


FIELDS = (
    "invoice_number",
    "customer_name",
    "supplier_name",
    "invoice_date",
    "subtotal",
    "total",
)
NUMERIC_FIELDS = {"subtotal", "total"}


def _labeled_fields(pdf_path: Path, text: str) -> dict[str, object]:
    filename_match = re.fullmatch(
        r"invoice_(.+)_(\d+)", pdf_path.stem, flags=re.IGNORECASE
    )
    if not filename_match:
        raise ValueError(f"Filename does not contain customer and invoice labels: {pdf_path.name}")

    customer_name, invoice_number = filename_match.groups()
    patterns = {
        "supplier_name": r"^\s*(.+?)\s+INVOICE\s*$",
        "invoice_date": r"^\s*Date:\s*(.+?)\s*$",
        "subtotal": r"^\s*Subtotal:\s*\$?([\d,]+(?:\.\d{1,2})?)",
        "total": r"^\s*Total:\s*\$?([\d,]+(?:\.\d{1,2})?)",
    }
    labels: dict[str, object] = {
        "invoice_number": invoice_number,
        "customer_name": customer_name,
    }
    for field, pattern in patterns.items():
        match = re.search(pattern, text, flags=re.IGNORECASE | re.MULTILINE)
        value = match.group(1).strip() if match else None
        if field in NUMERIC_FIELDS and value is not None:
            value = float(value.replace(",", ""))
        labels[field] = value
    return labels


def _matches(field: str, expected: object, actual: object) -> bool:
    if expected is None or actual is None:
        return False
    if field in NUMERIC_FIELDS:
        try:
            return abs(float(expected) - float(actual)) <= 0.01
        except (TypeError, ValueError):
            return False
    normalize = lambda value: " ".join(str(value).split()).casefold()
    return normalize(expected) == normalize(actual)


def run_evaluation(dataset_path: str = "1000+ PDF_Invoice_Folder") -> dict:
    dataset = Path(dataset_path)
    if not dataset.is_dir():
        raise NotADirectoryError(
            f"{dataset} is not a PDF dataset directory. "
            "Use the labeled '1000+ PDF_Invoice_Folder' corpus."
        )

    pdf_files = sorted(dataset.glob("*.pdf"))
    if not pdf_files:
        raise FileNotFoundError(f"No PDF invoices found in {dataset}.")

    correct_fields: Counter[str] = Counter()
    labeled_fields: Counter[str] = Counter()
    docs_with_all_labels = 0
    exact_documents = 0
    documents_with_total = 0
    validated_documents = 0
    failures: list[tuple[str, str]] = []
    processing_seconds = 0.0

    for pdf_path in pdf_files:
        start = perf_counter()
        try:
            text = extract_text_from_file(str(pdf_path))
            extracted = extract_document_data(text)
        except Exception as exc:
            processing_seconds += perf_counter() - start
            failures.append((pdf_path.name, f"{type(exc).__name__}: {exc}"))
            continue
        processing_seconds += perf_counter() - start

        if not extracted.get("error") and extracted.get("total") is not None:
            documents_with_total += 1
        else:
            failures.append((pdf_path.name, extracted.get("error", "Total was not extracted")))

        validation = validate_invoice(extracted)
        if validation["status"] == "VALID":
            validated_documents += 1

        try:
            labels = _labeled_fields(pdf_path, text)
        except ValueError as exc:
            failures.append((pdf_path.name, str(exc)))
            continue

        available_labels = [field for field in FIELDS if labels[field] is not None]
        if len(available_labels) == len(FIELDS):
            docs_with_all_labels += 1

        all_fields_correct = len(available_labels) == len(FIELDS)
        for field in available_labels:
            labeled_fields[field] += 1
            is_correct = _matches(field, labels[field], extracted.get(field))
            if is_correct:
                correct_fields[field] += 1
            else:
                all_fields_correct = False

        if all_fields_correct:
            exact_documents += 1

    total_documents = len(pdf_files)
    field_label_count = sum(labeled_fields.values())
    field_correct_count = sum(correct_fields.values())
    result = {
        "dataset": str(dataset),
        "documents": total_documents,
        "documents_with_total": documents_with_total,
        "validated": validated_documents,
        "success_rate": validated_documents / total_documents * 100,
        "failure_rate": (total_documents - validated_documents) / total_documents * 100,
        "parse_completion_rate": documents_with_total / total_documents * 100,
        "processing_seconds": processing_seconds,
        "average_seconds_per_document": processing_seconds / total_documents,
        "field_accuracy": field_correct_count / field_label_count * 100 if field_label_count else 0,
        "exact_documents": exact_documents,
        "fully_labeled_documents": docs_with_all_labels,
        "exact_document_accuracy": (
            exact_documents / docs_with_all_labels * 100 if docs_with_all_labels else 0
        ),
        "correct_fields": correct_fields,
        "labeled_fields": labeled_fields,
        "failures": failures,
    }

    print(f"Dataset: {dataset} (labels from invoice filenames and printed PDF fields)")
    print(f"Documents evaluated: {total_documents}")
    print(
        f"Documents with a total extracted: {documents_with_total}/{total_documents} "
        f"({result['parse_completion_rate']:.2f}%)"
    )
    print(
        f"Successful extractions (required fields validated): {validated_documents}/{total_documents} "
        f"({result['success_rate']:.2f}%)"
    )
    print(
        f"Failed/manual review: {total_documents - validated_documents}/{total_documents} "
        f"({result['failure_rate']:.2f}%)"
    )
    print(f"Total processing time: {processing_seconds:.3f} seconds")
    print(f"Average processing time: {result['average_seconds_per_document']:.4f} seconds/document")
    print(
        f"Field accuracy: {field_correct_count}/{field_label_count} "
        f"({result['field_accuracy']:.2f}%)"
    )
    print(
        f"Exact-document accuracy: {exact_documents}/{docs_with_all_labels} "
        f"({result['exact_document_accuracy']:.2f}%)"
    )
    print("Field accuracy by label:")
    for field in FIELDS:
        count = labeled_fields[field]
        accuracy = correct_fields[field] / count * 100 if count else 0
        print(f"  {field}: {correct_fields[field]}/{count} ({accuracy:.2f}%)")

    if failures:
        print(f"Processing/label failures: {len(failures)}")
        for filename, error in failures[:10]:
            print(f"  {filename}: {error}")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Evaluate extraction on labeled invoice PDFs.")
    parser.add_argument(
        "dataset",
        nargs="?",
        default="1000+ PDF_Invoice_Folder",
        help="Directory containing labeled invoice PDFs",
    )
    run_evaluation(parser.parse_args().dataset)
