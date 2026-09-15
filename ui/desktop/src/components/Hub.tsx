/**
 * Hub Component
 *
 * The empty-chat landing screen. Visually it's "Pair with no messages yet" —
 * a large time + greeting above a centered, narrower ChatInput. Submitting
 * creates a session and navigates to /pair so the rest of the chat lifecycle
 * lives there.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { defineMessages, useIntl } from '../i18n';
import { AppEvents } from '../constants/events';
import ChatInput from './ChatInput';
import { ChatInputCard } from './ChatInputCard';
import { ChatState } from '../types/chatState';
import 'react-toastify/dist/ReactToastify.css';
import { View, ViewOptions } from '../utils/navigationUtils';
import { useConfig } from './ConfigContext';
import { getEffectiveWorkingDir, getInitialWorkingDir } from '../utils/workingDir';
import { createSession } from '../sessions';
import LoadingGoose from './LoadingGoose';
import { UserInput } from '../types/message';
import {
  createNextChatExtensionDraft,
  selectNextChatExtensions,
  type NextChatExtensionDraft,
} from '../utils/nextChatExtensions';
import { formatAcpError } from '../acp/errors';
import { toastError } from '../toasts';
import { formatClockDisplay } from '../utils/timeUtils';
import { takeComposerSeed } from '../utils/composerSeed';
import { ModelForgeMark } from './icons/ModelForge';
import {
  BarChart3,
  Check,
  ChevronDown,
  ArrowRight,
  FolderOpen,
  ClipboardCheck,
  Database,
  FileText,
  MessageSquare,
  PenLine,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import WorkspaceToolbar from './workspace/WorkspaceToolbar';
import WorkspacePanel from './workspace/WorkspacePanel';
import WorkspaceEditorView from './workspace/WorkspaceEditorView';
import { useWorkspacePanel } from './workspace/useWorkspacePanel';
import { useWorkspaceShortcuts } from '../hooks/useWorkspaceShortcuts';
import {
  CONTEST_PRESETS,
  EXAMPLE_PROBLEMS,
  WORKFLOW_PRESETS,
  type ContestPreset,
  type WorkflowPreset,
} from '../catalog/homePresets';
import { cn } from '../utils';

const i18n = defineMessages({
  projectMaterials: {
    id: 'hub.projectMaterials',
    defaultMessage: 'View project materials and next steps',
  },
  chooseProject: { id: 'hub.chooseProject', defaultMessage: 'Choose a folder to begin' },
  goodMorning: { id: 'hub.goodMorning', defaultMessage: 'Good morning' },
  goodAfternoon: { id: 'hub.goodAfternoon', defaultMessage: 'Good afternoon' },
  goodEvening: { id: 'hub.goodEvening', defaultMessage: 'Good evening' },
  appTitle: { id: 'hub.appTitle', defaultMessage: 'Mathematical Modeling Assistant' },
  workflowLabel: { id: 'hub.workflowLabel', defaultMessage: 'Workflow' },
  paperLabel: { id: 'hub.paperLabel', defaultMessage: 'Paper' },
  contestLabel: { id: 'hub.contestLabel', defaultMessage: 'Contest' },
  contestInfo: { id: 'hub.contestInfo', defaultMessage: 'Contest info' },
  freeChat: { id: 'hub.freeChat', defaultMessage: 'Free chat' },
  freeChatHint: {
    id: 'hub.freeChatHint',
    defaultMessage: 'No preset workflow; start from your own input',
  },
  examplesTitle: { id: 'hub.examplesTitle', defaultMessage: 'Try one of these contest problems' },
  exampleNeedsInput: {
    id: 'hub.exampleNeedsInput',
    defaultMessage: 'Statement not bundled — add it yourself',
  },
  exampleReady: { id: 'hub.exampleReady', defaultMessage: 'Statement and attachments included' },
});

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(interval);
  }, []);

  return formatClockDisplay(now);
}

export default function Hub({
  setView,
  draftRef,
}: {
  setView: (view: View, viewOptions?: ViewOptions) => void;
  /** Unsent input of this screen, kept above the route outlet across the unmount. */
  draftRef: RefObject<string>;
}) {
  const intl = useIntl();
  const { extensionsList } = useConfig();
  const [workingDir, setWorkingDir] = useState(getInitialWorkingDir());
  const userSelectedWorkingDirRef = useRef(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [nextChatExtensionDraft, setNextChatExtensionDraft] =
    useState<NextChatExtensionDraft | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { time, meridiem, hour } = useClock();
  const workspacePanel = useWorkspacePanel();
  const { clearActiveFile } = workspacePanel;

  useWorkspaceShortcuts(true, {
    onTogglePanel: workspacePanel.toggle,
    onToggleEditor: () =>
      workspacePanel.isEditorOpen ? workspacePanel.closeEditor() : workspacePanel.openEditor(),
  });

  // Re-resolve the working dir on mount: GOOSE_WORKING_DIR is fixed at window
  // creation, so a configured remote directory may have changed since then.
  useEffect(() => {
    let active = true;
    void getEffectiveWorkingDir().then((dir) => {
      if (active && !userSelectedWorkingDirRef.current) setWorkingDir(dir);
    });
    return () => {
      active = false;
    };
  }, []);

  const greeting = useMemo(() => {
    if (hour < 12) return intl.formatMessage(i18n.goodMorning);
    if (hour < 18) return intl.formatMessage(i18n.goodAfternoon);
    return intl.formatMessage(i18n.goodEvening);
  }, [intl, hour]);

  const draftForMenu = useMemo(
    () => nextChatExtensionDraft ?? createNextChatExtensionDraft(extensionsList),
    [extensionsList, nextChatExtensionDraft]
  );

  // rAF is more reliable than autoFocus across async render boundaries.
  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frameId);
  }, []);

  const handleNextChatExtensionDraftChange = useCallback((draft: NextChatExtensionDraft) => {
    setNextChatExtensionDraft(draft);
  }, []);

  const handleWorkingDirChange = useCallback((dir: string) => {
    userSelectedWorkingDirRef.current = true;
    setWorkingDir(dir);
  }, []);

  // Presets only shape the prompt, so they are held here and composed on demand.
  const [workflowId, setWorkflowId] = useState<WorkflowPreset['id'] | null>(null);
  const [contestId, setContestId] = useState<ContestPreset['id'] | null>(null);
  const [presetPrompt, setPresetPrompt] = useState<{
    id: string;
    text: string;
    mode?: 'append';
  } | null>(null);
  useEffect(() => clearActiveFile(), [workingDir, clearActiveFile]);

  // The figure and paper catalogue pages queue a prompt before navigating here, because
  // the composer only exists on this route.
  useEffect(() => {
    const seed = takeComposerSeed();
    if (seed) setPresetPrompt(seed);
  }, []);

  const workflow = useMemo(
    () => WORKFLOW_PRESETS.find((item) => item.id === workflowId) ?? null,
    [workflowId]
  );
  const contest = useMemo(
    () => CONTEST_PRESETS.find((item) => item.id === contestId) ?? null,
    [contestId]
  );

  /**
   * Builds the composer text for a selection. The workflow leads (it is the task
   * instruction) and the contest requirement is appended as a formatting note.
   */
  const composePrompt = useCallback(
    (nextWorkflow: WorkflowPreset | null, nextContest: ContestPreset | null, task = '') => {
      const parts: string[] = [];
      if (nextWorkflow) parts.push(nextWorkflow.prompt);
      if (nextContest && nextContest.id !== 'custom') parts.push(nextContest.prompt);
      if (task) parts.push(task);
      return parts.join('\n\n');
    },
    []
  );

  const applyPreset = useCallback(
    (nextWorkflow: WorkflowPreset | null, nextContest: ContestPreset | null, task = '') => {
      const text = composePrompt(nextWorkflow, nextContest, task);
      if (!text) return;
      // The id forces a re-apply when the text is identical (e.g. re-clicking the
      // same example after clearing the composer).
      setPresetPrompt({
        id: `${nextWorkflow?.id ?? 'none'}:${nextContest?.id ?? 'none'}:${task.slice(0, 24)}:${Date.now()}`,
        text,
      });
    },
    [composePrompt]
  );

  const handleWorkflowSelect = useCallback(
    (next: WorkflowPreset) => {
      const selected = workflow?.id === next.id ? null : next;
      setWorkflowId(selected?.id ?? null);
      if (selected) applyPreset(selected, contest);
    },
    [workflow, contest, applyPreset]
  );

  const handleContestSelect = useCallback(
    (next: ContestPreset) => {
      const selected = contest?.id === next.id ? null : next;
      setContestId(selected?.id ?? null);
      if (workflow) applyPreset(workflow, selected);
    },
    [workflow, contest, applyPreset]
  );

  const handleExampleSelect = useCallback(
    (problem: (typeof EXAMPLE_PROBLEMS)[number]) => {
      applyPreset(workflow, contest, problem.prompt);
    },
    [workflow, contest, applyPreset]
  );

  const handleSubmit = async (input: UserInput) => {
    const { msg: userMessage, images } = input;
    if (!(images.length > 0 || userMessage.trim()) || isCreatingSession) return;

    const draftAtSubmit = draftRef.current;
    setIsCreatingSession(true);

    try {
      const selectedExtensions = nextChatExtensionDraft
        ? selectNextChatExtensions(extensionsList, nextChatExtensionDraft)
        : [];
      const sessionOptions =
        selectedExtensions.length > 0
          ? { extensionConfigs: selectedExtensions }
          : { allExtensions: extensionsList };

      // Resolve the effective directory at submit time: the IPC lookup may still
      // be pending when the user submits, and an explicit pick must win.
      const dir = userSelectedWorkingDirRef.current ? workingDir : await getEffectiveWorkingDir();
      const session = await createSession(dir, sessionOptions);
      setNextChatExtensionDraft(null);

      window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED));
      window.dispatchEvent(
        new CustomEvent(AppEvents.ADD_ACTIVE_SESSION, {
          detail: { sessionId: session.id, initialMessage: { msg: userMessage, images } },
        })
      );

      // The draft is this screen's own, so it is dropped once the session exists.
      // Comparing it against the value at submit leaves an edit made while the
      // session was starting alone, including one that emptied the input.
      if (draftRef.current === draftAtSubmit) {
        draftRef.current = '';
      }

      setView('pair', {
        disableAnimation: true,
        resumeSessionId: session.id,
        initialMessage: { msg: userMessage, images },
      });
    } catch (error) {
      console.error('Failed to create session:', error);
      toastError({ title: "Couldn't start chat", msg: formatAcpError(error) });
      setIsCreatingSession(false);
    }
  };

  const editorVisible = workspacePanel.isEditorOpen && Boolean(workingDir);

  return (
    <div className="flex h-full min-h-0 flex-row">
      <div
        className={cn(
          'relative flex h-full min-h-0 flex-col overflow-hidden',
          editorVisible ? 'w-[24vw] min-w-[260px] max-w-[360px] shrink-0' : 'flex-1'
        )}
      >
        <div className="absolute right-4 top-[14px] z-[60] flex flex-row items-center gap-2">
          <WorkspaceToolbar
            isOpen={workspacePanel.isOpen}
            isEditorOpen={workspacePanel.isEditorOpen}
            activeTab={workspacePanel.tab}
            onSelect={workspacePanel.selectTab}
            onToggleEditor={() =>
              workspacePanel.isEditorOpen
                ? workspacePanel.closeEditor()
                : workspacePanel.openEditor()
            }
            onToggle={workspacePanel.toggle}
          />
        </div>

        <div className="flex flex-col h-full min-h-0 items-center justify-center px-6 relative overflow-y-auto">
          <div className="w-full max-w-2xl py-8">
            <div className="mb-6 flex flex-col items-center text-center">
              <div className="mb-3 flex items-center gap-3">
                <ModelForgeMark className="h-9 w-9" />
                <h1 className="text-3xl font-light tracking-tight text-text-primary">
                  {intl.formatMessage(i18n.appTitle)}
                </h1>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-sm text-text-secondary tabular-nums">{time}</span>
                {meridiem ? <span className="text-xs text-text-tertiary">{meridiem}</span> : null}
                <span className="text-sm text-text-secondary">{greeting}</span>
              </div>
            </div>

            <PresetBar
              workflow={workflow}
              contest={contest}
              onWorkflowSelect={handleWorkflowSelect}
              onContestSelect={handleContestSelect}
              labels={{
                workflow: intl.formatMessage(i18n.workflowLabel),
                paper: intl.formatMessage(i18n.paperLabel),
                contestLabel: intl.formatMessage(i18n.contestLabel),
                contestInfo: intl.formatMessage(i18n.contestInfo),
                freeChat: intl.formatMessage(i18n.freeChat),
                freeChatHint: intl.formatMessage(i18n.freeChatHint),
              }}
            />

            <ChatInputCard>
              <ChatInput
                sessionId={null}
                draftRef={draftRef}
                handleSubmit={handleSubmit}
                chatState={isCreatingSession ? ChatState.LoadingConversation : ChatState.Idle}
                onStop={() => {}}
                initialValue=""
                setView={setView}
                totalTokens={0}
                accumulatedInputTokens={0}
                accumulatedOutputTokens={0}
                droppedFiles={[]}
                onFilesProcessed={() => {}}
                messages={[]}
                disableAnimation={false}
                workingDir={workingDir}
                onWorkingDirChange={handleWorkingDirChange}
                inputRef={inputRef}
                nextChatExtensionDraft={draftForMenu}
                onNextChatExtensionDraftChange={handleNextChatExtensionDraftChange}
                presetPrompt={presetPrompt}
              />
            </ChatInputCard>

            <button
              type="button"
              onClick={() => workspacePanel.selectTab('project')}
              className="mt-4 flex w-full items-center gap-3 rounded-lg border border-border-primary px-3 py-3 text-left text-text-primary transition-colors hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-info motion-reduce:transition-none"
            >
              <FolderOpen aria-hidden="true" className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  {intl.formatMessage(i18n.projectMaterials)}
                </span>
                <span className="mt-1 block truncate font-mono text-xs" title={workingDir}>
                  {workingDir || intl.formatMessage(i18n.chooseProject)}
                </span>
              </span>
              <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0" />
            </button>

            <section className="mt-6">
              <h2 className="mb-2 text-xs font-medium text-text-secondary">
                {intl.formatMessage(i18n.examplesTitle)}
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {EXAMPLE_PROBLEMS.map((problem) => (
                  <button
                    key={problem.id}
                    onClick={() => handleExampleSelect(problem)}
                    className="flex flex-col rounded-xl border border-border-secondary p-3 text-left transition-colors hover:border-border-primary"
                  >
                    <span className="text-[11px] text-text-tertiary">{problem.label}</span>
                    <span className="mt-1 line-clamp-2 text-sm text-text-primary">
                      {problem.title}
                    </span>
                    <span className="mt-2 flex flex-wrap gap-1">
                      {problem.methods.map((method) => (
                        <span
                          key={method}
                          className="rounded-full bg-background-secondary px-1.5 py-0.5 text-[10px] text-text-secondary"
                        >
                          {method}
                        </span>
                      ))}
                    </span>
                    {problem.dataReady ? (
                      <span className="mt-2 text-[10px] text-text-tertiary">
                        {intl.formatMessage(i18n.exampleReady)}
                      </span>
                    ) : (
                      <span className="mt-2 text-[10px] text-text-tertiary">
                        {intl.formatMessage(i18n.exampleNeedsInput)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </section>
          </div>

          {isCreatingSession && (
            <div className="absolute bottom-4 left-4 z-20 pointer-events-none">
              <LoadingGoose chatState={ChatState.LoadingConversation} />
            </div>
          )}
        </div>
      </div>

      {workspacePanel.isEditorOpen && Boolean(workingDir) && (
        <WorkspaceEditorView
          activeFile={workspacePanel.activeFile}
          workingDir={workingDir}
          onClose={workspacePanel.closeEditor}
          onClearFile={workspacePanel.clearActiveFile}
        />
      )}

      {workspacePanel.isMounted && (
        <WorkspacePanel
          isOpen={workspacePanel.isOpen}
          isAgentActive={isCreatingSession}
          isEditorOpen={workspacePanel.isEditorOpen}
          onOpenFile={workspacePanel.openFile}
          onRevealFile={workspacePanel.revealFile}
          onCompose={(text) =>
            setPresetPrompt({ id: window.crypto.randomUUID(), text, mode: 'append' })
          }
          onWorkingDirChange={handleWorkingDirChange}
          onSelectTab={workspacePanel.selectTab}
          tab={workspacePanel.tab}
          onClose={workspacePanel.close}
          workingDir={workingDir}
        />
      )}
    </div>
  );
}

/** Workflow / contest quick actions shown above the composer. */
function PresetBar({
  workflow,
  contest,
  onWorkflowSelect,
  onContestSelect,
  labels,
}: {
  workflow: WorkflowPreset | null;
  contest: ContestPreset | null;
  onWorkflowSelect: (preset: WorkflowPreset) => void;
  onContestSelect: (preset: ContestPreset) => void;
  labels: {
    workflow: string;
    paper: string;
    contestLabel: string;
    contestInfo: string;
    freeChat: string;
    freeChatHint: string;
  };
}) {
  const workflowIcons: Record<string, React.ReactNode> = {
    paper: <FileText className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />,
    'modeling-report': <PenLine className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />,
    'figure-set': <BarChart3 className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />,
    review: <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />,
    'data-search': <Database className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />,
  };

  const triggerClass =
    'flex items-center gap-1.5 rounded-full border border-border-secondary px-2.5 py-1 text-xs text-text-secondary transition-colors hover:border-border-primary hover:text-text-primary';

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-border-secondary px-3 py-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className={triggerClass}>
            <WorkflowIcon />
            {workflow?.title ?? labels.freeChat}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80">
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() => workflow && onWorkflowSelect(workflow)}
          >
            <div className="flex w-full items-start gap-2">
              <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-text-primary">{labels.freeChat}</p>
                <p className="text-[11px] text-text-tertiary">{labels.freeChatHint}</p>
              </div>
              {!workflow && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-info" />}
            </div>
          </DropdownMenuItem>
          {WORKFLOW_PRESETS.map((preset) => (
            <DropdownMenuItem
              key={preset.id}
              className="cursor-pointer"
              onClick={() => onWorkflowSelect(preset)}
            >
              <div className="flex w-full items-start gap-2">
                {workflowIcons[preset.id]}
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-text-primary">{preset.title}</p>
                  <p className="text-[11px] text-text-tertiary">{preset.description}</p>
                </div>
                {workflow?.id === preset.id && (
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-info" />
                )}
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className={triggerClass}>
            <PaperIcon />
            {contest?.label ?? labels.contestLabel}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
          {CONTEST_PRESETS.map((preset) => (
            <DropdownMenuItem
              key={preset.id}
              className="cursor-pointer"
              onClick={() => onContestSelect(preset)}
            >
              <PaperIcon />
              <span className="min-w-0 flex-1 truncate text-xs">{preset.label}</span>
              {contest?.id === preset.id && (
                <Check className="h-3.5 w-3.5 shrink-0 text-text-info" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        onClick={() => window.open('https://www.mcm.edu.cn/', '_blank')}
        className="ml-auto flex items-center gap-1 rounded-full border border-border-secondary px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:text-text-primary"
      >
        <InfoIcon />
        {labels.contestInfo}
      </button>
    </div>
  );
}

function WorkflowIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <circle cx="4" cy="4" r="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M4 6v4a2 2 0 0 0 2 2h4" />
    </svg>
  );
}

function PaperIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <rect x="3" y="2" width="10" height="12" rx="1.5" />
      <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.5v4M8 5.2v.6" />
    </svg>
  );
}
