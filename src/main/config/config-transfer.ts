// Configuration export / import (#67) in main: gathers the four stores into one file, previews a
// file against them, and applies the sections the user picked. The rules are in
// config-file.ts; this file only reads and writes. Dialogs stay in index.ts.
//
// Calibration is written to the client's copy only (calibration-cache.json). The device is never
// touched here: if it has lost calibration, the HID tab's Review & restore offer picks up the copy.
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type {
  AppConfig,
  ConfigExportResult,
  ConfigImportApplyResult,
  ConfigImportOpen,
  ConfigSnapshot,
  SectionId
} from '@shared/config'
import type { NodeDefaults, NodeMappingFile, NodeMappingResult } from '@shared/nodes'
import {
  applyToConfig,
  appSettings,
  buildConfigFile,
  diffImport,
  parseConfigFile,
  SECTION_IDS,
  withSectionNotes,
  type ParsedConfig
} from './config-file'
import type { CalCache } from '@shared/hid/calibration'
import { errorText, stamp } from '@shared/format'
import { mergeCalibration } from '../hid/calibration'

export interface ConfigTransferDeps {
  getConfig(): AppConfig
  /** Apply and persist a whole AppConfig (the config:set path). */
  setConfig(config: AppConfig): AppConfig
  /**
   * An import was applied (R3.3): the renderer is told the settings, and its forms start over
   * from them — as they did from the import's answer, whatever sections it held.
   */
  imported?(): void
  nodes: {
    mappingFile(): NodeMappingFile
    registryDefaults(): Map<number, NodeDefaults>
    /** The imported settings over the current mapping; observed state (added, lastSeen) stays. */
    importMapping(file: NodeMappingFile): NodeMappingResult
    /** NODE_IDs on the bus now — an import never hides one. */
    onlineIds(): number[]
  }
  loadCalCache(): CalCache
  saveCalCache(cache: CalCache): void
  /** Directory backups go to (<userData>/backups). */
  backupDir(): string
  clientVersion(): string
  now?(): Date
}

export class ConfigTransfer {
  /** The file last previewed, until it is applied or another is opened. */
  private pending?: { token: string; config: ParsedConfig }

  constructor(private readonly deps: ConfigTransferDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  snapshot(): ConfigSnapshot {
    const config = this.deps.getConfig()
    return {
      app: appSettings(config),
      nodeMapping: this.deps.nodes.mappingFile(),
      powerSupply: config.psu,
      calibration: this.deps.loadCalCache()
    }
  }

  /** The export file's text. */
  exportText(): string {
    const file = buildConfigFile(
      this.snapshot(),
      this.now().toISOString(),
      this.deps.clientVersion()
    )
    return JSON.stringify(file, null, 2)
  }

  defaultFileName(): string {
    return `skyhawk-config-${this.now().toISOString().slice(0, 10)}.json`
  }

  /**
   * Write the export to the file the save dialog picked, and say what came of it (R3.4a: the
   * renderer read that from which field was set). No file: the dialog was cancelled.
   */
  exportTo(filePath: string | undefined): ConfigExportResult {
    if (!filePath) return { outcome: 'canceled' }
    try {
      writeFileSync(filePath, this.exportText())
      return { outcome: 'saved', path: filePath }
    } catch (err) {
      return {
        outcome: 'failed',
        error: `Could not write the file: ${err instanceof Error ? err.message : err}`
      }
    }
  }

  /** Validate a file's text and preview it against the current setup. */
  preview(text: string, path: string): ConfigImportOpen {
    const parsed = parseConfigFile(text)
    if (!parsed.ok) {
      this.pending = undefined
      return { status: 'error', error: parsed.error }
    }
    const { config } = parsed
    const sections = withSectionNotes(
      diffImport(
        this.deps.nodes.registryDefaults(),
        this.snapshot(),
        config.sections,
        this.deps.nodes.onlineIds()
      )
    )
    const token = randomUUID()
    this.pending = { token, config }
    return {
      status: 'ready',
      preview: {
        token,
        fileName: basename(path),
        ...(config.exportedAt ? { exportedAt: config.exportedAt } : {}),
        ...(config.client ? { client: config.client } : {}),
        sections,
        skipped: config.skipped,
        identical: sections.every((s) => s.rows.length === 0)
      }
    }
  }

  /**
   * Apply the picked sections. The backup, when asked for, is written first and its failure stops
   * everything. The node mapping goes next because it is the one store that can refuse a save
   * (read-only, or written by a newer client); if it does, nothing else is applied either.
   */
  apply(token: string, sections: unknown, backup: unknown): ConfigImportApplyResult {
    const pending = this.pending
    if (!pending || pending.token !== token) {
      return { ok: false, error: 'That file is no longer open — import it again.' }
    }
    if (
      !Array.isArray(sections) ||
      sections.some((s) => !(SECTION_IDS as unknown[]).includes(s)) ||
      typeof backup !== 'boolean'
    ) {
      return { ok: false, error: 'Invalid import request' }
    }
    const imported = pending.config.sections
    const picked = new Set((sections as SectionId[]).filter((id) => imported[id] !== undefined))
    if (picked.size === 0) return { ok: false, error: 'No sections picked' }

    let backupPath: string | undefined
    if (backup) {
      try {
        const dir = this.deps.backupDir()
        mkdirSync(dir, { recursive: true })
        backupPath = join(dir, `skyhawk-config-${stamp(this.now())}.json`)
        writeFileSync(backupPath, this.exportText())
      } catch (err) {
        return { ok: false, error: `Backup failed, nothing was changed: ${errorText(err)}` }
      }
    }

    if (picked.has('nodeMapping')) {
      const r = this.deps.nodes.importMapping(imported.nodeMapping!)
      if (!r.ok) return { ok: false, error: `Nothing was changed: ${r.error}` }
    }
    if (picked.has('calibration')) {
      this.deps.saveCalCache(mergeCalibration(this.deps.loadCalCache(), imported.calibration!))
    }
    let config = this.deps.getConfig()
    if (picked.has('app') || picked.has('powerSupply')) {
      config = this.deps.setConfig(applyToConfig(config, imported, picked))
    }
    this.pending = undefined
    this.deps.imported?.()
    const applied = SECTION_IDS.filter((id) => picked.has(id))
    return { ok: true, applied, ...(backupPath ? { backupPath } : {}), config }
  }
}
