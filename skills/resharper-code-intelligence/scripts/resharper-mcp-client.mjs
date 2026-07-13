#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const EXIT_CODES = Object.freeze({
  usage: 2,
  protocol: 3,
  tool: 4,
  safety: 5,
});

export const READ_TOOLS = new Set([
  "list_solutions",
  "find_usages",
  "get_symbol_info",
  "find_implementations",
  "get_file_errors",
  "search_symbol",
  "go_to_definition",
  "get_solution_structure",
  "browse_namespace",
  "list_symbols_in_file",
  "flow",
  "get_symbol_source",
  "get_call_hierarchy",
  "get_type_hierarchy",
  "get_diagnostics",
  "list_quick_fixes",
  "complete_at",
]);

export const WRITE_TOOLS = new Set([
  "fix_usings",
  "format_file",
  "apply_quick_fix",
  "rename_symbol",
  "generate_members",
  "apply_suggestions",
]);

export const PREVIEW_TOOLS = new Set([
  "rename_symbol",
  "apply_suggestions",
]);

export const KNOWN_TOOLS = new Set([...READ_TOOLS, ...WRITE_TOOLS]);

const DEFAULT_URL = "http://127.0.0.1:23741/";
const DEFAULT_TIMEOUT_MS = 120_000;
const PROTOCOL_VERSION = "2025-03-26";

const HELP = `Usage:
  resharper-mcp-client.mjs status [options]
  resharper-mcp-client.mjs solutions [options]
  resharper-mcp-client.mjs tools [options]
  resharper-mcp-client.mjs schema <tool> [options]
  resharper-mcp-client.mjs call <tool> [--arguments-json <json> | --arguments-file <path|->] [--apply] [options]

Options:
  --url <url>              MCP endpoint (default: RESHARPER_MCP_URL or http://127.0.0.1:23741/)
  --timeout-ms <ms>        Per-request timeout (default: RESHARPER_MCP_TIMEOUT_MS or 120000)
  --arguments-json <json>  Tool arguments as a JSON object
  --arguments-file <path>  Tool arguments from a JSON file; use - for stdin
  --apply                  Permit a source-changing tool to execute
  --help                   Show this help
`;

export class ClientError extends Error {
  constructor(message, exitCode, cause) {
    super(message, { cause });
    this.name = "ClientError";
    this.exitCode = exitCode;
  }
}

function fail(message, exitCode = EXIT_CODES.usage, cause) {
  throw new ClientError(message, exitCode, cause);
}

function normalizeUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    fail(`Invalid MCP URL: ${value}`, EXIT_CODES.usage, error);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(`Unsupported MCP URL protocol: ${parsed.protocol}`);
  }

  if (!parsed.pathname.endsWith("/")) {
    parsed.pathname += "/";
  }
  return parsed.toString();
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return parsed;
}

export function parseCliArgs(argv, env = process.env) {
  const tokens = [...argv];
  if (tokens.length === 0 || tokens.includes("--help")) {
    return { help: true };
  }

  const command = tokens.shift();
  const positionals = [];
  const options = {
    command,
    url: env.RESHARPER_MCP_URL || DEFAULT_URL,
    timeoutMs: env.RESHARPER_MCP_TIMEOUT_MS
      ? parsePositiveInteger(env.RESHARPER_MCP_TIMEOUT_MS, "RESHARPER_MCP_TIMEOUT_MS")
      : DEFAULT_TIMEOUT_MS,
    apply: false,
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    if (token === "--apply") {
      options.apply = true;
      continue;
    }

    const value = tokens[index + 1];
    if (value === undefined) {
      fail(`Missing value for ${token}`);
    }
    index += 1;

    switch (token) {
      case "--url":
        options.url = value;
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInteger(value, "--timeout-ms");
        break;
      case "--arguments-json":
        options.argumentsJson = value;
        break;
      case "--arguments-file":
        options.argumentsFile = value;
        break;
      default:
        fail(`Unknown option: ${token}`);
    }
  }

  options.url = normalizeUrl(options.url);

  if (!["status", "solutions", "tools", "schema", "call"].includes(command)) {
    fail(`Unknown command: ${command}`);
  }

  if (["schema", "call"].includes(command)) {
    if (positionals.length !== 1) {
      fail(`${command} requires exactly one tool name`);
    }
    [options.toolName] = positionals;
  } else if (positionals.length !== 0) {
    fail(`${command} does not accept positional arguments`);
  }

  if (options.argumentsJson !== undefined && options.argumentsFile !== undefined) {
    fail("Use only one of --arguments-json and --arguments-file");
  }

  if (command !== "call" && (options.argumentsJson !== undefined || options.argumentsFile !== undefined || options.apply)) {
    fail("Argument and --apply options are valid only for call");
  }

  return options;
}

export async function loadArguments(options) {
  let source = options.argumentsJson;
  if (options.argumentsFile !== undefined) {
    try {
      source = options.argumentsFile === "-"
        ? await readStdin()
        : await readFile(options.argumentsFile, "utf8");
    } catch (error) {
      fail(`Cannot read tool arguments from '${options.argumentsFile}': ${error.message}`, EXIT_CODES.usage, error);
    }
  }

  if (source === undefined || source.trim() === "") {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    fail(`Tool arguments are not valid JSON: ${error.message}`, EXIT_CODES.usage, error);
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    fail("Tool arguments must be a JSON object");
  }
  return parsed;
}

async function readStdin() {
  let source = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    source += chunk;
  }
  return source;
}

function prepareToolCall(toolName, argumentsValue, apply) {
  if (!KNOWN_TOOLS.has(toolName)) {
    fail(
      `Tool '${toolName}' is not classified by this client. Inspect it with schema and update the client before calling it.`,
      EXIT_CODES.safety,
    );
  }

  const prepared = { ...argumentsValue };
  if (!WRITE_TOOLS.has(toolName)) {
    return prepared;
  }

  if (!apply && PREVIEW_TOOLS.has(toolName)) {
    prepared.dryRun = true;
    return prepared;
  }

  if (!apply) {
    fail(`Write tool '${toolName}' requires --apply`, EXIT_CODES.safety);
  }

  if (PREVIEW_TOOLS.has(toolName) && prepared.dryRun === undefined) {
    prepared.dryRun = false;
  }
  return prepared;
}

export class McpClient {
  constructor({ url = DEFAULT_URL, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") {
      fail("This client requires Node.js 18 or newer with global fetch support");
    }
    this.url = normalizeUrl(url);
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.sessionId = null;
    this.nextId = 1;
    this.initializeResult = null;
  }

  async fetchWithTimeout(init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(this.url, { ...init, signal: controller.signal });
    } catch (error) {
      const detail = error?.name === "AbortError"
        ? `Request timed out after ${this.timeoutMs}ms`
        : `Cannot reach ReSharper MCP at ${this.url}: ${error.message}`;
      fail(detail, EXIT_CODES.protocol, error);
    } finally {
      clearTimeout(timer);
    }
  }

  headers() {
    const headers = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    return headers;
  }

  async post(payload) {
    const response = await this.fetchWithTimeout({
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });

    const returnedSessionId = response.headers.get("mcp-session-id");
    if (returnedSessionId) {
      this.sessionId = returnedSessionId;
    }

    const text = await response.text();
    if (!response.ok) {
      fail(`MCP HTTP ${response.status}: ${text || response.statusText}`, EXIT_CODES.protocol);
    }
    if (text === "") {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      fail("MCP returned invalid JSON", EXIT_CODES.protocol, error);
    }
  }

  async connect() {
    const response = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "resharper-code-intelligence-skill", version: "1.0.0" },
      },
    });
    this.unwrap(response);
    this.initializeResult = response.result;

    await this.post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    return this.initializeResult;
  }

  unwrap(response) {
    if (!response || typeof response !== "object") {
      fail("MCP returned an empty JSON-RPC response", EXIT_CODES.protocol);
    }
    if (response.error) {
      fail(`MCP error ${response.error.code}: ${response.error.message}`, EXIT_CODES.protocol);
    }
    return response.result;
  }

  async request(method, params = {}) {
    const response = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params,
    });
    return this.unwrap(response);
  }

  async listTools() {
    const result = await this.request("tools/list");
    if (!Array.isArray(result?.tools)) {
      fail("MCP tools/list response does not contain a tools array", EXIT_CODES.protocol);
    }
    return result.tools;
  }

  async callTool(name, argumentsValue) {
    const result = await this.request("tools/call", { name, arguments: argumentsValue });
    if (result?.isError) {
      fail(extractContent(result) || `Tool '${name}' failed`, EXIT_CODES.tool);
    }
    return result;
  }

  async close() {
    if (!this.sessionId) {
      return;
    }
    try {
      await this.fetchWithTimeout({
        method: "DELETE",
        headers: { Accept: "application/json", "Mcp-Session-Id": this.sessionId },
      });
    } catch {
      // Session cleanup must not hide the command result or its original error.
    }
  }
}

function extractContent(result) {
  if (!Array.isArray(result?.content)) {
    return "";
  }
  return result.content
    .map((block) => block?.text ?? JSON.stringify(block))
    .filter(Boolean)
    .join("\n");
}

async function withClient(options, action) {
  const client = new McpClient(options);
  try {
    const initializeResult = await client.connect();
    return await action(client, initializeResult);
  } finally {
    await client.close();
  }
}

export async function executeCommand(options, dependencies = {}) {
  const clientOptions = {
    url: options.url,
    timeoutMs: options.timeoutMs,
    fetchImpl: dependencies.fetchImpl,
  };

  if (options.command === "call") {
    const prepared = prepareToolCall(options.toolName, options.arguments ?? {}, options.apply);
    return withClient(clientOptions, async (client) => ({
      format: "text",
      value: extractContent(await client.callTool(options.toolName, prepared)),
    }));
  }

  return withClient(clientOptions, async (client, initializeResult) => {
    switch (options.command) {
      case "status":
        return {
          format: "json",
          value: {
            url: client.url,
            protocolVersion: initializeResult.protocolVersion,
            serverInfo: initializeResult.serverInfo,
          },
        };
      case "solutions":
        return {
          format: "text",
          value: extractContent(await client.callTool("list_solutions", {})),
        };
      case "tools": {
        const tools = await client.listTools();
        return {
          format: "json",
          value: tools.map(({ name, description }) => ({ name, description })),
        };
      }
      case "schema": {
        const tools = await client.listTools();
        const tool = tools.find(({ name }) => name === options.toolName);
        if (!tool) {
          fail(`MCP server does not expose tool '${options.toolName}'`, EXIT_CODES.tool);
        }
        return { format: "json", value: tool };
      }
      default:
        fail(`Unknown command: ${options.command}`);
    }
  });
}

async function main() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(HELP);
      return;
    }
    options.arguments = await loadArguments(options);
    const result = await executeCommand(options);
    const output = result.format === "json"
      ? JSON.stringify(result.value, null, 2)
      : result.value;
    process.stdout.write(`${output ?? ""}\n`);
  } catch (error) {
    const exitCode = error instanceof ClientError ? error.exitCode : 1;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = exitCode;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
