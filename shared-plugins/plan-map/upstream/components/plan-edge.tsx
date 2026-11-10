import { BaseEdge, type Edge, type EdgeProps } from '@xyflow/react'

export type PlanEdge = Edge<
  { path: string; description: string; dependencyId: string },
  'plan'
>

export function RoutedEdge({ id, data, markerEnd, style }: EdgeProps<PlanEdge>) {
  if (!data) return null
  return (
    <>
      <title>{data.description}</title>
      <BaseEdge id={id} path={data.path} markerEnd={markerEnd} style={style} />
    </>
  )
}
