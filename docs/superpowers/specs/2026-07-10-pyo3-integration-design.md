# PyO3 Integration & Scripts Refactoring Design

## Overview
This design outlines the migration of Thoth's Python scripts integration. Currently, Thoth calls Python scripts (`render_headline.py`, `analyze_narration_structure.py`, `tts_generate.py`) via subprocesses (`Command::new`). This causes significant startup overhead and inefficient file-based I/O serialization.

The new architecture adopts a Hybrid approach:
1. **PyO3 Embedding:** Python logic that relies heavily on specific Python libraries (like Pillow for text rendering) will be embedded inside the Rust process using PyO3, eliminating subprocess startup overhead.
2. **Rust Rewrite:** Scripts that are purely HTTP API clients and database connectors will be rewritten in 100% Rust to simplify the architecture.

## Architecture

### 1. `render_headline` (PyO3 Integration)
- **Problem:** `render_headline.py` is invoked via `python render_headline.py spec.json`. Startup of Python and Pillow takes seconds.
- **Solution:** 
  - Rust integrates `pyo3` crate with the `auto-initialize` feature.
  - Rust uses the `pythonize` crate to serialize `HeadlinePngSpec` directly into a Python dictionary in memory.
  - `render_headline.py` exposes a new `render_from_dict(spec: dict) -> str` function.
  - Rust's `headline_png.rs` loads the `render_headline` module and calls `render_from_dict` directly.

### 2. `analyze_narration_structure` (Rust Rewrite)
- **Problem:** `analyze_narration_structure.py` is a Python script making `requests` to Groq/Novita and executing SQL via `psycopg2`.
- **Solution:** 
  - Rewrite this script entirely in Rust under a new module, e.g., `src/narration/analyzer.rs`.
  - Use `reqwest` for API calls to Groq and Novita.
  - Use the existing Supabase configuration (via `reqwest` or Postgres clients already present in Thoth) to upsert into `narration_structures`.
  - The Python script is deprecated.

### 3. `tts_generate` (Status Quo)
- **Decision:** Due to the complexity of embedding Python's `asyncio` event loop (required by `edge-tts`) into Rust's Tokio runtime via PyO3 (`pyo3-asyncio`), `tts_generate.py` will remain a subprocess CLI for now to limit the scope and risk of this migration phase.

## Data Flow & Interfaces

### PyO3 Rendering
1. **Input:** `HeadlinePngSpec` struct in Rust.
2. **Conversion:** `pythonize(py, &spec)` converts it to a `PyDict`.
3. **Execution:** `py.import("render_headline")?.call_method1("render_from_dict", (py_dict,))`.
4. **Output:** `PyResult<String>` containing the absolute path to the generated PNG, mapped to `Result<PathBuf, EditError>`.

### Rust Analyzer
1. **Input:** A video URL.
2. **Process:** Rust fetches metadata, downloads audio, calls Groq API (Whisper), calls Novita API (LLM analysis and embeddings), and upserts to Supabase.
3. **Output:** `Result<(), String>` (Success or Failure).

## Error Handling
- **PyO3 Execution:** If Python crashes (e.g., missing font, Pillow error), `PyErr` is caught by Rust. It is converted to a string using `e.to_string()` (which contains the Python traceback) and wrapped in `EditError::SubtitleError`.
- **Rust Rewrite:** HTTP and DB errors are handled using Rust's `Result` standard pattern.

## Testing
- **Integration Test:** Add a `#[test]` in `headline_png.rs` to verify that `pyo3` can successfully load `render_headline` and output a test image without panicking.
- **Manual Test:** Run Thoth to generate a video cover and ensure the PyO3 renderer matches the previous subprocess renderer's visual output.
