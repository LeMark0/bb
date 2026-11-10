/* oxlint-disable jsx-a11y/prefer-tag-over-role -- A focusable ARIA window splitter is an interactive separator, not a static horizontal rule. */
import { useEffect, useRef, useState, type RefObject } from 'react'

import { usePlanLocation } from '@/lib/host'
import { cn } from '@/lib/utils'

const defaultLayout = { width: 44, isVisible: true }
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

function readLayout(preferenceKey: string) {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(preferenceKey) ?? 'null')
    if (typeof saved === 'object' && saved !== null) {
      return {
        width:
          'width' in saved &&
          typeof saved.width === 'number' &&
          Number.isFinite(saved.width)
            ? clamp(saved.width, 25, 70)
            : defaultLayout.width,
        isVisible:
          'isVisible' in saved && typeof saved.isVisible === 'boolean'
            ? saved.isVisible
            : defaultLayout.isVisible,
      }
    }
  } catch {
    /* Layout preferences are optional when storage is unavailable. */
  }
  return defaultLayout
}

export function usePlanPanelLayout() {
  const preferenceKey = usePlanLocation().storageKey('panel')
  const [layout, setLayout] = useState(() => readLayout(preferenceKey))

  useEffect(
    function saveLayout() {
      const timer = window.setTimeout(() => {
        try {
          localStorage.setItem(preferenceKey, JSON.stringify(layout))
        } catch {
          /* Optional preference. */
        }
      }, 150)
      return () => window.clearTimeout(timer)
    },
    [layout, preferenceKey],
  )

  return { layout, setLayout }
}

type Props = {
  workspaceRef: RefObject<HTMLDivElement | null>
  value: number
  isHidden: boolean
  onChange: (width: number) => void
  onCollapse: () => void
}

export function PlanPanelDivider({
  workspaceRef,
  value,
  isHidden,
  onChange,
  onCollapse,
}: Props) {
  const [workspaceWidth, setWorkspaceWidth] = useState(
    () => workspaceRef.current?.clientWidth ?? window.innerWidth,
  )
  const [isDragging, setIsDragging] = useState(false)
  const drag = useRef<{ x: number; width: number; pointerId: number } | null>(null)
  const min = Math.max(25, (360 / workspaceWidth) * 100)
  const max = Math.min(70, ((workspaceWidth - 368) / workspaceWidth) * 100)
  const width = clamp(value, min, max)
  const stopDragging = () => {
    drag.current = null
    setIsDragging(false)
  }

  useEffect(
    function measureWorkspace() {
      const workspace = workspaceRef.current
      if (!workspace) return
      const observer = new ResizeObserver(() => setWorkspaceWidth(workspace.clientWidth))
      observer.observe(workspace)
      return () => observer.disconnect()
    },
    [workspaceRef],
  )

  return (
    <div
      className={cn('panel-resizer', isDragging && 'is-dragging')}
      hidden={isHidden}
      role="separator"
      tabIndex={0}
      aria-label="Resize list and details"
      aria-orientation="vertical"
      aria-controls="plan-panel"
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(width)}
      aria-valuetext={`${Math.round(width)}% of workspace`}
      title="Drag to resize. Arrow keys adjust width; Enter hides the panel. Double-click to reset."
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, width, pointerId: event.pointerId }
        setIsDragging(true)
      }}
      onPointerMove={(event) => {
        const start = drag.current
        if (!start || event.pointerId !== start.pointerId) return
        onChange(
          clamp(
            start.width + ((start.x - event.clientX) / workspaceWidth) * 100,
            min,
            max,
          ),
        )
      }}
      onPointerUp={(event) => {
        stopDragging()
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={stopDragging}
      onLostPointerCapture={stopDragging}
      onDoubleClick={() => onChange(clamp(defaultLayout.width, min, max))}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 10 : 2
        const widths: Record<string, number> = {
          ArrowLeft: width + step,
          ArrowRight: width - step,
          Home: min,
          End: max,
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          onCollapse()
        } else if (event.key in widths) {
          event.preventDefault()
          onChange(clamp(widths[event.key], min, max))
        }
      }}
    />
  )
}
