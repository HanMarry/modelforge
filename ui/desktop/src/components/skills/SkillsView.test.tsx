/**
 * @vitest-environment jsdom
 *
 * The skills page has to show three things the previous flat list could not: which skills
 * are enabled, which are disabled, and the SKILL.md body of the selected one. It also has
 * to route enable/disable to the folder-move IPC. Without a Rust toolchain the app cannot
 * be started for a visual pass, so this test is what keeps the page honest.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SkillsView from './SkillsView';
import { IntlTestWrapper } from '../../i18n/test-utils';

const mocks = vi.hoisted(() => ({
  listSkillSources: vi.fn(),
  deleteSkillSource: vi.fn(),
  setSkillEnabled: vi.fn(),
  listDisabledSkills: vi.fn(),
}));

vi.mock('../../acp/sources', () => ({
  listSkillSources: mocks.listSkillSources,
  deleteSkillSource: mocks.deleteSkillSource,
  createSkillSource: vi.fn(),
  updateSkillSource: vi.fn(),
  exportSkillSource: vi.fn(),
  importSkillSources: vi.fn(),
}));

// The body rendering itself is covered by MarkdownContent's own tests; here the content
// only has to arrive.
vi.mock('../MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <div data-testid="skill-body">{content}</div>,
}));

vi.mock('../../utils/workingDir', () => ({
  getInitialWorkingDir: () => '/tmp/project',
}));

const BUILTIN = {
  type: 'builtinSkill' as const,
  name: 'math-paper',
  description: '论文写作与赛事模板',
  content: '---\nname: math-paper\ndescription: 论文写作与赛事模板\n---\n\n# 论文写作',
  path: 'builtin://skills/math-paper',
  global: true,
  writable: false,
};

const GLOBAL = {
  type: 'skill' as const,
  name: 'my-skill',
  description: '我自己写的技能',
  content: '---\nname: my-skill\n---\n\n# 我的技能',
  path: '/home/user/.agents/skills/my-skill',
  global: true,
  writable: true,
};

beforeEach(() => {
  mocks.listSkillSources.mockResolvedValue([BUILTIN, GLOBAL]);
  mocks.listDisabledSkills.mockResolvedValue([
    { name: 'paused-skill', originalPath: '/home/user/.agents/skills/paused-skill', disabledAt: '2026-09-12T10:00:00.000Z' },
  ]);
  mocks.setSkillEnabled.mockResolvedValue({ ok: true, records: [], location: '' });
  Object.assign(window.electron, {
    listDisabledSkills: mocks.listDisabledSkills,
    setSkillEnabled: mocks.setSkillEnabled,
    importSkillFolder: vi.fn(),
    selectSkillImportFile: vi.fn(),
    showSaveDialog: vi.fn(),
    writeFile: vi.fn(),
  });
});

const renderView = () =>
  render(
    <IntlTestWrapper>
      <SkillsView />
    </IntlTestWrapper>
  );

/**
 * Clicks a row in the list. A name also appears in the detail header for the selected
 * skill, and the first enabled skill is selected automatically — so the list row is the
 * first match in DOM order.
 */
const clickRow = async (name: string) => {
  const matches = await screen.findAllByText(name);
  fireEvent.click(matches[0]);
};

describe('skills page', () => {
  it('lists enabled and disabled skills as separate groups', async () => {
    renderView();

    await screen.findAllByText('math-paper');
    // Each group is a labelled region, so the assertion is about the grouping rather than
    // about how many times the words appear in the page.
    expect(within(screen.getByRole('region', { name: 'Enabled' })).getByText('my-skill')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Disabled' })).getByText('paused-skill')
    ).toBeInTheDocument();
    // The count in the header covers the enabled skills the kernel reports.
    expect(screen.getByText('2 skills')).toBeInTheDocument();
  });

  it('shows the SKILL.md body without its frontmatter, and refuses to disable a built-in', async () => {
    renderView();

    await clickRow('math-paper');

    const body = screen.getByTestId('skill-body');
    expect(body.textContent).toContain('# 论文写作');
    expect(body.textContent).not.toContain('name: math-paper');

    // A built-in has no folder to move, so it explains rather than offering the toggle.
    expect(screen.getByText(/cannot be disabled/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Disable$/ })).toBeNull();
  });

  it('moves a user skill into the disabled store through the IPC', async () => {
    renderView();

    await clickRow('my-skill');
    fireEvent.click(screen.getByRole('button', { name: /^Disable$/ }));

    await waitFor(() =>
      expect(mocks.setSkillEnabled).toHaveBeenCalledWith({
        name: 'my-skill',
        path: GLOBAL.path,
        enabled: false,
      })
    );
  });

  it('restores a disabled skill to its original path', async () => {
    renderView();

    await clickRow('paused-skill');
    fireEvent.click(screen.getByRole('button', { name: /^Enable$/ }));

    await waitFor(() =>
      expect(mocks.setSkillEnabled).toHaveBeenCalledWith({
        name: 'paused-skill',
        path: '/home/user/.agents/skills/paused-skill',
        enabled: true,
      })
    );
  });
});
