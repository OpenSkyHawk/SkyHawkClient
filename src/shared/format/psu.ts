// The PSU limit labels: the Settings › Cockpit form and the config-import review name the three
// custom limits the same way.

/** A PSU limit field. The same keys as the nodes contract's PsuLimits, which this leaf can't import. */
export type PsuLimitKey = 'a12' | 'a5' | 'w'

export const PSU_LIMITS: { key: PsuLimitKey; label: string; unit: string; hint: string }[] = [
  {
    key: 'a12',
    label: '12 V rail limit',
    unit: 'A',
    hint: 'Combined current of all 12 V outputs (PSU label)'
  },
  {
    key: 'a5',
    label: '5 V rail limit',
    unit: 'A',
    hint: 'Combined current of all 5 V outputs (PSU label)'
  },
  { key: 'w', label: 'Total power', unit: 'W', hint: 'Rated output (PSU label)' }
]
