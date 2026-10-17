import { useEffect } from 'react'
import { HidPanel } from '../../hid'
import { CalibrationDialog, useCalibrationStore } from '../../hid/calibration'

/**
 * The HID tab: the live HID panel (hid) with axis calibration (hid/calibration) over it — badges,
 * the restore offer and the dialog. Composed here because hid never imports hid/calibration.
 */
export function HidTab() {
  const calibration = useCalibrationStore((s) => s.calibration)
  const calibrate = useCalibrationStore((s) => s.calibrate)
  // The calibration workflow lives as long as this tab is mounted (main builds and disposes it).
  const { attach } = calibrate
  useEffect(() => {
    attach(true)
    return () => attach(false)
  }, [attach])

  return (
    <HidPanel
      dialog={
        calibration.dialog && <CalibrationDialog d={calibration.dialog} calibrate={calibrate} />
      }
      cal={calibration.tab}
      onCalibrate={calibrate.open}
    />
  )
}
