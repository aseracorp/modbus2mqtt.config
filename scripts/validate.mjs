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
 * The structural parts of validation use the backend's own M2mSpecification.
 * Identification is checked testdata-aware: each entity's registers are
 * resolved through the spec testdata and conditional entities are only
 * required to identify when their conditions are met (inactive variants such
 * as the WRF06 SI/Imperial dual-unit registers are skipped, not failed).
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
const require = createRequire(BACKEND + '/backend/')   // monorepo: backend deps live here
const { parse } = require('yaml') // yaml is a backend dependency
const { M2mSpecification } = await import(path.join(BACKEND, 'dist/specification/m2mspecification.js'))
const { Migrator } = await import(path.join(BACKEND, 'dist/specification/migrator.js'))
const { emptyModbusValues } = await import(path.join(BACKEND, 'dist/specification/modbusValues.js'))
const { entityConditions, isEntityActiveByValues } = await import(path.join(BACKEND, 'dist/specification/conditions.js'))
const { IdentifiedStates, ModbusRegisterType } = await import(path.join(BACKEND, 'dist/shared/specification/index.js'))

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

/** Build the modbus-values map from the spec's testdata block. */
function buildValues(spec) {
  const values = emptyModbusValues()
  const td = spec.testdata
  if (!td) return values
  const add = (map, list) => {
    if (!list) return
    for (const it of list) map.set(it.address, { data: [it.value] })
  }
  add(values.holdingRegisters, td.holdingRegisters)
  add(values.analogInputs, td.analogInputs)
  add(values.coils, td.coils)
  add(values.discreteInputs, td.discreteInputs)
  return values
}

/** Decode one register value through the number converter parameters (replaces the
 *  full converter pipeline for the common `number` converter used by identification). */
function decodeNumber(entity, raw) {
  const p = entity.converterParameters || {}
  const mult = p.multiplier != undefined ? p.multiplier : 1
  const off = p.offset != undefined ? p.offset : 0
  const nf = p.numberFormat
  let v = raw
  if (nf === 2 || nf === 1) {
    // signed 16 / 32 bit two's complement
    const bits = nf === 2 ? 16 : 32
    const max = 2 ** bits
    if (v >= max / 2) v -= max
  }
  const value = v * mult + off
  const dec = p.decimals != undefined ? p.decimals : 0
  return Number(value.toFixed(dec))
}

/**
 * Conditional-register-aware identification check.
 * Returns { pass: boolean, detail: string[] }
 */
function checkIdentification(spec, values) {
  const issues = []
  let anyActive = false
  for (const entity of spec.entities || []) {
    // Only modbus-backed numeric entities with an identification range are checked.
    if (entity.modbusAddress == undefined || entity.registerType == undefined) continue
    if (entity.converter !== 'number' || !entity.converterParameters) continue
    const ident = entity.converterParameters.identification
    if (!ident) continue

    // Conditional entity: if its conditions are not met by the testdata, it is
    // an inactive variant — skip it (do not fail the whole spec).
    const conds = entityConditions(entity)
    if (conds.length > 0) {
      if (!isEntityActiveByValues(entity, values)) continue
      // Active but no data for its own address -> cannot confirm; issue.
      const map = values[registerMapKey(entity.registerType)]
      if (!map || !map.has(entity.modbusAddress)) {
        issues.push(`entity ${entity.id} (${entity.mqttname}) active but register ${entity.modbusAddress} missing testdata`)
        continue
      }
    }

    const map = values[registerMapKey(entity.registerType)]
    const entry = map && map.get(entity.modbusAddress)
    if (!entry || !entry.data || entry.data.length === 0) {
      // No testdata for this entity's register: only flag if it has no conditions
      // (unconditional entities are always expected to be present).
      if (conds.length === 0) issues.push(`entity ${entity.id} (${entity.mqttname}) register ${entity.modbusAddress} has no testdata`)
      continue
    }
    anyActive = true
    const decoded = decodeNumber(entity, entry.data[0])
    if (!(ident.min <= decoded && decoded <= ident.max)) {
      issues.push(`entity ${entity.id} (${entity.mqttname}) value ${decoded} outside identification ${ident.min}..${ident.max}`)
    }
  }
  return { pass: issues.length === 0, detail: issues }
}

function registerMapKey(rt) {
  switch (rt) {
    case ModbusRegisterType.AnalogInputs: return 'analogInputs'
    case ModbusRegisterType.Coils: return 'coils'
    case ModbusRegisterType.DiscreteInputs: return 'discreteInputs'
    default: return 'holdingRegisters'
  }
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

    // 1) Structural validation via the backend
    const structural = new M2mSpecification(spec).validate('en')
      .filter((m) => m.type !== 29) // drop backend notIdentified (replaced by conditional-aware check)
    // 2) Testdata-aware identification (supports conditional registers)
    const values = buildValues(spec)
    const ident = checkIdentification(spec, values)

    const problems = [...structural, ...ident.detail.map((d) => ({ type: -1, category: -1, message: d }))]
    if (problems.length === 0) {
      console.log(`PASS ${f}`)
    } else {
      console.log(`FAIL ${f}: ${problems.length} message(s)`)
      for (const m of problems.slice(0, 12)) console.log(`   type=${m.type} category=${m.category} ${m.message ?? ''}`)
      failed++
    }
  } catch (e) {
    console.log(`ERROR ${f}: ${e instanceof Error ? e.message : e}`)
    failed++
  }
}
console.log(failed === 0 ? 'ALL SPECS VALID' : `${failed} INVALID`)
process.exit(failed === 0 ? 0 : 1)
