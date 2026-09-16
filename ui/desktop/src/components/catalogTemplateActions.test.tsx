/**
 * @vitest-environment jsdom
 *
 * Covers the two "use this template" paths: the figure gallery and the paper catalogue.
 *
 * Without a Rust toolchain the app cannot be started for manual acceptance, so these
 * tests are what keeps the buttons honest: they assert the text actually queued for the
 * composer (template identity, script path, cover values) and that the view navigates
 * home. A button that looks right but seeds nothing would fail here.
 */
import type { ReactElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FigureTemplatesView from './FigureTemplatesView';
import PaperTemplatesView from './PaperTemplatesView';
import { FIGURE_CATALOG } from '../catalog/figures';
import { PAPER_TEMPLATE_CATALOG } from '../catalog/papers';
import { IntlTestWrapper } from '../i18n/test-utils';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), seedComposer: vi.fn() }));

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => mocks.navigate,
}));

vi.mock('../utils/composerSeed', () => ({
  seedComposer: mocks.seedComposer,
  takeComposerSeed: () => null,
}));

const renderView = (ui: ReactElement) => render(<IntlTestWrapper>{ui}</IntlTestWrapper>);

const useTemplateButton = () => screen.getByRole('button', { name: /use this template/i });

/**
 * Clicks a card in the catalogue grid. A title also appears in the detail panel (and a
 * contest name twice inside its own card), so the first match in DOM order is the one
 * that selects — the grid renders before the aside.
 */
const selectCard = (label: string) => fireEvent.click(screen.getAllByText(label)[0]);

const lastSeedText = (): string => {
  expect(mocks.seedComposer).toHaveBeenCalled();
  return mocks.seedComposer.mock.calls[mocks.seedComposer.mock.calls.length - 1][0] as string;
};

beforeEach(() => {
  mocks.navigate.mockClear();
  mocks.seedComposer.mockClear();
});

describe('figure catalogue', () => {
  // The gallery renders all 104 cards with their previews, which takes jsdom well past
  // the default 5s timeout. The cost is the fixture, not the behaviour under test.
  const GALLERY_TIMEOUT = 60_000;

  it(
    'seeds a request naming the selected template and where its script lives',
    () => {
      renderView(<FigureTemplatesView />);
      const first = FIGURE_CATALOG[0];

      fireEvent.click(useTemplateButton());

      const text = lastSeedText();
      expect(text).toContain(first.title);
      expect(text).toContain(first.script);
      expect(text).toContain(first.skill);
      expect(mocks.seedComposer.mock.calls[0][1]).toContain(`figure-${first.id}`);
      expect(mocks.navigate).toHaveBeenCalledWith('/');
    },
    GALLERY_TIMEOUT
  );

  it(
    'routes the MathModel family through the renderer, and the project family directly',
    () => {
      renderView(<FigureTemplatesView />);

      // The MathModel set is rendered by its own script, which copies the template first.
      const mathmodel = FIGURE_CATALOG.find(
        (entry) => entry.skill === 'mathmodel-figure-templates'
      );
      expect(mathmodel, 'catalogue should contain MathModel templates').toBeDefined();
      selectCard(mathmodel!.title);
      fireEvent.click(useTemplateButton());
      expect(lastSeedText()).toContain('render_template.py');

      // The project-written templates are copied out and run as-is.
      const own = FIGURE_CATALOG.find((entry) => entry.skill === 'math-figure');
      expect(own, 'catalogue should contain project-written templates').toBeDefined();
      selectCard(own!.title);
      fireEvent.click(useTemplateButton());
      const text = lastSeedText();
      expect(text).toContain(own!.script);
      expect(text).not.toContain('render_template.py');
    },
    GALLERY_TIMEOUT
  );
});

describe('paper catalogue', () => {
  it('writes the cover values the template declares into the request', () => {
    renderView(<PaperTemplatesView />);
    const first = PAPER_TEMPLATE_CATALOG[0];
    const [coverField] = first.fields;
    expect(coverField, 'the first template should declare a cover field').toBeDefined();

    fireEvent.change(screen.getByPlaceholderText(coverField.placeholder), {
      target: { value: 'A' },
    });
    fireEvent.click(useTemplateButton());

    const text = lastSeedText();
    expect(text).toContain(`math_paper/assets/templates/${first.directory}/`);
    expect(text).toContain(first.entryFile);
    expect(text).toContain(`${coverField.label}：A`);
    expect(mocks.navigate).toHaveBeenCalledWith('/');
  });

  it('drops the typed values when another contest is selected', () => {
    renderView(<PaperTemplatesView />);
    const first = PAPER_TEMPLATE_CATALOG[0];
    const placeholder = first.fields[0].placeholder;

    const input = screen.getByPlaceholderText(placeholder);
    fireEvent.change(input, { target: { value: 'A' } });
    expect(input).toHaveValue('A');

    // Switch to a template with no cover fields (华数杯), then back.
    const bare = PAPER_TEMPLATE_CATALOG.find(
      (entry) => entry.fields.length === 0 && entry.profileFields.length === 0
    );
    expect(bare, 'a template without cover fields should exist').toBeDefined();
    fireEvent.click(screen.getAllByText(bare!.contest)[0]);
    fireEvent.click(screen.getAllByText(first.contest)[0]);

    expect(screen.getByPlaceholderText(placeholder)).toHaveValue('');
  });
});
