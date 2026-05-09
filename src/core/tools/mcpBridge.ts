/**
 * MCP Bridge for DeepSeekRuntime.
 * P1: Read-only MCP tool discovery and execution.
 *
 * Design:
 * - Enumerate MCP tools from enabled servers via @modelcontextprotocol/sdk
 * - Convert MCP tools to OpenAI-compatible tool definitions
 * - Execute individual MCP tool calls (connect → callTool → disconnect)
 * - Read-only filter: only allow tools with read-like names
 */

import { Client } from '@modelcontextprotocol/sdk/client';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp';

import { parseCommand } from '../../utils/mcp';
import { createNodeFetch } from '../mcp/McpTester';
import { getEnhancedPath } from '../../utils/env';
import type { McpServerConfig, CodianMcpServer } from '../types/mcp';
import type { McpServerManager } from '../mcp';
import type { DeepSeekToolDefinition } from './toolSchemas';

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// ── Read-only filter ──

const READ_ONLY_PATTERNS = [
  /^(list|get|read|search|find|query|fetch|show|view|describe|check|count)/i,
  /^(export|download|lookup|inspect|browse|scan)/i,
];

const BLOCKED_PATTERNS = [
  /(write|create|delete|remove|destroy|drop)/i,
  /(update|modify|patch|edit|change|rename|move|copy)/i,
  /(execute|exec|run|bash|shell|sh\b|cmd|command)/i,
  /(install|uninstall|deploy|publish|push)/i,
  /(send|post|put|submit|dispatch)/i,
];

function isReadOnlyMcpTool(toolName: string): boolean {
  // Block list takes priority
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(toolName)) {
      console.debug(`[Codian MCP Filter] BLOCKED: ${toolName}`);
      return false;
    }
  }

  // Allow list
  for (const pattern of READ_ONLY_PATTERNS) {
    if (pattern.test(toolName)) {
      return true;
    }
  }

  // Unknown tools default to blocked (conservative)
  console.debug(`[Codian MCP Filter] BLOCKED (unknown): ${toolName}`);
  return false;
}

// ── Schema mapping ──

function mcpToolToOpenAI(serverName: string, tool: McpTool): DeepSeekToolDefinition {
  const inputSchema = tool.inputSchema as Record<string, unknown> | undefined;

  return {
    type: 'function',
    function: {
      name: `mcp__${serverName}__${tool.name}`,
      description: tool.description || `MCP tool from ${serverName}: ${tool.name}`,
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
 * Enumerate all read-only MCP tools from enabled servers.
 * Connects to each server, lists tools, applies the read-only filter,
 * and converts to OpenAI-compatible tool definitions.
 */
export async function enumerateMcpToolsForDeepSeek(
  mcpManager: McpServerManager,
): Promise<DeepSeekToolDefinition[]> {
  const servers: CodianMcpServer[] = mcpManager.getServers();
  const allTools: DeepSeekToolDefinition[] = [];

  console.debug('[Codian MCP] enumerateMcpToolsForDeepSeek: servers total:', servers.length);

  for (const server of servers) {
    console.debug('[Codian MCP] checking server:', server.name, 'enabled:', server.enabled, 'disabledTools:', server.disabledTools);
    if (!server.enabled) {
      console.debug('[Codian MCP] skipping disabled server:', server.name);
      continue;
    }

    const serverType = getMcpServerType(server.config);
    console.debug('[Codian MCP] connecting to', server.name, 'type:', serverType);
    let client: Client | null = null;

    try {
      const transport = createTransport(server.config, serverType);
      client = new Client({ name: 'codian-deepseek', version: '1.0.0' });

      const connectTimeout = setTimeout(() => {
        client?.close().catch(() => {});
      }, 8000);

      await client.connect(transport);
      clearTimeout(connectTimeout);
      console.debug('[Codian MCP] connected to', server.name);

      const result = await client.listTools(undefined, {
        signal: AbortSignal.timeout(8000),
      });
      console.debug('[Codian MCP]', server.name, 'listed tools count:', result.tools.length);

      for (const tool of result.tools) {
        console.debug('[Codian MCP]', server.name, 'tool:', tool.name);

        // Skip explicitly disabled tools
        if (server.disabledTools?.includes(tool.name)) {
          console.debug('[Codian MCP Filter] SKIPPED (disabled):', server.name, tool.name);
          continue;
        }

        // Apply read-only filter
        if (!isReadOnlyMcpTool(tool.name)) {
          console.debug('[Codian MCP Filter] BLOCKED:', server.name, tool.name);
          continue;
        }

        allTools.push(mcpToolToOpenAI(server.name, tool));
        console.debug('[Codian MCP Filter] ALLOWED:', server.name, tool.name);
      }
    } catch (error) {
      console.debug(
        '[Codian MCP] Failed to enumerate tools from', server.name, ':',
        error instanceof Error ? error.message : String(error),
      );
      // Continue with other servers
    } finally {
      if (client) {
        try { await client.close(); } catch { /* ignore */ }
      }
    }
  }

  console.debug('[Codian MCP] enumeration complete. total tools:', allTools.length);
  return allTools;
}

// ── Execution ──

/**
 * Execute an MCP tool call.
 * Parses the server name and tool name from the mcp__<server>__<tool> format,
 * connects to the server, calls the tool, and returns the result.
 */
export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  mcpManager: McpServerManager,
  signal: AbortSignal,
): Promise<string> {
  // Parse mcp__<serverName>__<toolName>
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

  // Double-check read-only
  if (!isReadOnlyMcpTool(actualToolName)) {
    return `Error: Tool "${actualToolName}" is not allowed (read-only MCP only).`;
  }

  const serverType = getMcpServerType(server.config);
  let client: Client | null = null;

  try {
    const transport = createTransport(server.config, serverType);
    client = new Client({ name: 'codian-deepseek', version: '1.0.0' });

    // Connection timeout: 10s
    await client.connect(transport, { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });

    // Call timeout: 30s
    const result = await client.callTool(
      { name: actualToolName, arguments: args },
      undefined,
      { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) },
    );

    // Serialize result
    const content = result.content as Array<{ type: string; text?: string; data?: unknown }>;
    if (!content || content.length === 0) {
      return '(empty result)';
    }

    const textParts = content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!);

    if (textParts.length > 0) {
      const combined = textParts.join('\n');
      // Truncate very large results
      if (combined.length > 50000) {
        return combined.slice(0, 50000) + '\n\n... (result truncated at 50000 characters)';
      }
      return combined;
    }

    // Fallback: stringify the entire content
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return '(non-serializable result)';
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return `MCP tool "${actualToolName}" timed out or was cancelled.`;
    }
    return `MCP error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }
}
