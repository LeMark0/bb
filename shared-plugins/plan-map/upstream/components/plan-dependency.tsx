import { ArrowRight, ChevronRight } from 'lucide-react'

import { StatusMark } from '@/components/plan-parts'
import { statusLabels, type PlanItem } from '@/lib/plan'
import type { PlanDependency } from '@/lib/plan-view'

export function DependencyDetails({
  dependency,
  onInspect,
}: {
  dependency: PlanDependency
  onInspect: (id: string) => void
}) {
  const stepLink = (item: PlanItem) => (
    <button key={item.id} className="related-step" onClick={() => onInspect(item.id)}>
      <StatusMark status={item.status} />
      <span>
        <small>
          {item.id} · {statusLabels[item.status]}
        </small>
        {item.shortTitle}
      </span>
      <ChevronRight size={15} />
    </button>
  )
  return (
    <>
      <div className="dependency-direction">
        <span>{dependency.sourceTitle}</span>
        <ArrowRight size={14} />
        <span>{dependency.targetTitle}</span>
      </div>
      <h2>{dependency.summary}</h2>
      <p className="full-title">
        The arrow points from a prerequisite to the step that needs it.
        {dependency.kind === 'workstream' &&
          ' Only the step dependencies listed below connect these workstreams.'}
      </p>
      <p className="small-label">
        {dependency.prerequisiteCount} prerequisite{' '}
        {dependency.prerequisiteCount === 1 ? 'step' : 'steps'}
        {' · '}
        {dependency.dependents.length} dependent{' '}
        {dependency.dependents.length === 1 ? 'step' : 'steps'}
      </p>
      {dependency.dependents.map(({ item, needs }) => (
        <section
          className="detail-section dependency-record"
          key={item.id}
          aria-label={`${item.shortTitle} prerequisites`}
        >
          <h3>Dependent step</h3>
          {stepLink(item)}
          <h4>Needs first</h4>
          {needs.map(stepLink)}
        </section>
      ))}
    </>
  )
}
