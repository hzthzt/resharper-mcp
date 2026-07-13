# Navigation And Structure

Select one tool, then query its live schema before calling it.

| Intent | Tool |
|---|---|
| Discover open Rider solutions | `list_solutions` |
| List projects, frameworks, and references | `get_solution_structure` |
| Search declarations by partial name | `search_symbol` |
| Inspect a symbol signature, type, docs, or members | `get_symbol_info` |
| Read a complete declaration | `get_symbol_source` |
| Navigate to a declaration | `go_to_definition` |
| Find references | `find_usages` |
| Find implementations or overrides | `find_implementations` |
| Trace callers or callees | `get_call_hierarchy` |
| Inspect base types or subtypes | `get_type_hierarchy` |
| Explain control flow | `flow` |
| Browse child namespaces and types | `browse_namespace` |
| List declarations in a file | `list_symbols_in_file` |
| Get completion candidates at a caret | `complete_at` |

Prefer position-based resolution (`filePath`, `line`, `column`) when a name is ambiguous. Use batch parameters only after checking the selected tool's schema.
