/**
 * Resolves the context window of the model an external kernel actually calls.
 *
 * The kernel reports its own window (Claude Code's 200k/1M), which says nothing about the
 * model serving the request. The window is a property of that model, so it is resolved per
 * model name, in this order:
 *
 *   1. an override the user entered for that model in the kernel settings,
 *   2. the window the provider declares for it,
 *   3. goose's model catalogue (works for known providers, e.g. a built-in DeepSeek entry),
 *   4. the provider inventory, when the catalogue has no entry.
 *
 * `null` means "unknown" — the caller then shows the kernel's own number rather than a wrong
 * clamped one.
 */
import { fetchCanonicalModelInfo } from '../utils/canonical';
import { acpListProviderModels } from './providers';
import type { AgentKernelStatus } from '../utils/agentKernel';

export async function resolveUpstreamContextLimit(
  status: AgentKernelStatus
): Promise<number | null> {
  if (status.runtime === 'builtin' || !status.providerId || !status.model) {
    return null;
  }
  if (status.contextLimit && status.contextLimit > 0) {
    return status.contextLimit;
  }

  try {
    const canonical = await fetchCanonicalModelInfo(status.providerId, status.model);
    if (canonical?.contextLimit) {
      return canonical.contextLimit;
    }
  } catch {
    // Fall through to the inventory below.
  }

  try {
    const models = await acpListProviderModels(status.providerId);
    const match = models.find((model) => model.id === status.model);
    return match?.contextLimit && match.contextLimit > 0 ? match.contextLimit : null;
  } catch {
    return null;
  }
}
