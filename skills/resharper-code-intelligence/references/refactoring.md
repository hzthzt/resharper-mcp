# Refactoring And Writes

These tools can modify source files. Query the live schema first and use the client safety controls.

| Intent | Tool | Preview support |
|---|---|---|
| Add missing using directives | `fix_usings` | No |
| Format or clean up files | `format_file` | No |
| Apply one quick fix at a position | `apply_quick_fix` | No |
| Rename a symbol and its references | `rename_symbol` | Automatic without `--apply` |
| Generate constructors, overrides, or other members | `generate_members` | No |
| Apply inspection suggestions across files | `apply_suggestions` | Automatic without `--apply` |

For `rename_symbol` and `apply_suggestions`, call without `--apply` first and review the dry-run result. Repeat with `--apply` only when the user requested the change.

The other write tools are blocked unless `--apply` is present. Before using them, inspect the target with a read-only tool and limit the arguments to the smallest applicable file, position, or member set.
