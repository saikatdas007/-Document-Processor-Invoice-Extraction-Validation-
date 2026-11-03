# AI Assistance Disclosure

AI assistance was used during development to help inspect the codebase, identify and fix defects, improve customer-name extraction and semantic-search ranking, add daily processing analytics, refine frontend behavior, and prepare tests and documentation. The developer reviewed and ran the resulting changes and remains responsible for the submitted work.

## AI-assisted invoice extraction

When an OpenAI API key is configured, the backend sends extracted document text to the OpenAI Chat Completions API using `gpt-4o-mini` and requests JSON output. The system prompt used by the upload routes is:

> You are a document intelligence assistant. Extract customer_name, invoice_number, invoice_date, supplier_name, subtotal, total into a valid JSON object. Use null for fields that are not present; never guess or claim validation status.

The uploaded document text is provided to the model as extraction input. OpenAI-assisted extraction is distinct from the local PDF corpus evaluation in `docs/evaluation-report.md`.

## Security and privacy note

Do not include API keys, `.env` contents, authentication tokens, or real customer documents in this disclosure. Before using the project with sensitive documents, confirm that sending their contents to an external AI service is permitted and configure appropriate data-handling controls.

## AI-assisted coding

The coding assistant helped with source-code review and implementation suggestions, regression-test creation, final verification, and assessment documentation. All generated or suggested code should be reviewed by the submitting developer.
