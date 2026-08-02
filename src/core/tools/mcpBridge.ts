/**
 * MCP Bridge for DeepSeekRuntime.
 * v1.3.77: Risk-classified MCP tool discovery and execution.
 *
 * Design:
 * - Enumerate MCP tools from enabled servers via @modelcontextprotocol/sdk
 * - Convert MCP tools to OpenAI-compatible tool definitions
 * - Risk classification: read-only / low-risk-action / high-risk-action / blocked
 * - Read-only tools auto-execute; action tools require user confirmation
 * - Each tool call connects → callTool → disconnects
 */

import { Client } from '@modelcontextprotocol/sdk/client';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp';

import { getEnhancedPath } from '../../utils/env';
import { parseCommand } from '../../utils/mcp';
import type { McpServerManager } from '../mcp';
import { createNodeFetch } from '../mcp/McpTester';
import { boundText, MAX_TOOL_RESULT_CHARS } from '../runtime/deepseekLimits';
import type { CodianMcpServer,McpServerConfig } from '../types/mcp';
import type { DeepSeekToolDefinition } from './toolSchemas';

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// ── Risk classification ──

export type McpRiskLevel = 'read-only' | 'low-risk-action' | 'high-risk-action' | 'blocked';

export interface McpClassification {
  level: McpRiskLevel;
  reason: string;
}

/** Read-only keywords — auto-allow, no confirmation. */
const READ_ONLY_PATTERNS = [
  /^(list|get|read|search|find|query|fetch|show|view|describe|check|count)/i,
  /^(export|download|lookup|inspect|browse|scan)/i,
  // AI-powered read-only operations
  /^(ai_search|ai_query|ai_find|ai_lookup|ai_analyze|ai_describe)/i,
  /^(search_by|query_by|find_by)/i,
  // Specific read-only variants for domain objects
  /^(item_list|item_get|item_search|item_query|list_items|get_item)/i,
  /^(tag_list|tag_get|tag_search|tag_query|list_tags|get_tags)/i,
  /^(folder_list|folder_get|list_folders|get_folder)/i,
  /^(collection_list|collection_get|list_collections|get_collection)/i,
  /^(asset_list|asset_get|asset_search|asset_query)/i,
];

/** Low-risk action keywords — session-level approval (first confirm, then auto). */
const LOW_RISK_ACTION_PATTERNS = [
  // Tag operations
  /^(add_tag|remove_tag|delete_tag|set_tag|update_tag|edit_tag|rename_tag|clear_tag|untag)/i,
  /^(tag_add|tag_remove|tag_delete|tag_set|tag_update|tag_edit|tag_rename|tag_clear)/i,
  /^(tag|mark|classify|annotate|label|rate|flag|star|favorite)/i,
  // Item/asset operations
  /^(add_item|remove_item|update_item|edit_item|move_item|rename_item)/i,
  /^(item_add|item_update|item_edit|item_move|item_rename)/i,
  // Folder/collection operations
  /^(add_to|move_to|copy_to|assign_to|link_to|relate|remove_from)/i,
  /^(create_folder|move_folder|rename_folder)/i,
  /^(create_collection|delete_collection)/i,
  // Metadata and organizational
  /^(update_metadata|set_metadata|change_metadata|edit_metadata)/i,
  /^(sort|categorize|organize|group)/i,
  /^(refresh|reload|sync|rescan)/i,
  /^(import|ingest|index)/i,
];

/** High-risk keywords — always confirm. */
const HIGH_RISK_PATTERNS = [
  /^(delete|remove|destroy|purge|erase|wipe|clear|trash)/i,
  /^(write|create|modify|update|edit|change|rename|move|copy)/i,
  /^(execute|exec|run|invoke|launch)/i,
  /^(publish|deploy|release|push|upload|send|post|submit|dispatch|share)/i,
  /^(install|uninstall|configure|setup|enable|disable)/i,
  /^(grant|revoke|permission|chmod|chown)/i,
];

/** Blocked keywords — never allowed. */
const BLOCKED_PATTERNS = [
  /(bash|shell|sh\b|cmd|command|powershell|terminal)/i,
  /(sudo|root|admin_auth|privilege|elevate)/i,
  /(credential|password|secret|token|api_key|private_key)/i,
  /(format|reformat|partition|fdisk|mkfs)/i,
  /(fork|exec|spawn|subprocess)/i,
  /(eval|inject|override|hijack)/i,
];

/**
 * Classify an MCP tool by risk level.
 * Uses tool name + description for classification.
 * Default: unknown = high-risk (conservative).
 */
export function classifyMcpToolRisk(
  toolName: string,
  toolDescription?: string,
): McpClassification {
  const combined = `${toolName} ${toolDescription || ''}`;

  // Blocked takes priority
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(combined)) {
      return { level: 'blocked', reason: `matches blocked pattern: ${pattern.source}` };
    }
  }

  // Read-only
  for (const pattern of READ_ONLY_PATTERNS) {
    if (pattern.test(toolName)) {
      return { level: 'read-only', reason: 'matches read-only pattern' };
    }
  }

  // Low-risk action
  for (const pattern of LOW_RISK_ACTION_PATTERNS) {
    if (pattern.test(toolName)) {
      return { level: 'low-risk-action', reason: 'matches low-risk-action pattern' };
    }
  }

  // High-risk action
  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test(toolName)) {
      return { level: 'high-risk-action', reason: `matches high-risk pattern: ${pattern.source}` };
    }
  }

  // Unknown → high-risk (conservative)
  return { level: 'high-risk-action', reason: 'unknown tool, defaulting to high-risk' };
}

// ── Schema mapping ──

function mcpToolToOpenAI(
  serverName: string,
  tool: McpTool,
  classification: McpClassification,
): DeepSeekToolDefinition {
  const inputSchema = tool.inputSchema as Record<string, unknown> | undefined;
  const riskLabel =
    classification.level === 'read-only' ? '' :
    classification.level === 'low-risk-action' ? ' [needs approval]' :
    ' [requires confirmation]';

  return {
    type: 'function',
    function: {
      name: `mcp__${serverName}__${tool.name}`,
      description: (tool.description || `MCP tool from ${serverName}: ${tool.name}`) + riskLabel,
      parameters: {
        type: 'object',
        properties: (inputSchema?.properties as Record<string, unknown>) || {},
        ...(inputSchema?.required
          ? { required: inputSchema.required as string[] }
          : {}),
      },
    },
  };
}

// ── Discovery ──

function getMcpServerType(config: McpServerConfig): 'stdio' | 'sse' | 'http' {
  if (config.type === 'sse') return 'sse';
  if (config.type === 'http') return 'http';
  return 'stdio';
}

function createTransport(config: McpServerConfig, serverType: 'stdio' | 'sse' | 'http') {
  const nodeFetch = createNodeFetch();

  switch (serverType) {
    case 'stdio': {
      const stdioConfig = config as { command: string; args?: string[]; env?: Record<string, string> };
      const { cmd, args } = parseCommand(stdioConfig.command, stdioConfig.args);
      return new StdioClientTransport({
        command: cmd,
        args,
        env: {
          ...process.env,
          ...stdioConfig.env,
          PATH: getEnhancedPath(stdioConfig.env?.PATH),
        },
        stderr: 'ignore',
      });
    }
    case 'sse': {
      const sseConfig = config as { url: string; headers?: Record<string, string> };
      return new SSEClientTransport(new URL(sseConfig.url), {
        fetch: nodeFetch,
        requestInit: sseConfig.headers ? { headers: sseConfig.headers } : undefined,
      });
    }
    case 'http': {
      const httpConfig = config as { url: string; headers?: Record<string, string> };
      return new StreamableHTTPClientTransport(new URL(httpConfig.url), {
        fetch: nodeFetch,
        requestInit: httpConfig.headers ? { headers: httpConfig.headers } : undefined,
      });
    }
  }
}

/**
 * Enumerate all non-blocked MCP tools from enabled servers.
 * Connects to each server, lists tools, applies risk classification,
 * and converts to OpenAI-compatible tool definitions.
 * Blocked tools are excluded entirely.
 */
export async function enumerateMcpToolsForDeepSeek(
  mcpManager: McpServerManager,
): Promise<DeepSeekToolDefinition[]> {
  const servers: CodianMcpServer[] = mcpManager.getServers();
  const allTools: DeepSeekToolDefinition[] = [];

  for (const server of servers) {
    if (!server.enabled) continue;

    const serverType = getMcpServerType(server.config);
    let client: Client | null = null;

    try {
      const transport = createTransport(server.config, serverType);
      client = new Client({ name: 'codian-deepseek', version: '1.0.0' });

      let connectTimedOut = false;
      const connectTimeout = setTimeout(() => {
        connectTimedOut = true;
        client?.close().catch(() => {});
      }, 8000);

      await client.connect(transport);
      clearTimeout(connectTimeout);
      if (connectTimedOut) continue;

      const result = await client.listTools(undefined, {
        signal: AbortSignal.timeout(8000),
      });

      // Print classification table header once per server
      console.debug(`[Codian MCP] === ${server.name} tool classification ===`);
      for (const tool of result.tools) {
        if (server.disabledTools?.includes(tool.name)) {
          continue;
        }

        const classification = classifyMcpToolRisk(tool.name, tool.description);

        if (classification.level === 'blocked') {
          console.debug(`[Codian MCP] ${server.name}: [BLOCKED     ] ${tool.name}`);
          continue;
        }

        const levelLabel =
          classification.level === 'read-only' ? '[READ-ONLY  ]' :
          classification.level === 'low-risk-action' ? '[LOW-RISK   ]' :
          '[HIGH-RISK  ]';

        const schemaKeys = tool.inputSchema?.properties
          ? Object.keys(tool.inputSchema.properties as Record<string, unknown>).join(',')
          : '(none)';

        console.debug(`[Codian MCP] ${server.name}: ${levelLabel} ${tool.name} | schema: ${schemaKeys} | ${classification.reason}`);
        allTools.push(mcpToolToOpenAI(server.name, tool, classification));
      }
    } catch (error) {
      console.warn(
        `[Codian MCP] failed to enumerate ${server.name}:`,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (client) {
        try { await client.close(); } catch { /* ignore */ }
      }
    }
  }

  return allTools;
}

// ── Execution ──

/**
 * Execute an MCP tool call.
 * Parses the server name and tool name from the mcp__<server>__<tool> format,
 * connects to the server, calls the tool, and returns the result.
 * Approval is handled by the caller (toolExecutor) based on risk level.
 */
export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  mcpManager: McpServerManager,
  signal: AbortSignal,
): Promise<string> {
  const parts = toolName.split('__');
  if (parts.length < 3 || parts[0] !== 'mcp') {
    return `Error: Invalid MCP tool name format: ${toolName}`;
  }
  const serverName = parts[1];
  const actualToolName = parts.slice(2).join('__');

  // Find server
  const servers: CodianMcpServer[] = mcpManager.getServers();
  const server = servers.find((s) => s.name === serverName);
  if (!server) {
    return `Error: MCP server "${serverName}" not found.`;
  }
  if (!server.enabled) {
    return `Error: MCP server "${serverName}" is disabled.`;
  }
  if (server.disabledTools?.includes(actualToolName)) {
    return `Error: Tool "${actualToolName}" is disabled for server "${serverName}".`;
  }

  // Risk check: blocked tools are rejected
  const classification = classifyMcpToolRisk(actualToolName);
  if (classification.level === 'blocked') {
    return `Error: Tool "${actualToolName}" is blocked (${classification.reason}).`;
  }

  const serverType = getMcpServerType(server.config);
  let client: Client | null = null;

  try {
    const transport = createTransport(server.config, serverType);
    client = new Client({ name: 'codian-deepseek', version: '1.0.0' });

    await client.connect(transport, { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });

    const result = await client.callTool(
      { name: actualToolName, arguments: args },
      undefined,
      { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) },
    );

    const content = result.content as Array<{ type: string; text?: string; data?: unknown }>;
    if (!content || content.length === 0) {
      return '(empty result)';
    }

    const textParts = content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!);

    if (textParts.length > 0) {
      const combined = textParts.join('\n');
      return boundText(combined, MAX_TOOL_RESULT_CHARS, 'tool result');
    }

    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return '(non-serializable result)';
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return `MCP tool "${actualToolName}" timed out or was cancelled.`;
    }
    const rawMsg = error instanceof Error ? error.message : String(error);
    const sanitized = rawMsg.replace(/\/[^\s]*/g, '[path]');
    return `MCP error: ${sanitized}`;
  } finally {
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }
}
