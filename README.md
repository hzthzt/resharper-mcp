# ReSharper MCP Server

**English** | [简体中文](README.zh-CN.md)

An MCP (Model Context Protocol) server that runs inside the ReSharper/Rider backend process, exposing code intelligence features to AI assistants via HTTP.

Supports C#, F#, VB, and any language with a ReSharper PSI implementation.

## Tools

The server exposes 23 tools: 17 read-only tools and 6 source-changing tools.

### Read-only tools

| Tool | Description |
|------|-------------|
| `find_usages` | Find all references to a symbol |
| `get_symbol_info` | Detailed symbol info: kind, type, params, docs, base types, members |
| `find_implementations` | Find implementations of interfaces/abstract classes and overrides |
| `get_file_errors` | Get compile errors and unresolved references |
| `search_symbol` | Search symbols by name (substring match) across the solution |
| `go_to_definition` | Navigate to a symbol's declaration with source text |
| `get_solution_structure` | List projects, target frameworks, and project references |
| `browse_namespace` | Browse namespace hierarchy: child namespaces and types |
| `list_symbols_in_file` | List all declarations in a file |
| `list_solutions` | List all open solutions across Rider instances |
| `flow` | Describe control flow of a method or type: execution steps, branches, loops, error paths, inlined call targets |
| `get_symbol_source` | Get the full declaration source code of a symbol (not just a snippet) |
| `get_call_hierarchy` | Build an incoming (callers) or outgoing (callees) call hierarchy tree for a method |
| `get_type_hierarchy` | Get the inheritance hierarchy of a type: supertypes (base/interfaces) or subtypes |
| `get_diagnostics` | Run daemon inspections on a file; reports severity, inspection id, message, location, and quick-fix availability |
| `list_quick_fixes` | List the ReSharper quick-fixes (bulb actions) available at a position |
| `complete_at` | Get code completion suggestions at a caret position |

### Source-changing tools

These tools modify source files and run under ReSharper's write lock:

| Tool | Description |
|------|-------------|
| `fix_usings` | Fix missing using directives in C# files |
| `format_file` | Format, clean up, or apply code style to a file |
| `rename_symbol` | Semantic, solution-wide rename of a symbol and all its references (supports `dryRun`) |
| `generate_members` | Generate members on a type (constructors, overrides, equality members, etc.) |
| `apply_quick_fix` | Apply a ReSharper quick-fix (bulb action) at a position |
| `apply_suggestions` | Apply inspection quick-fixes file-wide by inspection id (e.g. convert explicit constructor → primary constructor); position-free, `dryRun`/`all` supported |

### Symbol resolution

Tools that operate on a symbol accept two modes:
- **By position** — `filePath` + `line` + `column` (1-based)
- **By name** — `symbolName` (e.g. `"MyClass"`, `"Namespace.MyClass"`, `"MyClass.MyMethod"`)

An optional `kind` filter (`"type"`, `"method"`, `"property"`, `"field"`, `"event"`) helps disambiguate. When multiple symbols match, tools return an ambiguity error listing all candidates with their qualified names, kinds, and locations.

### Multi-solution targeting

Multiple Rider instances can share the same MCP endpoint. Call `list_solutions` to discover them, then pass `solutionName` to other tools when more than one solution is open. A unique path segment can also identify solutions that have the same name.

### Batch mode

Most tools support batch mode — processing multiple inputs in a single call. This reduces round-trips when querying several symbols or files at once:

- **Symbol-based tools** (`find_usages`, `get_symbol_info`, `find_implementations`, `go_to_definition`) accept a `symbols` array of `{symbolName, kind, filePath, line, column}` objects.
- **File-based tools** (`get_file_errors`, `list_symbols_in_file`, `fix_usings`, `format_file`) accept a `filePaths` array of strings.
- **`search_symbol`** accepts a `queries` array of strings.
- **`browse_namespace`** accepts a `namespaceNames` array of strings.

Results are concatenated with `=== [N/total] label ===` separators. Shared options (e.g. `maxResults`, `kinds`, `mode`) apply to all items in the batch. Original single-input parameters remain for backward compatibility.

## Installation

### From JetBrains Marketplace

Install the plugin from Rider: **Settings → Plugins → Marketplace** → search for "MCP Server for Code Intelligence".

### From source

```bash
./install-rider.sh
# Restart Rider
```

The script builds the plugin and copies it to your local Rider plugin directory.

## MCP client configuration

Add to your MCP client config (e.g. Claude Code `settings.json`):

```json
{
  "mcpServers": {
    "resharper": {
      "type": "http",
      "url": "http://127.0.0.1:23741/"
    }
  }
}
```

The server starts automatically when you open a solution in Rider.

Set `RESHARPER_MCP_PORT` environment variable to override the default port.

## Codex Skill (progressive disclosure)

This repository also provides the `resharper-code-intelligence` Codex Skill. It calls the same local Rider endpoint through a bundled Node.js client, but reveals a tool schema only when the Skill selects that tool. Codex does not need to register all 23 ReSharper tools at session startup.

### Install

Prerequisites:

- Install this Rider plugin and open a solution.
- Install Node.js 18 or newer.
- Keep the endpoint on `http://127.0.0.1:23741/`, or set `RESHARPER_MCP_URL`.

Ask Codex to install the Skill from GitHub:

```text
Use $skill-installer to install the skill from https://github.com/hzthzt/resharper-mcp/tree/main/skills/resharper-code-intelligence.
```

The installed Skill becomes available on the next Codex turn.

### Avoid duplicate tool registration

To avoid loading the native MCP catalog alongside the Skill, disable (or remove) the direct Codex MCP entry:

```toml
[mcp_servers.resharper]
url = "http://127.0.0.1:23741/"
enabled = false
```

The Skill first checks Rider and the open solutions, loads only the relevant navigation, diagnostics, or refactoring guidance, fetches the selected tool schema, and then calls it.

### Safety and troubleshooting

The bundled client treats all six source-changing tools as writes. It blocks them unless `--apply` is present, except `rename_symbol` and `apply_suggestions`, which automatically run with `dryRun=true` when `--apply` is omitted.

Run the client directly when troubleshooting:

```bash
node skills/resharper-code-intelligence/scripts/resharper-mcp-client.mjs status
node skills/resharper-code-intelligence/scripts/resharper-mcp-client.mjs solutions
node skills/resharper-code-intelligence/scripts/resharper-mcp-client.mjs schema find_usages
node skills/resharper-code-intelligence/scripts/resharper-mcp-client.mjs call search_symbol --arguments-json '{"query":"MyType"}'
```

Use `--url` or `RESHARPER_MCP_URL` for a custom endpoint, and `--timeout-ms` or `RESHARPER_MCP_TIMEOUT_MS` for a custom request timeout.

## Building

```bash
# Build the .NET backend
dotnet build src/ReSharperMcp/ReSharperMcp.csproj -c Release

# Build a distributable plugin ZIP
./build-plugin.sh
```

## Architecture

- Runs as a ReSharper `SolutionComponent` (activated when a solution opens, stopped when it closes)
- Hosts an HTTP server on `127.0.0.1:23741` implementing MCP over JSON-RPC 2.0
- Uses ReSharper's PSI (Program Structure Interface) APIs for code analysis
- Two-part Rider plugin: minimal JVM JAR (plugin descriptor) + .NET backend DLL
- Targets `net472` (required by the ReSharper host process)
