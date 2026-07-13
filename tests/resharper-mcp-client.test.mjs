import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ClientError,
  EXIT_CODES,
  KNOWN_TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
  executeCommand,
  loadArguments,
  parseCliArgs,
} from "../skills/resharper-code-intelligence/scripts/resharper-mcp-client.mjs";

const SESSION_ID = "test-session";

async function createServer({ delayMs = 0 } = {}) {
  const requests = [];
  const tools = [...KNOWN_TOOLS].map((name) => ({
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {} },
  }));

  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }
    const payload = body ? JSON.parse(body) : null;
    requests.push({ method: request.method, headers: request.headers, payload });

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    response.setHeader("Mcp-Session-Id", SESSION_ID);
    if (request.method === "DELETE") {
      response.writeHead(200).end();
      return;
    }

    if (payload?.method === "notifications/initialized") {
      response.writeHead(202).end();
      return;
    }

    response.setHeader("Content-Type", "application/json");
    if (payload?.method === "initialize") {
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mock-resharper", version: "1.0.0" },
        },
      }));
      return;
    }

    if (payload?.method === "tools/list") {
      response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { tools } }));
      return;
    }

    if (payload?.method === "tools/call") {
      const { name, arguments: argumentsValue } = payload.params;
      const isError = name === "get_file_errors" && argumentsValue.forceError;
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          isError,
          content: [{ type: "text", text: isError ? "mock tool error" : JSON.stringify({ name, arguments: argumentsValue }) }],
        },
      }));
      return;
    }

    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: payload?.id,
      error: { code: -32601, message: "not found" },
    }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function options(command, url, overrides = {}) {
  return { command, url, timeoutMs: 2_000, apply: false, arguments: {}, ...overrides };
}

async function expectClientError(action, exitCode, pattern) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof ClientError);
    assert.equal(error.exitCode, exitCode);
    assert.match(error.message, pattern);
    return true;
  });
}

test("classifies every one of the 23 tools exactly once", () => {
  assert.equal(KNOWN_TOOLS.size, 23);
  assert.equal(READ_TOOLS.size + WRITE_TOOLS.size, 23);
  for (const tool of WRITE_TOOLS) {
    assert.equal(READ_TOOLS.has(tool), false);
  }
});

test("parses command options and JSON argument files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "resharper-skill-test-"));
  const argumentsFile = path.join(directory, "arguments.json");
  try {
    await writeFile(argumentsFile, '{"symbolName":"Driver"}', "utf8");
    const parsed = parseCliArgs([
      "call",
      "find_usages",
      "--arguments-file",
      argumentsFile,
      "--timeout-ms",
      "5000",
    ], {});
    assert.equal(parsed.toolName, "find_usages");
    assert.equal(parsed.timeoutMs, 5_000);
    assert.deepEqual(await loadArguments(parsed), { symbolName: "Driver" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects invalid JSON arguments", async () => {
  await expectClientError(
    () => loadArguments({ argumentsJson: "not-json" }),
    EXIT_CODES.usage,
    /not valid JSON/,
  );
});

test("status performs initialize, initialized notification, and cleanup", async () => {
  const mock = await createServer();
  try {
    const result = await executeCommand(options("status", mock.url));
    assert.equal(result.value.serverInfo.name, "mock-resharper");
    assert.deepEqual(mock.requests.map(({ method, payload }) => [method, payload?.method]), [
      ["POST", "initialize"],
      ["POST", "notifications/initialized"],
      ["DELETE", undefined],
    ]);
    assert.equal(mock.requests[1].headers["mcp-session-id"], SESSION_ID);
    assert.equal(mock.requests[2].headers["mcp-session-id"], SESSION_ID);
  } finally {
    await mock.close();
  }
});

test("schema returns only the selected live definition", async () => {
  const mock = await createServer();
  try {
    const result = await executeCommand(options("schema", mock.url, { toolName: "find_usages" }));
    assert.equal(result.value.name, "find_usages");
    assert.equal(result.value.description, "find_usages description");
  } finally {
    await mock.close();
  }
});

test("read-only call forwards arguments and returns text", async () => {
  const mock = await createServer();
  try {
    const result = await executeCommand(options("call", mock.url, {
      toolName: "find_usages",
      arguments: { symbolName: "Driver.Awake" },
    }));
    const parsed = JSON.parse(result.value);
    assert.equal(parsed.name, "find_usages");
    assert.equal(parsed.arguments.symbolName, "Driver.Awake");
  } finally {
    await mock.close();
  }
});

test("tool errors use the tool exit code", async () => {
  const mock = await createServer();
  try {
    await expectClientError(
      () => executeCommand(options("call", mock.url, {
        toolName: "get_file_errors",
        arguments: { forceError: true },
      })),
      EXIT_CODES.tool,
      /mock tool error/,
    );
  } finally {
    await mock.close();
  }
});

test("unknown tools fail closed before connecting", async () => {
  let called = false;
  await expectClientError(
    () => executeCommand(options("call", "http://127.0.0.1:1/", {
      toolName: "future_write_tool",
      arguments: {},
    }), { fetchImpl: async () => { called = true; } }),
    EXIT_CODES.safety,
    /not classified/,
  );
  assert.equal(called, false);
});

for (const toolName of ["fix_usings", "format_file", "apply_quick_fix", "generate_members"]) {
  test(`${toolName} is blocked without --apply`, async () => {
    await expectClientError(
      () => executeCommand(options("call", "http://127.0.0.1:1/", { toolName })),
      EXIT_CODES.safety,
      /requires --apply/,
    );
  });
}

for (const toolName of ["rename_symbol", "apply_suggestions"]) {
  test(`${toolName} automatically previews without --apply`, async () => {
    const mock = await createServer();
    try {
      const result = await executeCommand(options("call", mock.url, {
        toolName,
        arguments: { dryRun: false },
      }));
      assert.equal(JSON.parse(result.value).arguments.dryRun, true);
    } finally {
      await mock.close();
    }
  });

  test(`${toolName} applies with --apply`, async () => {
    const mock = await createServer();
    try {
      const result = await executeCommand(options("call", mock.url, {
        toolName,
        apply: true,
      }));
      assert.equal(JSON.parse(result.value).arguments.dryRun, false);
    } finally {
      await mock.close();
    }
  });
}

test("non-preview writes execute only with --apply", async () => {
  const mock = await createServer();
  try {
    for (const toolName of ["fix_usings", "format_file", "apply_quick_fix", "generate_members"]) {
      const result = await executeCommand(options("call", mock.url, { toolName, apply: true }));
      assert.equal(JSON.parse(result.value).name, toolName);
    }
  } finally {
    await mock.close();
  }
});

test("request timeout produces a protocol error", async () => {
  const mock = await createServer({ delayMs: 100 });
  try {
    await expectClientError(
      () => executeCommand(options("status", mock.url, { timeoutMs: 10 })),
      EXIT_CODES.protocol,
      /timed out/,
    );
  } finally {
    await mock.close();
  }
});

test("connection failure produces a protocol error", async () => {
  const mock = await createServer();
  const url = mock.url;
  await mock.close();
  await expectClientError(
    () => executeCommand(options("status", url, { timeoutMs: 100 })),
    EXIT_CODES.protocol,
    /Cannot reach ReSharper MCP/,
  );
});
