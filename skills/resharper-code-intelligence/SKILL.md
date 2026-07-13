---
name: resharper-code-intelligence
description: Use Rider's ReSharper semantics through a progressively disclosed MCP client. Trigger for C#, F#, or VB solution navigation, symbol search, usages, implementations, hierarchies, diagnostics, completion, formatting, quick fixes, member generation, and semantic rename when a solution is open in Rider.
---

# ReSharper Code Intelligence

Use the bundled client to query the ReSharper MCP endpoint without registering its full tool catalog in Codex.

## Workflow

1. Resolve `<skill-root>` to the directory containing this file.
2. Run `node "<skill-root>/scripts/resharper-mcp-client.mjs" status` to verify Rider is available.
3. Run `node "<skill-root>/scripts/resharper-mcp-client.mjs" solutions` and select the intended solution. Include `solutionName` in later arguments when more than one solution is open.
4. Choose one tool using only the relevant reference:
   - Read [references/navigation.md](references/navigation.md) for symbols, source, usages, hierarchies, structure, flow, or completion.
   - Read [references/diagnostics.md](references/diagnostics.md) for errors, inspections, or available quick fixes.
   - Read [references/refactoring.md](references/refactoring.md) only for source-changing operations.
5. Fetch only the selected input contract with `node "<skill-root>/scripts/resharper-mcp-client.mjs" schema <tool>`.
6. Call it with `node "<skill-root>/scripts/resharper-mcp-client.mjs" call <tool> --arguments-json '<json>'`.

Use `tools` only when the references cannot identify a suitable tool, because it deliberately reveals the compact full catalog.

## Safety

- Treat `fix_usings`, `format_file`, `apply_quick_fix`, `rename_symbol`, `generate_members`, and `apply_suggestions` as writes.
- Do not pass `--apply` unless the user has requested the corresponding source change.
- Without `--apply`, `rename_symbol` and `apply_suggestions` run as dry-run previews. Other write tools are blocked.
- Inspect diagnostics or quick fixes before applying them. Re-read changed files after a write.
- Stop and report the error when Rider is closed, no solution is open, the requested solution is ambiguous, or the tool is unknown.

## Client Options

- Override the endpoint with `RESHARPER_MCP_URL` or `--url`.
- Override the request timeout with `RESHARPER_MCP_TIMEOUT_MS` or `--timeout-ms`.
- Use `--arguments-file <path>` or `--arguments-file -` for JSON that is awkward to quote.
