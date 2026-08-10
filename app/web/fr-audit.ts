// Freerange audit over the Create app's own core files (create/**/core*.ts), part
// of `bun check`. The vendored kit cores are audited upstream in mj-gallery
// (scripts/fr-kit.ts pins their coverage there); this script audits only the code
// this app owns. Uses the @chenglou/freerange devDep's `fr` CLI, which respects
// ./tsconfig.json.
//
// When the first core file lands, pin its coverage triple in CORE_PINS (the
// upstream fr-kit.ts pattern): findings alone can't catch a refactor that silently
// drops functions out of analysis — a coverage drop must fail here, and a coverage
// IMPROVEMENT must be pinned upward.
import { existsSync } from 'node:fs'

const fr = `${import.meta.dir}/node_modules/.bin/fr`
if (!existsSync(fr)) {
  console.error(`fr-audit: freerange not found at ${fr} — run bun install`)
  process.exit(1)
}

// file (relative to app/web/) -> expected "analyzed/total" coverage + partial count.
// Every create/core/*.ts file MUST have an entry; an unpinned file fails the audit.
// Most Create cores are string/JSON domain (declared in their headers, tested), so low
// analyzed counts are expected — the pin catches analyzability REGRESSIONS, and any
// finding fails via fr's exit code regardless of domain.
const CORE_PINS: { file: string, coverage: string, partial: number }[] = [
  // 5/23 -> 5/25 with §15: +parseUploadResult, +uploadUrl (string domain, unsupported).
  // 5/25 -> 5/26 with §16: +parseUnderpaintEnvelope (unknown-record parse, string
  // domain, unsupported as expected; api.test.ts is the checked surface).
  { file: 'create/core/api.ts', coverage: '5/26', partial: 2 },
  { file: 'create/core/feel.ts', coverage: '0/0', partial: 0 },
  { file: 'create/core/gallery.ts', coverage: '3/5', partial: 0 },
  // §15 weight_mask codec — string domain by declaration; the analyzed are the
  // incidental numeric-ish helpers. 4/12 -> 5/13 with §5.1a: +initNaturalDims (a
  // field projection, analyzable).
  { file: 'create/core/init.ts', coverage: '5/13', partial: 0 },
  { file: 'create/core/keys.ts', coverage: '1/1', partial: 0 },
  // 1/7 -> 4/14 with the two-axis lightbox (§8 rework): +makeJobsSource, +jobRef,
  // +dominantAxis, +stillSwipe, +landOnJob, +stepJob, +jumpToJob. Analyzed: refOf,
  // jobRef, stillSwipe, dominantAxis; the union/spread state transitions stay
  // string-domain as declared (lightbox.test.ts is the checked surface).
  { file: 'create/core/lightbox.ts', coverage: '4/14', partial: 0 },
  // §15 editor geometry: viewToImage + clampBrushSize analyzed; strokeStamps is an
  // array producer (documented fr exception in its header, tested).
  { file: 'create/core/mask.ts', coverage: '2/3', partial: 0 },
  // 2/11 -> 3/13 with the failed-submit queue-restore fix: +pendingFromQueueSlot,
  // +failSubmission (one of the two is in the analyzable subset).
  // 3/13 -> 3/15 with §15.7 containment: +openMaskEditor, +dropUnreadableMask — state
  // transitions on the tagged-union store (string/JSON domain, model.test.ts is the
  // checked surface), outside freerange's numeric subset as expected.
  // 3/15 held through the FIFO queue rework (§2.5): -pendingFromQueueSlot,
  // -failSubmission (one-slot contract dead), +findQueueItem, +removeQueueItem —
  // same domain, same checked surface.
  // 3/15 -> 3/16 with §5.1a: +replaceInit (tagged-union store transition — string/JSON
  // domain like the rest, model.test.ts is the checked surface).
  // 3/16 -> 3/17 with the EXPERIMENTS panel (§5.7): +applyHoldMeaning (union-store
  // transition, unsupported as expected; model.test.ts is the checked surface).
  // 3/17 -> 3/19 with the ANNEAL row + VQGAN/AUTO-STOP guards (§5.7): +applyLook,
  // +applyAutoStop — union-store transitions like applyHoldMeaning, unsupported as
  // expected; model.test.ts is the checked surface.
  // 3/19 -> 3/25 with §16 (two-phase sessions): +applyProjection, +applyFourier,
  // +applyUnderpaint, +applyAspect, +applySize, +enforceProjectionDims — union-store
  // transitions like applyLook, unsupported as expected; model.test.ts is the
  // checked surface.
  { file: 'create/core/model.ts', coverage: '3/25', partial: 0 },
  // 1/10 -> 2/10 with the SIZE/STEPS split: qualitySteps (unsupported Record read)
  // retired; parseStepsId (numeric exact-match loop, ensures return in 150..600) is
  // fully analyzed alongside dimsTable.
  // 2/10 -> 4/15 across the steps + AUTO merges: steps-as-plain-number added
  // +parseCustomSteps (string domain — regex boundary, unsupported as expected) and
  // +rematerializeSteps (Record read, unsupported as expected), parseStepsId's table
  // is now 150..2400 (450 retired; 1200/2400 added); AUTO aspect (§5.1a) added
  // +autoDims and +autoDimsMultiple, both fully analyzed (pure numeric), and
  // +autoAspectDims unsupported as expected (Record read into the tweak base).
  // 4/15 -> 5/26 with the EXPERIMENTS panel (§5.7): +defaultExperiments analyzed
  // (pure literal producer); +applyRow/+noiseEmit/+pyramidEmit/+toggleEmit/
  // +applyExperiments (Record writes) and +matchNoise/+matchPyramid/+matchToggle/
  // +matchSampler/+matchExperiments (Record/unknown reads) unsupported as expected —
  // string/JSON domain, presets.test.ts is the checked surface.
  // 5/26 -> 5/28 with the ANNEAL row (§5.7): +annealEmit (Record producer) and
  // +matchAnneal (unknown reads) unsupported as expected — same domain, same
  // checked surface (matchSampler became matchFullVision, count-neutral).
  // 5/28 -> 6/33 with §16 (two-phase sessions): +projectionDimsSafe ANALYZED (pure
  // numeric /8 gate — pinned upward); +underpaintEnvelope, +matchProjection,
  // +matchFourier, +matchUnderpaint unsupported as expected (Record/unknown reads,
  // string/JSON domain; presets.test.ts is the checked surface).
  { file: 'create/core/presets.ts', coverage: '6/33', partial: 0 },
  { file: 'create/core/surfaces.ts', coverage: '1/2', partial: 0 },
]

const coreFiles = [...new Bun.Glob('create/core/*.ts').scanSync(import.meta.dir)]
  .filter((f) => !f.endsWith('.test.ts'))
  .sort()
if (coreFiles.length === 0) {
  console.log('fr-audit: no create/core/*.ts files yet — nothing to audit')
  process.exit(0)
}

let failed = false
for (const file of coreFiles) {
  const pin = CORE_PINS.find((p) => p.file === file)
  if (pin == null) {
    console.error(`fr-audit: FAIL: ${file} has no coverage pin — add it to CORE_PINS with its fr coverage triple`)
    failed = true
    continue
  }
  console.log(`\n== fr ${file} (expect ${pin.coverage} analyzed, ${pin.partial} partial)`)
  const result = Bun.spawnSync(['bun', fr, file], { cwd: import.meta.dir, stdout: 'pipe', stderr: 'inherit' })
  const out = result.stdout.toString()
  console.log(out.trimEnd())
  if (result.exitCode !== 0) failed = true
  // Pin the full coverage triple: findings alone can't catch a partial->unsupported
  // slide, and full/unsupported alone can't catch analyzed->partial.
  const match = out.match(/coverage: (\d+\/\d+)[^;]*; (\d+) partially supported/)
  if (match == null) {
    console.error(`   FAIL: no coverage line found for ${file}`)
    failed = true
  } else if (match[1] !== pin.coverage || Number(match[2]) !== pin.partial) {
    console.error(`   FAIL: coverage ${match[1]}/${match[2]}-partial != pinned ${pin.coverage}/${pin.partial} — update the pin only with the analyzability change understood`)
    failed = true
  }
}
process.exit(failed ? 1 : 0)
