import { AppEvents } from '../constants/events';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defineMessages, useIntl } from '../i18n';
import { useLocation, useNavigate } from 'react-router';
import { SearchView } from './conversation/SearchView';
import LoadingGoose from './LoadingGoose';
import ActivityStatus from './ActivityStatus';
import WorkspacePanel from './workspace/WorkspacePanel';
import WorkspaceEditorView from './workspace/WorkspaceEditorView';
import WorkspaceToolbar from './workspace/WorkspaceToolbar';
import { useWorkspacePanel } from './workspace/useWorkspacePanel';
import { useWorkspaceShortcuts } from '../hooks/useWorkspaceShortcuts';
import ProgressiveMessageList from './ProgressiveMessageList';
import { MainPanelLayout } from './Layout/MainPanelLayout';
import ChatInput from './ChatInput';
import { ChatInputCard } from './ChatInputCard';
import { Button } from './ui/button';
import { ScrollArea, ScrollAreaHandle } from './ui/scroll-area';
import { useFileDrop } from '../hooks/useFileDrop';
import { ChatState } from '../types/chatState';
import { ChatType } from '../types/chat';
import { useIsMobile } from '../hooks/use-mobile';
import { useNavigationContextSafe } from './Layout/NavigationContext';
import { cn } from '../utils';
import { useChatSession } from '../hooks/useChatSession';
import { acpDeleteSession, acpUpdateWorkingDir } from '../acp/sessions';
import { useNavigation } from '../hooks/useNavigation';
import { RecipeHeader } from './RecipeHeader';
import { RecipeWarningModal } from './ui/RecipeWarningModal';
import { scanRecipe } from '../recipe';
import type { Recipe } from '../recipe';
import RecipeActivities from './recipes/RecipeActivities';
import {
  getTextAndImageContent,
  type ImageData,
  type Message,
  type UserInput,
} from '../types/message';
import { substituteParameters } from '../utils/parameterSubstitution';
import { useAutoSubmit } from '../hooks/useAutoSubmit';
import { ModelForgeWordmark } from './icons/ModelForge';
import { REPOSITORY_URL } from '../branding';
import EnvironmentBadge from './GooseSidebar/EnvironmentBadge';
import SessionActionsHeader from './SessionActionsHeader';
import { isAcpRecovering, subscribeToAcpRecovery } from '../acp/acpConnection';
import { estimateTokensFromChars } from '../utils/tokenEstimate';

const i18n = defineMessages({
  failedToLoadSession: {
    id: 'baseChat.failedToLoadSession',
    defaultMessage: 'Failed to Load Session',
  },
  goHome: {
    id: 'baseChat.goHome',
    defaultMessage: 'Go home',
  },
  retry: {
    id: 'baseChat.retry',
    defaultMessage: 'Retry',
  },
  reconnecting: {
    id: 'baseChat.reconnecting',
    defaultMessage: 'Connection lost. Reconnecting…',
  },
});

const isUserMessage = (message: Message) => message.role === 'user';

interface BaseChatProps {
  setChat: (chat: ChatType) => void;
  onMessageSubmit?: (message: string) => void;
  renderHeader?: () => React.ReactNode;
  customChatInputProps?: Record<string, unknown>;
  customMainLayoutProps?: Record<string, unknown>;
  contentClassName?: string;
  disableSearch?: boolean;
  suppressEmptyState: boolean;
  sessionId: string;
  isActiveSession: boolean;
  initialMessage?: UserInput;
  noAutoSubmit?: boolean;
}

export default function BaseChat({
  setChat,
  renderHeader,
  customChatInputProps = {},
  customMainLayoutProps = {},
  sessionId,
  initialMessage,
  noAutoSubmit,
  isActiveSession,
}: BaseChatProps) {
  const intl = useIntl();
  const location = useLocation();
  const navigate = useNavigate();
  const scrollRef = useRef<ScrollAreaHandle>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const disableAnimation = location.state?.disableAnimation || false;
  const [hasStartedUsingRecipe, setHasStartedUsingRecipe] = React.useState(false);
  const workspacePanel = useWorkspacePanel(isActiveSession);
  const { clearActiveFile } = workspacePanel;
  const [projectPrompt, setProjectPrompt] = useState<{
    id: string;
    text: string;
    mode?: 'append';
  } | null>(null);

  useWorkspaceShortcuts(isActiveSession, {
    onTogglePanel: workspacePanel.toggle,
    onToggleEditor: () =>
      workspacePanel.isEditorOpen ? workspacePanel.closeEditor() : workspacePanel.openEditor(),
  });
  const [hasNotAcceptedRecipe, setHasNotAcceptedRecipe] = useState<boolean>();
  const [hasRecipeSecurityWarnings, setHasRecipeSecurityWarnings] = useState(false);
  const [acpRecovering, setAcpRecovering] = useState(isAcpRecovering);
  const isMobile = useIsMobile();
  const navContext = useNavigationContextSafe();
  const setView = useNavigation();
  const isNavCollapsed = !navContext?.isNavExpanded;
  const contentClassName = cn('pr-1 pb-10 pt-12', (isMobile || isNavCollapsed) && 'pt-16');
  const { droppedFiles, setDroppedFiles, handleDrop, handleDragOver } = useFileDrop();
  const onStreamFinish = useCallback(() => {}, []);

  useEffect(() => subscribeToAcpRecovery(setAcpRecovering), []);

  const {
    session,
    messages,
    chatState,
    progressMessage,
    updateSession,
    handleSubmit,
    onSteerQueuedMessage,
    submitElicitationResponse,
    stopStreaming,
    retrySessionLoad,
    sessionLoadError,
    tokenState,
    notifications: toolCallNotifications,
    pauseQueueOnStop,
    queueProcessingBlocked,
    onMessageUpdate,
  } = useChatSession({
    sessionId,
    onStreamFinish,
  });
  const appendToChat = useCallback(
    (text: string) => handleSubmit({ msg: text, images: [] }),
    [handleSubmit]
  );

  const handleWorkingDirChange = useCallback(
    async (newDir: string) => {
      if (!session) {
        throw new Error('Cannot update working directory before ACP session is loaded');
      }
      await acpUpdateWorkingDir(session.id, newDir);
      updateSession((currentSession) => ({ ...currentSession, working_dir: newDir }));
    },
    [session, updateSession]
  );

  const recipe = session?.recipe as Recipe | null | undefined;
  const workspaceWorkingDir = session?.working_dir ?? '';
  useEffect(() => {
    clearActiveFile();
    setProjectPrompt(null);
  }, [workspaceWorkingDir, sessionId, clearActiveFile]);
  const editorVisible = workspacePanel.isEditorOpen && Boolean(workspaceWorkingDir);

  // The backend reports context usage once per request, so the live indicator would freeze for
  // a whole turn. Estimate what the streaming turn has produced on top of the last report and
  // reset the baseline whenever a fresh report lands (which already includes that output).
  const streamingChars = useMemo(() => {
    if (chatState === ChatState.Idle) return 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (candidate.role === 'assistant' && candidate.metadata.userVisible) {
        return getTextAndImageContent(candidate).textContent.length;
      }
    }
    return 0;
  }, [chatState, messages]);

  const reportedTokens = tokenState?.totalTokens ?? 0;
  const tokenBaselineRef = useRef({ reported: -1, chars: 0 });
  if (tokenBaselineRef.current.reported !== reportedTokens) {
    tokenBaselineRef.current = { reported: reportedTokens, chars: streamingChars };
  }
  const pendingTokens =
    chatState === ChatState.Idle
      ? 0
      : estimateTokensFromChars(Math.max(0, streamingChars - tokenBaselineRef.current.chars));

  const resolvedInitialMessage = useMemo((): UserInput | undefined => {
    if (!initialMessage) return undefined;
    if (recipe?.prompt && session?.user_recipe_values) {
      return {
        ...initialMessage,
        msg: substituteParameters(initialMessage.msg, session.user_recipe_values),
      };
    }
    return initialMessage;
  }, [initialMessage, recipe?.prompt, session?.user_recipe_values]);

  // noAutoSubmit only suppresses auto-submitting the initial prompt of a fresh session
  // (goose://new-session?prompt=...). Once the conversation has messages, later flows
  // such as forks or resumes should auto-submit normally.
  const suppressInitialAutoSubmit = noAutoSubmit && messages.length === 0;
  const canAutoSubmit =
    !acpRecovering &&
    !suppressInitialAutoSubmit &&
    (session?.session_type === 'scheduled' || !recipe || hasNotAcceptedRecipe === false);

  useAutoSubmit({
    sessionId,
    session,
    messages,
    chatState,
    initialMessage: resolvedInitialMessage,
    canAutoSubmit,
    handleSubmit,
  });

  useEffect(() => {
    let streamState: 'idle' | 'loading' | 'streaming' | 'error' = 'idle';
    if (chatState === ChatState.LoadingConversation) {
      streamState = 'loading';
    } else if (
      chatState === ChatState.Streaming ||
      chatState === ChatState.Thinking ||
      chatState === ChatState.Compacting
    ) {
      streamState = 'streaming';
    } else if (sessionLoadError) {
      streamState = 'error';
    }

    window.dispatchEvent(
      new CustomEvent(AppEvents.SESSION_STATUS_UPDATE, {
        detail: {
          sessionId,
          streamState,
          messageCount: messages.length,
        },
      })
    );
  }, [sessionId, chatState, messages.length, sessionLoadError]);

  // Generate command history from user messages (most recent first)
  const commandHistory = useMemo(() => {
    return messages
      .reduce<string[]>((history, message) => {
        if (message.role === 'user') {
          const text = getTextAndImageContent(message).textContent.trim();
          if (text) {
            history.push(text);
          }
        }
        return history;
      }, [])
      .reverse();
  }, [messages]);

  const chatInputSubmit = (input: UserInput) => {
    if (recipe && input.msg.trim()) {
      setHasStartedUsingRecipe(true);
    }
    handleSubmit(input);
  };

  const sessionModel = session?.model_config?.model_name ?? null;
  const sessionProvider = session?.provider_name ?? null;
  const sessionLoaded = session !== undefined;
  const latestInference = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (
        message.role === 'assistant' &&
        message.metadata.userVisible &&
        message.metadata.inference
      ) {
        return message.metadata.inference;
      }
    }
    return null;
  }, [messages]);

  useEffect(() => {
    if (!recipe || !isActiveSession || session?.session_type === 'scheduled') return;

    (async () => {
      const accepted = await window.electron.hasAcceptedRecipeBefore(recipe);
      setHasNotAcceptedRecipe(!accepted);

      if (!accepted) {
        const scanResult = await scanRecipe(recipe);
        setHasRecipeSecurityWarnings(scanResult.has_security_warnings);
      }
    })();
  }, [recipe, isActiveSession, session?.session_type]);

  const handleRecipeAccept = async (accept: boolean) => {
    if (recipe && accept) {
      await window.electron.recordRecipeHash(recipe);
      setHasNotAcceptedRecipe(false);
      return;
    }

    if (sessionId) {
      try {
        await acpDeleteSession(sessionId);
        window.dispatchEvent(new CustomEvent(AppEvents.SESSION_DELETED, { detail: { sessionId } }));
      } catch (error) {
        console.error('Failed to delete declined recipe session:', error);
      }
    }
    setView('chat');
  };

  // Track if this is the initial render for session resuming
  const initialRenderRef = useRef(true);

  // Auto-scroll when messages are loaded (for session resuming)
  const handleRenderingComplete = React.useCallback(() => {
    // Only force scroll on the very first render
    if (initialRenderRef.current && messages.length > 0) {
      initialRenderRef.current = false;
      if (scrollRef.current?.scrollToBottom) {
        scrollRef.current.scrollToBottom();
      }
    } else if (scrollRef.current?.isFollowing) {
      if (scrollRef.current?.scrollToBottom) {
        scrollRef.current.scrollToBottom();
      }
    }
  }, [messages.length]);

  // Listen for global scroll-to-bottom requests (e.g., from MCP App message actions)
  useEffect(() => {
    const handleGlobalScrollRequest = () => {
      // Add a small delay to ensure content has been rendered
      setTimeout(() => {
        if (scrollRef.current?.scrollToBottom) {
          scrollRef.current.scrollToBottom();
        }
      }, 200);
    };

    window.addEventListener(AppEvents.SCROLL_CHAT_TO_BOTTOM, handleGlobalScrollRequest);
    return () =>
      window.removeEventListener(AppEvents.SCROLL_CHAT_TO_BOTTOM, handleGlobalScrollRequest);
  }, []);

  useEffect(() => {
    if (
      isActiveSession &&
      sessionId &&
      chatInputRef.current &&
      chatState !== ChatState.LoadingConversation
    ) {
      const timeoutId = setTimeout(() => {
        chatInputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timeoutId);
    }
    return undefined;
  }, [isActiveSession, sessionId, chatState]);

  useEffect(() => {
    const handleSessionForked = (event: Event) => {
      const customEvent = event as CustomEvent<{
        newSessionId: string;
        shouldStartAgent: boolean;
        editedMessage: string;
        editedImages: ImageData[];
      }>;
      window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED));
      const { newSessionId, shouldStartAgent, editedMessage, editedImages } = customEvent.detail;

      const params = new URLSearchParams();
      params.set('resumeSessionId', newSessionId);
      if (shouldStartAgent) {
        params.set('shouldStartAgent', 'true');
      }

      navigate(`/pair?${params.toString()}`, {
        state: {
          disableAnimation: true,
          initialMessage: { msg: editedMessage, images: editedImages },
        },
      });
    };

    window.addEventListener(AppEvents.SESSION_FORKED, handleSessionForked);

    return () => {
      window.removeEventListener(AppEvents.SESSION_FORKED, handleSessionForked);
    };
  }, [location.pathname, navigate]);

  const lastSetNameRef = useRef<string>('');

  useEffect(() => {
    const currentSessionName = session?.name;
    if (currentSessionName && currentSessionName !== lastSetNameRef.current) {
      lastSetNameRef.current = currentSessionName;
      setChat({
        messages,
        recipe,
        sessionId,
        name: currentSessionName,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.name, setChat]);

  // If we have a recipe prompt and user recipe values, substitute parameters
  let recipePrompt = '';
  if (messages.length === 0 && recipe?.prompt) {
    recipePrompt = session?.user_recipe_values
      ? substituteParameters(recipe.prompt, session.user_recipe_values)
      : recipe.prompt;
  }

  const initialPrompt =
    noAutoSubmit && messages.length === 0 && resolvedInitialMessage?.msg
      ? resolvedInitialMessage.msg
      : recipePrompt;

  if (sessionLoadError) {
    return (
      <div className="h-full flex flex-col min-h-0">
        <MainPanelLayout
          backgroundColor={'bg-background-primary'}
          removeTopPadding={true}
          {...customMainLayoutProps}
        >
          {renderHeader && renderHeader()}
          <div className="flex flex-col flex-1 min-h-0 relative">
            <div className="flex-1 flex items-center justify-center">
              <div className="flex flex-col items-center justify-center p-8">
                <div className="text-red-700 dark:text-red-300 bg-red-400/50 p-4 rounded-lg mb-4 max-w-md">
                  <h3 className="font-semibold mb-2">
                    {intl.formatMessage(i18n.failedToLoadSession)}
                  </h3>
                  <p className="text-sm">{sessionLoadError}</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => void retrySessionLoad()}>
                    {intl.formatMessage(i18n.retry)}
                  </Button>
                  <Button variant="outline" onClick={() => setView('chat')}>
                    {intl.formatMessage(i18n.goHome)}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </MainPanelLayout>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-row min-h-0">
      <div
        className={cn(
          'flex h-full min-h-0 min-w-0 flex-col',
          editorVisible ? 'w-[24vw] min-w-[260px] max-w-[360px] shrink-0' : 'flex-1'
        )}
      >
        <MainPanelLayout
          backgroundColor={'bg-background-primary'}
          removeTopPadding={true}
          {...customMainLayoutProps}
        >
          {/* Custom header */}
          {renderHeader && renderHeader()}

          {/* Chat container with sticky recipe header */}
          <div className="flex flex-col flex-1 min-h-0 relative">
            {/* Brand watermark - top right */}
            <div className="absolute top-[14px] right-4 z-[60] flex flex-row items-center gap-2">
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
              <a
                href={REPOSITORY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="no-drag flex flex-row items-center gap-1 hover:opacity-80 transition-opacity"
              >
                <ModelForgeWordmark className="text-sm leading-none text-text-secondary" />
              </a>
              <EnvironmentBadge className="translate-y-px" />
            </div>

            <SessionActionsHeader session={session} onSessionChange={updateSession} />

            <ScrollArea
              ref={scrollRef}
              className={`flex-1 min-h-0 relative ${contentClassName}`}
              autoScroll
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              data-drop-zone="true"
              paddingX={6}
              paddingY={0}
            >
              {recipe?.title && (
                <div className="sticky top-0 z-10 bg-background-primary px-0 -mx-6 mb-6 pt-6">
                  <RecipeHeader title={recipe.title} />
                </div>
              )}

              {recipe && (
                <div className={hasStartedUsingRecipe ? 'mb-6' : ''}>
                  <RecipeActivities
                    append={appendToChat}
                    activities={Array.isArray(recipe.activities) ? recipe.activities : null}
                    title={recipe.title}
                    parameterValues={session?.user_recipe_values || {}}
                  />
                </div>
              )}

              {messages.length > 0 || recipe ? (
                <>
                  <SearchView>
                    <ProgressiveMessageList
                      messages={messages}
                      sessionId={sessionId}
                      toolCallNotifications={toolCallNotifications}
                      append={appendToChat}
                      isUserMessage={isUserMessage}
                      isStreamingMessage={chatState !== ChatState.Idle}
                      onRenderingComplete={handleRenderingComplete}
                      onMessageUpdate={onMessageUpdate}
                      submitElicitationResponse={submitElicitationResponse}
                    />
                  </SearchView>

                  <ActivityStatus
                    chatState={chatState}
                    messages={messages}
                    progressMessage={progressMessage}
                  />

                  <div className="block h-8" />
                </>
              ) : null}
            </ScrollArea>

            {(chatState === ChatState.LoadingConversation ||
              chatState === ChatState.RestartingAgent) && (
              <div className="absolute bottom-1 left-4 z-20 pointer-events-none">
                <LoadingGoose chatState={chatState} message={progressMessage} />
              </div>
            )}
          </div>

          {acpRecovering && (
            <div role="status" className="mx-4 mb-2 text-sm text-text-secondary">
              {intl.formatMessage(i18n.reconnecting)}
            </div>
          )}

          <ChatInputCard
            className={cn(
              'relative z-30 mx-4 mb-4',
              !disableAnimation && 'animate-[fadein_400ms_ease-in_forwards]'
            )}
          >
            <ChatInput
              inputRef={chatInputRef}
              sessionId={sessionId}
              handleSubmit={chatInputSubmit}
              chatState={chatState}
              onStop={stopStreaming}
              onSteerQueuedMessage={onSteerQueuedMessage}
              pauseQueueOnStop={pauseQueueOnStop}
              queueProcessingBlocked={queueProcessingBlocked || acpRecovering}
              commandHistory={commandHistory}
              initialValue={initialPrompt}
              setView={setView}
              totalTokens={tokenState?.totalTokens ?? session?.usage?.total_tokens ?? undefined}
              pendingTokens={pendingTokens}
              contextLimit={tokenState?.contextLimit}
              accumulatedInputTokens={
                tokenState?.accumulatedInputTokens ??
                session?.accumulated_usage?.input_tokens ??
                undefined
              }
              accumulatedOutputTokens={
                tokenState?.accumulatedOutputTokens ??
                session?.accumulated_usage?.output_tokens ??
                undefined
              }
              accumulatedCost={
                tokenState?.accumulatedCost ?? session?.accumulated_cost ?? undefined
              }
              droppedFiles={droppedFiles}
              onFilesProcessed={() => setDroppedFiles([])} // Clear dropped files after processing
              messages={messages}
              disableAnimation={disableAnimation}
              recipe={recipe}
              recipeAccepted={!hasNotAcceptedRecipe}
              initialPrompt={initialPrompt}
              sessionModel={sessionModel}
              sessionProvider={sessionProvider}
              sessionLoaded={sessionLoaded}
              workingDir={session?.working_dir}
              onWorkingDirChange={handleWorkingDirChange}
              latestInference={latestInference}
              presetPrompt={projectPrompt}
              {...customChatInputProps}
            />
          </ChatInputCard>
        </MainPanelLayout>
      </div>

      {editorVisible && (
        <WorkspaceEditorView
          activeFile={workspacePanel.activeFile}
          workingDir={workspaceWorkingDir}
          onClose={workspacePanel.closeEditor}
          onClearFile={workspacePanel.clearActiveFile}
        />
      )}

      {isActiveSession && workspacePanel.isMounted && (
        <WorkspacePanel
          isOpen={workspacePanel.isOpen && isActiveSession}
          isAgentActive={
            chatState !== ChatState.Idle && chatState !== ChatState.LoadingConversation
          }
          isEditorOpen={workspacePanel.isEditorOpen}
          onOpenFile={workspacePanel.openFile}
          onRevealFile={workspacePanel.revealFile}
          onCompose={(text) =>
            setProjectPrompt({ id: window.crypto.randomUUID(), text, mode: 'append' })
          }
          onWorkingDirChange={handleWorkingDirChange}
          onSelectTab={workspacePanel.selectTab}
          tab={workspacePanel.tab}
          onClose={workspacePanel.close}
          workingDir={workspaceWorkingDir}
        />
      )}

      {recipe && isActiveSession && session?.session_type !== 'scheduled' && (
        <RecipeWarningModal
          isOpen={!!hasNotAcceptedRecipe}
          onConfirm={() => handleRecipeAccept(true)}
          onCancel={() => handleRecipeAccept(false)}
          recipeDetails={{
            title: recipe.title,
            description: recipe.description,
            instructions: recipe.instructions || undefined,
          }}
          hasSecurityWarnings={hasRecipeSecurityWarnings}
        />
      )}
    </div>
  );
}
