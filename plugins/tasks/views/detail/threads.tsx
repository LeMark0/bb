import { useEffect, useRef, useState, type Ref } from "react";
import {
  UrlLink,
  useBbContext,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { DelegationRpcContract } from "../../delegate/contract.js";
import type {
  Preset,
  TaskPullRequest,
  TaskThread,
} from "../../shared/contract.js";
import { errorMessage } from "../../shared/errors.js";
import {
  PR_STATE_META,
  THREAD_STATUS_META,
  formatRelativeTime,
  isActiveThread,
} from "./meta.js";
import { PresetDialog, savePresetDraft } from "../manage/preset-dialog.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { useTasksRpc } from "../../shell/data.js";
import type { LiveThreads } from "./live-threads.js";
import type { MainThreadState } from "./main-thread.js";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

function ThreadPullRequestPill({
  pullRequest,
  unavailable,
}: {
  pullRequest: TaskPullRequest | undefined;
  unavailable: boolean;
}) {
  if (pullRequest) {
    const meta = PR_STATE_META[pullRequest.state];
    return (
      <UrlLink
        href={pullRequest.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`${pullRequest.title} (${meta.label})`}
        aria-label={`Pull request #${pullRequest.number}: ${pullRequest.title} (${meta.label})`}
        className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs font-medium shadow-2xs hover:border-input"
      >
        <Icon name={meta.icon} className={cn("size-3", meta.textClassName)} />#
        {pullRequest.number}
      </UrlLink>
    );
  }
  if (unavailable) {
    return (
      <span
        title="Couldn't check this thread's pull request"
        className="shrink-0 text-xs text-muted-foreground"
      >
        PR unavailable
      </span>
    );
  }
  return null;
}

const MANUAL_ATTACHMENT_PRESET_NAME = "attached";

function threadAttachmentLabel(thread: TaskThread): string {
  const attachedAt = formatRelativeTime(thread.attachedAt);
  return thread.presetName.toLowerCase() === MANUAL_ATTACHMENT_PRESET_NAME
    ? `Attached ${attachedAt}`
    : `${thread.presetName} · attached ${attachedAt}`;
}

const CARD_ACTION_CLASS =
  "flex shrink-0 items-center gap-1 text-xs font-medium underline decoration-input underline-offset-2 hover:decoration-current disabled:opacity-70";

function OpenThreadLink({
  threadId,
  title,
  href,
}: {
  threadId: string;
  title: string;
  href: string | undefined;
}) {
  const navigate = useBbNavigate();
  const content = (
    <>
      Open thread
      <Icon name="ArrowUpRight" className="size-3" />
    </>
  );
  const label = `Open thread: ${title}`;
  if (href !== undefined) {
    return (
      <a
        href={href}
        aria-label={label}
        data-thread-opener={threadId}
        className={CARD_ACTION_CLASS}
      >
        {content}
      </a>
    );
  }
  return (
    <button
      type="button"
      aria-label={label}
      data-thread-opener={threadId}
      className={CARD_ACTION_CLASS}
      onClick={() => navigate.toThread(threadId)}
    >
      {content}
    </button>
  );
}

const UNAVAILABLE_META = {
  label: "Unavailable",
  dotClassName: "bg-muted",
  textClassName: "text-muted-foreground",
};

function ThreadCard({
  thread,
  title,
  href,
  isUnavailable,
  isCurrentThread,
  pullRequest,
  pullRequestUnavailable,
  busy,
  onMakeMain,
  onDetach,
}: {
  thread: TaskThread;
  title: string;
  href: string | undefined;
  isUnavailable: boolean;
  isCurrentThread: boolean;
  pullRequest: TaskPullRequest | undefined;
  pullRequestUnavailable: boolean;
  busy: boolean;
  onMakeMain: () => void;
  onDetach: () => void;
}) {
  const meta = isUnavailable
    ? UNAVAILABLE_META
    : THREAD_STATUS_META[thread.liveStatus];
  return (
    <div className="mb-2 flex flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-2 shadow-2xs @lg:flex-row @lg:items-center @lg:gap-3">
      <span
        className={cn(
          "hidden shrink-0 items-center gap-1.5 text-xs font-medium @lg:flex",
          meta.textClassName,
        )}
      >
        <span
          aria-hidden
          className={cn("size-1.5 rounded-full", meta.dotClassName)}
        />
        {meta.label}
      </span>
      <div className="flex min-w-0 flex-1 gap-2">
        <span aria-hidden className="flex h-5 shrink-0 items-center @lg:hidden">
          <span className={cn("size-1.5 rounded-full", meta.dotClassName)} />
        </span>
        <div className="min-w-0 flex-1">
          <div
            title={title}
            className="line-clamp-2 text-sm font-medium wrap-break-word"
          >
            {title}
          </div>
          <div className="text-xs text-muted-foreground">
            <span className={cn("font-medium @lg:hidden", meta.textClassName)}>
              {meta.label}
              <span className="text-muted-foreground"> · </span>
            </span>
            {thread.isMain ? (
              <span className="font-medium text-foreground">
                Main thread
                <span className="font-normal text-muted-foreground"> · </span>
              </span>
            ) : null}
            {threadAttachmentLabel(thread)}
          </div>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-3.5 @lg:shrink-0 @lg:flex-nowrap @lg:pl-0">
        <ThreadPullRequestPill
          pullRequest={pullRequest}
          unavailable={pullRequestUnavailable}
        />
        {thread.isMain ? null : (
          <button
            type="button"
            aria-label={`Make ${title} the main thread`}
            disabled={busy}
            className={CARD_ACTION_CLASS}
            onClick={onMakeMain}
          >
            Make main
          </button>
        )}
        {isCurrentThread ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            This thread
          </span>
        ) : isUnavailable ? null : (
          <OpenThreadLink
            threadId={thread.threadId}
            title={title}
            href={href}
          />
        )}
        <button
          type="button"
          aria-label={`Detach ${title}`}
          title="Detach from task"
          disabled={busy}
          className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-70 @lg:ml-0"
          onClick={onDetach}
        >
          <Icon name="X" className="size-3" />
        </button>
      </div>
    </div>
  );
}

const LAST_PRESET_STORAGE_KEY = "bb-tasks:last-dispatch-preset";

function loadLastPresetId(): string | null {
  try {
    return window.localStorage.getItem(LAST_PRESET_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeLastPresetId(presetId: string): void {
  try {
    window.localStorage.setItem(LAST_PRESET_STORAGE_KEY, presetId);
  } catch {}
}

interface DispatchControlProps {
  taskId: string;
  presets: Preset[] | undefined;
  onError: (message: string) => void;
  align?: "start" | "end";
  className?: string;
}

export function DispatchControl({
  taskId,
  presets,
  onError,
  align = "end",
  className,
}: DispatchControlProps) {
  const rpc = useRpc<DelegationRpcContract>();
  const tasksRpc = useTasksRpc();
  const [dispatching, setDispatching] = useState(false);
  const [lastPresetId, setLastPresetId] = useState(loadLastPresetId);
  const [createDialogKey, setCreateDialogKey] = useState<number | null>(null);

  const dispatch = async (presetId: string) => {
    setDispatching(true);
    try {
      await rpc.call("delegate", { taskId, presetId });
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setDispatching(false);
    }
  };

  const pickPreset = (preset: Preset) => {
    setLastPresetId(preset.id);
    storeLastPresetId(preset.id);
    void dispatch(preset.id);
  };

  const primarySegment =
    "bg-primary text-primary-foreground hover:bg-primary/90";

  if (presets !== undefined && presets.length === 0) {
    return (
      <>
        <Button
          size="sm"
          className={cn("h-7 gap-1.5", primarySegment, className)}
          onClick={() => setCreateDialogKey(Date.now())}
        >
          <Icon name="Plus" className="size-3.5 shrink-0" />
          Add a preset…
        </Button>
        {createDialogKey !== null ? (
          <PresetDialog
            key={createDialogKey}
            open
            onOpenChange={(open) => {
              if (!open) setCreateDialogKey(null);
            }}
            editing={null}
            onSave={(draft) => savePresetDraft(tasksRpc, null, draft)}
          />
        ) : null}
      </>
    );
  }

  const current =
    presets?.find((preset) => preset.id === lastPresetId) ??
    (presets
      ? [...presets].sort((a, b) => a.name.localeCompare(b.name))[0]
      : undefined);

  return (
    <>
      <div className={cn("flex min-w-0", className)}>
        <Button
          size="sm"
          disabled={dispatching || !current}
          className={cn(
            "h-7 min-w-0 flex-1 gap-1.5 rounded-r-none",
            primarySegment,
          )}
          onClick={() => {
            if (current) pickPreset(current);
          }}
        >
          <span className="truncate">
            {dispatching ? "Dispatching…" : (current?.name ?? "Dispatch")}
          </span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={dispatching || !current}>
            <Button
              size="sm"
              aria-label="Choose dispatch preset"
              className={cn(
                "h-7 shrink-0 rounded-l-none border-l border-primary-foreground/25 px-1",
                primarySegment,
              )}
            >
              <Icon name="ChevronDown" className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align={align}>
            <DropdownMenuLabel>Dispatch with preset</DropdownMenuLabel>
            {(presets ?? []).map((preset) => (
              <DropdownMenuItem
                key={preset.id}
                onSelect={() => pickPreset(preset)}
              >
                <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                <span className="text-xs text-muted-foreground">
                  {preset.modelId}
                </span>
                {preset.id === current?.id ? (
                  <Icon name="Check" className="size-3.5" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

interface ThreadsSectionProps {
  ref: Ref<HTMLElement>;
  threads: TaskThread[];
  live: LiveThreads;
  main: MainThreadState | null;
  pullRequests: TaskPullRequest[] | undefined;
  unavailableThreadIds: string[];
  onMakeMain: (thread: TaskThread) => Promise<void>;
  onDetach: (thread: TaskThread) => Promise<void>;
  onError: (message: string) => void;
}

const MAIN_DETACH_WARNING =
  "This is the task's main thread. After you detach it, the task has no main thread until you choose one.";
const MAIN_FOCUS_WINDOW_MS = 5_000;

interface MainFocusRequest {
  taskId: string;
  threadId: string;
  confirmed: boolean;
}

export function ThreadsSection({
  ref,
  threads,
  live,
  main,
  pullRequests,
  unavailableThreadIds,
  onMakeMain,
  onDetach,
  onError,
}: ThreadsSectionProps) {
  const { threadId: currentThreadId } = useBbContext();
  const [confirm, setConfirm] = useState<TaskThread | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const latestThreads = useRef<readonly TaskThread[]>(threads);
  const mainFocus = useRef<MainFocusRequest | null>(null);

  const focusRequestedMain = () => {
    const request = mainFocus.current;
    if (!request?.confirmed) return;
    const fulfilled = latestThreads.current.some(
      (thread) =>
        thread.taskId === request.taskId &&
        thread.threadId === request.threadId &&
        thread.isMain,
    );
    if (!fulfilled) return;
    mainFocus.current = null;
    const list = listRef.current;
    const opener = [
      ...(list?.querySelectorAll<HTMLElement>("[data-thread-opener]") ?? []),
    ].find((element) => element.dataset.threadOpener === request.threadId);
    (opener ?? list?.closest("section"))?.focus();
  };

  useEffect(() => {
    latestThreads.current = threads;
    focusRequestedMain();
  });

  const runPending = async (
    thread: TaskThread,
    action: (thread: TaskThread) => Promise<void>,
  ): Promise<boolean> => {
    setPending((current) => new Set(current).add(thread.id));
    try {
      await action(thread);
      return true;
    } catch (error) {
      onError(errorMessage(error));
      return false;
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(thread.id);
        return next;
      });
    }
  };

  const resolvedMainTitle =
    main?.resolved.kind === "available" ? main.resolved.title : null;
  const titleOf = (thread: TaskThread) =>
    live.byId.get(thread.threadId)?.displayTitle ??
    (thread.threadId === main?.thread.threadId ? resolvedMainTitle : null) ??
    thread.title;

  const makeMain = async (thread: TaskThread) => {
    const request: MainFocusRequest = {
      taskId: thread.taskId,
      threadId: thread.threadId,
      confirmed: false,
    };
    mainFocus.current = request;
    const succeeded = await runPending(thread, onMakeMain);
    if (mainFocus.current !== request) return;
    if (!succeeded) {
      mainFocus.current = null;
      return;
    }
    request.confirmed = true;
    window.setTimeout(() => {
      if (mainFocus.current === request) mainFocus.current = null;
    }, MAIN_FOCUS_WINDOW_MS);
    setAnnouncement(`${titleOf(thread)} is now the main thread`);
    focusRequestedMain();
  };

  const activeCount = threads.filter(isActiveThread).length;
  const pullRequestByThread = new Map<string, TaskPullRequest>();
  for (const pullRequest of pullRequests ?? []) {
    for (const threadId of pullRequest.threadIds) {
      pullRequestByThread.set(threadId, pullRequest);
    }
  }
  const unavailable = new Set(unavailableThreadIds);

  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-label="Agent threads"
      className="@container outline-none"
    >
      <div className="mb-2 flex items-center gap-2 pt-1.5 text-xs font-semibold text-muted-foreground">
        Agent threads
        {activeCount > 0 ? (
          <span className="font-normal">{activeCount} working now</span>
        ) : null}
      </div>
      <div ref={listRef}>
        {threads.map((thread) => (
          <ThreadCard
            key={thread.id}
            thread={thread}
            title={titleOf(thread)}
            href={live.byId.get(thread.threadId)?.href}
            isUnavailable={
              main?.resolved.kind === "unavailable" &&
              thread.threadId === main.thread.threadId
            }
            isCurrentThread={thread.threadId === currentThreadId}
            pullRequest={pullRequestByThread.get(thread.threadId)}
            pullRequestUnavailable={unavailable.has(thread.threadId)}
            busy={pending.has(thread.id)}
            onMakeMain={() => void makeMain(thread)}
            onDetach={() => setConfirm(thread)}
          />
        ))}
      </div>
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title="Detach thread?"
        description={
          confirm
            ? [
                `"${titleOf(confirm)}" will no longer be listed on this task. The thread itself is not deleted; re-attach it with bb tasks attach.`,
                ...(confirm.isMain ? [MAIN_DETACH_WARNING] : []),
              ].join(" ")
            : ""
        }
        confirmLabel="Detach"
        onConfirm={() => {
          if (confirm) void runPending(confirm, onDetach);
        }}
      />
    </section>
  );
}
