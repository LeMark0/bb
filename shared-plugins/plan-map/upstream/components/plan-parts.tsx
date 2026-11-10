import {
  Ban,
  Check,
  Circle,
  CircleDot,
  Minus,
  ArrowUpRight,
  Search,
  X,
} from 'lucide-react'
import { type KeyboardEventHandler, type RefObject } from 'react'

import { statusLabels, type Status, type PlanTicket } from '@/lib/plan'
import { cn } from '@/lib/utils'

export function PanelSearch({
  label,
  value,
  onChange,
  inputRef,
  onKeyDown,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  inputRef?: RefObject<HTMLInputElement | null>
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>
}) {
  return (
    <div className="nav-search">
      <Search size={15} aria-hidden="true" />
      <input
        ref={inputRef}
        aria-label={label}
        placeholder={`${label}…`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {value ? (
        <button aria-label="Clear search" onClick={() => onChange('')}>
          <X size={15} />
        </button>
      ) : (
        inputRef && <kbd>/</kbd>
      )}
    </div>
  )
}

export function StatusMark({
  status,
  label = false,
}: {
  status: Status
  label?: boolean
}) {
  const Icon =
    status === 'done'
      ? Check
      : status === 'in_progress'
        ? CircleDot
        : status === 'dropped'
          ? Minus
          : status === 'blocked'
            ? Ban
            : Circle
  return (
    <span className={cn('status-mark', `status-${status}`)}>
      <Icon size={13} aria-hidden="true" />
      {label ? (
        statusLabels[status]
      ) : (
        <span className="sr-only">{statusLabels[status]}</span>
      )}
    </span>
  )
}

export function TicketReference({ ticket }: { ticket: PlanTicket }) {
  return ticket.url ? (
    <a
      className="ticket-link nodrag nopan"
      href={ticket.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ticket ${ticket.id} in a new tab`}
      title={`Open ${ticket.id} in a new tab`}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <span>{ticket.id}</span>
      <ArrowUpRight size={12} aria-hidden="true" />
    </a>
  ) : (
    <span className="ticket-reference" title={ticket.id}>
      {ticket.id}
    </span>
  )
}
