import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ChevronDown, Square, X } from 'lucide-react';

import type { BackgroundTaskSummary, ChatMessage } from '@/shared/types';
import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import {
  describeWorkflowAgent,
  findCurrentWorkflowAgent,
  listRunningBackgroundLaunches,
  ownBackgroundTasks,
  readBackgroundTaskId,
  readBackgroundTaskStatus,
} from '@/modules/chat/utils/backgroundTasks';
import {
  hideBackgroundTasks,
  recordTaskStopRequest,
  useBackgroundTaskStops,
} from '@/modules/chat/utils/backgroundTaskStops';
import { parseToolPayload } from '@/modules/chat/utils/messageTransforms';
import { parseWorkflowMeta } from '@/modules/chat/utils/workflowScriptMeta';

type BackgroundTasksStripProps = {
  /** Every loaded row of the session, not the visible window: a task launched pages ago is still running. */
  messages: ChatMessage[];
  /**
   * The session's running tasks as the activity map has them — from the
   * running-sessions poll after a reload, or the rows themselves once the
   * turn ended. A task whose launch row is on a page not loaded yet has no
   * row to draw from and is listed from here, so it can still be stopped.
   */
  tasks?: BackgroundTaskSummary[];
  /** The session the tasks belong to, which `chat.stop-task` names; null before one exists. */
  sessionId: string | null;
  /** The chat websocket's send, for stopping a task. */
  sendMessage: (message: unknown) => void;
  /**
   * Brings a row into view. Owned by the pane's session state because the
   * row may sit outside the visible window or in an unmounted lazy row, so
   * it takes more than an element lookup to reach it.
   */
  onReveal: (message: ChatMessage) => void;
  /** Loads the rest of the transcript, for a task whose launch row is not loaded yet. */
  onLoadAll: () => void;
};

/** The one-line description the launch was given, as the card reads it. */
function readLaunchDescription(message: ChatMessage): string {
  if (message.workflow?.description) {
    return message.workflow.description;
  }
  const input = parseToolPayload(message.toolInput);
  const { description, script } = input && typeof input === 'object'
    ? (input as { description?: unknown; script?: unknown })
    : { description: undefined, script: undefined };
  if (typeof description === 'string' && description) {
    return description;
  }
  // The CLI sets a workflow's description in the script's `meta` header, not
  // in the tool input, and reports it back as the run's first summary.
  return typeof script === 'string' ? parseWorkflowMeta(script).description ?? '' : '';
}

/** What one running task's chip says: its kind, its name, and how far it has got. */
function describeTask(message: ChatMessage, t: TFunction) {
  const live = message.taskStatus;
  const name = message.toolName === 'Workflow'
    ? message.workflow?.name || live?.workflowName || ''
    : message.subagent?.description || live?.description || '';
  const kind = message.toolName === 'Workflow'
    ? t('workflow.title', 'Workflow')
    : message.toolName === 'Bash'
      ? t('workflow.backgroundCommand', 'Command')
      : t('workflow.backgroundAgent', 'Agent');

  // A workflow reports on each agent it spawned — "2/6 agents · audit:sidebar"
  // says how many have finished and the one it is on. Short of that, its own
  // summary, unless it merely restates the launch's description (a workflow's
  // progress opens with it) or the chip's name — that says nothing new and it
  // is long. An agent reports only what it has spent. The history-loaded agent
  // counts stand in for a workflow the live stream has not described yet.
  let agentsProgress = '';
  if (live?.agents?.length) {
    const finished = live.agents.filter((agent) => agent.state === 'done' || agent.state === 'failed').length;
    const current = findCurrentWorkflowAgent(live.agents);
    agentsProgress = t('workflow.agentsProgress', { finished, count: live.agents.length, defaultValue_one: '{{finished}}/{{count}} agent', defaultValue_other: '{{finished}}/{{count}} agents' });
    if (current) {
      agentsProgress += ` · ${describeWorkflowAgent(current)}`;
    }
  }
  const description = readLaunchDescription(message);
  const summary = live?.summary && live.summary !== description && live.summary !== name ? live.summary : '';
  const progress = agentsProgress
    || summary
    || (live?.usage ? `${live.usage.toolUses} ${live.usage.toolUses === 1 ? 'tool' : 'tools'}` : '')
    || (message.workflow && message.workflow.agentCounts.total > 0
      ? `${message.workflow.agentCounts.completed + message.workflow.agentCounts.failed}/${message.workflow.agentCounts.total}`
      : '');

  return { kind, name, progress };
}

/** One running task as the strip lists it, whichever source it came from. */
type StripTask = {
  /** The row's tool id, or the task id for a task with no loaded row. */
  key: string;
  taskId?: string;
  kind: string;
  name: string;
  progress: string;
  title: string;
  /** What tapping it does: scroll to its card, or load the transcript to reach it. None for a nested task. */
  open?: () => void;
};

function taskKind(taskType: string | undefined, t: TFunction): string {
  return taskType === 'local_workflow'
    ? t('workflow.title', 'Workflow')
    : taskType === 'local_bash'
      ? t('workflow.backgroundCommand', 'Command')
      : t('workflow.backgroundAgent', 'Agent');
}

const pulse = <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400" />;

/**
 * Rendered by chat's ChatMessagesPane above the transcript: the background
 * tasks — workflow, agent or command — that are still running, each scrolling
 * to its card when clicked and stoppable. On a desktop they are a row of
 * chips; on a phone one line that opens a list, which the user can also hide.
 * Renders nothing while nothing runs, which is most of the time.
 */
export const BackgroundTasksStrip = memo(({ messages, tasks, sessionId, sendMessage, onReveal, onLoadAll }: BackgroundTasksStripProps) => {
  const { t } = useTranslation();
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const stops = useBackgroundTaskStops(sessionId);
  const running = listRunningBackgroundLaunches(messages);
  // A loaded row that has a word on its task — settled or not — is the word;
  // a task whose row is not loaded, or is loaded without one (a backgrounded
  // command's launch row from history says nothing until the poll does), is
  // drawn from the map.
  const settledToolIds = new Set(
    messages.filter((message) => readBackgroundTaskStatus(message) !== undefined).map((message) => message.toolId),
  );
  const fromMap = ownBackgroundTasks(tasks ?? []).filter((task) => !settledToolIds.has(task.toolUseId));

  const listed: StripTask[] = [
    ...running.map((message) => {
      const { kind, name, progress } = describeTask(message, t);
      return {
        key: message.toolId,
        taskId: readBackgroundTaskId(message),
        kind,
        name,
        progress,
        title: [kind, name, progress].filter(Boolean).join(' · '),
        open: () => onReveal(message),
      };
    }),
    ...fromMap.map((task) => {
      const kind = taskKind(task.taskType, t);
      const name = task.workflowName ?? task.description;
      const label = [kind, name].filter(Boolean).join(' · ');
      return {
        key: task.taskId,
        taskId: task.taskId,
        kind,
        name,
        progress: '',
        // Launched by one of the session's agents: its row is in that agent's
        // transcript, so no page of this one will ever hold it.
        title: task.nested
          ? `${label} · ${t('workflow.taskOfAgent', 'Launched by one of this session\'s agents')}`
          : `${label} · ${t('workflow.taskRowNotLoaded', 'Launched earlier in this conversation; click to load it')}`,
        open: task.nested ? undefined : onLoadAll,
      };
    }),
  ];
  // The server has said these are not running, whatever the rows still say.
  const shown = listed.filter((task) => !task.taskId || !stops.ended.has(task.taskId));
  const stop = sessionId
    ? (taskId: string) => {
      recordTaskStopRequest(sessionId, taskId);
      sendMessage({ type: 'chat.stop-task', sessionId, taskId });
    }
    : undefined;

  if (shown.length === 0 || shown.every((task) => stops.hidden.has(task.key))) {
    return null;
  }
  if (isMobile) {
    return (
      <CompactTaskList
        tasks={shown}
        stopping={stops.stopping}
        onStop={stop}
        onHide={sessionId ? () => hideBackgroundTasks(sessionId, shown.map((task) => task.key)) : undefined}
      />
    );
  }

  return (
    <div
      role="status"
      aria-label={t('workflow.backgroundTasks', 'Background tasks')}
      className="flex max-w-full flex-wrap items-center gap-1.5 rounded-md border border-border/60 bg-background/95 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur"
    >
      {shown.map((task) => {
        const label = (
          <>
            {pulse}
            <span className="flex-shrink-0 font-medium text-foreground">{task.kind}</span>
            {task.name && <span className="min-w-0 truncate">{task.name}</span>}
            {task.progress && <span className="min-w-0 truncate text-muted-foreground/70">· {task.progress}</span>}
          </>
        );
        const isStopping = Boolean(task.taskId && stops.stopping.has(task.taskId));
        return (
          <span key={task.key} className="flex min-w-0 max-w-full items-center">
            {task.open ? (
              <button
                type="button"
                onClick={task.open}
                title={task.title}
                className="flex min-w-0 max-w-xs items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
              >
                {label}
              </button>
            ) : (
              <span title={task.title} className="flex min-w-0 max-w-xs items-center gap-1.5 rounded px-1.5 py-0.5">
                {label}
              </span>
            )}
            {stop && task.taskId && (
              <button
                type="button"
                onClick={() => stop(task.taskId!)}
                disabled={isStopping}
                aria-label={t('workflow.stopTask', 'Stop')}
                title={isStopping ? t('workflow.stoppingTask', 'Stopping…') : t('workflow.stopTask', 'Stop')}
                className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-destructive disabled:opacity-40"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
});
BackgroundTasksStrip.displayName = 'BackgroundTasksStrip';

type CompactTaskListProps = {
  tasks: StripTask[];
  stopping: ReadonlySet<string>;
  onStop?: (taskId: string) => void;
  onHide?: () => void;
};

/**
 * The strip on a phone, where a row of chips wraps into a block over the
 * conversation: one line naming the task, or how many there are, that opens
 * the list. The list's rows are full-width touch targets with a labelled Stop,
 * and Hide puts the line away until another task starts.
 */
function CompactTaskList({ tasks, stopping, onStop, onHide }: CompactTaskListProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const closeOutside = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const summary = tasks.length === 1
    ? [tasks[0].kind, tasks[0].name].filter(Boolean).join(' · ')
    : t('workflow.backgroundTaskCount', { count: tasks.length, defaultValue_one: '{{count}} background task', defaultValue_other: '{{count}} background tasks' });

  return (
    <div ref={containerRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={t('workflow.backgroundTasks', 'Background tasks')}
        className="flex h-7 min-w-0 max-w-64 items-center gap-1.5 rounded-full border border-border/60 bg-background/95 px-2.5 text-xs text-muted-foreground shadow-sm backdrop-blur"
      >
        {pulse}
        <span className="min-w-0 truncate text-foreground">{summary}</span>
        <ChevronDown className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t('workflow.backgroundTasks', 'Background tasks')}
          className="absolute left-0 top-full z-20 mt-1.5 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
            <span>{t('workflow.backgroundTasks', 'Background tasks')} · {tasks.length}</span>
            {onHide && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onHide();
                }}
                className="rounded px-2 py-1 font-medium hover:bg-muted hover:text-foreground"
              >
                {t('workflow.hideTasks', 'Hide')}
              </button>
            )}
          </div>
          <ul className="max-h-[45vh] overflow-y-auto py-1">
            {tasks.map((task) => {
              const isStopping = Boolean(task.taskId && stopping.has(task.taskId));
              const text = (
                <>
                  <span className="flex min-w-0 items-center gap-1.5 text-sm">
                    {pulse}
                    <span className="flex-shrink-0 font-medium">{task.kind}</span>
                    {task.name && <span className="min-w-0 truncate text-muted-foreground">{task.name}</span>}
                  </span>
                  {task.progress && <span className="block truncate pl-3 text-xs text-muted-foreground/70">{task.progress}</span>}
                </>
              );
              return (
                <li key={task.key} className="flex items-center gap-2 px-1">
                  {task.open ? (
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        task.open?.();
                      }}
                      title={task.title}
                      className="min-w-0 flex-1 rounded-md px-2 py-2 text-left hover:bg-muted"
                    >
                      {text}
                    </button>
                  ) : (
                    <div title={task.title} className="min-w-0 flex-1 px-2 py-2">{text}</div>
                  )}
                  {onStop && task.taskId && (
                    <button
                      type="button"
                      onClick={() => onStop(task.taskId!)}
                      disabled={isStopping}
                      className="flex h-8 min-w-[6.5rem] flex-shrink-0 items-center justify-center gap-1 rounded-md border border-border/60 px-2.5 text-xs text-muted-foreground hover:text-destructive disabled:opacity-50"
                    >
                      <Square className="h-2.5 w-2.5 fill-current" />
                      {isStopping ? t('workflow.stoppingTask', 'Stopping…') : t('workflow.stopTask', 'Stop')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
