import { snakeToTitleCase } from '../utils';

export interface ToolCallLike {
  name: string;
  arguments?: Record<string, unknown>;
}

export function unwrapToolCall(toolCall: unknown): ToolCallLike | null {
  const data = toolCall as Record<string, unknown> | undefined;
  if (!data) return null;

  const value =
    data.status === 'success' ? (data.value as Record<string, unknown> | undefined) : data;
  if (!value || typeof value.name !== 'string') return null;

  const args = value.arguments;
  return {
    name: value.name,
    arguments: args && typeof args === 'object' ? (args as Record<string, unknown>) : undefined,
  };
}

export function getToolShortName(toolCallName: string): string {
  const lastIndex = toolCallName.lastIndexOf('__');
  if (lastIndex === -1) return toolCallName;

  return toolCallName.substring(lastIndex + 2);
}

function stringifyArgument(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function describeToolCall(toolCall: ToolCallLike): string | null {
  const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
  const toolName = getToolShortName(toolCall.name);

  switch (toolName) {
    case 'text_editor':
      if (args.command === 'write' && args.path) {
        return `writing ${stringifyArgument(args.path)}`;
      }
      if (args.command === 'view' && args.path) {
        return `reading ${stringifyArgument(args.path)}`;
      }
      if (args.command === 'str_replace' && args.path) {
        return `editing ${stringifyArgument(args.path)}`;
      }
      if (args.command && args.path) {
        return `${stringifyArgument(args.command)} ${stringifyArgument(args.path)}`;
      }
      break;

    case 'shell':
      if (args.command) {
        return `running ${stringifyArgument(args.command)}`;
      }
      break;

    case 'search':
      if (args.name) {
        return `searching for "${stringifyArgument(args.name)}"`;
      }
      if (args.mimeType) {
        return `searching for ${stringifyArgument(args.mimeType)} files`;
      }
      break;

    case 'read': {
      if (args.uri) {
        const uri = stringifyArgument(args.uri);
        const fileId = uri.replace('gdrive:///', '');
        return `reading file ${fileId}`;
      }
      if (args.url) {
        return `reading ${stringifyArgument(args.url)}`;
      }
      break;
    }

    case 'create_file':
      if (args.name) {
        return `creating ${stringifyArgument(args.name)}`;
      }
      break;

    case 'update_file':
      if (args.fileId) {
        return `updating file ${stringifyArgument(args.fileId)}`;
      }
      break;

    case 'sheets_tool': {
      if (args.operation && args.spreadsheetId) {
        const operation = stringifyArgument(args.operation);
        const sheetId = stringifyArgument(args.spreadsheetId);
        return `${operation} in sheet ${sheetId}`;
      }
      break;
    }

    case 'docs_tool': {
      if (args.operation && args.documentId) {
        const operation = stringifyArgument(args.operation);
        const docId = stringifyArgument(args.documentId);
        return `${operation} in document ${docId}`;
      }
      break;
    }

    case 'remember_memory':
      if (args.category && args.data) {
        return `storing ${stringifyArgument(args.category)}: ${stringifyArgument(args.data)}`;
      }
      break;

    case 'retrieve_memories':
      if (args.category) {
        return `retrieving ${stringifyArgument(args.category)} memories`;
      }
      break;

    case 'screen_capture':
      if (args.window_title) {
        return `capturing window "${stringifyArgument(args.window_title)}"`;
      }
      return `capturing screen`;

    case 'delegate': {
      if (args.instructions) {
        const instr = stringifyArgument(args.instructions);
        const truncated = instr.length > 80 ? instr.substring(0, 80) + '…' : instr;
        return `delegating: ${truncated}`;
      }
      if (args.source) {
        return `delegating to ${stringifyArgument(args.source)}`;
      }
      return 'delegating task';
    }

    case 'load': {
      if (args.source) {
        return `loading ${stringifyArgument(args.source)}`;
      }
      return 'loading source';
    }

    case 'final_output':
      return 'final output';

    case 'computer_control':
      return `poking around...`;

    case 'execute_typescript': {
      const toolGraph = args.tool_graph as { tool: string; description: string }[] | undefined;
      if (toolGraph && Array.isArray(toolGraph) && toolGraph.length > 0) {
        if (toolGraph.length === 1) {
          return `${toolGraph[0].description}`;
        }
        if (toolGraph.length === 2) {
          return `${toolGraph[0].tool}, ${toolGraph[1].tool}`;
        }
        return `${toolGraph.length} tools used`;
      }
      return 'executing code';
    }

    default: {
      // Generic fallback for unknown tools: ToolName + CompactArguments
      // This ensures any MCP tool works without explicit handling
      const toolDisplayName = snakeToTitleCase(toolName);
      const entries = Object.entries(args);

      if (entries.length === 0) {
        return `${toolDisplayName}`;
      }

      // For a single parameter, show key and truncated value
      if (entries.length === 1) {
        const [key, value] = entries[0];
        const stringValue = stringifyArgument(value);
        return `${toolDisplayName} ${key}: ${stringValue}`;
      }

      // For multiple parameters, show tool name and keys
      const keys = entries.map(([key]) => key).join(', ');
      return `${toolDisplayName} ${keys}`;
    }
  }

  return null;
}
