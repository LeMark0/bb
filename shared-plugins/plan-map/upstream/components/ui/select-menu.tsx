import { Select } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'

import { usePortalContainer } from '@/lib/host'

type Props = {
  options: { value: string; label: string; count?: string }[]
  value: string
  label: string
  displayValue?: string
  className: string
  onValueChange: (value: string) => void
}

export function SelectMenu({
  options,
  value,
  label,
  displayValue,
  className,
  onValueChange,
}: Props) {
  const selected = options.find((option) => option.value === value)
  const container = usePortalContainer()
  return (
    <Select.Root
      items={options}
      value={value}
      onValueChange={(next) => {
        if (next !== null && next !== value) onValueChange(next)
      }}
      modal={false}
    >
      <Select.Trigger
        className={className}
        aria-label={label}
        aria-description={selected?.count}
        title={displayValue ?? selected?.label}
      >
        <Select.Value className="picker-label">
          {displayValue ?? selected?.label}
        </Select.Value>
        {selected?.count !== undefined && (
          <span className="picker-count" aria-hidden="true">
            {selected.count}
          </span>
        )}
        <Select.Icon className="picker-icon">
          <ChevronDown size={16} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal container={container}>
        <Select.Positioner
          className="picker-positioner"
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          alignItemWithTrigger={false}
        >
          <Select.Popup className="picker-popup">
            <Select.List className="picker-list">
              {options.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  label={option.label}
                  className="picker-item"
                >
                  <Select.ItemIndicator className="picker-check">
                    <Check size={14} />
                  </Select.ItemIndicator>
                  <Select.ItemText className="picker-item-label">
                    {option.label}
                  </Select.ItemText>
                  {option.count !== undefined && (
                    <span className="picker-count">{option.count}</span>
                  )}
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}
