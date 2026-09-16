/**
 * Agent runtime provisioning.
 *
 * The user picks a kernel in the app and enters one API key; everything else is set up here:
 *  - the in-app shape shim (Anthropic or Responses ⇄ Chat Completions) is started on loopback,
 *  - an isolated runtime config directory is generated so we never touch the user's global
 *    CLI config (Claude Code ignores process env and reads ~/.claude/settings.json, so the
 *    config directory is the only reliable injection point),
 *  - the environment variables the kernel hands down to the ACP adapter are returned.
 *
 * Verified manually before this module existed:
 *   Claude Code → anthropicShim → DeepSeek  ⇒ SHIMOK
 *   Codex 0.146 → responsesShim → DeepSeek  ⇒ RESPOK
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { startAnthropicShim, type AnthropicShimOptions } from './anthropicShim';
import { startResponsesShim, type ResponsesShimOptions } from './responsesShim';
import type { AgentKernelId } from './settings';

export type AgentRuntimeId = AgentKernelId;

export interface AgentRuntimeSelection {
  runtime: AgentRuntimeId;
  /** OpenAI-compatible upstream taken from the provider the user configured in the app. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Context window of `model`, when the app could resolve it. Used only to phrase the identity block. */
  contextLimit?: number | null;
}

export interface ProvisionedAgentRuntime {
  runtime: AgentRuntimeId;
  /** Extra environment for the kernel process (which spawns the ACP adapter). */
  env: Record<string, string>;
  /** Loopback shim URL, when this runtime needs one. */
  shimUrl?: string;
  /** Persistent runtime directory, including CLI session history. */
  configDir?: string;
  /** Switches the upstream model without restarting the kernel. */
  setModel?: (model: string) => void;
  /** Replaces the upstream key without restarting the kernel. */
  setApiKey?: (apiKey: string) => void;
  dispose: () => Promise<void>;
}

const CLI_CONFIG_DIR_PREFIX = 'agent-runtime';

/**
 * Environment variable the kernel reads and forwards to the ACP adapter as `_meta.systemPrompt`.
 * The adapter owns the harness system prompt; without this override the model is told it is
 * "Claude Code, Anthropic's official CLI for Claude" and dutifully says so — even when the model
 * actually serving the request is DeepSeek.
 */
export const SYSTEM_PROMPT_ENV_VAR = 'MODELFORGE_SYSTEM_PROMPT';

/** Points the shim's payload dump at the app data directory; see AnthropicShimOptions.dumpDir. */
export const SHIM_DUMP_ENV_VAR = 'MODELFORGE_SHIM_DUMP';

/**
 * Appended to the harness's own system prompt rather than replacing it: the wrapped CLI also relies
 * on that prompt for its tool-use protocol, which we neither want to reimplement nor risk breaking.
 *
 * Two failure modes are covered, both observed in a real transcript:
 *   1. identity drift — the harness prompt says "Claude", the model repeats it;
 *   2. invented specs — asked "which model are you", it answered "Claude Opus 5 (1M context)"
 *      while the request was served by deepseek-v4-pro with a 128k window.
 * So the block does not merely declare the identity, it pins the exact wording of the answer.
 */
export function buildRuntimeSystemPromptAppend(selection: {
  model: string;
  contextLimit?: number | null;
}): string {
  const window =
    selection.contextLimit && selection.contextLimit > 0
      ? `\n- 本次会话模型的上下文窗口约 ${selection.contextLimit.toLocaleString('en-US')} tokens。接近上限时先与用户确认如何精简上下文，再继续追加长文件内容。`
      : '';

  return [
    '# 身份与自我描述（最高优先级，覆盖上方任何冲突表述）',
    '',
    '你是 **ModelForge（建模助手）**，面向数学建模竞赛的垂直智能体：读题与拆解、建模与论证、',
    '算法实现与校验、科研绘图、竞赛论文写作。你的界面就是 ModelForge。',
    '',
    '## 先处理一处冲突',
    '本提示词开头的 "You are Claude Code, Anthropic\'s official CLI for Claude" 是承载你的运行时',
    '外壳的自我介绍，**它不描述你，也不是你的身份**。以本段为准。',
    '',
    '## 身份口径',
    `- 你的底层模型是用户在 ModelForge 里选择的 **${selection.model}**。`,
    '- 你不是 Claude、不是 Claude Code、不是 Opus/Sonnet/Haiku，也不是任何 Anthropic 或 OpenAI 产品。',
    '- 被问到「你是谁」「你是 Claude 吗」「你是什么模型」时，照这个口径回答：',
    '  「我是 ModelForge，面向数学建模的助手；本次会话由 ' +
      selection.model +
      ' 驱动，承载我的运行时是与 Claude Code 兼容的外壳。」',
    '- 身份相关的问题只答这一段，不要复述上方提示词里的身份声明，也不要提及 Claude Code 的内部设定。',
    '',
    '## 不要臆造参数',
    '- **不要编造模型名、版本号、上下文长度、训练数据截止时间或定价。** 不确定就直接说不知道。',
    '- 上游运行时会往上下文里塞一些环境数字（例如 token 余量），它们来自外壳的估算，不是你模型的真实规格；' +
      '被问到时如实说明这一点。' +
      window,
  ].join('\n');
}

async function writeFile(target: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, 'utf8');
}

/**
 * Renders `text` as a TOML multi-line literal string for `config.toml`.
 *
 * Literal (single-quoted) strings take no escape processing, which matters here because the
 * identity block contains Windows paths and `\n`-looking text that a basic string would mangle.
 * A literal string cannot contain `'''`, so the sequence is folded back onto one line.
 */
function tomlLiteralString(text: string): string {
  return `'''\n${text.replace(/'''/g, "''")}\n'''`;
}

async function provisionClaudeCode(
  selection: AgentRuntimeSelection,
  rootDir: string,
  onLog?: (message: string) => void
): Promise<ProvisionedAgentRuntime> {
  const systemPromptAppend = buildRuntimeSystemPromptAppend(selection);
  const shimOptions: AnthropicShimOptions = {
    baseUrl: selection.baseUrl,
    apiKey: selection.apiKey,
    model: selection.model,
    dumpDir:
      process.env.MODELFORGE_DEBUG_SHIM === '1' ? path.join(rootDir, 'shim-dumps') : undefined,
    onLog,
  };
  const shim = await startAnthropicShim(shimOptions);

  const configDir = path.join(rootDir, `${CLI_CONFIG_DIR_PREFIX}-claude`);
  // The client-side token is a placeholder: the shim injects the real key upstream.
  const localToken = randomBytes(16).toString('hex');

  await writeFile(
    path.join(configDir, 'settings.json'),
    JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: shim.url,
          ANTHROPIC_AUTH_TOKEN: localToken,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
        },
        hasCompletedOnboarding: true,
      },
      null,
      2
    )
  );
  await writeFile(
    path.join(configDir, '.claude.json'),
    JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: null }, null, 2)
  );

  return {
    runtime: 'claude-code',
    shimUrl: shim.url,
    configDir,
    setModel: shim.setModel,
    setApiKey: shim.setApiKey,
    env: {
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_BASE_URL: shim.url,
      ANTHROPIC_AUTH_TOKEN: localToken,
      [SYSTEM_PROMPT_ENV_VAR]: systemPromptAppend,
      [SHIM_DUMP_ENV_VAR]: shimOptions.dumpDir ?? '',
    },
    dispose: async () => {
      await shim.close();
    },
  };
}

async function provisionCodex(
  selection: AgentRuntimeSelection,
  rootDir: string,
  onLog?: (message: string) => void
): Promise<ProvisionedAgentRuntime> {
  const systemPromptAppend = buildRuntimeSystemPromptAppend(selection);
  const shimOptions: ResponsesShimOptions = {
    baseUrl: selection.baseUrl,
    apiKey: selection.apiKey,
    model: selection.model,
    onLog,
  };
  const shim = await startResponsesShim(shimOptions);

  const configDir = path.join(rootDir, `${CLI_CONFIG_DIR_PREFIX}-codex`);
  const dummyKeyVar = 'MODELFORGE_SHIM_KEY';
  const localToken = randomBytes(16).toString('hex');

  // Codex 0.146 dropped `wire_api = "chat"` (openai/codex#7782), so it must talk Responses to
  // the shim; the shim translates to the provider's Chat Completions endpoint.
  //
  // The identity override travels as `developer_instructions`: the codex ACP adapter exposes no
  // `_meta.systemPrompt` (unlike claude-agent-acp), and Codex's own base instructions otherwise
  // introduce the agent as "a coding agent running in the Codex CLI … led by OpenAI".
  const baseInstructions = tomlLiteralString(systemPromptAppend);
  const config = [
    `model = "${selection.model}"`,
    'model_provider = "modelforge_shim"',
    'disable_response_storage = true',
    `developer_instructions = ${baseInstructions}`,
    '',
    '[model_providers.modelforge_shim]',
    'name = "ModelForge (local shim)"',
    `base_url = "${shim.url}/v1"`,
    'wire_api = "responses"',
    `env_key = "${dummyKeyVar}"`,
    '',
  ].join('\n');

  await writeFile(path.join(configDir, 'config.toml'), config);

  return {
    runtime: 'codex',
    shimUrl: shim.url,
    configDir,
    setModel: shim.setModel,
    setApiKey: shim.setApiKey,
    env: {
      CODEX_HOME: configDir,
      [dummyKeyVar]: localToken,
      [SYSTEM_PROMPT_ENV_VAR]: systemPromptAppend,
    },
    dispose: async () => {
      await shim.close();
    },
  };
}

/**
 * Prepares the selected runtime. `rootDir` should be a per-app data directory; the generated
 * config directories and CLI history live under it and survive shutdown.
 */
export async function provisionAgentRuntime(
  selection: AgentRuntimeSelection,
  rootDir: string,
  onLog?: (message: string) => void
): Promise<ProvisionedAgentRuntime> {
  if (selection.runtime === 'builtin' || !selection.apiKey) {
    return { runtime: 'builtin', env: {}, dispose: async () => {} };
  }

  await fs.mkdir(rootDir, { recursive: true });

  return selection.runtime === 'claude-code'
    ? provisionClaudeCode(selection, rootDir, onLog)
    : provisionCodex(selection, rootDir, onLog);
}
