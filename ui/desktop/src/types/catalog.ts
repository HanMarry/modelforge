/**
 * Shared types for the competition hub and example library (requirements 8 and 9).
 *
 * These are imported by the renderer catalogue (pure functions + views) and by the main
 * process (IPC handlers), so they must stay free of Vite renderer globals and Electron
 * imports.
 */

/** ISO calendar date, `YYYY-MM-DD` (requirement 8.1 dates are precise to the day). */
export type LocalDate = `${number}-${number}-${number}`;

export type CompetitionStatus = '未开始' | '报名中' | '进行中' | '已结束';

export interface CompetitionDateRange {
  start: LocalDate | null;
  end: LocalDate | null;
}

export interface Competition {
  id: string;
  name: string;
  organizer: string;
  /** Official site; `null` until it is confirmed, shown as "待公布" (requirement 8.9). */
  website: string | null;
  registration: CompetitionDateRange;
  contest: CompetitionDateRange;
  /** Paper template ids, matching `catalog/papers.ts` template directories. */
  templateIds: string[];
  /** Example problem ids from the example library. */
  exampleIds: string[];
}

export interface CompetitionCatalog {
  /** Last update of the local data, `YYYY-MM-DD` (requirement 8.5). */
  updatedAt: LocalDate;
  competitions: Competition[];
}

export interface CompetitionFilter {
  /** Empty means "no status filter". */
  statuses: CompetitionStatus[];
  /** 0..50 chars, case-insensitive substring match on the competition name. */
  keyword: string;
}

export type ExampleCategory = '优化类' | '预测/统计类' | '综合评价类';

export interface ExampleLicense {
  type: string;
  /** Whether the problem and attachments may be packaged (requirement 9.6). */
  redistributable: boolean;
  note: string;
}

export interface ExampleSolutionSection {
  /** Which sub-question this section addresses. */
  question: string;
  /** Relative path to the section markdown inside the example directory. */
  file: string;
}

export interface ExampleManifest {
  id: string;
  title: string;
  category: ExampleCategory;
  source: string;
  license: ExampleLicense;
  /** Official download link, present only for real (non-redistributable) problems. */
  officialUrl?: string;
  /** Relative path to the statement file. */
  problemFile: string;
  /** Relative paths to attachment data files, at least one (requirement 9.1). */
  attachments: string[];
  /** Reference approach, one section per sub-question (requirement 9.1). */
  solution: ExampleSolutionSection[];
}

/** An example as shown in the library, after completeness filtering. */
export interface ExampleEntry {
  manifest: ExampleManifest;
  /**
   * True when the manifest is complete but the statement/attachments are not shipped
   * locally and must be downloaded from `officialUrl` (requirement 9.1).
   */
  needsDownload: boolean;
}

export interface ProjectOriginCompetition {
  kind: 'competition';
  competitionId: string;
  templateIds: string[];
}

export interface ProjectOriginExample {
  kind: 'example';
  exampleId: string;
  /** Relative project paths copied from the example (problem + attachments). */
  inputFiles: string[];
}

export type ProjectOrigin = ProjectOriginCompetition | ProjectOriginExample;

export interface ProjectMetadata {
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  origin: ProjectOrigin;
}

export type ProjectCreateErrorCode =
  | 'PROJECT_EXISTS'
  | 'EACCES'
  | 'ENOSPC'
  | 'SOURCE_MISSING';
