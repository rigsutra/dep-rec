// A dependency-free MCP server over stdio.
//
// This used to be @modelcontextprotocol/sdk. The SDK did two things for us:
// framed JSON-RPC over stdin/stdout, and converted zod schemas into the JSON
// Schema that `tools/list` has to publish. Both are small. What they cost was
// a 15-package dependency tree carrying a moderate advisory
// (GHSA-frvp-7c67-39w9, in @hono/node-server, reachable only through an HTTP
// transport this server never uses) that no consumer could patch, because
// npm's `overrides` do not apply to a dependency's own package.json.
//
// Making it optional in 0.1.3 only meant people had to know to pass
// --omit=optional. A tool whose entire subject is dependency hygiene should
// not ship a default install with a known advisory in it and an opt-out flag
// in the README. So: no dependencies at all, and the tarball is the same
// either way.
//
// Protocol reference: JSON-RPC 2.0 framing, newline-delimited, one message
// per line, on stdin/stdout. Nothing else in the process may write to stdout.

import { validateArgs, toJsonSchema, type FieldSpec } from "./validate.js";

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  fields: Record<string, FieldSpec>;
  /** Receives arguments already validated against `fields`. Returns any JSON-serialisable value. */
  handler(args: Record<string, unknown>): Promise<unknown>;
}

const JSONRPC = "2.0";

// Fallback only. The negotiated version is normally whatever the client asked
// for: a client never proposes a version it cannot itself speak, so echoing
// its request back is both correct and the most compatible thing to do.
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

interface Incoming {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

// User-supplied objects can carry keys like `constructor`, `__proto__` and
// `toString`. Reading them with plain member access returns inherited
// built-ins on an ordinary object literal, which is how a payload shaped like
// { constructor: { prototype: {} } } turns into a confusing type error deep
// inside a validator instead of a clean "bad argument" response. Every read
// of a caller-controlled object goes through here.
function own(obj: unknown, key: string): unknown {
  if (typeof obj !== "object" || obj === null) return undefined;
  return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function createServer(info: { name: string; version: string }, tools: ToolSpec[]) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  function toolDescriptors() {
    return tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: toJsonSchema(t.fields),
    }));
  }

  async function callTool(params: unknown): Promise<unknown> {
    const name = own(params, "name");
    if (typeof name !== "string") {
      throw new RpcError(ERR_INVALID_PARAMS, "tools/call requires a string `name`");
    }
    const tool = byName.get(name);
    if (!tool) {
      throw new RpcError(ERR_INVALID_PARAMS, `Unknown tool: ${name}`);
    }

    const rawArgs = own(params, "arguments");
    // Absent arguments are legitimate for a no-input tool; anything present
    // but not an object is a caller error, not a crash.
    if (rawArgs !== undefined && !isPlainObject(rawArgs)) {
      return errorResult(`Invalid arguments for ${name}: expected an object, received ${describe(rawArgs)}`);
    }

    const validation = validateArgs(tool.fields, isPlainObject(rawArgs) ? rawArgs : {});
    if (!validation.ok) {
      // Deliberately a tool result rather than a JSON-RPC error: a model that
      // gets a protocol-level failure has nothing to act on, whereas an
      // isError result carries text it can read and correct itself with.
      return errorResult(`Invalid arguments for ${name}: ${validation.errors.join("; ")}`);
    }

    try {
      const value = await tool.handler(validation.value);
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }

  async function dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const requested = own(params, "protocolVersion");
        return {
          protocolVersion: typeof requested === "string" && requested.length > 0 ? requested : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: info,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: toolDescriptors() };
      case "tools/call":
        return callTool(params);
      default:
        throw new RpcError(ERR_METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  function write(message: unknown): void {
    process.stdout.write(JSON.stringify(message) + "\n");
  }

  async function handleMessage(raw: string): Promise<void> {
    let msg: Incoming;
    try {
      msg = JSON.parse(raw) as Incoming;
    } catch {
      write({ jsonrpc: JSONRPC, id: null, error: { code: ERR_PARSE, message: "Parse error" } });
      return;
    }

    if (!isPlainObject(msg)) {
      write({ jsonrpc: JSONRPC, id: null, error: { code: ERR_INVALID_REQUEST, message: "Invalid Request" } });
      return;
    }

    const id = own(msg, "id") as string | number | null | undefined;
    const method = own(msg, "method");
    const isNotification = id === undefined || id === null;

    if (typeof method !== "string") {
      if (!isNotification) {
        write({ jsonrpc: JSONRPC, id, error: { code: ERR_INVALID_REQUEST, message: "Invalid Request: missing method" } });
      }
      return;
    }

    // Notifications (initialized, cancelled, progress) get no reply, ever —
    // answering one corrupts the stream for a spec-compliant client.
    if (isNotification) return;

    try {
      const result = await dispatch(method, own(msg, "params"));
      write({ jsonrpc: JSONRPC, id, result });
    } catch (err) {
      const code = err instanceof RpcError ? err.code : ERR_INTERNAL;
      const message = err instanceof Error ? err.message : String(err);
      write({ jsonrpc: JSONRPC, id, error: { code, message } });
    }
  }

  return {
    toolDescriptors,
    /** Exposed for tests: exercises dispatch without going through stdio. */
    dispatch,
    listen(): void {
      process.stdin.setEncoding("utf8");
      let buffer = "";
      process.stdin.on("data", (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          // Requests are handled concurrently and matched by id, which is
          // what JSON-RPC specifies and what an agent firing parallel tool
          // calls depends on. Responses may therefore come back out of order.
          if (line.length > 0) void handleMessage(line);
        }
      });
      process.stdin.on("end", () => process.exit(0));
    },
  };
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

function errorResult(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
