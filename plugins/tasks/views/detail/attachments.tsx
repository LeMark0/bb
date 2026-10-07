import { useEffect, useRef, useState, type ReactNode } from "react";
import { attachmentDownloadUrl } from "../../shared/attachments.js";
import type { Attachment } from "../../shared/contract.js";
import { errorMessage } from "../../shared/errors.js";
import {
  formatFileSize,
  formatRelativeTime,
  useNowTick,
} from "../activity/time.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { Button } from "@/components/ui/button";
import { COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS } from "@/components/ui/coarse-pointer-sizing";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

let tokenPromise: Promise<string> | null = null;

function pluginToken(): Promise<string> {
  tokenPromise ??= (async () => {
    const response = await fetch("/api/v1/plugins/tasks/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const json: unknown = await response.json().catch(() => null);
    const token =
      json && typeof json === "object" && "token" in json
        ? (json as { token: unknown }).token
        : undefined;
    if (!response.ok || typeof token !== "string") {
      throw new Error(`failed to fetch plugin token (HTTP ${response.status})`);
    }
    return token;
  })();
  tokenPromise.catch(() => {
    tokenPromise = null;
  });
  return tokenPromise;
}

export type AttachmentOwnerRef = { taskId: string } | { commentId: string };

export async function uploadAttachment(
  file: File,
  owner: AttachmentOwnerRef,
): Promise<{ attachmentId: string; url: string }> {
  const token = await pluginToken();
  const query = new URLSearchParams({
    ...owner,
    fileName: file.name || "attachment",
    mime: file.type || "application/octet-stream",
  });
  const response = await fetch(
    `/api/v1/plugins/tasks/http/attachments/upload?${query.toString()}`,
    {
      method: "POST",
      headers: { "x-bb-plugin-token": token },
      body: file,
    },
  );
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      json && typeof json === "object" && "error" in json
        ? String((json as { error: unknown }).error)
        : `upload failed (HTTP ${response.status})`;
    throw new Error(message);
  }
  const result = json as { attachmentId: string; url: string };
  return { attachmentId: result.attachmentId, url: result.url };
}

export function Lightbox({
  attachment,
  onClose,
}: {
  attachment: Attachment;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-label={attachment.fileName}
      className="fixed inset-0 z-50 flex items-center justify-center p-8"
      style={{ background: "color-mix(in oklab, var(--ink) 60%, transparent)" }}
      onClick={onClose}
    >
      <img
        src={attachmentDownloadUrl(attachment.id)}
        alt={attachment.fileName}
        className="max-h-full max-w-full rounded-md shadow-md"
        onClick={(event) => event.stopPropagation()}
      />
      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-md bg-popover/90 px-3 py-1.5 text-xs text-popover-foreground shadow-md">
        <span className="max-w-72 truncate">{attachment.fileName}</span>
        <span className="text-muted-foreground">
          {formatFileSize(attachment.sizeBytes)}
        </span>
      </div>
      <button
        type="button"
        aria-label="Close"
        className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-md bg-popover/90 text-popover-foreground shadow-md hover:bg-popover"
        onClick={onClose}
      >
        <Icon name="X" className="size-4" />
      </button>
    </div>
  );
}

function RemovalSpinner() {
  return (
    <span role="status" aria-label="Removing" className="inline-flex">
      <Icon name="Spinner" className="size-3.5 animate-spin" aria-hidden />
    </span>
  );
}

function trackElement(elements: Map<string, HTMLElement>, id: string) {
  return (element: HTMLElement | null) => {
    if (element) elements.set(id, element);
    else elements.delete(id);
  };
}

const ROW_CONTROL_CLASS =
  "flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-sm py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function AttachmentRow({
  attachment,
  nowMs,
  busy,
  controlRef,
  onOpenImage,
  onRequestRemove,
}: {
  attachment: Attachment;
  nowMs: number;
  busy: boolean;
  controlRef: (element: HTMLElement | null) => void;
  onOpenImage: () => void;
  onRequestRemove: (origin: HTMLElement) => void;
}) {
  const size = formatFileSize(attachment.sizeBytes);
  const age = formatRelativeTime(attachment.createdAt, nowMs);
  const content = (
    <>
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center"
      >
        {attachment.isImage ? (
          <img
            src={attachmentDownloadUrl(attachment.id)}
            alt=""
            loading="lazy"
            className="size-5 rounded-sm border border-border object-cover"
          />
        ) : (
          <Icon name="File" className="size-3.5 text-muted-foreground" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col @sm:flex-row @sm:items-center @sm:gap-3">
        <span className="truncate @sm:min-w-0 @sm:flex-1">
          {attachment.fileName}
        </span>
        <span className="text-2xs text-muted-foreground tabular-nums @sm:shrink-0 @sm:text-xs">
          {size} · {age}
        </span>
      </span>
    </>
  );
  return (
    <li
      aria-busy={busy || undefined}
      className={cn(
        "flex items-center gap-1 border-b border-border-hairline px-0.5 text-sm first:border-t hover:bg-state-hover",
        busy && "opacity-70",
      )}
    >
      {attachment.isImage ? (
        <button
          ref={controlRef}
          type="button"
          title={attachment.fileName}
          className={ROW_CONTROL_CLASS}
          onClick={onOpenImage}
        >
          {content}
        </button>
      ) : (
        <a
          ref={controlRef}
          href={attachmentDownloadUrl(attachment.id)}
          download={attachment.fileName}
          title={attachment.fileName}
          className={ROW_CONTROL_CLASS}
        >
          {content}
        </a>
      )}
      <Button
        type="button"
        variant="ghost"
        aria-label={`Remove ${attachment.fileName}, ${size}, added ${age}`}
        aria-disabled={busy || undefined}
        className={cn(
          COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
          "shrink-0 text-muted-foreground aria-disabled:pointer-events-none",
        )}
        onClick={(event) => {
          if (!busy) onRequestRemove(event.currentTarget);
        }}
      >
        {busy ? <RemovalSpinner /> : <Icon name="X" />}
      </Button>
    </li>
  );
}

type PendingRemoval = {
  origin: HTMLElement | null;
  order: Attachment[];
  dialogClosed: boolean;
  succeeded: boolean;
};

function focusIsLost() {
  return (
    document.activeElement === null || document.activeElement === document.body
  );
}

export function TaskAttachments({
  leading,
  attachments,
  loadFailed,
  appliedSettlements,
  onRetry,
  onUpload,
  onRemove,
  onError,
}: {
  leading: ReactNode;
  attachments: Attachment[] | undefined;
  loadFailed: boolean;
  appliedSettlements: number;
  onRetry: () => void;
  onUpload: (files: File[]) => Promise<string[]>;
  onRemove: (attachment: Attachment) => Promise<void>;
  onError: (message: string) => void;
}) {
  const nowMs = useNowTick();
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const [confirm, setConfirm] = useState<Attachment | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [controls] = useState(() => new Map<string, HTMLElement>());
  const [removals] = useState(() => new Map<string, PendingRemoval>());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const removeOriginRef = useRef<HTMLElement | null>(null);
  const closingRemovalRef = useRef<string | null>(null);
  const retryPressedAtRef = useRef<number | null>(null);
  const revealIdRef = useRef<string | null>(null);

  const rows = attachments ?? [];

  const settleRetryFocus = () => {
    const pressedAt = retryPressedAtRef.current;
    if (pressedAt === null) return;
    const retryButton = retryButtonRef.current;
    if (!focusIsLost() && document.activeElement !== retryButton) {
      retryPressedAtRef.current = null;
      return;
    }
    if (appliedSettlements === pressedAt) return;
    retryPressedAtRef.current = null;
    if (!focusIsLost()) return;
    (retryButton ?? triggerRef.current ?? attachButtonRef.current)?.focus();
  };

  const revealUploadedRow = () => {
    const id = revealIdRef.current;
    const row = id === null ? null : controls.get(id)?.closest("li");
    if (!row) return;
    revealIdRef.current = null;
    row.scrollIntoView({ block: "nearest" });
  };

  useEffect(() => {
    settleRetryFocus();
    revealUploadedRow();
  });

  const retry = () => {
    retryPressedAtRef.current = appliedSettlements;
    onRetry();
  };

  const requestRemove = (attachment: Attachment, origin: HTMLElement) => {
    removeOriginRef.current = origin;
    setConfirm(attachment);
  };

  const focusAfterRemoval = (removedId: string, removal: PendingRemoval) => {
    const focusInRemovedRow =
      removal.origin?.closest("li")?.contains(document.activeElement) ?? false;
    if (!focusIsLost() && !focusInRemovedRow) return;
    const index = removal.order.findIndex((entry) => entry.id === removedId);
    const neighbours = [
      ...removal.order.slice(index + 1),
      ...removal.order.slice(0, index).reverse(),
    ];
    const target =
      neighbours
        .map((entry) => controls.get(entry.id))
        .find((element) => element !== undefined) ?? attachButtonRef.current;
    target?.focus();
  };

  const onConfirmClosed = () => {
    const removedId = closingRemovalRef.current;
    closingRemovalRef.current = null;
    removeOriginRef.current?.focus();
    const removal = removedId === null ? undefined : removals.get(removedId);
    if (removedId === null || removal === undefined) return;
    if (removal.succeeded) {
      removals.delete(removedId);
      focusAfterRemoval(removedId, removal);
    } else {
      removals.set(removedId, { ...removal, dialogClosed: true });
    }
  };

  const performRemove = async (attachment: Attachment) => {
    removals.set(attachment.id, {
      origin: removeOriginRef.current,
      order: rows,
      dialogClosed: false,
      succeeded: false,
    });
    closingRemovalRef.current = attachment.id;
    setLightbox((current) => (current?.id === attachment.id ? null : current));
    setPending((current) => new Set(current).add(attachment.id));
    try {
      await onRemove(attachment);
      const removal = removals.get(attachment.id);
      if (removal?.dialogClosed) {
        removals.delete(attachment.id);
        focusAfterRemoval(attachment.id, removal);
      } else if (removal) {
        removals.set(attachment.id, { ...removal, succeeded: true });
      }
    } catch (error) {
      removals.delete(attachment.id);
      onError(errorMessage(error));
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(attachment.id);
        return next;
      });
    }
  };

  const pickFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    try {
      const [firstUploaded] = await onUpload(files);
      if (firstUploaded === undefined) return;
      revealIdRef.current = firstUploaded;
      setOpen(true);
    } finally {
      setUploading(false);
    }
  };

  const changeOpen = (next: boolean) => {
    if (!next) revealIdRef.current = null;
    setOpen(next);
  };

  const closeLightbox = () => {
    const opened = lightbox;
    setLightbox(null);
    if (opened) controls.get(opened.id)?.focus();
  };

  const attachLabel = uploading ? "Uploading…" : "Attach file";

  return (
    <Collapsible open={open} onOpenChange={changeOpen}>
      <div className="mb-1 mt-3 flex flex-wrap items-center gap-1">
        {leading}
        <button
          ref={attachButtonRef}
          type="button"
          title={attachLabel}
          aria-label={attachLabel}
          aria-disabled={uploading || undefined}
          className="flex size-6.5 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground aria-disabled:pointer-events-none"
          onClick={() => {
            if (!uploading) fileInputRef.current?.click();
          }}
        >
          {uploading ? (
            <Icon name="Spinner" className="size-4 animate-spin" />
          ) : (
            <Icon name="Paperclip" className="size-4" />
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            void pickFiles(files);
          }}
        />
        {rows.length > 0 ? (
          <CollapsibleTrigger
            ref={triggerRef}
            className="flex h-6.5 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Attachments ({rows.length})
            <Icon
              name="ChevronRight"
              className="size-3 transition-transform [[data-state=open]>&]:rotate-90"
            />
          </CollapsibleTrigger>
        ) : attachments === undefined && loadFailed ? (
          <span className="flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground">
            Couldn't load attachments
            <button
              ref={retryButtonRef}
              type="button"
              className="rounded-sm font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={retry}
            >
              Retry
            </button>
          </span>
        ) : null}
      </div>
      {rows.length > 0 ? (
        <CollapsibleContent>
          <ul className="@container">
            {rows.map((attachment) => (
              <AttachmentRow
                key={attachment.id}
                attachment={attachment}
                nowMs={nowMs}
                busy={pending.has(attachment.id)}
                controlRef={trackElement(controls, attachment.id)}
                onOpenImage={() => setLightbox(attachment)}
                onRequestRemove={(origin) => requestRemove(attachment, origin)}
              />
            ))}
          </ul>
        </CollapsibleContent>
      ) : null}
      {lightbox ? (
        <Lightbox attachment={lightbox} onClose={closeLightbox} />
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(next) => {
          if (!next) setConfirm(null);
        }}
        title="Remove attachment?"
        description={
          confirm
            ? `"${confirm.fileName}" will be permanently removed. Any references in the task description will be removed too. This cannot be undone.`
            : ""
        }
        confirmLabel="Remove"
        onConfirm={() => {
          if (confirm) void performRemove(confirm);
        }}
        onAfterCloseAutoFocus={onConfirmClosed}
      />
    </Collapsible>
  );
}
