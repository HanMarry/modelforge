#!/usr/bin/env node
/**
 * Provides translations for messages introduced by the desktop shell work.
 *
 * Two jobs:
 *   1. `add`   — insert ids that exist in en.json but not in a locale, using the
 *                translation below when available and English otherwise.
 *   2. `patch` — overwrite specific ids with a supplied translation (used when a
 *                locale previously fell back to English).
 *
 * Keeping the overrides here rather than hand-editing 16 JSON files means the
 * catalogues stay sorted and complete, which `i18n:validate-locale` enforces.
 *
 * Usage:
 *   node scripts/i18n-translations.js --add --write
 *   node scripts/i18n-translations.js --patch --write
 */
const fs = require('fs');
const path = require('path');

const MESSAGES = path.join(__dirname, '..', 'src', 'i18n', 'messages');

/** Simplified Chinese is the primary target locale for this product. */
const ZH_CN = {
  // Navigation
  'navigation.itemHome': '新建会话',
  'navigation.itemFigures': '科研绘图',
  'navigation.itemPaper': '论文模板',
  'navigation.itemApps': '应用',
  'navigation.itemScheduler': '自动化',
  'navigation.itemSessions': '会话历史',
  'navigation.itemSettings': '设置',
  'navigation.itemProfile': '个人信息',
  'navigation.itemCatalog': '扩展',
  'navigation.catalogSkills': '技能',
  'navigation.catalogTemplates': '模板',
  'navigation.catalogAlgorithms': '算法',
  'navigation.catalogPlugins': '插件',
  'navigation.catalogConnectors': '连接器',

  // Algorithms
  'algorithmsView.title': '方法与算法',
  'algorithmsView.subtitle': '预置方法卡片：选一个，Agent 会装依赖并写出可运行代码。',
  'algorithmsView.searchPlaceholder': '搜索方法或依赖包，例如 PSO、scikit-learn',
  'algorithmsView.all': '全部',
  'algorithmsView.needsInstall': '需安装',
  'algorithmsView.useWhen': '适合什么时候用',
  'algorithmsView.dataNeeded': '需要什么数据',
  'algorithmsView.outputs': '会得到什么',
  'algorithmsView.notSuitableFor': '不适合的情况',
  'algorithmsView.entrypoint': '调用入口',
  'algorithmsView.dependencies': '依赖',
  'algorithmsView.homepage': '官方文档',
  'algorithmsView.license': '许可',
  'algorithmsView.empty': '没有匹配的方法。',
  'algorithmsView.useInSession': '在测试中使用',
  'algorithmsView.sessionFailed': '无法为该算法创建会话',

  // Figures
  'figuresView.title': '科研绘图',
  'figuresView.subtitle':
    '选择模板，Agent 会写出绘图脚本、出图并导出矢量 PDF/SVG 与 PNG 预览。',
  'figuresView.all': '全部',
  'figuresView.placeholder': '模板待补充',
  'figuresView.script': '生成脚本',
  'figuresView.depsValue': '依赖 {deps}',
  'figuresView.empty': '该分类下暂无模板。',
  'figuresView.total': '共 {count} 个模板',
  'figuresView.useTemplate': '使用此模板',
  'figuresView.useTemplateHint': '把「用该模板出图」的请求写进首页输入框，不会自动发送。',
  'figuresView.unavailable': '暂无预览——该模板需要额外的几何依赖库。',

  // Paper templates
  'paperView.title': '论文模板',
  'paperView.subtitle':
    '选择赛事模板，Agent 会把整套模板复制到项目里，并从入口文件开始撰写与编译论文。',
  'paperView.all': '全部',
  'paperView.availableOnly': '已内置',
  'paperView.available': '已内置',
  'paperView.planned': '待内置',
  'paperView.language': '语言',
  'paperView.source': '来源',
  'paperView.license': '许可',
  'paperView.engine': '引擎',
  'paperView.contents': '模板内容',
  'paperView.templateDir': '模板文件夹',
  'paperView.entryFile': '入口文件',
  'paperView.usage': '使用方式',
  'paperView.previewCaption': '模板编译后的首页（由 xelatex 实际渲染）。',
  'paperView.usageBody':
    'Agent 会把整个模板文件夹复制到项目中，并从入口文件开始写作；用 modeling 扩展的 compile_latex 编译。',
  'paperView.empty': '没有符合筛选条件的模板。',
  'paperView.engineLatex': 'LaTeX',
  'paperView.engineTypst': 'Typst',
  'paperView.langZh': '中文',
  'paperView.langEn': '英文',
  'paperView.coverFields': '封面信息',
  'paperView.coverHint':
    '由模板自身声明（题号、队号、学校…）。填好的值会写进请求；留空的项 Agent 会来问你。',
  'paperView.optional': '可留空',
  'paperView.useTemplate': '使用此模板写论文',
  'paperView.useTemplateHint': '把模板、入口文件与封面信息写进首页输入框，不会自动发送。',
  'paperView.defaultFor': '默认用于',
  'paperView.groupBundled': '内置 · 赛事模板',
  'paperView.groupVendored': '上游开源模板',
  'paperView.customize': '基于此模板自定义',
  'paperView.customizeHint': '在项目里生成你自己的副本再改造，内置模板保持原样。',
  'paperView.customizeName': '你的副本名称',
  'paperView.customizeNamePlaceholder': '例如 my-cumcm-2026',
  'paperView.customizeConfirm': '生成自定义请求',
  'paperView.customizeCancel': '取消',

  // Skills (rewritten page: enable/disable, detail body, import/export)
  'skillsView.title': '技能',
  'skillsView.subtitle':
    '教 Agent 怎么做事的方法文档（SKILL.md）。已启用的技能可以在输入框用「/」调用。',
  'skillsView.enabled': '已启用',
  'skillsView.disabled': '已停用',
  'skillsView.builtin': '内置',
  'skillsView.globalSkill': '全局',
  'skillsView.projectSkill': '项目',
  'skillsView.searchPlaceholder': '按名称或说明搜索技能…',
  'skillsView.total': '共 {count} 个技能',
  'skillsView.noSkills': '没有找到技能',
  'skillsView.noMatch': '没有匹配的技能。',
  'skillsView.loadFailed': '技能加载失败',
  'skillsView.tryAgain': '重试',
  'skillsView.status': '状态',
  'skillsView.location': '位置',
  'skillsView.source': '来源',
  'skillsView.supportingFiles': '支撑文件',
  'skillsView.disabledAt': '停用于',
  'skillsView.newSkill': '新建技能',
  'skillsView.importFolder': '导入文件夹',
  'skillsView.importJson': '导入文件',
  'skillsView.edit': '编辑',
  'skillsView.remove': '删除',
  'skillsView.exportSkill': '导出',
  'skillsView.disable': '停用',
  'skillsView.enable': '启用',
  'skillsView.confirmDelete': '确认删除',
  'skillsView.cancel': '取消',
  'skillsView.builtinCannotDisable': '内置技能随应用更新，不能停用。',
  'skillsView.readOnly': '该技能是只读的，不能在这里编辑。',
  'skillsView.nameLabel': '名称',
  'skillsView.namePlaceholder': '例如 data-cleaning',
  'skillsView.descriptionLabel': '一句话说明',
  'skillsView.descriptionPlaceholder': '什么时候该加载这个技能？',
  'skillsView.contentLabel': 'SKILL.md 正文',
  'skillsView.contentPlaceholder': '# 这个技能做什么\n\nAgent 应该按这些步骤执行…',
  'skillsView.scopeLabel': '保存到',
  'skillsView.save': '保存',
  'skillsView.saving': '保存中…',
  'skillsView.nameRequired': '必须填名称。',
  'skillsView.notToggled': '无法切换技能状态',
  'skillsView.imported': '已导入 {count} 个技能',
  'skillsView.exported': '已导出到 {path}',
  'skillsView.runError': '操作失败',

  // Connectors
  'connectorsView.title': '连接器',
  'connectorsView.subtitle': '通过 MCP 服务器扩展能力：文献检索、网页抓取、代码仓库。',
  'connectorsView.builtin': '内置',
  'connectorsView.builtinHint': '随应用发布，可在「插件」里开关。',
  'connectorsView.installable': '可连接',
  'connectorsView.planned': '规划中',
  'connectorsView.plannedHint': '尚未实现对应服务；列出以保证目录完整。',
  'connectorsView.install': '安装',
  'connectorsView.installed': '已安装',
  'connectorsView.capabilities': '能力',
  'connectorsView.transport': '传输方式',
  'connectorsView.source': '包名',
  'connectorsView.docs': '官方文档',
  'connectorsView.defaultOn': '默认开启',
  'connectorsView.defaultOff': '默认关闭',
  'connectorsView.all': '全部',
  'connectorsView.addCustom': '添加自定义连接器',
  'connectorsView.installing': '安装中…',
  'connectorsView.prerequisite': '开始之前',
  'connectorsView.command': '运行方式',
  'connectorsView.secretsTitle': '凭据',
  'connectorsView.secretsHint':
    '保存在系统钥匙串中，不会写入配置文件。也可以留空，稍后再填。',
  'connectorsView.optional': '可选',
  'connectorsView.cancel': '取消',
  'connectorsView.confirmInstall': '添加连接器',
  'connectorsView.installSuccess': '连接器已添加',
  'connectorsView.installSuccessMsg': '{name} 已启用。首次调用可能需要等待依赖下载。',
  'connectorsView.installFailed': '连接器添加失败',
  'connectorsView.alreadyInstalled': '该连接器已在你的扩展列表中。',

  // Home
  'hub.appTitle': '数学建模助手',
  'hub.workflowLabel': '工作流',
  'hub.paperLabel': '排版',
  'hub.contestLabel': '赛事',
  'hub.contestInfo': '赛事信息',
  'hub.examplesTitle': '试试这些数模真题案例',
  'hub.exampleNeedsInput': '题目未内置，请自行补充',
  'hub.exampleReady': '已附带题目与附件',

  // Profile
  'profileView.title': '个人信息',
  'profileView.subtitle': '本机使用情况，由会话列表统计得出。',
  'profileView.refresh': '刷新',
  'profileView.loading': '正在统计…',
  'profileView.error': '无法读取会话统计。',
  'profileView.statSessions': '会话数',
  'profileView.statMessages': '提示词',
  'profileView.statActiveDays': '活跃天数',
  'profileView.statProjects': '项目数',
  'profileView.statStreakCurrent': '当前连续天数',
  'profileView.statStreakLongest': '最长连续天数',
  'profileView.daysValue': '{count} 天',
  'profileView.modelUsage': '模型使用情况',
  'profileView.modelUsageHint': '按会话数计算的占比。',
  'profileView.statSpan': '历史跨度',
  'profileView.spanValue': '{days} 天',
  'profileView.spanUnknown': '—',
  'profileView.activity': '活跃度',
  'profileView.activityHint': '近一年每日提示词数。',
  'profileView.less': '少',
  'profileView.more': '多',
  'profileView.providers': '最常用供应商',
  'profileView.models': '最常用模型',
  'profileView.projects': '最常用项目',
  'profileView.recipes': '使用配方的会话',
  'profileView.none': '暂无数据',
  'profileView.tokensNote':
    'Token 与费用按会话统计——打开某个会话可查看其用量，此处尚未做汇总。',
  'profileView.countValue': '{count}',

  // Settings page (merged profile + settings)
  'settingsView.title': '设置',
  'settingsView.backToApp': '返回应用',
  'settingsView.searchSettings': '搜索设置',
  'navigation.itemProfile': '个人资料',

  // Kernel cost estimate + proactive context warnings
  'agentKernelSection.pricingTitle': '模型计价（可选）',
  'agentKernelSection.pricingHelp':
    '按每百万 token 填写，用来估算内核在你模型上的花费。token 数来自内核自己的用量统计，goose 不知道你模型的单价。',
  'agentKernelSection.inputPrice': '输入 / 百万',
  'agentKernelSection.outputPrice': '输出 / 百万',
  'agentKernelSection.currency': '货币符号',
  'agentKernelSection.restartNote':
    '模型、密钥、上下文窗口和单价都是即时生效；只有「切换内核」本身需要重启应用。',
  'agentKernelSection.restartRequired': '内核已更改——重启 ModelForge 完成装配。',
  'agentKernelSection.contextWindowTitle': '{model} 的上下文窗口',
  'agentKernelSection.contextWindowHelp':
    '窗口是每个模型各自的属性，这里只对 {model} 生效。进度条与预警会用这个值，而不是内核自己那个（通常更大的）窗口。',
  'agentKernelSection.contextWindowSourceOverride': '当前使用你填写的窗口。',
  'agentKernelSection.contextWindowSourceProvider': '当前使用 provider 为该模型声明的窗口。',
  'agentKernelSection.contextWindowSourceUnknown':
    'provider 没有为该模型声明窗口，进度条无法及时预警——建议在这里填一个。',
  'costTracker.kernelEstimate': '按你填写的单价估算',
  'costTracker.kernelEstimateTooltip':
    '本次会话由 {kernel} 内核调用 {model} 完成，费用按「设置 → 应用 → 智能体内核」里的单价估算：输入 {inputTokens} tok、输出 {outputTokens} tok。',
  'costTracker.kernelPricesMissing':
    '内核正在用你的模型 {model} 提供服务，goose 没有它的价格数据。到「设置 → 应用 → 智能体内核」填写每百万 token 单价，即可看到费用估算。',
  'chatInput.contextWarningTitle': '上下文快满了',
  'chatInput.contextWarningBody':
    '已用 {percent}%（{used} / {limit} tokens）。建议开个新会话，回答质量会更稳。',
  'chatInput.contextWarningKernelBody':
    '已用 {percent}%（{used} / {limit} tokens）。{kernel} 内核会自行压缩历史，但开新会话能让细节更可靠。',
  'chatInput.contextCriticalTitle': '上下文即将占满',
  'chatInput.contextCriticalBody':
    '已用 {percent}%（{used} / {limit} tokens）。请立刻开始新会话，否则下一轮长回答可能被上游直接拒绝。',
  'chatInput.contextCriticalKernelBody':
    '已用 {percent}%（{used} / {limit} tokens）。请立刻开始新会话——{kernel} 内核仍可能超出你模型的窗口。',
  'chatInput.contextWarningNotificationTitle': 'ModelForge：上下文即将占满',

  // Kernel model picker (external kernels proxy to the user's own models)
  'chatInput.kernelContextManaged':
    '上下文由 {kernel} 内核自行管理（接近上限时它会自动压缩）；这里的进度条按你所用模型的窗口计算。',
  'modelsBottomBar.kernelModel': '内核模型',
  'modelsBottomBar.kernelModelHint':
    '{kernel} 内核实际请求的就是这个模型；在「设置 → 模型 → 内核模型」里切换。',
  'modelsSection.kernelSlotNote':
    '内核自身固定使用 current 这一模型位，真正调用的模型是下方「内核模型」里选中的那个。',
  'kernelModel.title': '内核模型',
  'kernelModel.description':
    '{kernel} 内核的每次请求都会经本地适配器转发到下面选中的模型，切换后下一次请求即生效。',
  'kernelModel.provider': '服务提供方：{provider}',
  'kernelModel.loading': '正在加载模型…',
  'kernelModel.empty': '该服务提供方没有可选模型。',
  'kernelModel.notRunning': '内核尚未运行——请到「应用 → 智能体内核」确认配置。',
  'kernelModel.switched': '内核模型已切换为 {model}',
  'kernelModel.switchFailed': '无法切换内核模型',
  'kernelModel.readFailed': '无法读取内核状态',

  // Agent kernel (Claude Code / Codex as selectable agent loops)
  'agentKernelSection.title': '智能体内核',
  'agentKernelSection.description':
    '选择运行对话的智能体循环。内置内核开箱即用；Claude Code 与 Codex 内核会通过本地适配器使用你在 ModelForge 中配置的 API。',
  'agentKernelSection.builtinTitle': '内置内核',
  'agentKernelSection.builtinDescription': 'ModelForge 自带的智能体循环，无需额外运行时。',
  'agentKernelSection.claudeCodeTitle': 'Claude Code 内核',
  'agentKernelSection.claudeCodeDescription': '用你配置的 API 运行 Claude Code 的智能体循环。',
  'agentKernelSection.codexTitle': 'Codex 内核',
  'agentKernelSection.codexDescription': '用你配置的 API 运行 OpenAI Codex 的智能体循环。',
  'agentKernelSection.statusTitle': '内核状态',
  'agentKernelSection.statusBuiltin': '当前使用内置内核。',
  'agentKernelSection.statusReady': '已就绪 · {baseUrl} · 模型 {model} · 本地适配器 {shimUrl}',
  'agentKernelSection.statusIncomplete': '尚未就绪',
  'agentKernelSection.activeBadge': '使用中',
  'agentKernelSection.usingProvider': '服务提供方：{providerId}',
  'agentKernelSection.keySource': '密钥来源：{source}',
  'agentKernelSection.keySourceKernel': '内核专用密钥',
  'agentKernelSection.keySourceProvider': '从服务提供方设置中获取',
  'agentKernelSection.keySourceEnv': '环境变量 {name}',
  'agentKernelSection.keySourceNone': '未设置',
  'agentKernelSection.apiKeyLabel': '内核使用的 API Key（可选）',
  'agentKernelSection.apiKeyPlaceholder': '留空则复用服务提供方设置里保存的密钥',
  'agentKernelSection.apiKeyHelp':
    '密钥在本机加密保存。goose 不会把服务提供方密钥回传给应用，因此若提示缺少密钥，在此填写一次即可。',
  'agentKernelSection.saveKey': '保存密钥',
  'agentKernelSection.clearKey': '删除已保存密钥',
  'agentKernelSection.keySaved': '密钥已保存。',
  'agentKernelSection.restartNote':
    '模型、密钥、上下文窗口和单价都是即时生效；只有「切换内核」本身需要重启应用。',
  'agentKernelSection.restartNow': '立即重启',
};

function loadLocale(locale) {
  const file = path.join(MESSAGES, `${locale}.json`);
  return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function saveLocale(file, data) {
  const sorted = {};
  for (const key of Object.keys(data).sort()) sorted[key] = data[key];
  fs.writeFileSync(file, JSON.stringify(sorted, null, 2) + '\n');
}

function add(write) {
  const en = JSON.parse(fs.readFileSync(path.join(MESSAGES, 'en.json'), 'utf8'));
  const locales = fs
    .readdirSync(MESSAGES)
    .filter((name) => name.endsWith('.json') && name !== 'en.json')
    .map((name) => name.replace(/\.json$/, ''));

  let total = 0;
  for (const locale of locales) {
    const { file, data } = loadLocale(locale);
    const missing = Object.keys(en).filter((key) => !(key in data));
    if (!missing.length) {
      console.log(`${locale}: complete`);
      continue;
    }
    let translated = 0;
    for (const key of missing) {
      const override = locale === 'zh-CN' || locale === 'zh-TW' ? ZH_CN[key] : undefined;
      data[key] = { defaultMessage: override ?? en[key].defaultMessage };
      if (override) translated++;
    }
    if (write) saveLocale(file, data);
    total += missing.length;
    console.log(`${locale}: +${missing.length} (${translated} translated)`);
  }
  console.log(`${write ? 'added' : 'would add'} ${total} messages`);
}

function patch(write) {
  let patched = 0;
  for (const locale of ['zh-CN', 'zh-TW']) {
    const { file, data } = loadLocale(locale);
    let changed = 0;
    for (const [key, text] of Object.entries(ZH_CN)) {
      if (!(key in data)) continue;
      if (data[key].defaultMessage === text) continue;
      data[key] = { defaultMessage: text };
      changed++;
    }
    if (changed && write) saveLocale(file, data);
    patched += changed;
    console.log(`${locale}: ${write ? 'patched' : 'would patch'} ${changed}`);
  }
  console.log(`${patched} messages ${write ? 'updated' : 'pending'}`);
}

function prune(write) {
  const en = JSON.parse(fs.readFileSync(path.join(MESSAGES, 'en.json'), 'utf8'));
  const enKeys = new Set(Object.keys(en));
  const locales = fs
    .readdirSync(MESSAGES)
    .filter((name) => name.endsWith('.json') && name !== 'en.json')
    .map((name) => name.replace(/\.json$/, ''));

  let total = 0;
  for (const locale of locales) {
    const { file, data } = loadLocale(locale);
    const stale = Object.keys(data).filter((key) => !enKeys.has(key));
    if (!stale.length) {
      console.log(`${locale}: no stale ids`);
      continue;
    }
    for (const key of stale) delete data[key];
    if (write) saveLocale(file, data);
    total += stale.length;
    console.log(`${locale}: -${stale.length} stale (${stale.slice(0, 5).join(', ')})`);
  }
  console.log(`${write ? 'removed' : 'would remove'} ${total} stale ids`);
}

function main() {
  const write = process.argv.includes('--write');
  const mode = process.argv.includes('--patch')
    ? 'patch'
    : process.argv.includes('--prune')
      ? 'prune'
      : 'add';
  if (mode === 'patch') patch(write);
  else if (mode === 'prune') prune(write);
  else add(write);
}

if (require.main === module) main();
