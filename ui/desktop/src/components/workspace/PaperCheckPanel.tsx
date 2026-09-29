import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { defineMessages, useIntl } from '../../i18n';
import type {
  PaperCheckIssue,
  PaperCheckItem,
  PaperCheckItemId,
  PaperCheckReason,
  PaperCheckReport,
  PaperCheckRequest,
} from '../../types/paperCheckApi';
import type { IpcError } from '../../utils/ipcResult';
import type { PaperCheckVerdict } from '../../utils/paperCheck/common';
import { cn } from '../../utils';
import type { WorkspaceFeaturePanelProps, WorkspaceFileLocation } from './featurePanelProps';

const i18n = defineMessages({
  title: { id: 'paperCheck.title', defaultMessage: 'Paper check' },
  description: {
    id: 'paperCheck.description',
    defaultMessage:
      'Checks the paper for common problems before you submit it. Files are only read, never changed.',
  },
  paperLabel: { id: 'paperCheck.paperLabel', defaultMessage: 'Paper source' },
  loadingPapers: { id: 'paperCheck.loadingPapers', defaultMessage: 'Looking for paper sources…' },
  noPaper: {
    id: 'paperCheck.noPaper',
    defaultMessage: 'No LaTeX, Typst or Markdown paper source found in this project.',
  },
  rescan: { id: 'paperCheck.rescan', defaultMessage: 'Look for paper sources again' },
  online: { id: 'paperCheck.online', defaultMessage: 'Verify references online (Crossref)' },
  onlineHint: {
    id: 'paperCheck.onlineHint',
    defaultMessage: 'Up to 10 seconds per reference; not included in the 60-second limit.',
  },
  anonymous: {
    id: 'paperCheck.anonymous',
    defaultMessage: 'The competition requires anonymous papers',
  },
  anonymousHint: {
    id: 'paperCheck.anonymousHint',
    defaultMessage: 'Searched for in the sources and the PDF. Kept on this computer only.',
  },
  names: { id: 'paperCheck.names', defaultMessage: 'Member names' },
  namesPlaceholder: {
    id: 'paperCheck.namesPlaceholder',
    defaultMessage: 'Separate names with commas',
  },
  school: { id: 'paperCheck.school', defaultMessage: 'School' },
  team: { id: 'paperCheck.team', defaultMessage: 'Team name' },
  run: { id: 'paperCheck.run', defaultMessage: 'Run check' },
  running: { id: 'paperCheck.running', defaultMessage: 'Checking…' },
  empty: {
    id: 'paperCheck.empty',
    defaultMessage: 'Pick the paper source and run the check to see the report.',
  },
  failed: { id: 'paperCheck.failed', defaultMessage: 'The check could not run: {detail}' },
  errorProjectNotFound: {
    id: 'paperCheck.errorProjectNotFound',
    defaultMessage: 'The project folder no longer exists.',
  },
  errorOutsideProject: {
    id: 'paperCheck.errorOutsideProject',
    defaultMessage: 'The paper must be inside the project folder.',
  },
  errorTimeout: { id: 'paperCheck.errorTimeout', defaultMessage: 'The check did not finish in time.' },
  finishedAt: { id: 'paperCheck.finishedAt', defaultMessage: 'Finished {time}' },
  issueCount: {
    id: 'paperCheck.issueCount',
    defaultMessage: '{count, plural, one {# issue} other {# issues}}',
  },
  omitted: {
    id: 'paperCheck.omitted',
    defaultMessage: '{count, plural, one {# more issue not shown} other {# more issues not shown}}',
  },
  locationLine: { id: 'paperCheck.locationLine', defaultMessage: '{file}, line {line}' },
  locationPage: { id: 'paperCheck.locationPage', defaultMessage: '{file}, page {page}' },

  itemQuestionCoverage: { id: 'paperCheck.itemQuestionCoverage', defaultMessage: 'Question coverage' },
  itemNumberConsistency: {
    id: 'paperCheck.itemNumberConsistency',
    defaultMessage: 'Numbers match results',
  },
  itemFigureLabels: { id: 'paperCheck.itemFigureLabels', defaultMessage: 'Figure labels and units' },
  itemReferences: { id: 'paperCheck.itemReferences', defaultMessage: 'References' },
  itemPdfFreshness: { id: 'paperCheck.itemPdfFreshness', defaultMessage: 'PDF up to date' },
  itemAnonymity: { id: 'paperCheck.itemAnonymity', defaultMessage: 'Anonymity' },

  verdictPass: { id: 'paperCheck.verdictPass', defaultMessage: 'Passed' },
  verdictIssues: { id: 'paperCheck.verdictIssues', defaultMessage: 'Issues found' },
  verdictCannotRun: { id: 'paperCheck.verdictCannotRun', defaultMessage: 'Could not run' },

  reasonMissingProblemStatement: {
    id: 'paperCheck.reasonMissingProblemStatement',
    defaultMessage: 'No problem statement found (a file named like 题目, 赛题 or problem).',
  },
  reasonMissingPaperSource: {
    id: 'paperCheck.reasonMissingPaperSource',
    defaultMessage: 'The paper source file is missing.',
  },
  reasonMissingQuestionNumbers: {
    id: 'paperCheck.reasonMissingQuestionNumbers',
    defaultMessage: 'The problem statement names no question numbers.',
  },
  reasonMissingRunRecords: {
    id: 'paperCheck.reasonMissingRunRecords',
    defaultMessage: 'No Run_Record found in .modelforge/runs.',
  },
  reasonNoResultTables: {
    id: 'paperCheck.reasonNoResultTables',
    defaultMessage: 'No current result table (CSV, TSV or JSON output of a successful run).',
  },
  reasonNoLinkedValues: {
    id: 'paperCheck.reasonNoLinkedValues',
    defaultMessage: 'No number in the paper could be matched to a result table value.',
  },
  reasonNoFigures: { id: 'paperCheck.reasonNoFigures', defaultMessage: 'The paper shows no figures.' },
  reasonFiguresUnreadable: {
    id: 'paperCheck.reasonFiguresUnreadable',
    defaultMessage: 'None of the figures could be read.',
  },
  reasonOffline: { id: 'paperCheck.reasonOffline', defaultMessage: 'Online verification is off.' },
  reasonNoReferences: { id: 'paperCheck.reasonNoReferences', defaultMessage: 'No reference list found.' },
  reasonNetworkUnavailable: {
    id: 'paperCheck.reasonNetworkUnavailable',
    defaultMessage: 'Crossref could not be reached.',
  },
  reasonMissingProfile: {
    id: 'paperCheck.reasonMissingProfile',
    defaultMessage: 'Enter the names, school or team name to search for.',
  },
  reasonTimedOut: {
    id: 'paperCheck.reasonTimedOut',
    defaultMessage: 'Stopped: the 60-second limit was reached.',
  },
  reasonCheckFailed: { id: 'paperCheck.reasonCheckFailed', defaultMessage: 'The check failed: {detail}' },

  issueQuestionUncovered: {
    id: 'paperCheck.issueQuestionUncovered',
    defaultMessage: 'Question {number} is never mentioned in the paper',
  },
  issueNumberMismatch: {
    id: 'paperCheck.issueNumberMismatch',
    defaultMessage: '{paperValue} does not match {tableValue} in {table} (run {runId})',
  },
  issueFigureMissing: { id: 'paperCheck.issueFigureMissing', defaultMessage: 'Missing {parts}' },
  issueFigureUnreadable: {
    id: 'paperCheck.issueFigureUnreadable',
    defaultMessage: 'Cannot be checked: {reason}',
  },
  issueReferenceUnverified: {
    id: 'paperCheck.issueReferenceUnverified',
    defaultMessage: '[{index}] {title}: could not be verified ({reason})',
  },
  issueReferenceNetwork: {
    id: 'paperCheck.issueReferenceNetwork',
    defaultMessage: '[{index}] {title}: not verified (network)',
  },
  issuePdfStale: { id: 'paperCheck.issuePdfStale', defaultMessage: 'Newer than {pdf}' },
  issuePdfMissing: { id: 'paperCheck.issuePdfMissing', defaultMessage: 'PDF missing: {pdf}' },
  issueAnonymityHit: {
    id: 'paperCheck.issueAnonymityHit',
    defaultMessage: '{field} “{term}” appears here',
  },
  issuePdfUnreadable: {
    id: 'paperCheck.issuePdfUnreadable',
    defaultMessage: 'The PDF text could not be read',
  },

  partXLabel: { id: 'paperCheck.partXLabel', defaultMessage: 'x-axis label' },
  partYLabel: { id: 'paperCheck.partYLabel', defaultMessage: 'y-axis label' },
  partXUnit: { id: 'paperCheck.partXUnit', defaultMessage: 'x-axis unit' },
  partYUnit: { id: 'paperCheck.partYUnit', defaultMessage: 'y-axis unit' },

  figureBitmap: { id: 'paperCheck.figureBitmap', defaultMessage: 'bitmap image' },
  figureUnsupported: { id: 'paperCheck.figureUnsupported', defaultMessage: 'unsupported format' },
  figureNoAxes: { id: 'paperCheck.figureNoAxes', defaultMessage: 'no axis structure found' },
  figureNoText: { id: 'paperCheck.figureNoText', defaultMessage: 'no text layer' },
  figureParseError: { id: 'paperCheck.figureParseError', defaultMessage: 'could not be parsed' },

  referenceDoiNotFound: { id: 'paperCheck.referenceDoiNotFound', defaultMessage: 'DOI not found' },
  referenceDoiMismatch: {
    id: 'paperCheck.referenceDoiMismatch',
    defaultMessage: 'DOI belongs to another title',
  },
  referenceNoMatch: { id: 'paperCheck.referenceNoMatch', defaultMessage: 'no matching record' },
  referenceNoIdentifier: { id: 'paperCheck.referenceNoIdentifier', defaultMessage: 'no DOI or title' },

  fieldName: { id: 'paperCheck.fieldName', defaultMessage: 'Name' },
  fieldSchool: { id: 'paperCheck.fieldSchool', defaultMessage: 'School' },
  fieldTeam: { id: 'paperCheck.fieldTeam', defaultMessage: 'Team name' },
});

type MessageKey = keyof typeof i18n;

const ITEM_TITLES: Record<PaperCheckItemId, MessageKey> = {
  'question-coverage': 'itemQuestionCoverage',
  'number-consistency': 'itemNumberConsistency',
  'figure-labels': 'itemFigureLabels',
  references: 'itemReferences',
  'pdf-freshness': 'itemPdfFreshness',
  anonymity: 'itemAnonymity',
};

const VERDICTS: Record<PaperCheckVerdict, MessageKey> = {
  通过: 'verdictPass',
  发现问题: 'verdictIssues',
  无法执行: 'verdictCannotRun',
};

const REASONS: Record<PaperCheckReason, MessageKey> = {
  'missing-problem-statement': 'reasonMissingProblemStatement',
  'missing-paper-source': 'reasonMissingPaperSource',
  'missing-question-numbers': 'reasonMissingQuestionNumbers',
  'missing-run-records': 'reasonMissingRunRecords',
  'no-result-tables': 'reasonNoResultTables',
  'no-linked-values': 'reasonNoLinkedValues',
  'no-figures': 'reasonNoFigures',
  'figures-unreadable': 'reasonFiguresUnreadable',
  offline: 'reasonOffline',
  'no-references': 'reasonNoReferences',
  'network-unavailable': 'reasonNetworkUnavailable',
  'missing-profile': 'reasonMissingProfile',
  'timed-out': 'reasonTimedOut',
  'check-failed': 'reasonCheckFailed',
};

const PARTS: Record<string, MessageKey> = {
  'x-label': 'partXLabel',
  'y-label': 'partYLabel',
  'x-unit': 'partXUnit',
  'y-unit': 'partYUnit',
};

const FIGURE_REASONS: Record<string, MessageKey> = {
  bitmap: 'figureBitmap',
  'unsupported-format': 'figureUnsupported',
  'no-axes-structure': 'figureNoAxes',
  'no-text': 'figureNoText',
  'parse-error': 'figureParseError',
};

const REFERENCE_REASONS: Record<string, MessageKey> = {
  'doi-not-found': 'referenceDoiNotFound',
  'doi-title-mismatch': 'referenceDoiMismatch',
  'no-match': 'referenceNoMatch',
  'no-identifier': 'referenceNoIdentifier',
};

const FIELDS: Record<string, MessageKey> = {
  name: 'fieldName',
  school: 'fieldSchool',
  team: 'fieldTeam',
};

const ERRORS: Record<string, MessageKey> = {
  PROJECT_NOT_FOUND: 'errorProjectNotFound',
  OUTSIDE_PROJECT: 'errorOutsideProject',
  TIMEOUT: 'errorTimeout',
};

const ONLINE_KEY = 'modelforge.paperCheck.online';
const PROFILE_KEY = 'modelforge.paperCheck.profile';

const PAPER_EXTENSIONS = ['.tex', '.typ', '.md', '.markdown'];

interface StoredProfile {
  anonymous: boolean;
  names: string;
  school: string;
  team: string;
}

const EMPTY_PROFILE: StoredProfile = { anonymous: true, names: '', school: '', team: '' };

function loadProfile(): StoredProfile {
  try {
    const stored = JSON.parse(window.localStorage.getItem(PROFILE_KEY) ?? 'null') as unknown;
    if (typeof stored !== 'object' || stored === null) {
      return EMPTY_PROFILE;
    }
    const value = stored as Partial<Record<keyof StoredProfile, unknown>>;
    return {
      anonymous: typeof value.anonymous === 'boolean' ? value.anonymous : true,
      names: typeof value.names === 'string' ? value.names : '',
      school: typeof value.school === 'string' ? value.school : '',
      team: typeof value.team === 'string' ? value.team : '',
    };
  } catch {
    return EMPTY_PROFILE;
  }
}

/** Main files first (`main.tex`, `paper.typ`, …), LaTeX and Typst before Markdown. */
function paperRank(path: string): number {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const stem = name.replace(/\.[^.]*$/, '');
  const main = /^(main|paper|thesis|report|论文|终稿)$/.test(stem) ? 0 : 1;
  const markdown = name.endsWith('.md') || name.endsWith('.markdown') ? 1 : 0;
  return main * 2 + markdown;
}

function joinPath(root: string, relative: string): string {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  return [base, ...relative.split('/')].join(separator);
}

function VerdictIcon({ verdict }: { verdict: PaperCheckVerdict }) {
  if (verdict === '通过') {
    return <CheckCircle2 aria-hidden className="h-4 w-4 shrink-0 text-text-success" />;
  }
  if (verdict === '发现问题') {
    return <AlertTriangle aria-hidden className="h-4 w-4 shrink-0 text-amber-500" />;
  }
  return <AlertCircle aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />;
}

/**
 * Paper delivery check tab (requirement 18, task 23.10): runs the checks for the chosen paper
 * source and shows every check's verdict and number of issues; an issue with a location opens
 * the file at that line or page.
 */
export default function PaperCheckPanel({ workingDir, onOpenFile }: WorkspaceFeaturePanelProps) {
  const intl = useIntl();
  const idPrefix = useId();
  const ids = {
    paper: `${idPrefix}-paper`,
    names: `${idPrefix}-names`,
    school: `${idPrefix}-school`,
    team: `${idPrefix}-team`,
  };
  const [papers, setPapers] = useState<string[] | null>(null);
  const [paperPath, setPaperPath] = useState('');
  const [online, setOnline] = useState(() => window.localStorage.getItem(ONLINE_KEY) === 'true');
  const [profile, setProfile] = useState<StoredProfile>(loadProfile);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<PaperCheckReport | null>(null);
  const [error, setError] = useState<IpcError | null>(null);
  const [collapsed, setCollapsed] = useState<Set<PaperCheckItemId>>(() => new Set());

  useEffect(() => {
    window.localStorage.setItem(ONLINE_KEY, String(online));
  }, [online]);

  useEffect(() => {
    window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  }, [profile]);

  const scan = useCallback(async () => {
    setPapers(null);
    try {
      const snapshot = await window.electron.workspaceScanProject(workingDir);
      const found = snapshot.artifacts
        .filter(({ stage, relativePath }) => {
          const lower = relativePath.toLowerCase();
          return stage === 'paper' && PAPER_EXTENSIONS.some((extension) => lower.endsWith(extension));
        })
        .map(({ relativePath }) => relativePath)
        .sort((a, b) => paperRank(a) - paperRank(b) || a.localeCompare(b));
      setPapers(found);
      setPaperPath((current) => (found.includes(current) ? current : (found[0] ?? '')));
    } catch {
      setPapers([]);
      setPaperPath('');
    }
  }, [workingDir]);

  useEffect(() => {
    setReport(null);
    setError(null);
    void scan();
  }, [scan]);

  const run = useCallback(async () => {
    if (paperPath === '') {
      return;
    }
    setRunning(true);
    setError(null);
    const request: PaperCheckRequest = {
      projectDir: workingDir,
      paperPath,
      online,
      ...(profile.anonymous
        ? { anonymity: { names: [profile.names], school: profile.school, team: profile.team } }
        : {}),
    };
    try {
      const result = await window.electron.paperCheckRun(request);
      if (result.ok) {
        setReport(result.data);
        setCollapsed(new Set());
      } else {
        setError(result.error);
      }
    } catch (cause) {
      setError({ code: 'IPC_FAILED', message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setRunning(false);
    }
  }, [online, paperPath, profile, workingDir]);

  const format = useCallback(
    (key: MessageKey | undefined, values?: Record<string, string | number>, fallback = '') =>
      key === undefined ? fallback : intl.formatMessage(i18n[key], values),
    [intl]
  );

  const issueText = useCallback(
    (issue: PaperCheckIssue): string => {
      const { params } = issue;
      switch (issue.code) {
        case 'question-uncovered':
          return format('issueQuestionUncovered', { number: params.number ?? '' });
        case 'number-mismatch':
          return format('issueNumberMismatch', {
            paperValue: params.paperValue ?? '',
            tableValue: params.tableValue ?? '',
            table: params.table ?? '',
            runId: params.runId ?? '',
          });
        case 'figure-missing': {
          const parts = String(params.missing ?? '')
            .split(',')
            .filter((part) => part !== '')
            .map((part) => format(PARTS[part], undefined, part));
          return format('issueFigureMissing', { parts: intl.formatList(parts) });
        }
        case 'figure-unreadable':
          return format('issueFigureUnreadable', {
            reason: format(FIGURE_REASONS[String(params.reason)], undefined, String(params.reason)),
          });
        case 'reference-unverified':
          return format('issueReferenceUnverified', {
            index: params.index ?? '',
            title: params.title ?? '',
            reason: format(
              REFERENCE_REASONS[String(params.reason)],
              undefined,
              String(params.reason)
            ),
          });
        case 'reference-network':
          return format('issueReferenceNetwork', {
            index: params.index ?? '',
            title: params.title ?? '',
          });
        case 'pdf-stale':
          return format('issuePdfStale', { pdf: params.pdf ?? '' });
        case 'pdf-missing':
          return format('issuePdfMissing', { pdf: params.pdf ?? '' });
        case 'anonymity-hit':
          return format('issueAnonymityHit', {
            field: format(FIELDS[String(params.field)], undefined, String(params.field)),
            term: params.term ?? '',
          });
        case 'pdf-unreadable':
          return format('issuePdfUnreadable');
        default:
          return issue.message;
      }
    },
    [format, intl]
  );

  const locationText = useCallback(
    (issue: PaperCheckIssue): string | null => {
      if (issue.file === undefined) {
        return null;
      }
      if (issue.line !== undefined) {
        return format('locationLine', { file: issue.file, line: issue.line });
      }
      if (issue.page !== undefined) {
        return format('locationPage', { file: issue.file, page: issue.page });
      }
      return issue.file;
    },
    [format]
  );

  const openIssue = useCallback(
    (issue: PaperCheckIssue) => {
      if (issue.file === undefined) {
        return;
      }
      const location: WorkspaceFileLocation = {};
      if (issue.line !== undefined) {
        location.line = issue.line;
      }
      if (issue.page !== undefined) {
        location.page = issue.page;
      }
      onOpenFile(
        {
          name: issue.file.slice(issue.file.lastIndexOf('/') + 1),
          path: joinPath(workingDir, issue.file),
          isDirectory: false,
          size: 0,
          modifiedAt: 0,
        },
        location
      );
    },
    [onOpenFile, workingDir]
  );

  const toggle = useCallback((id: PaperCheckItemId) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const errorText = useMemo(() => {
    if (error === null) {
      return null;
    }
    const known = ERRORS[error.code];
    return format('failed', { detail: known === undefined ? error.message : format(known) });
  }, [error, format]);

  const inputClass =
    'w-full rounded border border-border-primary bg-background-primary px-2 py-1 text-xs text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-info';

  const renderItem = (entry: PaperCheckItem) => {
    const open = !collapsed.has(entry.id);
    const hasDetails = entry.issues.length > 0 || entry.reason !== undefined;
    const reason =
      entry.reason === undefined
        ? null
        : format(REASONS[entry.reason], { detail: entry.reasonDetail ?? '' }, entry.reason);
    return (
      <li key={entry.id} className="rounded border border-border-primary">
        <button
          type="button"
          onClick={() => toggle(entry.id)}
          aria-expanded={hasDetails ? open : undefined}
          disabled={!hasDetails}
          className="flex w-full items-center gap-2 px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-info disabled:cursor-default"
        >
          {hasDetails ? (
            open ? (
              <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
            ) : (
              <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
            )
          ) : (
            <span className="h-3.5 w-3.5 shrink-0" />
          )}
          <VerdictIcon verdict={entry.verdict} />
          <span className="min-w-0 flex-1 truncate text-xs text-text-primary">
            {format(ITEM_TITLES[entry.id], undefined, entry.id)}
          </span>
          <span className="shrink-0 text-[11px] text-text-secondary">
            {format(VERDICTS[entry.verdict], undefined, entry.verdict)}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-text-tertiary">
            {format('issueCount', { count: entry.issues.length + (entry.omittedIssues ?? 0) })}
          </span>
        </button>
        {open && hasDetails && (
          <div className="border-t border-border-primary px-2 py-1.5">
            {reason !== null && <p className="text-[11px] text-text-secondary">{reason}</p>}
            {entry.issues.length > 0 && (
              <ul className="mt-1 flex flex-col gap-0.5">
                {entry.issues.map((issue, index) => {
                  const where = locationText(issue);
                  const content = (
                    <>
                      <span className="block text-xs text-text-primary">{issueText(issue)}</span>
                      {where !== null && (
                        <span className="block truncate font-mono text-[10px] text-text-tertiary">
                          {where}
                        </span>
                      )}
                    </>
                  );
                  return (
                    <li key={`${issue.code}-${index}`}>
                      {issue.file !== undefined ? (
                        <button
                          type="button"
                          onClick={() => openIssue(issue)}
                          className="w-full rounded px-1.5 py-1 text-left hover:bg-background-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-info"
                        >
                          {content}
                        </button>
                      ) : (
                        <div className="px-1.5 py-1">{content}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {entry.omittedIssues !== undefined && (
              <p className="mt-1 text-[11px] text-text-tertiary">
                {format('omitted', { count: entry.omittedIssues })}
              </p>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="paper-check-panel">
      <div className="flex flex-col gap-2 border-b border-border-primary px-3 py-2">
        <div>
          <h2 className="text-xs font-medium text-text-primary">{format('title')}</h2>
          <p className="text-[11px] text-text-tertiary">{format('description')}</p>
        </div>

        <div className="flex items-end gap-1.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <label htmlFor={ids.paper} className="text-[11px] text-text-secondary">
              {format('paperLabel')}
            </label>
            <select
              id={ids.paper}
              value={paperPath}
              onChange={(event) => setPaperPath(event.target.value)}
              disabled={papers === null || papers.length === 0 || running}
              className={inputClass}
            >
              {(papers ?? []).map((paper) => (
                <option key={paper} value={paper}>
                  {paper}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => void scan()}
            disabled={running}
            title={format('rescan')}
            aria-label={format('rescan')}
            className="rounded p-1.5 text-text-tertiary hover:bg-background-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-info"
          >
            <RefreshCw aria-hidden className="h-3.5 w-3.5" />
          </button>
        </div>
        {papers === null && <p className="text-[11px] text-text-tertiary">{format('loadingPapers')}</p>}
        {papers !== null && papers.length === 0 && (
          <p className="text-[11px] text-text-secondary">{format('noPaper')}</p>
        )}

        <label className="flex items-start gap-1.5 text-xs text-text-primary">
          <input
            type="checkbox"
            checked={online}
            onChange={(event) => setOnline(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            {format('online')}
            <span className="block text-[11px] text-text-tertiary">{format('onlineHint')}</span>
          </span>
        </label>

        <label className="flex items-start gap-1.5 text-xs text-text-primary">
          <input
            type="checkbox"
            checked={profile.anonymous}
            onChange={(event) =>
              setProfile((current) => ({ ...current, anonymous: event.target.checked }))
            }
            className="mt-0.5"
          />
          <span>
            {format('anonymous')}
            <span className="block text-[11px] text-text-tertiary">{format('anonymousHint')}</span>
          </span>
        </label>
        {profile.anonymous && (
          <div className="grid grid-cols-1 gap-1.5 pl-5">
            {(
              [
                ['names', ids.names, 'names'],
                ['school', ids.school, 'school'],
                ['team', ids.team, 'team'],
              ] as const
            ).map(([field, id, label]) => (
              <div key={field} className="flex flex-col gap-0.5">
                <label htmlFor={id} className="text-[11px] text-text-secondary">
                  {format(label)}
                </label>
                <input
                  id={id}
                  type="text"
                  value={profile[field]}
                  placeholder={field === 'names' ? format('namesPlaceholder') : undefined}
                  onChange={(event) => {
                    const value = event.target.value;
                    setProfile((current) => {
                      const next = { ...current };
                      next[field] = value;
                      return next;
                    });
                  }}
                  className={inputClass}
                />
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => void run()}
          disabled={running || paperPath === ''}
          className="flex items-center justify-center gap-1.5 rounded bg-background-info px-3 py-1.5 text-xs text-text-inverse hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-info disabled:opacity-50"
        >
          {running && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />}
          {format(running ? 'running' : 'run')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" aria-live="polite">
        {errorText !== null && (
          <p role="alert" className="mb-2 text-xs text-text-danger">
            {errorText}
          </p>
        )}
        {report === null ? (
          errorText === null && <p className="text-[11px] text-text-tertiary">{format('empty')}</p>
        ) : (
          <>
            <ul className={cn('flex flex-col gap-1.5', running && 'opacity-60')}>
              {report.items.map(renderItem)}
            </ul>
            <p className="mt-2 text-[10px] text-text-tertiary">
              {format('finishedAt', {
                time: intl.formatTime(new Date(report.finishedAt), {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                }),
              })}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
