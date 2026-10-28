// Process + topic boundaries for the structure rewrite (SkyHawkClient#97, arch-phase0-v2 §5).
//
// Seeded from `depcruise --init oneshot` (dependency-cruiser 18.5.0); its default rule set is
// replaced by the boundary rules below, its options are kept.
//
// The rules describe the layout: src/main/<topic>/, src/renderer/src/<topic>/ and
// src/shared/<topic>/{index,ipc}.ts contracts, plus the leaves src/shared/firmware/,
// src/shared/format/ and src/renderer/src/app/kit/.
//
// Severities live ONLY in .dependency-cruiser.severity.json, one key per rule family. Each phase
// flipped its own families from "warn" to "error"; since R3.4b every family is "error".
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS config file
const SEV = require('./.dependency-cruiser.severity.json')

const MAIN = 'src/main'
const RENDERER = 'src/renderer/src'

const FIRMWARE = '^src/shared/firmware/'
const FORMAT = '^src/shared/format/'
const KIT = `^${RENDERER}/app/kit/`
const CONTRACT = '^src/shared/[a-z-]+(/calibration)?/(index|ipc)\\.ts$'
// Topic directions, the same inside main and inside the renderer. `app` may import everything,
// so it has no rule. Every topic may also import the leaves, the kit and the shared contracts.
const ALLOW = {
  nodes: ['gateway', 'events'],
  dcs: ['gateway', 'events'],
  hid: ['gateway'],
  'hid/calibration': ['hid', 'gateway'],
  gateway: ['events'],
  config: ['nodes', 'hid/calibration'],
  releases: ['events'],
  update: [],
  events: []
}

// A topic's folder; `hid` must not swallow `hid/calibration`.
const dir = (root, topic) =>
  topic === 'hid' ? `^${root}/hid/(?!calibration/)` : `^${root}/${topic}/`

const topicRules = (side, root, severity, extraAllowed) =>
  Object.entries(ALLOW).map(([topic, allowed]) => ({
    name: `topic-${side}-${topic.replace('/', '-')}`,
    severity,
    comment: `${side} ${topic} may import only ${allowed.join(', ') || 'no other topic'} (+ firmware, format, kit, contracts)`,
    from: { path: dir(root, topic) },
    to: {
      path: `^${root}/`,
      pathNot: [dir(root, topic), ...allowed.map((t) => dir(root, t)), ...extraAllowed]
    }
  }))

// T2: across topics, import only a topic's index.ts. $1 is the importing topic.
const deepRule = (side, root, severity, extraAllowed) => ({
  name: `T2-${side}-no-deep-topic-import`,
  severity,
  comment: `outside a ${side} topic, import only its index.ts`,
  from: { path: `^${root}/([^/]+)/` },
  to: {
    path: `^${root}/[^/]+/`,
    pathNot: [
      `^${root}/$1/`,
      `^${root}/[^/]+/index\\.ts$`,
      `^${root}/hid/calibration/index\\.ts$`,
      ...extraAllowed
    ]
  }
})

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ── process (hard boundary) ─────────────────────────────────────────────
    {
      name: 'P1-renderer-not-main',
      severity: SEV.crossProcess,
      comment: 'the renderer reaches main only over IPC',
      from: { path: '^src/renderer/' },
      to: { path: '^src/(main|preload)/' }
    },
    {
      name: 'P2-main-not-renderer',
      severity: SEV.crossProcess,
      comment: 'main never imports renderer code',
      from: { path: '^src/main/' },
      to: { path: '^src/renderer/' }
    },
    {
      name: 'P3-shared-is-a-leaf',
      severity: SEV.process,
      comment: 'shared code imports nothing from a process',
      from: { path: '^src/shared/' },
      to: { path: '^src/(main|renderer|preload)/' }
    },
    {
      name: 'P4-renderer-imports-contracts-only',
      severity: SEV.rendererShared,
      comment: 'the renderer imports only shared contracts and the firmware/format leaves',
      from: { path: '^src/renderer/' },
      to: { path: '^src/shared/', pathNot: [CONTRACT, FIRMWARE, FORMAT] }
    },
    {
      name: 'P6-electron-only-in-app',
      severity: SEV.electron,
      comment: 'electron is imported only by main/app and preload',
      from: { pathNot: '^src/(main/app|preload)/' },
      to: { path: '^node_modules/electron/' }
    },
    // ── contracts + leaves ──────────────────────────────────────────────────
    {
      name: 'C1-contracts-import-contracts',
      severity: SEV.contracts,
      comment: 'a contract imports only other contracts and the leaves',
      from: { path: CONTRACT },
      to: { path: '^src/', pathNot: [CONTRACT, FIRMWARE, FORMAT] }
    },
    {
      name: 'L-firmware-leaf',
      severity: SEV.firmwareLeaf,
      comment: 'shared/firmware imports nothing else in src',
      from: { path: FIRMWARE },
      to: { path: '^src/', pathNot: FIRMWARE }
    },
    {
      name: 'L-format-leaf',
      severity: SEV.formatLeaf,
      comment: 'shared/format imports nothing else in src',
      from: { path: FORMAT },
      to: { path: '^src/', pathNot: FORMAT }
    },
    {
      name: 'L-kit-leaf',
      severity: SEV.kitLeaf,
      comment: 'app/kit imports no other renderer code',
      from: { path: KIT },
      to: { path: '^src/renderer/', pathNot: KIT }
    },
    // ── topics (soft boundary) ──────────────────────────────────────────────
    ...topicRules('main', MAIN, SEV.topicsMain, []),
    ...topicRules('renderer', RENDERER, SEV.topicsRenderer, [KIT]),
    deepRule('main', MAIN, SEV.deepMain, []),
    deepRule('renderer', RENDERER, SEV.deepRenderer, [KIT]),
    // ── cycles ──────────────────────────────────────────────────────────────
    {
      name: 'C2-no-circular',
      severity: SEV.cycles,
      comment: 'no circular dependencies anywhere (type-only imports included)',
      from: {},
      to: { circular: true }
    }
  ],
  options: {
    doNotFollow: { path: ['node_modules'] },
    exclude: {
      path: [
        '\\.test\\.tsx?$',
        '^src/test-fixtures/',
        '^src/renderer/test/',
        '^src/main/test-harness/'
      ]
    },
    // Type-only imports count: today's model <-> contract cycles are type cycles.
    tsPreCompilationDeps: true,
    // tsconfig.json carries both the @shared and @renderer paths; main and preload use only
    // @shared, which resolves the same way.
    tsConfig: { fileName: 'tsconfig.json' },
    detectProcessBuiltinModuleCalls: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.d.ts'],
      mainFields: ['main', 'types', 'typings']
    },
    skipAnalysisNotInRules: true,
    reporterOptions: {
      dot: { collapsePattern: 'node_modules/(?:@[^/]+/[^/]+|[^/]+)' },
      archi: {
        collapsePattern:
          '^(?:packages|src|lib(s?)|app(s?)|bin|test(s?)|spec(s?))/[^/]+|node_modules/(?:@[^/]+/[^/]+|[^/]+)'
      },
      text: { highlightFocused: true }
    }
  }
}
