import { Focus, GitBranch, Plus } from 'lucide-react'
import { type CSSProperties } from 'react'

import { BlockerPreview } from '@/components/plan-blocker'
import { StatusMark } from '@/components/plan-parts'
import { type PlanItem, type PlanModel } from '@/lib/plan'
import { cn } from '@/lib/utils'

type Props = {
  items: PlanItem[]
  model: PlanModel
  selectedId: string | null
  onSelect: (id: string) => void
  onInspect: (id: string) => void
  onShowOnMap?: (id: string) => void
}

// The overflow region needs a tab stop for horizontal keyboard scrolling.
/* oxlint-disable jsx-a11y/no-noninteractive-tabindex */
export function PlanList({
  items,
  model,
  selectedId,
  onSelect,
  onInspect,
  onShowOnMap,
}: Props) {
  const idColumnWidth = Math.min(
    18,
    Math.max(3, ...model.report.items.map((item) => item.id.length)),
  )

  return (
    <>
      <p className="list-scroll-hint">Scroll across for prerequisites and scope →</p>
      <section
        className="plan-table-scroll"
        tabIndex={0}
        aria-label="Steps and prerequisites"
      >
        <table
          className="plan-table"
          style={{ '--step-id-width': `${idColumnWidth}ch` } as CSSProperties}
        >
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col">Status</th>
              <th scope="col">Needs</th>
              <th scope="col">Scope</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className={cn(selectedId === item.id && 'selected')}>
                <th scope="row" aria-label={`${item.id}: ${item.shortTitle}`}>
                  <button
                    className="step-select"
                    onClick={() => onSelect(item.id)}
                    aria-pressed={selectedId === item.id}
                  >
                    <span className="table-id">{item.id}</span>
                    <span className="table-title">
                      {item.shortTitle}
                      <small>{model.groupById[item.groupId].title}</small>
                    </span>
                  </button>
                  {onShowOnMap && (
                    <button
                      className="show-search-result text-button"
                      onClick={() => onShowOnMap(item.id)}
                      aria-label={`Show ${item.shortTitle} on map`}
                    >
                      <Focus size={13} /> Show on map
                    </button>
                  )}
                  {item.status === 'blocked' && (
                    <div className="list-blocker-preview">
                      <BlockerPreview
                        item={item}
                        model={model}
                        onInspect={() => onInspect(item.id)}
                      />
                    </div>
                  )}
                </th>
                <td>
                  <StatusMark status={item.status} label />
                </td>
                <td className="prerequisite-cell">
                  {item.needs.length ? (
                    item.needs.map((id) => (
                      <button
                        key={id}
                        onClick={() => onSelect(id)}
                        aria-label={`Inspect prerequisite ${id}: ${model.itemById[id].shortTitle}`}
                      >
                        {id}
                      </button>
                    ))
                  ) : (
                    <span aria-label="No prerequisites">—</span>
                  )}
                </td>
                <td className="scope-cell">
                  {item.origin === 'added' ? (
                    <span>
                      <Plus size={12} /> Added
                    </span>
                  ) : item.changed ? (
                    <span>
                      <GitBranch size={12} /> Changed
                    </span>
                  ) : (
                    <span className="muted">Original</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  )
}
