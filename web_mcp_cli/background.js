/*
Manual build commands (run in terminal yourself, do NOT run automatically from the extension):
1) pnpm --dir web_mcp_cli install
2) pnpm --dir web_mcp_cli exec esbuild background.js --bundle --format=esm --platform=browser --target=chrome120 --outfile=background.bundle.js --sourcemap
3) pnpm --dir web_mcp_cli exec esbuild background.js --bundle --format=esm --platform=browser --target=chrome120 --outfile=background.bundle.js --sourcemap --watch
*/

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_CONFIG_STORAGE_KEY = "tm_mcp_config_v1";
const MCP_ENABLED_TOOLS_STORAGE_KEY = "tm_mcp_enabled_tools_v1";
const MCP_DISCOVERED_TOOLS_STORAGE_KEY = "tm_mcp_discovered_tools_v1";
const CONNECTION_IDLE_TTL_MS = 5 * 60 * 1000;
const CONNECTION_SWEEP_INTERVAL_MS = 45 * 1000;
const MCP_TRANSPORT_STREAMABLE_HTTP = "streamable-http";
const MCP_TRANSPORT_SSE = "sse";
const MCP_TRANSPORT_STDIO = "stdio";
const MCP_TOOL_POLICY_DEFAULT_MAX_RETRIES = 5;
const MCP_TOOL_POLICY_DEFAULT_TIMEOUT_MS = 60 * 1000;
const MCP_TOOL_POLICY_DEFAULT_RESULT_MAX_CHARS = 0;
const MCP_TOOL_POLICY_DEFAULT_MAX_AUTO_ROUNDS = 0;
const MCP_TOOL_POLICY_MAX_AUTO_ROUNDS = 1000;
const MCP_TOOL_POLICY_MAX_RESULT_MAX_CHARS = 2 * 1000 * 1000;

const DEFAULT_CONFIG_STORE = {
  servers: [],
  toolPolicy: {
    maxRetries: MCP_TOOL_POLICY_DEFAULT_MAX_RETRIES,
    timeoutMs: MCP_TOOL_POLICY_DEFAULT_TIMEOUT_MS,
    resultMaxChars: MCP_TOOL_POLICY_DEFAULT_RESULT_MAX_CHARS,
    maxAutoRounds: MCP_TOOL_POLICY_DEFAULT_MAX_AUTO_ROUNDS
  },
  updatedAt: 0
};

const connectionPool = new Map();
const inflightToolExecutions = new Map();

function toSafeString(value) {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function getObjectValueByAliasesCaseInsensitive(source, aliases = []) {
  if (!source || typeof source !== "object" || !Array.isArray(aliases) || aliases.length === 0) {
    return undefined;
  }

  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(source, alias)) {
      return source[alias];
    }
  }

  const normalizedAliases = new Set(
    aliases
      .map((item) => toSafeString(item).toLowerCase())
      .filter(Boolean)
  );
  if (normalizedAliases.size === 0) return undefined;

  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = toSafeString(rawKey).toLowerCase();
    if (!key) continue;
    if (normalizedAliases.has(key)) {
      return rawValue;
    }
  }

  return undefined;
}

function clampInteger(value, fallback, min, max) {
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) return fallback;
  const asInt = Math.trunc(asNumber);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return asInt;
  if (asInt < min) return min;
  if (asInt > max) return max;
  return asInt;
}

function normalizeToolPolicy(rawPolicy) {
  const source = rawPolicy && typeof rawPolicy === "object" ? rawPolicy : {};
  return {
    maxRetries: clampInteger(
      source.maxRetries,
      MCP_TOOL_POLICY_DEFAULT_MAX_RETRIES,
      0,
      20
    ),
    timeoutMs: clampInteger(
      source.timeoutMs,
      MCP_TOOL_POLICY_DEFAULT_TIMEOUT_MS,
      5000,
      10 * 60 * 1000
    ),
    resultMaxChars: clampInteger(
      source.resultMaxChars,
      MCP_TOOL_POLICY_DEFAULT_RESULT_MAX_CHARS,
      0,
      MCP_TOOL_POLICY_MAX_RESULT_MAX_CHARS
    ),
    maxAutoRounds: clampInteger(
      source.maxAutoRounds,
      MCP_TOOL_POLICY_DEFAULT_MAX_AUTO_ROUNDS,
      0,
      MCP_TOOL_POLICY_MAX_AUTO_ROUNDS
    )
  };
}

function normalizeHeaders(rawHeaders) {
  if (!rawHeaders || typeof rawHeaders !== "object") return {};
  const normalized = {};
  for (const [rawKey, rawValue] of Object.entries(rawHeaders)) {
    const key = toSafeString(rawKey);
    if (!key) continue;
    const value = toSafeString(rawValue);
    if (!value) continue;
    normalized[key] = value;
  }
  return normalized;
}

function normalizeArgs(rawArgs) {
  if (!Array.isArray(rawArgs)) return [];
  const args = [];
  for (const item of rawArgs) {
    const value = toSafeString(item);
    if (!value) continue;
    args.push(value);
  }
  return args;
}

function normalizeEnv(rawEnv) {
  if (!rawEnv || typeof rawEnv !== "object") return {};
  const env = {};
  for (const [rawKey, rawValue] of Object.entries(rawEnv)) {
    const key = toSafeString(rawKey);
    if (!key) continue;
    const value = toSafeString(rawValue);
    if (!value) continue;
    env[key] = value;
  }
  return env;
}

function normalizeTransport(rawTransport, fallbackUrl = "") {
  const source = toSafeString(rawTransport).toLowerCase();
  if (source === MCP_TRANSPORT_STREAMABLE_HTTP || source === "streamable_http" || source === "http") {
    return MCP_TRANSPORT_STREAMABLE_HTTP;
  }
  if (source === MCP_TRANSPORT_SSE) {
    return MCP_TRANSPORT_SSE;
  }
  if (source === MCP_TRANSPORT_STDIO) {
    return MCP_TRANSPORT_STDIO;
  }

  const hintUrl = toSafeString(fallbackUrl).toLowerCase();
  if (hintUrl && /\/sse(?:$|[/?#])/i.test(hintUrl)) {
    return MCP_TRANSPORT_SSE;
  }
  return MCP_TRANSPORT_STREAMABLE_HTTP;
}

function normalizeUrl(rawUrl) {
  const url = toSafeString(rawUrl);
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch (_error) {
    return "";
  }
  return "";
}

function normalizeToolNames(rawTools) {
  if (!Array.isArray(rawTools)) return [];
  const seen = new Set();
  const tools = [];
  for (const item of rawTools) {
    const name = toSafeString(item);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    tools.push(name);
  }
  return tools;
}

function normalizeToolDescriptor(rawTool) {
  if (!rawTool || typeof rawTool !== "object") return null;
  const name = toSafeString(rawTool.name);
  if (!name) return null;

  return {
    name,
    description: toSafeString(rawTool.description),
    inputSchema: rawTool.inputSchema && typeof rawTool.inputSchema === "object"
      ? rawTool.inputSchema
      : {}
  };
}

function normalizeDiscoveredToolsByServer(rawMap) {
  if (!rawMap || typeof rawMap !== "object") return {};
  const result = {};

  for (const [rawServerId, rawTools] of Object.entries(rawMap)) {
    const serverId = toSafeString(rawServerId);
    if (!serverId) continue;
    if (!Array.isArray(rawTools)) continue;

    result[serverId] = rawTools
      .map((item) => normalizeToolDescriptor(item))
      .filter(Boolean);
  }

  return result;
}

function normalizeServerConfig(rawServer, index = 0) {
  const fallbackId = `server-${index + 1}`;
  const id = toSafeString(rawServer?.id) || fallbackId;
  const name = toSafeString(rawServer?.name) || id;
  const rawUrl = getObjectValueByAliasesCaseInsensitive(rawServer, ["url", "baseUrl"]);
  const url = normalizeUrl(rawUrl);
  const command = toSafeString(rawServer?.command);
  const rawTransport = getObjectValueByAliasesCaseInsensitive(rawServer, ["type", "transport"]);
  // 同时支持 type 和 transport 输入，内部统一使用 type
  let type = normalizeTransport(rawTransport, rawUrl);
  const args = normalizeArgs(rawServer?.args);
  const env = normalizeEnv(rawServer?.env);
  const cwd = toSafeString(rawServer?.cwd);
  if (!toSafeString(rawTransport) && !url && command) {
    type = MCP_TRANSPORT_STDIO;
  }

  return {
    id,
    name,
    type,
    url,
    command,
    args,
    env,
    cwd,
    headers: normalizeHeaders(rawServer?.headers),
    enabledTools: normalizeToolNames(rawServer?.enabledTools),
    tools: Array.isArray(rawServer?.tools)
      ? rawServer.tools.map(normalizeToolDescriptor).filter(Boolean)
      : []
  };
}

function normalizeServersMap(rawMap) {
  if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap)) {
    return [];
  }

  return Object.entries(rawMap).map(([serverId, serverConfig]) => ({
    ...(serverConfig && typeof serverConfig === "object" ? serverConfig : {}),
    // For object-style mcpServers config, the outer key is the canonical server id.
    // This avoids copied snippets with stale inner ids being silently deduped away.
    id: toSafeString(serverId) || toSafeString(serverConfig?.id) || undefined,
    name: toSafeString(serverConfig?.name) || toSafeString(serverId) || toSafeString(serverConfig?.id) || undefined
  }));
}

function normalizeServersInput(rawStore) {
  const rawServers = getObjectValueByAliasesCaseInsensitive(rawStore, ["servers"]);
  if (Array.isArray(rawServers)) {
    return rawServers;
  }
  const mappedServers = normalizeServersMap(rawServers);
  if (mappedServers.length > 0) {
    return mappedServers;
  }

  const rawMcpServers = getObjectValueByAliasesCaseInsensitive(rawStore, [
    "mcpServers",
    "mcp_servers",
    "mcpservers"
  ]);
  if (Array.isArray(rawMcpServers)) {
    return rawMcpServers;
  }
  const mappedMcpServers = normalizeServersMap(rawMcpServers);
  if (mappedMcpServers.length > 0) {
    return mappedMcpServers;
  }

  return [];
}

function toStoredServerConfig(server) {
  const normalized = normalizeServerConfig(server);
  return {
    id: normalized.id,
    name: normalized.name,
    type: normalized.type,
    url: normalized.url,
    command: normalized.command,
    args: normalized.args,
    env: normalized.env,
    cwd: normalized.cwd,
    headers: normalized.headers
  };
}

function normalizeConfigStore(rawStore) {
  const servers = normalizeServersInput(rawStore).map((server, index) => normalizeServerConfig(server, index));

  const deduped = [];
  const seenIds = new Set();
  for (const server of servers) {
    if (!server.id || seenIds.has(server.id)) continue;
    seenIds.add(server.id);
    deduped.push(server);
  }

  return {
    servers: deduped,
    toolPolicy: normalizeToolPolicy(rawStore?.toolPolicy),
    updatedAt: Number.isFinite(rawStore?.updatedAt) ? rawStore.updatedAt : Date.now()
  };
}

function mergeEnabledTools(config, enabledToolsByServer) {
  const mergedServers = config.servers.map((server) => {
    const external = normalizeToolNames(enabledToolsByServer?.[server.id]);
    return {
      ...server,
      enabledTools: external
    };
  });

  return {
    servers: mergedServers,
    toolPolicy: normalizeToolPolicy(config.toolPolicy),
    updatedAt: config.updatedAt || Date.now()
  };
}

function mergeDiscoveredTools(config, discoveredToolsByServer) {
  const mergedServers = config.servers.map((server) => ({
    ...server,
    tools: Array.isArray(discoveredToolsByServer?.[server.id])
      ? discoveredToolsByServer[server.id]
      : []
  }));

  return {
    servers: mergedServers,
    toolPolicy: normalizeToolPolicy(config.toolPolicy),
    updatedAt: config.updatedAt || Date.now()
  };
}

function getStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime?.lastError) {
        resolve({});
        return;
      }
      resolve(result || {});
    });
  });
}

function setStorage(payload) {
  return new Promise((resolve) => {
    chrome.storage.local.set(payload, () => {
      if (chrome.runtime?.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve({ ok: true });
    });
  });
}

async function getConfigState() {
  const stored = await getStorage({
    [MCP_CONFIG_STORAGE_KEY]: DEFAULT_CONFIG_STORE,
    [MCP_ENABLED_TOOLS_STORAGE_KEY]: {},
    [MCP_DISCOVERED_TOOLS_STORAGE_KEY]: {}
  });

  const config = normalizeConfigStore(stored[MCP_CONFIG_STORAGE_KEY]);
  const enabledToolsByServer = stored[MCP_ENABLED_TOOLS_STORAGE_KEY] && typeof stored[MCP_ENABLED_TOOLS_STORAGE_KEY] === "object"
    ? stored[MCP_ENABLED_TOOLS_STORAGE_KEY]
    : {};
  const discoveredToolsByServer = normalizeDiscoveredToolsByServer(stored[MCP_DISCOVERED_TOOLS_STORAGE_KEY]);

  const merged = mergeDiscoveredTools(mergeEnabledTools(config, enabledToolsByServer), discoveredToolsByServer);
  return {
    config: merged,
    enabledToolsByServer,
    discoveredToolsByServer
  };
}

async function persistConfigState(config, enabledToolsByServerOverride = null, discoveredToolsByServerOverride = null) {
  const normalized = normalizeConfigStore(config);
  const {
    enabledToolsByServer: existingEnabledToolsByServer,
    discoveredToolsByServer: existingDiscoveredToolsByServer
  } = await getConfigState();
  const sourceEnabledToolsByServer = enabledToolsByServerOverride && typeof enabledToolsByServerOverride === "object"
    ? enabledToolsByServerOverride
    : existingEnabledToolsByServer;
  const sourceDiscoveredToolsByServer = discoveredToolsByServerOverride && typeof discoveredToolsByServerOverride === "object"
    ? discoveredToolsByServerOverride
    : existingDiscoveredToolsByServer;

  const enabledToolsByServer = {};
  const discoveredToolsByServer = {};
  for (const server of normalized.servers) {
    enabledToolsByServer[server.id] = normalizeToolNames(sourceEnabledToolsByServer?.[server.id]);
    discoveredToolsByServer[server.id] = Array.isArray(sourceDiscoveredToolsByServer?.[server.id])
      ? sourceDiscoveredToolsByServer[server.id].map((item) => normalizeToolDescriptor(item)).filter(Boolean)
      : [];
  }

  const result = await setStorage({
    [MCP_CONFIG_STORAGE_KEY]: {
      servers: normalized.servers.map((server) => toStoredServerConfig(server)),
      toolPolicy: normalizeToolPolicy(normalized.toolPolicy),
      updatedAt: Date.now()
    },
    [MCP_ENABLED_TOOLS_STORAGE_KEY]: enabledToolsByServer,
    [MCP_DISCOVERED_TOOLS_STORAGE_KEY]: discoveredToolsByServer
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error || "Failed to persist MCP config"
    };
  }

  return {
    ok: true,
    config: {
      servers: normalized.servers.map((server) => ({
        ...server,
        enabledTools: enabledToolsByServer[server.id] || [],
        tools: discoveredToolsByServer[server.id] || []
      })),
      toolPolicy: normalizeToolPolicy(normalized.toolPolicy),
      updatedAt: Date.now()
    },
    enabledToolsByServer,
    discoveredToolsByServer
  };
}

function buildTransport(server) {
  const headers = normalizeHeaders(server.headers);

  if (server.type === MCP_TRANSPORT_STDIO) {
    throw new Error("stdio type is not supported in browser extension");
  }

  if (!server.url) {
    throw new Error(`invalid URL for server: ${server.id}`);
  }

  if (server.type === MCP_TRANSPORT_SSE) {
    return new SSEClientTransport(new URL(server.url), {
      requestInit: {
        headers
      },
      eventSourceInit: {
        headers
      }
    });
  }

  return new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: {
      headers
    }
  });
}

const LIGHTWEIGHT_SCHEMA_MAX_DEPTH = 8;

function buildSchemaPath(basePath, nextSegment) {
  if (!basePath) return String(nextSegment || "");
  if (!nextSegment) return basePath;
  return `${basePath}.${nextSegment}`;
}

function validatePrimitiveType(value, type) {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return true;
}

function validateBySchema(input, schema, path = "$", depth = 0) {
  if (!schema || typeof schema !== "object") {
    return { valid: true, errorMessage: "" };
  }
  if (depth > LIGHTWEIGHT_SCHEMA_MAX_DEPTH) {
    return { valid: true, errorMessage: "" };
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    for (const subSchema of schema.anyOf) {
      const subResult = validateBySchema(input, subSchema, path, depth + 1);
      if (subResult.valid) {
        return { valid: true, errorMessage: "" };
      }
    }
    return { valid: false, errorMessage: `${path} does not match any schema in anyOf` };
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    let passCount = 0;
    for (const subSchema of schema.oneOf) {
      const subResult = validateBySchema(input, subSchema, path, depth + 1);
      if (subResult.valid) passCount += 1;
      if (passCount > 1) break;
    }
    if (passCount !== 1) {
      return { valid: false, errorMessage: `${path} must match exactly one schema in oneOf` };
    }
    return { valid: true, errorMessage: "" };
  }

  const typeList = Array.isArray(schema.type)
    ? schema.type.filter((item) => typeof item === "string")
    : (typeof schema.type === "string" ? [schema.type] : []);
  if (typeList.length > 0) {
    const matched = typeList.some((type) => validatePrimitiveType(input, type));
    if (!matched) {
      return {
        valid: false,
        errorMessage: `${path} type mismatch, expected ${typeList.join(" | ")}`
      };
    }
  }

  if ((typeList.includes("object") || (!schema.type && schema.properties)) && input && typeof input === "object" && !Array.isArray(input)) {
    const objectValue = input;
    const requiredFields = Array.isArray(schema.required) ? schema.required : [];
    for (const fieldName of requiredFields) {
      if (!Object.prototype.hasOwnProperty.call(objectValue, fieldName)) {
        return {
          valid: false,
          errorMessage: `${buildSchemaPath(path, fieldName)} is required`
        };
      }
    }

    if (schema.properties && typeof schema.properties === "object") {
      for (const [fieldName, fieldSchema] of Object.entries(schema.properties)) {
        if (!Object.prototype.hasOwnProperty.call(objectValue, fieldName)) continue;
        const childResult = validateBySchema(
          objectValue[fieldName],
          fieldSchema,
          buildSchemaPath(path, fieldName),
          depth + 1
        );
        if (!childResult.valid) return childResult;
      }
    }
  }

  if ((typeList.includes("array") || (!schema.type && schema.items)) && Array.isArray(input) && schema.items && typeof schema.items === "object") {
    for (let index = 0; index < input.length; index += 1) {
      const childResult = validateBySchema(input[index], schema.items, `${path}[${index}]`, depth + 1);
      if (!childResult.valid) return childResult;
    }
  }

  return { valid: true, errorMessage: "" };
}

const lightweightJsonSchemaValidator = {
  getValidator(schema) {
    return (input) => {
      const result = validateBySchema(input, schema);
      if (!result.valid) {
        return {
          valid: false,
          data: undefined,
          errorMessage: result.errorMessage || "Schema validation failed"
        };
      }
      return {
        valid: true,
        data: input,
        errorMessage: undefined
      };
    };
  }
};

function createClient() {
  return new Client(
    {
      name: "cursor-toolbox-mcp-client",
      version: "1.0.0"
    },
    {
      capabilities: {},
      jsonSchemaValidator: lightweightJsonSchemaValidator
    }
  );
}

async function closePoolEntry(serverId) {
  const entry = connectionPool.get(serverId);
  if (!entry) return;
  connectionPool.delete(serverId);

  try {
    await entry.transport?.close?.();
  } catch (_error) {
    // noop
  }

  try {
    await entry.client?.close?.();
  } catch (_error) {
    // noop
  }
}

function getServerConnectionSignature(server) {
  const type = normalizeTransport(server?.type, server?.url);
  const url = toSafeString(server?.url);
  const headersJson = JSON.stringify(normalizeHeaders(server?.headers));
  const command = toSafeString(server?.command);
  const argsJson = JSON.stringify(normalizeArgs(server?.args));
  const envJson = JSON.stringify(normalizeEnv(server?.env));
  const cwd = toSafeString(server?.cwd);
  return `${type}|${url}|${headersJson}|${command}|${argsJson}|${envJson}|${cwd}`;
}

async function getPooledClient(server) {
  const existing = connectionPool.get(server.id);
  const now = Date.now();
  const nextSignature = getServerConnectionSignature(server);
  if (existing && existing.signature === nextSignature && now - existing.lastUsedAt < CONNECTION_IDLE_TTL_MS) {
    existing.lastUsedAt = now;
    return existing;
  }

  if (existing) {
    await closePoolEntry(server.id);
  }

  const transport = buildTransport(server);
  const client = createClient();
  await client.connect(transport);

  const entry = {
    serverId: server.id,
    signature: nextSignature,
    transport,
    client,
    lastUsedAt: Date.now()
  };

  connectionPool.set(server.id, entry);
  return entry;
}

function extractToolText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const pieces = [];

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.text === "string" && item.text.trim()) {
      pieces.push(item.text.trim());
      continue;
    }
    if (typeof item.content === "string" && item.content.trim()) {
      pieces.push(item.content.trim());
    }
  }

  return pieces.join("\n\n").trim();
}

function extractNonTextToolContent(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const nonTextItems = [];

  for (const item of content) {
    if (!item || typeof item !== "object") continue;

    const hasTextField = typeof item.text === "string" && item.text.trim().length > 0;
    const type = toSafeString(item.type).toLowerCase();
    const hasLegacyTextField = typeof item.content === "string" && item.content.trim().length > 0;
    const isTextLike = hasTextField || (hasLegacyTextField && (!type || type === "text"));

    if (!isTextLike) {
      nonTextItems.push(item);
    }
  }

  return nonTextItems;
}

function serializeError(error) {
  const message = error?.message ? String(error.message) : String(error || "Unknown error");
  return {
    message,
    name: toSafeString(error?.name) || "Error"
  };
}

function parseToolRef(toolRef) {
  const ref = toSafeString(toolRef);
  if (!ref) return null;

  const slashIndex = ref.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= ref.length - 1) return null;

  return {
    serverId: ref.slice(0, slashIndex),
    toolName: ref.slice(slashIndex + 1)
  };
}

function parseToolArgsStrictJson(rawArgs) {
  const source = String(rawArgs || "").trim();
  if (!source) {
    return {
      ok: true,
      value: {}
    };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(source)
    };
  } catch (error) {
    return {
      ok: false,
      value: null,
      error: serializeError(error).message || "tool arguments must be strict JSON"
    };
  }
}

function escapeRegExp(source) {
  return String(source || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveObjectSchemaForRecovery(schema, depth = 0) {
  if (!schema || typeof schema !== "object") return null;
  if (depth > 6) return null;

  if (schema.properties && typeof schema.properties === "object") {
    return schema;
  }

  const branches = [];
  if (Array.isArray(schema.anyOf)) branches.push(...schema.anyOf);
  if (Array.isArray(schema.oneOf)) branches.push(...schema.oneOf);
  if (Array.isArray(schema.allOf)) branches.push(...schema.allOf);

  for (const branch of branches) {
    const resolved = resolveObjectSchemaForRecovery(branch, depth + 1);
    if (resolved) return resolved;
  }

  return null;
}

function trimRawValueSegment(segment) {
  let output = String(segment || "").trim();
  while (output.endsWith(",")) {
    output = output.slice(0, -1).trimEnd();
  }
  return output;
}

function decodeLenientStringEscapes(text) {
  const source = String(text || "");
  return source
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : _match;
    })
    .replace(/\\(["\\/bfnrt])/g, (_match, flag) => {
      if (flag === "b") return "\b";
      if (flag === "f") return "\f";
      if (flag === "n") return "\n";
      if (flag === "r") return "\r";
      if (flag === "t") return "\t";
      return flag;
    });
}

function parseLenientStringValue(rawValue) {
  let source = trimRawValueSegment(rawValue);
  if (!source) return "";

  const quote = source[0];
  if ((quote === "\"" || quote === "'") && source.length >= 2) {
    source = source.slice(1);
    if (source.endsWith(quote)) {
      source = source.slice(0, -1);
    }
  }

  return decodeLenientStringEscapes(source);
}

function parseValueBySchemaLenient(rawValue, fieldSchema) {
  const cleaned = trimRawValueSegment(rawValue);
  const schemaTypes = getSchemaTypeList(fieldSchema || {});
  const expectsString = schemaTypes.includes("string")
    || (schemaTypes.length === 0 && fieldSchema && typeof fieldSchema === "object"
      && (typeof fieldSchema.pattern === "string"
        || (Array.isArray(fieldSchema.enum) && fieldSchema.enum.every((item) => typeof item === "string"))));

  if (expectsString) {
    return {
      ok: true,
      value: parseLenientStringValue(cleaned)
    };
  }

  if (!cleaned) {
    return {
      ok: true,
      value: ""
    };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(cleaned)
    };
  } catch (_error) {
    // Keep primitive salvage conservative to avoid type confusion.
    if (schemaTypes.includes("boolean")) {
      const lower = cleaned.toLowerCase();
      if (lower === "true") return { ok: true, value: true };
      if (lower === "false") return { ok: true, value: false };
    }

    if (schemaTypes.includes("integer")) {
      const num = Number(cleaned);
      if (Number.isFinite(num) && Number.isInteger(num)) {
        return { ok: true, value: num };
      }
    }

    if (schemaTypes.includes("number")) {
      const num = Number(cleaned);
      if (Number.isFinite(num)) {
        return { ok: true, value: num };
      }
    }

    return {
      ok: false,
      value: null
    };
  }
}

function findFieldMarkerInRawArgs(rawArgs, fieldName, fromIndex = 0) {
  const source = String(rawArgs || "");
  const escaped = escapeRegExp(fieldName);
  if (!escaped) return null;

  const quotedRe = new RegExp(`["']${escaped}["']\\s*:`, "ig");
  quotedRe.lastIndex = Math.max(0, fromIndex);
  const quotedMatch = quotedRe.exec(source);
  if (quotedMatch) {
    return {
      startIndex: quotedMatch.index,
      valueStartIndex: quotedMatch.index + quotedMatch[0].length
    };
  }

  const bareRe = new RegExp(`\\b${escaped}\\b\\s*:`, "ig");
  bareRe.lastIndex = Math.max(0, fromIndex);
  const bareMatch = bareRe.exec(source);
  if (bareMatch) {
    return {
      startIndex: bareMatch.index,
      valueStartIndex: bareMatch.index + bareMatch[0].length
    };
  }

  return null;
}

function tryRecoverArgsFromRawBySchema(rawArgs, inputSchema) {
  const source = String(rawArgs || "").trim();
  if (!source) {
    return {
      ok: false,
      value: null
    };
  }

  const objectSchema = resolveObjectSchemaForRecovery(inputSchema);
  if (!objectSchema || !objectSchema.properties || typeof objectSchema.properties !== "object") {
    return {
      ok: false,
      value: null
    };
  }

  const properties = objectSchema.properties;
  const required = Array.isArray(objectSchema.required)
    ? objectSchema.required.filter((item) => typeof item === "string")
    : [];
  const names = [...required, ...Object.keys(properties)]
    .filter((item, index, arr) => arr.indexOf(item) === index);
  if (names.length === 0) {
    return {
      ok: false,
      value: null
    };
  }

  const markers = [];
  for (const name of names) {
    const marker = findFieldMarkerInRawArgs(source, name, 0);
    if (!marker) continue;
    markers.push({
      name,
      ...marker
    });
  }
  if (markers.length === 0) {
    return {
      ok: false,
      value: null
    };
  }

  markers.sort((left, right) => left.startIndex - right.startIndex);
  const objectEndIndex = (() => {
    const idx = source.lastIndexOf("}");
    return idx >= 0 ? idx : source.length;
  })();

  const recovered = {};
  for (let i = 0; i < markers.length; i += 1) {
    const current = markers[i];
    const next = markers[i + 1] || null;
    const segmentEnd = next ? next.startIndex : objectEndIndex;
    if (segmentEnd <= current.valueStartIndex) continue;
    const segment = source.slice(current.valueStartIndex, segmentEnd);
    const parsed = parseValueBySchemaLenient(segment, properties[current.name]);
    if (!parsed.ok) continue;
    recovered[current.name] = parsed.value;
  }

  if (Object.keys(recovered).length === 0) {
    return {
      ok: false,
      value: null
    };
  }

  if (required.length > 0) {
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(recovered, key)) {
        return {
          ok: false,
          value: null
        };
      }
    }
  }

  return {
    ok: true,
    value: recovered
  };
}

function parseToolCodeTemplate(code) {
  const source = String(code || "").trim();
  if (!source) {
    return {
      ok: false,
      error: "tool_code is empty"
    };
  }

  const callMatch = source.match(/^\s*await\s+mcp\.call\(\s*(["'])([^"']+)\1\s*,\s*([\s\S]+?)\s*\)\s*;?\s*$/);
  if (!callMatch) {
    return {
      ok: false,
      error: "tool_code format invalid. Expected: await mcp.call(\"serverId/toolName\", { ...json })"
    };
  }

  const ref = parseToolRef(callMatch[2]);
  if (!ref) {
    return {
      ok: false,
      error: "tool reference must be serverId/toolName"
    };
  }

  const argsRaw = String(callMatch[3] || "").trim();
  const parsedArgs = parseToolArgsStrictJson(argsRaw);

  return {
    ok: true,
    serverId: ref.serverId,
    toolName: ref.toolName,
    toolRef: `${ref.serverId}/${ref.toolName}`,
    args: parsedArgs.ok ? parsedArgs.value : null,
    argsRaw,
    argsParseError: parsedArgs.ok ? "" : parsedArgs.error
  };
}

function getToolInputSchema(server, toolName) {
  if (!server || typeof server !== "object") return null;
  if (!Array.isArray(server.tools)) return null;
  const descriptor = server.tools.find((item) => toSafeString(item?.name) === toSafeString(toolName));
  if (!descriptor || typeof descriptor !== "object") return null;
  return descriptor.inputSchema && typeof descriptor.inputSchema === "object"
    ? descriptor.inputSchema
    : null;
}

function getSchemaTypeList(schema) {
  if (!schema || typeof schema !== "object") return [];
  const direct = Array.isArray(schema.type)
    ? schema.type.filter((item) => typeof item === "string")
    : (typeof schema.type === "string" ? [schema.type] : []);
  if (direct.length > 0) return direct;
  if (schema.properties && typeof schema.properties === "object") return ["object"];
  if (schema.items && typeof schema.items === "object") return ["array"];
  return [];
}

function coercePrimitiveForSchemaType(value, type) {
  if (type === "string") {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";
    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch (_error) {
        return String(value);
      }
    }
    return String(value);
  }
  if (type === "integer") {
    if (Number.isInteger(value)) return value;
    const fromString = typeof value === "string" ? Number(value.trim()) : Number(value);
    if (Number.isFinite(fromString) && Number.isInteger(fromString)) return fromString;
    return value;
  }
  if (type === "number") {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const fromString = typeof value === "string" ? Number(value.trim()) : Number(value);
    if (Number.isFinite(fromString)) return fromString;
    return value;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
      if (normalized === "false" || normalized === "0" || normalized === "no") return false;
    }
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
    }
    return value;
  }
  return value;
}

function coerceArgsBySchema(input, schema, depth = 0) {
  if (!schema || typeof schema !== "object") return input;
  if (depth > LIGHTWEIGHT_SCHEMA_MAX_DEPTH) return input;

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    for (const subSchema of schema.anyOf) {
      const candidate = coerceArgsBySchema(input, subSchema, depth + 1);
      if (validateBySchema(candidate, subSchema, "$", depth + 1).valid) return candidate;
    }
    return input;
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    for (const subSchema of schema.oneOf) {
      const candidate = coerceArgsBySchema(input, subSchema, depth + 1);
      if (validateBySchema(candidate, subSchema, "$", depth + 1).valid) return candidate;
    }
    return input;
  }

  const typeList = getSchemaTypeList(schema);
  if ((typeList.includes("object") || (!schema.type && schema.properties))
      && input && typeof input === "object" && !Array.isArray(input)) {
    if (!schema.properties || typeof schema.properties !== "object") {
      return input;
    }
    const output = { ...input };
    for (const [fieldName, fieldSchema] of Object.entries(schema.properties)) {
      if (!Object.prototype.hasOwnProperty.call(output, fieldName)) continue;
      output[fieldName] = coerceArgsBySchema(output[fieldName], fieldSchema, depth + 1);
    }
    return output;
  }

  if ((typeList.includes("array") || (!schema.type && schema.items))
      && Array.isArray(input)
      && schema.items
      && typeof schema.items === "object") {
    return input.map((item) => coerceArgsBySchema(item, schema.items, depth + 1));
  }

  if (typeList.length > 0) {
    for (const type of typeList) {
      const candidate = coercePrimitiveForSchemaType(input, type);
      if (validatePrimitiveType(candidate, type)) return candidate;
    }
  }

  return input;
}

function wrapPrimitiveArgsBySchema(value, schema) {
  const sourceSchema = schema && typeof schema === "object" ? schema : null;
  const schemaTypes = getSchemaTypeList(sourceSchema || {});
  const expectsObject = sourceSchema
    && (schemaTypes.includes("object") || (!sourceSchema.type && sourceSchema.properties));

  if (!expectsObject) {
    return {
      input: typeof value === "string" ? value : String(value ?? "")
    };
  }

  const properties = sourceSchema.properties && typeof sourceSchema.properties === "object"
    ? sourceSchema.properties
    : {};
  const propertyNames = Object.keys(properties);
  if (propertyNames.length === 0) {
    return {
      input: typeof value === "string" ? value : String(value ?? "")
    };
  }

  if (propertyNames.length === 1) {
    return {
      [propertyNames[0]]: value
    };
  }

  const required = Array.isArray(sourceSchema.required)
    ? sourceSchema.required.filter((item) => typeof item === "string")
    : [];
  const preferred = ["input", "text", "content", "query", "prompt", "message", "path", "value", "data", "code"];
  const ordered = [...required, ...preferred, ...propertyNames];
  const picked = ordered.find((key, index) => ordered.indexOf(key) === index && propertyNames.includes(key));
  if (!picked) {
    return {
      [propertyNames[0]]: value
    };
  }
  return {
    [picked]: value
  };
}

function resolveToolArguments(parsed, inputSchema) {
  let argsValue = parsed?.args;
  if ((argsValue === null || argsValue === undefined) && parsed?.argsParseError) {
    const recovered = tryRecoverArgsFromRawBySchema(parsed?.argsRaw, inputSchema);
    if (recovered.ok) {
      argsValue = recovered.value;
      try {
        console.warn(`[MCP] recovered tool args from malformed JSON for ${toSafeString(parsed?.toolRef) || "unknown"}`);
      } catch (_error) {
        // noop
      }
    }
  }
  if (argsValue === null || argsValue === undefined) {
    const raw = String(parsed?.argsRaw || "").trim();
    if (!raw) {
      argsValue = {};
    } else {
      argsValue = wrapPrimitiveArgsBySchema(raw, inputSchema);
    }
  }

  if (argsValue === null || argsValue === undefined) {
    return {
      ok: false,
      error: parsed?.argsParseError || "tool arguments parse failed"
    };
  }

  if (!argsValue || typeof argsValue !== "object" || Array.isArray(argsValue)) {
    argsValue = wrapPrimitiveArgsBySchema(argsValue, inputSchema);
  }

  if (inputSchema && typeof inputSchema === "object") {
    argsValue = coerceArgsBySchema(argsValue, inputSchema, 0);
    const validation = validateBySchema(argsValue, inputSchema);
    if (!validation.valid) {
      return {
        ok: false,
        error: `tool arguments schema mismatch: ${validation.errorMessage || "invalid input"}`
      };
    }
  }

  if (!argsValue || typeof argsValue !== "object" || Array.isArray(argsValue)) {
    return {
      ok: false,
      error: "tool arguments must resolve to a JSON object"
    };
  }

  return {
    ok: true,
    args: argsValue
  };
}

function findServer(config, serverId) {
  return config.servers.find((server) => server.id === serverId) || null;
}

function getServerConfigError(server) {
  if (!server || !toSafeString(server.id)) {
    return "Invalid MCP server config";
  }

  const type = normalizeTransport(server.type, server.url);
  if (type === MCP_TRANSPORT_STDIO) {
    return "stdio type is not supported in browser extension";
  }

  if (type !== MCP_TRANSPORT_STREAMABLE_HTTP && type !== MCP_TRANSPORT_SSE) {
    return `Unsupported type: ${type}`;
  }

  if (!server.url) {
    return `Invalid server URL for: ${server.id}`;
  }

  return "";
}

function isEnabledTool(server, enabledToolsByServer, toolName) {
  const external = normalizeToolNames(enabledToolsByServer?.[server.id]);
  const source = external.length > 0 ? external : normalizeToolNames(server.enabledTools);
  return source.includes(toolName);
}

async function discoverServerTools(server) {
  const error = getServerConfigError(server);
  if (error) {
    return {
      ok: false,
      error
    };
  }

  try {
    const entry = await getPooledClient(server);
    const toolsResult = await entry.client.listTools();
    entry.lastUsedAt = Date.now();

    const tools = Array.isArray(toolsResult?.tools)
      ? toolsResult.tools.map(normalizeToolDescriptor).filter(Boolean)
      : [];

    return {
      ok: true,
      serverId: server.id,
      tools
    };
  } catch (error) {
    return {
      ok: false,
      error: serializeError(error).message
    };
  }
}

function normalizeOperationId(rawOperationId) {
  const input = toSafeString(rawOperationId);
  if (!input) {
    return `mcp-op-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }
  if (input.length > 96) return input.slice(0, 96);
  return input;
}

function isTimeoutLikeError(message, name) {
  const source = `${toSafeString(name)} ${toSafeString(message)}`.toLowerCase();
  if (!source) return false;
  return source.includes("requesttimeout")
    || source.includes("timed out")
    || source.includes("timeout");
}

function isAbortLikeError(message, name) {
  const source = `${toSafeString(name)} ${toSafeString(message)}`.toLowerCase();
  if (!source) return false;
  return source.includes("abort")
    || source.includes("cancel")
    || source.includes("aborted")
    || source.includes("cancelled");
}

function buildToolResultPayload(raw) {
  const payload = {
    text: extractToolText(raw),
    isError: Boolean(raw?.isError)
  };

  const nonTextContent = extractNonTextToolContent(raw);
  if (nonTextContent.length > 0) {
    payload.content = nonTextContent;
  }

  if (raw?.structuredContent !== undefined && raw?.structuredContent !== null) {
    const structured = raw.structuredContent;
    if (structured && typeof structured === "object" && !Array.isArray(structured)) {
      const { content: _omittedContent, ...restStructured } = structured;
      if (Object.keys(restStructured).length > 0) {
        payload.structuredContent = restStructured;
      }
    } else {
      payload.structuredContent = structured;
    }
  }

  return payload;
}

async function executeToolCode(request) {
  const parsed = parseToolCodeTemplate(request?.code);
  if (!parsed.ok) {
    return {
      ok: false,
      toolRef: "",
      error: parsed.error,
      raw: null
    };
  }

  const operationId = normalizeOperationId(request?.operationId);
  if (inflightToolExecutions.has(operationId)) {
    return {
      ok: false,
      operationId,
      toolRef: parsed.toolRef,
      error: `Duplicate operationId: ${operationId}`,
      raw: null
    };
  }

  const { config, enabledToolsByServer } = await getConfigState();
  const toolPolicy = normalizeToolPolicy(config.toolPolicy);
  const server = findServer(config, parsed.serverId);
  if (!server) {
    return {
      ok: false,
      operationId,
      toolRef: parsed.toolRef,
      error: `MCP server not found: ${parsed.serverId}`,
      raw: null
    };
  }

  const serverConfigError = getServerConfigError(server);
  if (serverConfigError) {
    return {
      ok: false,
      operationId,
      toolRef: parsed.toolRef,
      error: serverConfigError,
      raw: null
    };
  }

  if (!isEnabledTool(server, enabledToolsByServer, parsed.toolName)) {
    return {
      ok: false,
      operationId,
      toolRef: parsed.toolRef,
      error: `Tool is not enabled: ${parsed.toolName}`,
      raw: null
    };
  }

  const inputSchema = getToolInputSchema(server, parsed.toolName);
  const resolvedArgs = resolveToolArguments(parsed, inputSchema);
  if (!resolvedArgs.ok) {
    return {
      ok: false,
      operationId,
      toolRef: parsed.toolRef,
      error: resolvedArgs.error || "Invalid tool arguments",
      raw: null
    };
  }

  const executionEntry = {
    operationId,
    serverId: server.id,
    toolRef: parsed.toolRef,
    abortController: new AbortController(),
    startedAt: Date.now()
  };
  inflightToolExecutions.set(operationId, executionEntry);

  const maxAttempts = Math.max(1, toolPolicy.maxRetries + 1);
  let lastErrorMessage = "";
  let lastTimeout = false;
  let attempt = 0;
  try {
    for (attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (executionEntry.abortController.signal.aborted) {
        return {
          ok: false,
          cancelled: true,
          operationId,
          toolRef: parsed.toolRef,
          error: "Tool call cancelled by user",
          raw: null,
          attempt,
          maxAttempts
        };
      }

      try {
        const entry = await getPooledClient(server);
        const raw = await entry.client.callTool(
          {
            name: parsed.toolName,
            arguments: resolvedArgs.args
          },
          undefined,
          {
            signal: executionEntry.abortController.signal,
            timeout: toolPolicy.timeoutMs
          }
        );
        entry.lastUsedAt = Date.now();

        if (raw?.isError) {
          lastTimeout = false;
          lastErrorMessage = extractToolText(raw) || "Tool returned error";
          if (attempt < maxAttempts) continue;
          return {
            ok: false,
            operationId,
            toolRef: parsed.toolRef,
            data: buildToolResultPayload(raw),
            error: `Tool returned error after ${maxAttempts} attempts: ${lastErrorMessage}`,
            raw,
            attempt,
            maxAttempts
          };
        }

        return {
          ok: true,
          operationId,
          toolRef: parsed.toolRef,
          data: buildToolResultPayload(raw),
          error: "",
          raw,
          attempt,
          maxAttempts
        };
      } catch (error) {
        const normalized = serializeError(error);
        lastErrorMessage = normalized.message;
        const aborted = executionEntry.abortController.signal.aborted || isAbortLikeError(normalized.message, normalized.name);
        if (aborted) {
          return {
            ok: false,
            cancelled: true,
            operationId,
            toolRef: parsed.toolRef,
            error: "Tool call cancelled by user",
            raw: null,
            attempt,
            maxAttempts
          };
        }
        lastTimeout = isTimeoutLikeError(normalized.message, normalized.name);
        if (attempt >= maxAttempts) break;
      }
    }

    const timeoutHint = lastTimeout ? " (timeout reached)" : "";
    return {
      ok: false,
      operationId,
      toolRef: parsed.toolRef,
      error: `Tool execution failed after ${maxAttempts} attempts${timeoutHint}: ${lastErrorMessage || "Unknown error"}`,
      raw: null,
      attempt: Math.min(attempt, maxAttempts),
      maxAttempts,
      timedOut: lastTimeout
    };
  } finally {
    inflightToolExecutions.delete(operationId);
  }
}

async function cancelToolExecution(request) {
  const requestOperationId = toSafeString(request?.operationId);
  if (!requestOperationId) {
    return {
      ok: false,
      operationId: "",
      error: "Missing operationId"
    };
  }
  const operationId = normalizeOperationId(requestOperationId);
  const target = inflightToolExecutions.get(operationId);
  if (!target) {
    return {
      ok: false,
      operationId,
      error: "No in-flight tool execution found"
    };
  }

  if (!target.abortController.signal.aborted) {
    target.abortController.abort("Cancelled by user");
  }
  if (target.serverId) {
    void closePoolEntry(target.serverId);
  }

  return {
    ok: true,
    operationId,
    toolRef: target.toolRef,
    cancelled: true
  };
}

async function handleConfigSave(message) {
  const normalized = normalizeConfigStore(message?.config);
  const prevState = await getConfigState();
  const invalidServer = normalized.servers.find((server) => {
    const type = normalizeTransport(server.type, server.url);
    if (type === MCP_TRANSPORT_STDIO) {
      return !server.command;
    }
    return !server.url;
  });

  if (invalidServer) {
    if (normalizeTransport(invalidServer.type, invalidServer.url) === MCP_TRANSPORT_STDIO) {
      return {
        ok: false,
        error: `Missing command for stdio server: ${invalidServer.id}`
      };
    }
    return {
      ok: false,
      error: `Invalid server URL for: ${invalidServer.id}`
    };
  }

  const nextDiscoveredToolsByServer = {
    ...prevState.discoveredToolsByServer
  };

  for (const server of normalized.servers) {
    const previousServer = findServer(prevState.config, server.id);
    if (!previousServer) continue;
    if (getServerConnectionSignature(previousServer) === getServerConnectionSignature(server)) continue;
    nextDiscoveredToolsByServer[server.id] = [];
  }

  return persistConfigState(
    normalized,
    prevState.enabledToolsByServer,
    nextDiscoveredToolsByServer
  );
}

async function handleToolsSetEnabled(message) {
  const serverId = toSafeString(message?.serverId);
  if (!serverId) {
    return {
      ok: false,
      error: "Missing serverId"
    };
  }

  const enabledTools = normalizeToolNames(message?.enabledTools);
  const { config, enabledToolsByServer } = await getConfigState();
  const targetServer = findServer(config, serverId);
  if (!targetServer) {
    return {
      ok: false,
      error: `Server not found: ${serverId}`
    };
  }

  enabledToolsByServer[serverId] = enabledTools;
  const nextServers = config.servers.map((server) => {
    if (server.id !== serverId) return server;
    return {
      ...server,
      enabledTools
    };
  });

  return persistConfigState({
    servers: nextServers,
    toolPolicy: normalizeToolPolicy(config.toolPolicy),
    updatedAt: Date.now()
  }, enabledToolsByServer);
}

async function handleToolsDiscover(message) {
  const inlineServer = message?.server && typeof message.server === "object"
    ? normalizeServerConfig(message.server, 0)
    : null;

  if (inlineServer) {
    const discovered = await discoverServerTools(inlineServer);
    if (!discovered.ok) return discovered;

    const { config, enabledToolsByServer, discoveredToolsByServer } = await getConfigState();
    discoveredToolsByServer[inlineServer.id] = Array.isArray(discovered.tools) ? discovered.tools : [];
    const persisted = await persistConfigState(config, enabledToolsByServer, discoveredToolsByServer);
    if (!persisted.ok) {
      return {
        ok: false,
        error: persisted.error || "Failed to persist discovered tools"
      };
    }
    return discovered;
  }

  const serverId = toSafeString(message?.serverId);
  if (!serverId) {
    return {
      ok: false,
      error: "Missing server config or serverId"
    };
  }

  const { config } = await getConfigState();
  const server = findServer(config, serverId);
  if (!server) {
    return {
      ok: false,
      error: `Server not found: ${serverId}`
    };
  }

  const discovered = await discoverServerTools(server);
  if (!discovered.ok) return discovered;

  const stateAfterDiscover = await getConfigState();
  stateAfterDiscover.discoveredToolsByServer[server.id] = Array.isArray(discovered.tools) ? discovered.tools : [];
  const persisted = await persistConfigState(
    stateAfterDiscover.config,
    stateAfterDiscover.enabledToolsByServer,
    stateAfterDiscover.discoveredToolsByServer
  );
  if (!persisted.ok) {
    return {
      ok: false,
      error: persisted.error || "Failed to persist discovered tools"
    };
  }
  return discovered;
}

async function handleLegacyTest(config) {
  if (!config || !config.baseUrl) {
    return {
      success: false,
      error: "Missing baseUrl"
    };
  }

  const server = normalizeServerConfig({
    id: "legacy-test",
    name: "legacy-test",
    url: config.baseUrl,
    headers: config.headers || {}
  }, 0);

  const result = await discoverServerTools(server);
  if (!result.ok) {
    return {
      success: false,
      error: result.error
    };
  }

  return {
    success: true,
    tools: result.tools
  };
}

function reloadTab(tabId, bypassCache) {
  return new Promise((resolve, reject) => {
    chrome.tabs.reload(tabId, { bypassCache }, () => {
      if (chrome.runtime?.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function handleMessage(message, sender) {
  if (message?.action === "test_mcp") {
    return handleLegacyTest(message.config);
  }

  switch (message?.type) {
    case "MCP_CONFIG_GET": {
      const state = await getConfigState();
      return {
        ok: true,
        config: state.config,
        enabledToolsByServer: state.enabledToolsByServer
      };
    }

    case "MCP_CONFIG_SAVE":
      return handleConfigSave(message);

    case "MCP_TOOLS_DISCOVER":
      return handleToolsDiscover(message);

    case "MCP_TOOLS_SET_ENABLED":
      return handleToolsSetEnabled(message);

    case "MCP_TOOLCODE_EXECUTE":
      return executeToolCode(message);

    case "MCP_TOOLCODE_CANCEL":
      return cancelToolExecution(message);

    case "TAB_FORCE_RELOAD": {
      const tabId = sender?.tab?.id;
      if (!Number.isInteger(tabId)) {
        return {
          ok: false,
          error: "No sender tab available for force reload."
        };
      }
      const bypassCache = message?.bypassCache !== false;
      await reloadTab(tabId, bypassCache);
      return {
        ok: true
      };
    }

    default:
      return {
        ok: false,
        error: `Unsupported message type: ${toSafeString(message?.type) || "unknown"}`
      };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => {
      sendResponse(response);
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: serializeError(error).message
      });
    });

  return true;
});

if (typeof setInterval === "function") {
  setInterval(() => {
    const now = Date.now();
    for (const [serverId, entry] of connectionPool.entries()) {
      if (now - entry.lastUsedAt <= CONNECTION_IDLE_TTL_MS) continue;
      void closePoolEntry(serverId);
    }
  }, CONNECTION_SWEEP_INTERVAL_MS);
}
