import { ArrowUpRight } from 'lucide-react'

import { BlockerPreview } from '@/components/plan-blocker'
import { StatusMark, TicketReference } from '@/components/plan-parts'
import { statusLabels, type PlanItem, type PlanModel } from '@/lib/plan'
import { planBoardColumns } from '@/lib/plan-view'
import { cn } from '@/lib/utils'

type Props = {
  items: PlanItem[]
  model: PlanModel
  selectedId: string | null
  hidden: boolean
  onInspect: (id: string) => void
}

// Keep the horizontal board reachable even when every column is empty.
/* oxlint-disable jsx-a11y/no-noninteractive-tabindex */
export function PlanBoard({ items, model, selectedId, hidden, onInspect }: Props) {
  return (
    <section
      className="plan-board"
      aria-label="Tasks by status"
      hidden={hidden}
      tabIndex={0}
    >
      {planBoardColumns(items).map((column) => (
        <section
          key={column.status}
          className="board-column"
          aria-labelledby={`board-${column.status}`}
        >
          <h3 className="board-column-heading" id={`board-${column.status}`}>
            <StatusMark status={column.status} label />
            <span className="board-count">{column.items.length}</span>
          </h3>
          <ol className="board-cards">
            {column.items.map((item) => (
              <li key={item.id}>
                <article
                  className={cn('board-card', selectedId === item.id && 'is-selected')}
                  data-status={item.status}
                >
                  <button
                    className="board-card-select"
                    aria-label={`${item.id}: ${item.shortTitle}. Open details.`}
                    aria-pressed={selectedId === item.id}
                    onClick={() => onInspect(item.id)}
                  >
                    <span className="board-card-id">
                      {item.id}
                      <ArrowUpRight size={13} />
                    </span>
                    <span className="board-card-title">{item.shortTitle}</span>
                    <span className="board-card-group">
                      {model.groupById[item.groupId].title}
                    </span>
                  </button>
                  {item.status === 'blocked' && (
                    <BlockerPreview
                      item={item}
                      model={model}
                      onInspect={() => onInspect(item.id)}
                    />
                  )}
                  {item.tickets.length > 0 && (
                    <div className="board-card-tickets">
                      <TicketReference ticket={item.tickets[0]} />
                      {item.tickets.length > 1 && (
                        <span title="Additional tickets are listed in the step details">
                          +{item.tickets.length - 1}
                        </span>
                      )}
                    </div>
                  )}
                </article>
              </li>
            ))}
          </ol>
          {column.items.length === 0 && (
            <p className="board-empty">
              No {statusLabels[column.status].toLowerCase()} steps
            </p>
          )}
        </section>
      ))}
    </section>
  )
}
