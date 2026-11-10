import { ArrowRight, ChevronRight } from 'lucide-react'

import { StatusMark } from '@/components/plan-parts'
import type { PlanItem, PlanModel } from '@/lib/plan'
import { blockerInfo } from '@/lib/plan-blockers'

type Props = { item: PlanItem; model: PlanModel }

export function BlockerPreview({
  item,
  model,
  onInspect,
}: Props & { onInspect: () => void }) {
  const info = blockerInfo(item, model)
  if (!info) return null
  return (
    <button
      className="blocker-preview nodrag nopan"
      aria-label={`Why is ${item.shortTitle} blocked?`}
      onClick={(event) => {
        event.stopPropagation()
        onInspect()
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <span className="blocker-preview-note">{info.summary}</span>
      <span className="blocker-preview-action">
        Why blocked? <ArrowRight size={12} />
      </span>
    </button>
  )
}

export function BlockerDetails({
  item,
  model,
  onInspect,
}: Props & { onInspect: (id: string) => void }) {
  const info = blockerInfo(item, model)
  if (!info) return null
  return (
    <section className="blocker-details" aria-label="Why blocked">
      <h3>Why blocked?</h3>
      <h4>Recorded status notes</h4>
      {info.notes.length ? (
        info.notes.map((note) => <p key={note}>{note}</p>)
      ) : (
        <p>No status note recorded for this blocked step.</p>
      )}
      <h4>
        Unfinished prerequisites <span>{info.unfinished.length}</span>
      </h4>
      {info.unfinished.length ? (
        info.unfinished.map((step) => (
          <button
            key={step.id}
            className="related-step"
            onClick={() => onInspect(step.id)}
          >
            <StatusMark status={step.status} label />
            <span>
              <small>{step.id}</small>
              {step.shortTitle}
              <small>{model.groupById[step.groupId].title}</small>
            </span>
            <ChevronRight size={15} />
          </button>
        ))
      ) : (
        <p className="muted">
          {item.needs.length
            ? 'All recorded prerequisites are done.'
            : 'No prerequisites are recorded.'}{' '}
          The blocked status is recorded separately.
        </p>
      )}
      <small className="source-label">ADR updated · {model.report.snapshotDate}</small>
    </section>
  )
}
