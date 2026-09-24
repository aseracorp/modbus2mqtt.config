#!/usr/bin/env node
/**
 * Validate modbus2mqtt specification YAML files using the shared backend
 * validator from the aseracorp/modbus2mqtt fork.
 *
 * Usage (from the config repo root after building the backend):
 *   M2M_BACKEND=/path/to/modbus2mqtt node scripts/validate.mjs [file.yaml ...]
 *
 * With no file arguments, every `specifications/*.yaml` in the repo is
 * validated. Targets (typically the files changed in the PR) may be passed
 * explicitly — only those are checked.
 *
 * Exit code 0 = all specs valid, 1 = ony invalid spec, 2 = usage/env error.
 */
import * as fs from 'fs'
import * as path from 'path'
import { createRequire } from 'module'

const BACKEND = process.env.M2M_BACKEND
if (!BACKEND) {
  console.error('validate.mjs: M2M_BACKEND env var must point at a modbus2mqtt checkout')
  process.exit(2)
}
const require = createRequire(BACKEND + '/')
const { parse } = require('yaml') // yaml is a backend dependency
const { M2mSpecification } = await import(path.join(BACKEND, 'dist/specification/m2mspecification.js'))
const { Migrator } = await import(path.join(BACKEND, 'dist/specification/migrator.js'))

/**
 * Mirrors SpecPersistence.postProcessSpec: normalises the hand-authored
 * `converter: { name: 'number' }` object form to the runtime string form,
 * fills numberFormat defaults, nextEntityId, i18n and files.
 */
function postProcess(o) {
  if (o.entities)
    o.entities.forEach((entity) => {
      if (entity.converter != undefined && typeof entity.converter === 'object' && 'name' in entity.converter) {
        entity.converter = entity.converter.name
      }
      if (entity.converter != undefined) {
        const p = entity.converterParameters
        if (p && p.multiplier != undefined && p.numberFormat == undefined) p.numberFormat = 0
      }
      if (!o.nextEntityId || entity.id > o.nextEntityId + 1) o.nextEntityId = entity.id + 1
    })
  if (!o.i18n) o.i18n = []
  if (!o.files) o.files = []
  return o
}

const args = process.argv.slice(2)
const targets = args.length > 0
  ? args
  : fs.readdirSync(path.join(process.cwd(), 'specifications'))
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => path.join('specifications', f))

let failed = 0
for (const f of targets) {
  const full = path.isAbsolute(f) ? f : path.join(process.cwd(), f)
  try {
    const raw = fs.readFileSync(full, 'utf8')
    let spec = parse(raw)
    if (!spec) {
      console.log(`FAIL ${f}: YAML parsed to nothing`)
      failed++
      continue
    }
    if (spec.version !== '0.5') spec = new Migrator().migrate(spec)
    spec = postProcess(spec)
    const msgs = new M2mSpecification(spec).validate('en')
    if (msgs.length === 0) {
      console.log(`PASS ${f}`)
    } else {
      console.log(`FAIL ${f}: ${msgs.length} message(s)`)
      for (const m of msgs.slice(0, 10)) console.log(`   type=${m.type} category=${m.category} ${m.message ?? ''}`)
      failed++
    }
  } catch (e) {
    console.log(`ERROR ${f}: ${e instanceof Error ? e.message : e}`)
    failed++
  }
}
console.log(failed === 0 ? 'ALL SPECS VALID' : `${failed} INVALID`)
process.exit(failed === 0 ? 0 : 1)