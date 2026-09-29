/**
 * Optional external runtimes (spec mathmodel-parity-and-beyond, requirement 7.7): the name,
 * purpose, which features depend on each, and where to install it. The diagnostics centre and
 * the feature entry points both read this table, so a missing runtime is described once.
 */
export type OptionalRuntimeId = 'python' | 'latex' | 'typst' | 'claude-code' | 'codex';

export interface OptionalRuntime {
  id: OptionalRuntimeId;
  /** Display name. */
  name: string;
  /** One sentence about what the runtime does. */
  purpose: string;
  /** Feature entry points that need this runtime; others keep working without it. */
  dependentFeatures: string[];
  /** Official install guide. */
  installGuideUrl: string;
}

export const OPTIONAL_RUNTIMES: readonly OptionalRuntime[] = [
  {
    id: 'python',
    name: 'Python',
    purpose: '运行代码与处理数据',
    dependentFeatures: ['代码执行', '数据集预览', '建模脚本'],
    installGuideUrl: 'https://www.python.org/downloads/',
  },
  {
    id: 'latex',
    name: 'LaTeX (TeX Live)',
    purpose: '编译数学建模竞赛论文 PDF',
    dependentFeatures: ['论文编译'],
    installGuideUrl: 'https://tug.org/texlive/',
  },
  {
    id: 'typst',
    name: 'Typst',
    purpose: '编译数学建模竞赛论文 PDF',
    dependentFeatures: ['论文编译'],
    installGuideUrl: 'https://typst.app/docs/',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    purpose: '作为外部智能体运行时经 ACP 接入',
    dependentFeatures: ['通过 ACP 接入本机运行时'],
    installGuideUrl: 'https://docs.anthropic.com/en/docs/claude-code/setup',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    purpose: '作为外部智能体运行时经 ACP 接入',
    dependentFeatures: ['通过 ACP 接入本机运行时'],
    installGuideUrl: 'https://github.com/openai/codex',
  },
];

export function optionalRuntime(id: OptionalRuntimeId): OptionalRuntime {
  // The table is exhaustive by construction; the fallback keeps callers total without widening
  // the type to `| undefined`.
  return OPTIONAL_RUNTIMES.find((runtime) => runtime.id === id) ?? OPTIONAL_RUNTIMES[0];
}
