// Bridge core: MCP config normalization, page bridge, and shared helpers

'use strict';

const MCP_PANEL_TAB_CONFIG = 'config';
const MCP_PANEL_TAB_TOOLS = 'tools';
const MCP_TRANSPORT_STREAMABLE_HTTP = 'streamable-http';
const MCP_TRANSPORT_SSE = 'sse';
const MCP_TRANSPORT_STDIO = 'stdio';
const MCP_URL_FALLBACK_PLACEHOLDER = 'xxxxxx';
const TM_FAB_MCP_TOOL_RESULT_PREFIX = '[MCP_TOOL_RESULT]';
const MCP_CONFIG_DEFAULT_TEXT = [
  '{',
  '  "mcpServers": {}',
  '}',
].join('\n');
const MCP_CONFIG_PLACEHOLDER_TEXT = [
  '{',
  '  "mcpServers": {',
  '    "my-http-server": {',
  '      "name": "My HTTP Server",',
  '      "type": "streamable-http",',
  '      "url": "https://example.com/mcp",',
  '      "headers": { "Authorization": "Bearer <token>" },',
  '      "command": "",',
  '      "args": [],',
  '      "cwd": "",',
  '      "env": {}',
  '    }',
  '  }',
  '}',
].join('\n');
let mcpPanelViewportListenersBound = false;

function normalizeMcpTransport(rawTransport, fallbackUrl = '') {
  const source = toSafeString(rawTransport).toLowerCase();
  if (source === 'streamable-http' || source === 'streamable_http' || source === 'http') {
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

function normalizeMcpArgs(rawArgs) {
  if (!Array.isArray(rawArgs)) return [];
  return rawArgs.map((item) => toSafeString(item)).filter(Boolean);
}

function normalizeMcpEnv(rawEnv) {
  if (!rawEnv || typeof rawEnv !== 'object') return {};
  const env = {};
  Object.entries(rawEnv).forEach(([rawKey, rawValue]) => {
    const key = toSafeString(rawKey);
    if (!key) return;
    const value = toSafeString(rawValue);
    if (!value) return;
    env[key] = value;
  });
  return env;
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

function normalizeMcpToolPolicy(rawPolicy) {
  const source = rawPolicy && typeof rawPolicy === 'object' ? rawPolicy : {};
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

function handleMcpPanelViewportChange() {
  if (!state.mcpPanelOpen) return;
  const panel = getMcpPanelElement();
  if (panel) repositionMcpPanel(panel);
}

function bindMcpPanelViewportListeners() {
  if (mcpPanelViewportListenersBound) return;
  mcpPanelViewportListenersBound = true;
  window.addEventListener('resize', handleMcpPanelViewportChange, { passive: true });
  window.addEventListener('scroll', handleMcpPanelViewportChange, true);
}

function postToPage(type, payload) {
  window.postMessage({ source: BRIDGE_SOURCE_CONTENT, type, payload }, window.location.origin);
}

function syncEnabledStateToPage() {
  if (!state.pageHookReady) return;
  postToPage('CONTENT_SET_ENABLED', { enabled: isPluginEnabled });
}

function syncThinkingInjectionStateToPage() {
  if (!state.pageHookReady) return;
  postToPage('CONTENT_SET_THINKING_INJECTION', { enabled: isThinkingInjectionEnabled });
}

function syncGlobalPromptInstructionStateToPage() {
  if (!state.pageHookReady) return;
  postToPage('CONTENT_SET_GLOBAL_PROMPT_INSTRUCTION', { text: globalPromptInstruction });
}

function sendRuntimeMessage(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime?.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message
        });
        return;
      }
      resolve(response || { ok: false, error: 'Empty background response' });
    });
  });
}

function toSafeString(value) {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function getObjectValueByAliasesCaseInsensitive(source, aliases = []) {
  if (!source || typeof source !== 'object' || !Array.isArray(aliases) || aliases.length === 0) {
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

function escapeHtmlText(value) {
  return toSafeString(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeMcpTool(tool) {
  if (!tool || typeof tool !== 'object') return null;
  const name = toSafeString(tool.name);
  if (!name) return null;
  return {
    name,
    description: toSafeString(tool.description),
    inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {}
  };
}

function normalizeMcpServer(server, index = 0) {
  const fallbackId = `server-${index + 1}`;
  const id = toSafeString(server?.id) || fallbackId;
  const name = toSafeString(server?.name) || id;
  const rawUrl = getObjectValueByAliasesCaseInsensitive(server, ['url', 'baseUrl']);
  const url = toSafeString(rawUrl);
  const rawTransport = getObjectValueByAliasesCaseInsensitive(server, ['type', 'transport']);
  // 同时支持 type 和 transport 输入，内部统一使用 type
  let type = normalizeMcpTransport(rawTransport, url);
  const command = toSafeString(server?.command);
  const args = normalizeMcpArgs(server?.args);
  const env = normalizeMcpEnv(server?.env);
  const cwd = toSafeString(server?.cwd);
  if (!toSafeString(rawTransport) && !url && command) {
    type = MCP_TRANSPORT_STDIO;
  }

  const headers = {};
  if (server?.headers && typeof server.headers === 'object') {
    Object.entries(server.headers).forEach(([rawKey, rawValue]) => {
      const key = toSafeString(rawKey);
      const value = toSafeString(rawValue);
      if (!key || !value) return;
      headers[key] = value;
    });
  }

  const enabledTools = Array.isArray(server?.enabledTools)
    ? server.enabledTools.map((item) => toSafeString(item)).filter(Boolean)
    : [];
  const seen = new Set();
  const dedupedEnabledTools = [];
  enabledTools.forEach((nameItem) => {
    if (seen.has(nameItem)) return;
    seen.add(nameItem);
    dedupedEnabledTools.push(nameItem);
  });

  const tools = Array.isArray(server?.tools)
    ? server.tools.map(normalizeMcpTool).filter(Boolean)
    : [];

  return {
    id,
    name,
    type,
    url,
    command,
    args,
    env,
    cwd,
    headers,
    enabledTools: dedupedEnabledTools,
    tools
  };
}

function normalizeMcpServersMap(rawMap) {
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
    return [];
  }

  return Object.entries(rawMap).map(([serverId, serverValue]) => ({
    ...(serverValue && typeof serverValue === 'object' ? serverValue : {}),
    // For object-style mcpServers config, the outer key is the canonical server id.
    // This avoids copied snippets with stale inner ids being silently deduped away.
    id: toSafeString(serverId) || toSafeString(serverValue?.id) || undefined,
    name: toSafeString(serverValue?.name) || toSafeString(serverId) || toSafeString(serverValue?.id) || undefined
  }));
}

function normalizeMcpServersInput(rawConfig) {
  const rawServers = getObjectValueByAliasesCaseInsensitive(rawConfig, ['servers']);
  if (Array.isArray(rawServers)) {
    return rawServers;
  }
  const mappedServers = normalizeMcpServersMap(rawServers);
  if (mappedServers.length > 0) {
    return mappedServers;
  }

  const rawMcpServers = getObjectValueByAliasesCaseInsensitive(rawConfig, [
    'mcpServers',
    'mcp_servers',
    'mcpservers'
  ]);
  if (Array.isArray(rawMcpServers)) {
    return rawMcpServers;
  }
  const mappedMcpServers = normalizeMcpServersMap(rawMcpServers);
  if (mappedMcpServers.length > 0) {
    return mappedMcpServers;
  }

  return [];
}

function normalizeMcpConfig(rawConfig) {
  const servers = normalizeMcpServersInput(rawConfig).map((item, index) => normalizeMcpServer(item, index));

  const seen = new Set();
  const deduped = [];
  servers.forEach((server) => {
    if (!server.id || seen.has(server.id)) return;
    seen.add(server.id);
    deduped.push(server);
  });

  return {
    servers: deduped,
    toolPolicy: normalizeMcpToolPolicy(rawConfig?.toolPolicy),
    updatedAt: Number.isFinite(rawConfig?.updatedAt) ? rawConfig.updatedAt : Date.now()
  };
}

function syncMcpStateToPage() {
  if (!state.pageHookReady) return;

  const enabledToolSchemas = [];
  state.mcpConfig.servers.forEach((server) => {
    if (!Array.isArray(server.tools) || server.tools.length === 0) return;
    const enabled = Array.isArray(server.enabledTools) ? server.enabledTools : [];
    server.tools.forEach((tool) => {
      if (!enabled.includes(tool.name)) return;
      enabledToolSchemas.push({
        serverId: server.id,
        serverName: server.name,
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {}
      });
    });
  });

  postToPage('CONTENT_SYNC_MCP_STATE', {
    enabledTools: enabledToolSchemas
  });
}

function resetMcpRuntimeState() {
  state.mcpAutoRoundCount = 0;
  state.mcpAutoInFlight = false;
  state.mcpPendingExecutionPayload = null;
  state.mcpPendingExecutionFingerprint = '';
  state.mcpLastToolHash = '';
  state.mcpLastToolSessionKey = '';
  state.mcpLastToolExecutedAt = 0;
  state.mcpMergedToolTriggerLastFingerprint = '';
  state.mcpMergedToolTriggerLastAt = 0;
  state.mcpLastToolEventFingerprint = '';
  state.mcpLastToolEventAt = 0;
  state.mcpToolFormatRetryLastFingerprint = '';
  state.mcpToolFormatRetryLastAt = 0;
  state.mcpToolFormatRetryInFlightFingerprint = '';
  state.mcpToolFormatRetryInFlightPromise = null;
  state.mcpToolRunCancelNoticeSent = false;
  state.mcpToolRunCancelNoticeOperationId = '';
  state.mcpToolRunCancelRequestedOperationId = '';
  state.mcpToolRunCancelNoticeInFlightOperationId = '';
  state.mcpToolRunCancelNoticePromise = null;
  stopMcpToolRunUi();
}

async function refreshMcpConfigFromBackground() {
  const response = await sendRuntimeMessage({ type: 'MCP_CONFIG_GET' });
  if (!response?.ok) return false;

  state.mcpConfig = normalizeMcpConfig(response.config);
  if (response.enabledToolsByServer && typeof response.enabledToolsByServer === 'object') {
    state.mcpEnabledToolsByServer = response.enabledToolsByServer;
  } else {
    state.mcpEnabledToolsByServer = {};
  }

  const nextToolFetchStateByServer = {};
  for (const server of state.mcpConfig.servers) {
    const external = Array.isArray(state.mcpEnabledToolsByServer[server.id])
      ? state.mcpEnabledToolsByServer[server.id].map((item) => toSafeString(item)).filter(Boolean)
      : [];
    if (external.length > 0) {
      server.enabledTools = external;
    }

    const previousMeta = state.mcpDiscoveredToolsByServer?.[server.id];
    if (Array.isArray(server.tools) && server.tools.length > 0) {
      nextToolFetchStateByServer[server.id] = {
        ok: true,
        error: '',
        fetchedAt: Number.isFinite(previousMeta?.fetchedAt) ? previousMeta.fetchedAt : Date.now(),
        toolCount: server.tools.length
      };
    } else if (previousMeta && previousMeta.ok === false) {
      nextToolFetchStateByServer[server.id] = previousMeta;
    }
  }
  state.mcpDiscoveredToolsByServer = nextToolFetchStateByServer;

  syncMcpStateToPage();
  updateMcpButtonState();
  if (state.mcpPanelOpen) {
    renderMcpPanel();
  }

  return true;
}

function persistThinkingInjectionEnabled() {
  chrome.storage.local.set({ [THINKING_INJECTION_STORAGE_KEY]: isThinkingInjectionEnabled });
}

function setThinkingInjectionEnabled(nextEnabled, { persist = true, sync = true } = {}) {
  const normalized = nextEnabled !== false;
  const changed = isThinkingInjectionEnabled !== normalized;
  isThinkingInjectionEnabled = normalized;

  updateThinkingToggleUi();
  if (changed && persist) {
    persistThinkingInjectionEnabled();
  }
  if (sync) {
    syncThinkingInjectionStateToPage();
  }
}

function persistGlobalPromptInstruction() {
  chrome.storage.local.set({ [GLOBAL_PROMPT_INSTRUCTION_STORAGE_KEY]: globalPromptInstruction });
}

function normalizeGlobalPromptInstructionText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n').trim();
}

function setGlobalPromptInstruction(nextText, { persist = true, sync = true } = {}) {
  const normalized = normalizeGlobalPromptInstructionText(nextText);
  const changed = globalPromptInstruction !== normalized;
  globalPromptInstruction = normalized;

  if (typeof updateGlobalPromptUi === 'function') {
    updateGlobalPromptUi();
  }
  if (changed && persist) {
    persistGlobalPromptInstruction();
  }
  if (sync) {
    syncGlobalPromptInstructionStateToPage();
  }
}

function injectPageHookScript() {
  if (document.getElementById('cursor-toolbox-page-hook-script')) return;

  const script = document.createElement('script');
  script.id = 'cursor-toolbox-page-hook-script';
  script.src = chrome.runtime.getURL('src/injected/page-hook.js');
  script.async = false;
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}
