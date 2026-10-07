import { useEffect, useState, type ReactNode } from "react";
import { useBbContext, useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import type { TaskThread } from "../../shared/contract.js";
import type { LiveThreads } from "./live-threads.js";
import { THREAD_STATUS_META } from "./meta.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type ResolvedThread =
  | { kind: "pending" }
  | { kind: "unavailable" }
  | {
      kind: "available";
      title: string;
      href: string | undefined;
      isArchived: boolean;
      isHidden: boolean;
    };

export interface MainThreadState {
  thread: TaskThread;
  resolved: ResolvedThread;
}

interface ThreadProbe {
  threadId: string;
  found: {
    title: string | null;
    isArchived: boolean;
    isHidden: boolean;
  } | null;
}

function useResolvedThread(
  thread: TaskThread | null,
  live: LiveThreads,
): ResolvedThread {
  const sdk = useSdk();
  const threadId = thread?.threadId ?? null;
  const liveThread = threadId === null ? undefined : live.byId.get(threadId);
  const shouldProbe =
    threadId !== null && live.ready && liveThread === undefined;
  const [probe, setProbe] = useState<ThreadProbe | null>(null);

  useEffect(() => {
    if (!shouldProbe || threadId === null) return;
    let cancelled = false;
    const lookup = async () => sdk.threads.get({ threadId });
    lookup().then(
      (response) => {
        if (cancelled) return;
        setProbe({
          threadId,
          found:
            response.deletedAt === null
              ? {
                  title: response.title ?? response.titleFallback,
                  isArchived: response.archivedAt !== null,
                  isHidden: response.visibility === "hidden",
                }
              : null,
        });
      },
      () => {
        if (!cancelled) setProbe({ threadId, found: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sdk, shouldProbe, threadId, thread]);

  if (thread === null) return { kind: "pending" };
  if (liveThread) {
    return {
      kind: "available",
      title: liveThread.displayTitle,
      href: liveThread.href,
      isArchived: liveThread.isArchived,
      isHidden: liveThread.isHidden,
    };
  }
  if (!shouldProbe || probe?.threadId !== thread.threadId) {
    return { kind: "pending" };
  }
  if (probe.found === null) return { kind: "unavailable" };
  return {
    kind: "available",
    title: probe.found.title ?? thread.title,
    href: undefined,
    isArchived: probe.found.isArchived,
    isHidden: probe.found.isHidden,
  };
}

export function useMainThread(
  threads: readonly TaskThread[] | undefined,
  live: LiveThreads,
): MainThreadState | null {
  const main = threads?.find((thread) => thread.isMain) ?? null;
  const resolved = useResolvedThread(main, live);
  return main === null ? null : { thread: main, resolved };
}

function StatusDot({ thread }: { thread: TaskThread }) {
  return (
    <span aria-hidden className="flex h-4 shrink-0 items-center">
      <span
        className={cn(
          "size-1.5 rounded-full",
          THREAD_STATUS_META[thread.liveStatus].dotClassName,
        )}
      />
    </span>
  );
}

function StatusLead({ thread }: { thread: TaskThread }) {
  return (
    <>
      <StatusDot thread={thread} />
      <span className="hidden shrink-0 @md:inline">
        {THREAD_STATUS_META[thread.liveStatus].label}
      </span>
      <span aria-hidden className="hidden shrink-0 @md:inline">
        ·
      </span>
    </>
  );
}

const ROW_ITEMS_CLASS =
  "flex min-w-0 flex-wrap items-start gap-x-1.5 @md:flex-nowrap";
const ROW_TITLE_BLOCK_CLASS = "min-w-0 basis-full pl-3 @md:basis-auto @md:pl-0";
const ROW_TITLE_TEXT_CLASS =
  "min-w-0 line-clamp-2 wrap-break-word @md:block @md:overflow-hidden @md:text-ellipsis @md:whitespace-nowrap";

const ROW_LINK_CLASS = cn(
  ROW_ITEMS_CLASS,
  "group rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
);

function ThreadLink({
  threadId,
  href,
  label,
  children,
}: {
  threadId: string;
  href: string | undefined;
  label: string;
  children: ReactNode;
}) {
  const navigate = useBbNavigate();
  if (href !== undefined) {
    return (
      <a href={href} aria-label={label} className={ROW_LINK_CLASS}>
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      aria-label={label}
      className={ROW_LINK_CLASS}
      onClick={() => navigate.toThread(threadId)}
    >
      {children}
    </button>
  );
}

function Separator() {
  return (
    <span aria-hidden className="shrink-0">
      ·
    </span>
  );
}

function TitleSeparator() {
  return (
    <span aria-hidden className="hidden shrink-0 @md:inline">
      ·
    </span>
  );
}

function LinkedTitle({ title }: { title: string }) {
  return (
    <span className={cn(ROW_TITLE_BLOCK_CLASS, "flex items-start gap-1.5")}>
      <span
        className={cn(
          ROW_TITLE_TEXT_CLASS,
          "font-medium text-foreground underline decoration-input underline-offset-2 group-hover:decoration-current",
        )}
      >
        {title}
        <span aria-hidden className="inline-block pl-1 align-middle @md:hidden">
          <Icon name="ArrowUpRight" className="size-3" />
        </span>
      </span>
      <span aria-hidden className="hidden h-4 shrink-0 items-center @md:flex">
        <Icon name="ArrowUpRight" className="size-3" />
      </span>
    </span>
  );
}

function MainThreadContent({
  main,
  isCurrentThread,
}: {
  main: MainThreadState;
  isCurrentThread: boolean;
}) {
  const { thread, resolved } = main;
  const status = THREAD_STATUS_META[thread.liveStatus].label;

  if (resolved.kind === "unavailable") {
    return (
      <span className="flex min-w-0 flex-wrap items-start gap-x-1.5">
        <StatusDot thread={thread} />
        <span className="shrink-0 font-medium text-foreground">
          Main thread unavailable
        </span>
        <span className="min-w-0 basis-full pl-3" title={thread.title}>
          <span className="line-clamp-2 wrap-break-word">
            last known: {thread.title}
          </span>
        </span>
      </span>
    );
  }

  if (isCurrentThread) {
    return (
      <span className={ROW_ITEMS_CLASS}>
        <StatusLead thread={thread} />
        <span className="shrink-0 font-medium text-foreground">
          Main thread
        </span>
        <Separator />
        <span className="shrink-0">This thread</span>
      </span>
    );
  }

  if (resolved.kind === "pending") {
    return (
      <span className={ROW_ITEMS_CLASS}>
        <StatusLead thread={thread} />
        <span className="shrink-0 font-medium text-foreground">
          Main thread
        </span>
        <TitleSeparator />
        <span className={ROW_TITLE_BLOCK_CLASS} title={thread.title}>
          <span className={ROW_TITLE_TEXT_CLASS}>{thread.title}</span>
        </span>
      </span>
    );
  }

  const markers = [
    resolved.isArchived ? "Archived" : null,
    resolved.isHidden ? "Hidden" : null,
  ].filter((marker) => marker !== null);
  const label = [
    `Open main thread: ${resolved.title}`,
    status.toLowerCase(),
    ...markers.map((marker) => marker.toLowerCase()),
  ].join(", ");

  return (
    <ThreadLink threadId={thread.threadId} href={resolved.href} label={label}>
      <StatusLead thread={thread} />
      <span className="shrink-0 font-medium text-foreground">Main thread</span>
      {markers.map((marker) => (
        <span key={marker} className="flex shrink-0 items-start gap-1.5">
          <Separator />
          {marker}
        </span>
      ))}
      <TitleSeparator />
      <LinkedTitle title={resolved.title} />
    </ThreadLink>
  );
}

function MainThreadShortcut({
  main,
  otherCount,
  onShowThreads,
}: {
  main: MainThreadState;
  otherCount: number;
  onShowThreads: () => void;
}) {
  const { threadId: currentThreadId } = useBbContext();
  return (
    <>
      <div className="flex min-w-0 basis-full @md:basis-auto @md:flex-1">
        <MainThreadContent
          main={main}
          isCurrentThread={currentThreadId === main.thread.threadId}
        />
      </div>
      {otherCount > 0 ? (
        <button
          type="button"
          className="shrink-0 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onShowThreads}
        >
          +{otherCount} {otherCount === 1 ? "thread" : "threads"}
        </button>
      ) : null}
    </>
  );
}

function SingleThreadShortcut({
  thread,
  live,
}: {
  thread: TaskThread;
  live: LiveThreads;
}) {
  const { threadId: currentThreadId } = useBbContext();
  const liveThread = live.byId.get(thread.threadId);
  const title = liveThread?.displayTitle ?? thread.title;
  const status = THREAD_STATUS_META[thread.liveStatus].label;
  if (currentThreadId === thread.threadId) {
    return (
      <span className={ROW_ITEMS_CLASS}>
        <StatusLead thread={thread} />
        <span className="shrink-0 font-medium text-foreground">Thread</span>
        <Separator />
        <span className="shrink-0">This thread</span>
      </span>
    );
  }
  return (
    <ThreadLink
      threadId={thread.threadId}
      href={liveThread?.href}
      label={`Open thread: ${title}, ${status.toLowerCase()}`}
    >
      <StatusLead thread={thread} />
      <span className="shrink-0 font-medium text-foreground">Thread</span>
      <TitleSeparator />
      <LinkedTitle title={title} />
    </ThreadLink>
  );
}

function ThreadChooser({
  threads,
  live,
}: {
  threads: readonly TaskThread[];
  live: LiveThreads;
}) {
  const navigate = useBbNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded-sm font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Threads ({threads.length})
          <Icon name="ChevronDown" className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-80">
        {threads.map((thread) => (
          <DropdownMenuItem
            key={thread.id}
            onSelect={() => navigate.toThread(thread.threadId)}
          >
            <StatusDot thread={thread} />
            <span className="min-w-0 flex-1 truncate">
              {live.byId.get(thread.threadId)?.displayTitle ?? thread.title}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ThreadShortcutRow({
  threads,
  main,
  live,
  onShowThreads,
}: {
  threads: readonly TaskThread[];
  main: MainThreadState | null;
  live: LiveThreads;
  onShowThreads: () => void;
}) {
  const [only, ...rest] = threads;
  if (only === undefined) return null;
  return (
    <div className="mb-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground @md:flex-nowrap">
      {main ? (
        <MainThreadShortcut
          main={main}
          otherCount={threads.length - 1}
          onShowThreads={onShowThreads}
        />
      ) : rest.length === 0 ? (
        <SingleThreadShortcut thread={only} live={live} />
      ) : (
        <ThreadChooser threads={threads} live={live} />
      )}
    </div>
  );
}
