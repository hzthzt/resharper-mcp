# Diagnostics

Select one tool, then query its live schema before calling it.

| Intent | Tool |
|---|---|
| Get compile errors and unresolved references | `get_file_errors` |
| Run ReSharper inspections with severity and quick-fix metadata | `get_diagnostics` |
| List bulb actions available at a position | `list_quick_fixes` |

Start with `get_file_errors` for compilation failures. Use `get_diagnostics` for broader inspections. Call `list_quick_fixes` only after identifying an exact file position. Read [refactoring.md](refactoring.md) before applying any returned fix.
