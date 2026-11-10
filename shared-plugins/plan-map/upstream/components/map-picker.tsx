import { SelectMenu } from '@/components/ui/select-menu'

type Props = {
  maps: { id: string; name: string }[]
  mapId: string
  title?: string
  onSelect: (id: string) => void
}

export function MapPicker({ maps, mapId, title, onSelect }: Props) {
  const label = title ?? maps.find((map) => map.id === mapId)?.name ?? 'Choose a map'
  const options = [
    { value: '', label: 'Choose a map' },
    ...maps.map((map) => ({
      value: map.id,
      label: map.id === mapId && title ? title : map.name,
    })),
  ]

  return (
    <SelectMenu
      options={options}
      value={mapId}
      label="Feature ADR"
      displayValue={label}
      className="map-picker-trigger"
      onValueChange={onSelect}
    />
  )
}
