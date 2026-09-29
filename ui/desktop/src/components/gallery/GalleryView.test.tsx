import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import type { GalleryWork } from '../../utils/gallery/galleryService';
import GalleryView from './GalleryView';

vi.mock('./GalleryPdfThumb', () => ({ default: () => null }));

const originalElectron = window.electron;
const galleryList = vi.fn();
const galleryCandidates = vi.fn();
const galleryExport = vi.fn();
const galleryImport = vi.fn();
const galleryRemote = vi.fn();

function localWork(overrides: Partial<GalleryWork> = {}): GalleryWork {
  return {
    id: 'local:/project',
    source: 'local',
    pdfPath: '/project/paper.pdf',
    projectDir: '/project',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  galleryList.mockResolvedValue([localWork()]);
  galleryCandidates.mockResolvedValue({ candidates: ['data/input.csv'], excluded: [] });
  galleryExport.mockResolvedValue({ ok: true, data: { path: '/project/share-x.zip', excluded: [] } });
  window.electron = {
    ...originalElectron,
    galleryList,
    galleryCandidates,
    galleryExport,
    galleryImport,
    galleryRemote,
    getVersion: () => '1.50.0',
  } as typeof window.electron;
});

afterEach(() => {
  window.electron = originalElectron;
});

describe('GalleryView', () => {
  it('shows "Not filled in" for works whose metadata fields are missing', async () => {
    galleryList.mockResolvedValue([localWork()]);
    render(
      <IntlTestWrapper>
        <GalleryView />
      </IntlTestWrapper>
    );

    expect(await screen.findByText('Local')).toBeVisible();
    expect(screen.getAllByText(/Not filled in/).length).toBeGreaterThanOrEqual(2);
    // The temporary "a paper PDF marks a work" rule is gone (task 22.10).
    expect(screen.queryByText(/Temporary rule/)).not.toBeInTheDocument();
  });

  it('shows a prompt when the project has no exportable paper PDF', async () => {
    galleryList.mockResolvedValue([
      localWork({ title: 'My paper', competition: '国赛', category: '优化', abstract: '摘要' }),
    ]);
    galleryExport.mockResolvedValue({ ok: false, code: 'NO_PDF' });

    render(
      <IntlTestWrapper>
        <GalleryView />
      </IntlTestWrapper>
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Export share package' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No exportable paper PDF');
  });
});
