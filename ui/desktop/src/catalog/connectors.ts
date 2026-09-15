/**
 * Connector catalogue (扩展 → 连接器).
 *
 * Every `install` block below was verified against the live registry before being
 * written here — package name, licence and entry command:
 *
 *   arxiv-mcp-server            PyPI 0.7.2   MIT    run via uvx
 *   mcp-server-fetch            PyPI 2026.8.18 MIT  run via uvx (official reference server)
 *   zotero-mcp                  PyPI 0.3.1   MIT    run via uvx; local API needs no key
 *   drawio-mcp                  PyPI 1.0.2   MIT    run via uvx, **pin mcp<2** (see note below)
 *   crossref-mcp                PyPI 0.1.0   MIT    run via uvx, **pin mcp<2** too
 *   fred-mcp                    PyPI 1.0.1   MIT    run via uvx, needs FRED_API_KEY
 *   @modelcontextprotocol/server-github  npm 2025.4.8 MIT  — DEPRECATED, not used
 *   @upstash/context7-mcp       npm 4.1.0    MIT    run via npx, needs an API key
 *
 * `drawio-mcp` and `crossref-mcp` were checked by running them: both install but crash on
 * import because they target MCP SDK 1.x (`from mcp.server.fastmcp import FastMCP`), and
 * the resolver now installs mcp 2.x where that module was renamed. Pinning `mcp<2` via
 * `--with` makes both start, so the constraint is baked into the launch arguments rather
 * than left to the user. GitHub's official server moved to a hosted remote endpoint, so
 * the deprecated npm package is not offered.
 *
 * `fred-mcp` was checked the same way: it loads and then exits with "FRED_API_KEY is
 * required for stdio transport" — that is the correct behaviour for a server whose
 * credential is genuinely required, and it confirms the package is functional.
 *
 * Considered and rejected: `open-data-mcp` (Korean public data) carries **no licence
 * information**, so it cannot be listed under this project's permissive-licence rule.
 *
 * `uvx.exe` ships in the packaged app (pinned in
 * ui/desktop/scripts/prepare-platform-binaries.js), and `npx.cmd` is shimmed on
 * Windows by utils/winShims.ts, so both commands resolve without the user
 * installing anything.
 *
 * Deliberately absent: `@modelcontextprotocol/server-fetch` and
 * `@modelcontextprotocol/server-zotero` do not exist on npm — the fetch server is
 * the Python one listed above and Zotero is the community Python server.
 */
export type ConnectorKind = 'builtin' | 'stdio' | 'streamable_http';
export type ConnectorStatus = 'installed' | 'installable' | 'planned';

/** Secret the connector needs before it can run. Collected at install time. */
export interface ConnectorSecret {
  /** Env var (stdio) or header (streamable_http) name the server reads. */
  key: string;
  label: string;
  /** Shown in the install prompt. */
  hint: string;
  /** Optional: Zotero's local API needs no key at all. */
  optional?: boolean;
  /**
   * Prefix applied to the collected value, e.g. `Bearer ` for an Authorization
   * header. Only used for header secrets.
   */
  valuePrefix?: string;
}

/** Concrete MCP extension configuration, ready to write into config.yaml. */
export interface ConnectorInstall {
  type: 'stdio' | 'streamable_http' | 'builtin';
  cmd?: string;
  args?: string[];
  uri?: string;
  /** Fixed env vars that are part of the integration, not user secrets. */
  envs?: Record<string, string>;
  secrets?: ConnectorSecret[];
}

export interface ConnectorEntry {
  id: string;
  name: string;
  description: string;
  status: ConnectorStatus;
  /** Enabled out of the box for a fresh install (built-ins only). */
  defaultEnabled: boolean;
  /** Extension name as registered in goose, present once installed. */
  extensionName?: string;
  /** Package or URL, shown on the card. */
  package?: string;
  license?: string;
  capabilities: string[];
  homepage?: string;
  /** How to install it; absent for `planned` entries. */
  install?: ConnectorInstall;
  /** What the user must do outside the app, if anything. */
  prerequisite?: string;
}

export const CONNECTOR_CATALOG: ConnectorEntry[] = [
  // --- Built in -------------------------------------------------------------
  {
    id: 'modeling',
    name: 'modeling',
    description:
      '数学建模工具链：检测 Python / uv / LaTeX / Typst 环境，编译 LaTeX 与 Typst 论文并解析报错行。',
    status: 'installed',
    defaultEnabled: true,
    extensionName: 'modeling',
    capabilities: ['check_env', 'compile_latex'],
    install: { type: 'builtin' },
  },
  {
    id: 'developer',
    name: 'developer',
    description: '文件读写、Shell 执行、代码编辑等通用开发工具，是所有建模任务的基础。',
    status: 'installed',
    defaultEnabled: true,
    extensionName: 'developer',
    capabilities: ['文件操作', 'Shell', '代码编辑'],
    install: { type: 'builtin' },
  },
  {
    id: 'computercontroller',
    name: 'computercontroller',
    description: '通用电脑控制工具，不要求使用者具备工程背景。',
    status: 'installed',
    defaultEnabled: false,
    extensionName: 'computercontroller',
    capabilities: ['系统操作'],
    install: { type: 'builtin' },
  },
  {
    id: 'autovisualiser',
    name: 'autovisualiser',
    description: '数据可视化与界面生成工具。',
    status: 'installed',
    defaultEnabled: false,
    extensionName: 'autovisualiser',
    capabilities: ['图表生成'],
    install: { type: 'builtin' },
  },
  {
    id: 'memory',
    name: 'memory',
    description: '记录用户偏好，跨会话保持。',
    status: 'installed',
    defaultEnabled: false,
    extensionName: 'memory',
    capabilities: ['偏好记忆'],
    install: { type: 'builtin' },
  },

  // --- Installable ----------------------------------------------------------
  {
    id: 'arxiv',
    name: 'arXiv',
    description: '按作者、领域或关键词检索论文，并下载正文供每日抓取与图表复现工作流使用。',
    status: 'installable',
    defaultEnabled: false,
    package: 'arxiv-mcp-server',
    license: 'MIT',
    capabilities: ['检索论文', '下载并读取全文', '本地缓存论文'],
    homepage: 'https://github.com/blazickjp/arxiv-mcp-server',
    install: {
      type: 'stdio',
      cmd: 'uvx',
      args: ['arxiv-mcp-server'],
    },
  },
  {
    id: 'web-fetch',
    name: 'Web Fetch',
    description: '抓取网页正文并转成 Markdown，用于采集公开数据、标准与文档。',
    status: 'installable',
    defaultEnabled: false,
    package: 'mcp-server-fetch',
    license: 'MIT',
    capabilities: ['网页抓取', 'HTML 转 Markdown', 'robots.txt 遵守'],
    homepage: 'https://github.com/modelcontextprotocol/servers',
    install: {
      type: 'stdio',
      cmd: 'uvx',
      args: ['mcp-server-fetch'],
    },
  },
  {
    id: 'zotero',
    name: 'Zotero',
    description:
      '连接本地 Zotero 文献库，检索条目、读取元数据与 PDF 全文。用本地 API 时无需 API key。',
    status: 'installable',
    defaultEnabled: false,
    package: 'zotero-mcp',
    license: 'MIT',
    capabilities: ['检索文献库', '读取条目元数据', '读取 PDF 全文'],
    homepage: 'https://github.com/kujenga/zotero-mcp',
    prerequisite:
      '需在 Zotero 设置 → 高级 中勾选「允许本机其他应用与 Zotero 通信」；若改用 Web API 则需填写 API Key 与 Library ID。',
    install: {
      type: 'stdio',
      cmd: 'uvx',
      args: ['zotero-mcp'],
      envs: { ZOTERO_LOCAL: 'true' },
      secrets: [
        {
          key: 'ZOTERO_API_KEY',
          label: 'Zotero API Key',
          hint: '使用本地 API 时可留空',
          optional: true,
        },
        {
          key: 'ZOTERO_LIBRARY_ID',
          label: 'Zotero Library ID',
          hint: '使用本地 API 时可留空',
          optional: true,
        },
      ],
    },
  },
  {
    id: 'github',
    name: 'GitHub',
    description:
      '读写仓库、Issue 与 PR，便于把建模项目纳入版本管理。使用 GitHub 官方托管的远程 MCP 服务器，无需本地安装。',
    status: 'installable',
    defaultEnabled: false,
    package: 'api.githubcopilot.com/mcp/',
    license: 'MIT (github/github-mcp-server)',
    capabilities: ['仓库读写', 'Issue / PR', '代码检索', 'Actions 运行状态'],
    homepage: 'https://github.com/github/github-mcp-server',
    prerequisite:
      '官方 npm 包（@modelcontextprotocol/server-github）已标记废弃，因此这里改用官方托管的远程服务器；需要一个 GitHub Personal Access Token（按需勾选 repo 权限）。',
    install: {
      type: 'streamable_http',
      uri: 'https://api.githubcopilot.com/mcp/',
      secrets: [
        {
          key: 'Authorization',
          label: 'GitHub Personal Access Token',
          hint: '在 GitHub Settings → Developer settings → Personal access tokens 生成，按需授予 repo 权限',
          valuePrefix: 'Bearer ',
        },
      ],
    },
  },
  {
    id: 'context7',
    name: 'Context7',
    description: '按需拉取库与框架的最新文档，避免让模型凭记忆写已过时的 API。',
    status: 'installable',
    defaultEnabled: false,
    package: '@upstash/context7-mcp',
    license: 'MIT',
    capabilities: ['实时文档检索'],
    homepage: 'https://github.com/upstash/context7',
    install: {
      type: 'stdio',
      cmd: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      secrets: [
        {
          key: 'CONTEXT7_API_KEY',
          label: 'Context7 API Key',
          hint: '在 context7.com 注册后获取，免费额度足够个人使用',
        },
      ],
    },
  },

  {
    id: 'drawio',
    name: 'draw.io',
    description:
      '生成 draw.io 技术路线图/流程图，输出 .drawio XML 文件，可在 draw.io 里继续编辑并导出 PDF/PNG 供论文使用。',
    status: 'installable',
    defaultEnabled: false,
    package: 'drawio-mcp',
    license: 'MIT',
    capabilities: ['生成路线图 XML', '自动整理布局与连线', '导出为可编辑文件'],
    homepage: 'https://github.com/yohasacura/drawio-mcp',
    prerequisite:
      '该服务器不兼容 MCP Python SDK 2.x（FastMCP 已改名为 MCPServer），默认安装会直接崩溃，因此启动参数里固定了 mcp<2。',
    install: {
      type: 'stdio',
      cmd: 'uvx',
      args: ['--from', 'drawio-mcp', '--with', 'mcp<2', 'drawio-mcp'],
    },
  },

  // --- Planned --------------------------------------------------------------
  {
    id: 'crossref',
    name: '引用真实性校验',
    description:
      '按标题或 DOI 在 Crossref 检索，核对参考文献是否真实存在并取回标准元数据，避免编造引用。',
    status: 'installable',
    defaultEnabled: false,
    package: 'crossref-mcp',
    license: 'MIT',
    capabilities: ['按标题检索', 'DOI 校验', '取回标准元数据'],
    homepage: 'https://www.crossref.org',
    prerequisite:
      '同样需要 mcp<2 约束（该服务器面向 MCP SDK 1.x）。填写邮箱可加入 Crossref 礼貌池，获得更稳定的限流。',
    install: {
      type: 'stdio',
      cmd: 'uvx',
      args: ['--from', 'crossref-mcp', '--with', 'mcp<2', 'crossref-mcp'],
      secrets: [
        {
          key: 'CROSSREF_MAILTO',
          label: '联系邮箱',
          hint: '加入 Crossref 礼貌池用，可留空',
          optional: true,
        },
      ],
    },
  },
  {
    id: 'fred',
    name: 'FRED 经济数据',
    description:
      '检索并下载美联储 FRED 的宏观经济时间序列（GDP、CPI、利率、就业等），用于需要真实宏观数据的建模与预测。',
    status: 'installable',
    defaultEnabled: false,
    package: 'fred-mcp',
    license: 'MIT',
    capabilities: ['时间序列检索', '下载观测值', '数据系列元数据'],
    homepage: 'https://github.com/zachspar/fred-mcp',
    prerequisite:
      '需要 FRED API Key（在 fredaccount.stlouisfed.org/apikey 免费申请）。没有 key 时服务器会直接报错退出，这是预期行为。',
    install: {
      type: 'stdio',
      cmd: 'uvx',
      args: ['fred-mcp'],
      secrets: [
        {
          key: 'FRED_API_KEY',
          label: 'FRED API Key',
          hint: '在 fredaccount.stlouisfed.org/apikey 免费申请',
        },
      ],
    },
  },
];

export const INSTALLED_CONNECTORS = CONNECTOR_CATALOG.filter((c) => c.status === 'installed');
export const INSTALLABLE_CONNECTORS = CONNECTOR_CATALOG.filter((c) => c.status === 'installable');
export const PLANNED_CONNECTORS = CONNECTOR_CATALOG.filter((c) => c.status === 'planned');

/**
 * Maps a catalogue entry onto the desktop app's extension config shape.
 *
 * Secrets go where the transport reads them: `envs`/`env_keys` for stdio, and
 * `headers` for streamable_http. The backend moves secret headers into its secret
 * store and persists namespaced references, which the HTTP transport resolves.
 */
export function toExtensionConfig(
  entry: ConnectorEntry,
  secretValues: Record<string, string> = {}
) {
  const install = entry.install;
  if (!install || install.type === 'builtin') {
    return { type: 'builtin' as const, name: entry.extensionName ?? entry.id };
  }

  if (install.type === 'streamable_http') {
    const headers: Record<string, string> = {};
    const envKeys: string[] = [];
    for (const secret of install.secrets ?? []) {
      const raw = secretValues[secret.key]?.trim();
      if (!raw) continue;
      headers[secret.key] = `${secret.valuePrefix ?? ''}${raw}`;
      envKeys.push(secret.key);
    }
    return {
      type: 'streamable_http' as const,
      name: entry.extensionName ?? entry.id,
      description: entry.description,
      uri: install.uri ?? '',
      headers,
      env_keys: envKeys,
      timeout: 300,
    };
  }

  const envs: Record<string, string> = { ...(install.envs ?? {}) };
  const envKeys: string[] = [];
  for (const secret of install.secrets ?? []) {
    const raw = secretValues[secret.key]?.trim();
    if (!raw) continue;
    envs[secret.key] = raw;
    envKeys.push(secret.key);
  }

  return {
    type: 'stdio' as const,
    name: entry.extensionName ?? entry.id,
    description: entry.description,
    cmd: install.cmd ?? '',
    args: install.args ?? [],
    envs,
    env_keys: envKeys,
    timeout: 300,
  };
}
