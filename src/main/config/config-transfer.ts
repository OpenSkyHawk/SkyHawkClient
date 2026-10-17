// Configuration export / import (#67) in main: gathers the four stores into one file, previews a
// file against them, and applies the sections the user picked as one transaction (C2/M10). The
// rules are in config-file.ts; this file only reads and writes. Dialogs stay in index.ts.
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
  buildImportPreview,
  parseConfigFile,
  SECTION_IDS,
  SECTION_TITLES,
  type ParsedConfig
} from './config-file'
import type { CalCache } from '@shared/hid/calibration'
import { errorText, stamp } from '@shared/format'
import { mergeCalibration } from '../hid/calibration'
import { importMapping } from '../nodes'
import type { SettingsReplace } from './settings-service'

export interface ConfigTransferDeps {
  getConfig(): AppConfig
  /**
   * Save a whole AppConfig, then make it live — only once it is on disk (SettingsService.replace).
   * Says why when config.json was not written; nothing changed then.
   */
  replaceConfig(config: AppConfig): SettingsReplace
  /**
   * An import was applied (R3.3): the renderer is told the settings, and its forms start over
   * from them — as they did from the import's answer, whatever sections it held.
   */
  imported?(): void
  nodes: {
    mappingFile(): NodeMappingFile
    registryDefaults(): Map<number, NodeDefaults>
    /** Save this whole mapping: an import's staged result, or its rollback (NodeHub). */
    replaceMapping(file: NodeMappingFile): NodeMappingResult
    /** NODE_IDs on the bus now — an import never hides one. */
    onlineIds(): number[]
  }
  loadCalCache(): CalCache
  /** Save the calibration copy; says why when it did not reach the disk. */
  saveCalCache(cache: CalCache): string | undefined
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
    const token = randomUUID()
    this.pending = { token, config }
    const against = {
      defaults: this.deps.nodes.registryDefaults(),
      current: this.snapshot(),
      online: this.deps.nodes.onlineIds()
    }
    return { status: 'ready', preview: buildImportPreview(config, against, token, basename(path)) }
  }

  /**
   * Apply the picked sections as one transaction (C2/M10). Every picked target is staged first —
   * its new content worked out, nothing written. The backup, when asked for, is written next and
   * its failure stops everything. Then the targets are committed in turn: the node mapping first
   * (the one store that can refuse a save: read-only, or written by a newer client), then the
   * calibration copy, then the settings (config.json; live only once it is on disk). If one fails,
   * the targets already written are put back as they were before the import, and the answer says
   * which section failed — and, if a rollback failed too, that the import is only partly applied.
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

    // Staged first: every target's new content worked out before anything is written.
    const targets = this.stage(imported, picked)

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

    const done: Target[] = []
    for (const t of targets) {
      const failed = t.commit()
      if (failed === undefined) {
        done.push(t)
        continue
      }
      return {
        ok: false,
        error: rolledBack(`${t.title} could not be saved: ${failed}`, done, backupPath)
      }
    }
    this.pending = undefined
    this.deps.imported?.()
    const applied = SECTION_IDS.filter((id) => picked.has(id))
    return {
      ok: true,
      applied,
      ...(backupPath ? { backupPath } : {}),
      config: this.deps.getConfig()
    }
  }

  /**
   * Every picked target's new content, worked out before anything is written, with how to write
   * it and how to put back what was there. In commit order.
   */
  private stage(imported: Partial<ConfigSnapshot>, picked: ReadonlySet<SectionId>): Target[] {
    const { nodes } = this.deps
    const targets: Target[] = []
    if (picked.has('nodeMapping')) {
      const before = nodes.mappingFile()
      const next = importMapping(before, imported.nodeMapping!, nodes.onlineIds())
      const write = (f: NodeMappingFile) => {
        const r = nodes.replaceMapping(f)
        return r.ok ? undefined : r.error
      }
      targets.push({
        title: SECTION_TITLES.nodeMapping,
        commit: () => write(next),
        rollback: () => write(before)
      })
    }
    if (picked.has('calibration')) {
      const before = this.deps.loadCalCache()
      const next = mergeCalibration(before, imported.calibration!)
      targets.push({
        title: SECTION_TITLES.calibration,
        commit: () => this.deps.saveCalCache(next),
        rollback: () => this.deps.saveCalCache(before)
      })
    }
    if (picked.has('app') || picked.has('powerSupply')) {
      const before = this.deps.getConfig()
      const next = applyToConfig(before, imported, picked)
      const write = (c: AppConfig) => {
        const r = this.deps.replaceConfig(c)
        return r.ok ? undefined : r.error
      }
      const titles = (['app', 'powerSupply'] as const).filter((id) => picked.has(id))
      targets.push({
        title: titles.map((id) => SECTION_TITLES[id]).join(' and '),
        commit: () => write(next),
        rollback: () => write(before)
      })
    }
    return targets
  }
}

/** One store an import writes: its sections' title, and its write and rollback (each: why not). */
interface Target {
  title: string
  commit(): string | undefined
  rollback(): string | undefined
}

/**
 * Put back the targets already written, newest first, and say what came of the import: nothing
 * changed, or — when a rollback failed too — which sections are left as the file has them.
 */
function rolledBack(failed: string, done: readonly Target[], backupPath?: string): string {
  const restored: string[] = []
  const stuck: string[] = []
  for (const t of [...done].reverse()) {
    const error = t.rollback()
    if (error === undefined) restored.unshift(t.title)
    else stuck.unshift(`${t.title} could not be put back (${error})`)
  }
  const back = restored.length
    ? `. ${and(restored)} ${restored.length === 1 ? 'was' : 'were'} put back as before`
    : ''
  if (stuck.length === 0) return `Nothing was changed — ${failed}${back}`
  const keep = stuck.length === 1 ? 'it keeps' : 'they keep'
  const copy = backupPath ? ` Your previous setup is in ${basename(backupPath)}.` : ''
  const left = `${stuck.join('; ')}, so ${keep} the imported settings`
  return `The import is only partly applied — ${failed}. ${left}${back}.${copy}`
}

/** "a", "a and b", "a, b and c". */
const and = (items: string[]): string =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
