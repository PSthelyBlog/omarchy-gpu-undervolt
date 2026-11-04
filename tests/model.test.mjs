// Run with: node --test tests/
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import vm from "node:vm"

const Model = {}
vm.createContext(Model)
vm.runInContext(readFileSync(new URL("../Model.js", import.meta.url), "utf8"), Model)

const curve = JSON.parse(readFileSync(new URL("./fixtures/rtx4070-vf-curve.json", import.meta.url), "utf8"))
const idle = { powerDefault: 200, powerMin: 100, powerMax: 200 }

// vm contexts have their own Array/Object, which deepStrictEqual treats as distinct.
const plain = (value) => JSON.parse(JSON.stringify(value))

// Shape taken from lact-schema's DeviceStats, with this RTX 4070's limits.
const stats = {
  fan: { control_enabled: false, pwm_current: 102, speed_current: 1400 },
  clockspeed: { gpu_clockspeed: 2670, vram_clockspeed: 10501, sensors: {} },
  voltage: { gpu: 975, sensors: {} },
  vram: { total: 12282 * 1024 * 1024, used: 6144 * 1024 * 1024 },
  power: { current: 148.4, cap_current: 150, cap_max: 200, cap_min: 100, cap_default: 200, sensors: {} },
  temps: { GPU: { current: 62, crit: 90, crit_hyst: null, primary: true, display_only: false } },
  busy_percent: 97,
  throttle_info: { SW_POWER_CAP: [] },
}

test("parseResponse unwraps ok and error replies", () => {
  assert.deepEqual(plain(Model.parseResponse('{"status":"ok","data":5}')), { ok: true, data: 5, error: "" })
  assert.equal(Model.parseResponse('{"status":"ok"}').data, null)
  const err = Model.parseResponse('{"status":"error","data":{"description":"Profile x already exists","source":null}}')
  assert.equal(err.ok, false)
  assert.equal(err.error, "Profile x already exists")
  assert.equal(Model.parseResponse("not json").ok, false)
})

test("encodeRequest is newline framed and omits absent args", () => {
  assert.equal(Model.encodeRequest("list_devices"), '{"command":"list_devices"}\n')
  assert.equal(Model.encodeRequest("hold_profile", { name: "x" }), '{"command":"hold_profile","args":{"name":"x"}}\n')
})

test("pickGpu takes the dedicated card and skips integrated ones", () => {
  const igpu = { id: "a", name: "iGPU", device_type: "Integrated" }
  const dgpu = { id: "b", name: "dGPU", device_type: "Dedicated" }
  assert.equal(Model.pickGpu([igpu, dgpu]).id, "b")
  assert.equal(Model.pickGpu([igpu]), null)
  assert.equal(Model.pickGpu(null), null)
})

test("shortName and pciAddress read LACT's formats", () => {
  assert.equal(Model.shortName("AD104 [GeForce RTX 4070]"), "GeForce RTX 4070")
  assert.equal(Model.shortName("Plain Name"), "Plain Name")
  assert.equal(Model.shortName(null), "GPU")
  assert.equal(Model.pciAddress("10DE:2709-1462:5138-0000:01:00.0"), "0000:01:00.0")
  assert.equal(Model.pciAddress("garbage"), "")
})

test("parseStats normalizes every metric", () => {
  const s = Model.parseStats(stats)
  assert.equal(s.powerNow, 148.4)
  assert.equal(s.powerCap, 150)
  assert.equal(s.clockMhz, 2670)
  assert.equal(s.voltageMv, 975)
  assert.equal(s.tempC, 62)
  assert.equal(s.fanPercent, 40)
  assert.equal(s.loadPercent, 97)
  assert.deepEqual(plain(s.limits), ["Power limit"])
})

test("parseStats keeps unavailable metrics null instead of inventing values", () => {
  const s = Model.parseStats({ power: {}, clockspeed: {}, voltage: {}, vram: {}, fan: {}, temps: {} })
  for (const key of ["powerNow", "powerCap", "clockMhz", "voltageMv", "tempC", "fanPercent", "loadPercent"]) {
    assert.equal(s[key], null, key)
  }
  assert.equal(Model.formatVoltage(s.voltageMv), "—")
  assert.equal(Model.formatPower(s), "—")
  assert.equal(Model.formatVram(s), "—")
})

test("parseStats falls back to average power (AMD reports it this way)", () => {
  assert.equal(Model.parseStats({ power: { average: 90 } }).powerNow, 90)
})

test("primaryTemp prefers GPU, then a primary sensor, then anything", () => {
  assert.equal(Model.primaryTemp({ edge: { current: 40, primary: true }, junction: { current: 70, primary: false } }), 40)
  assert.equal(Model.primaryTemp({ junction: { current: 70, primary: false } }), 70)
  assert.equal(Model.primaryTemp({}), null)
  assert.equal(Model.primaryTemp(null), null)
})

test("limitLabels merges duplicates and survives unknown reasons", () => {
  assert.deepEqual(plain(Model.limitLabels({ SW_THERMAL_SLOWDOWN: [], HW_THERMAL_SLOWDOWN: [] })), ["Thermal limit"])
  assert.deepEqual(plain(Model.limitLabels({ NEW_REASON: [] })), ["new reason"])
  assert.deepEqual(plain(Model.limitLabels(null)), [])
})

test("efficiencyCap is 75% of default on this card's 100-200 W range", () => {
  assert.equal(Model.efficiencyCap({ powerDefault: 200, powerMin: 100, powerMax: 200 }), 150)
})

test("efficiencyCap respects the card's minimum", () => {
  assert.equal(Model.efficiencyCap({ powerDefault: 200, powerMin: 180, powerMax: 200 }), 180)
})

test("efficiencyCap refuses cards that cannot go below default", () => {
  assert.equal(Model.efficiencyCap({ powerDefault: 200, powerMin: 200, powerMax: 200 }), null)
  assert.equal(Model.efficiencyCap({ powerDefault: null, powerMin: null, powerMax: null }), null)
  assert.equal(Model.efficiencyCap(null), null)
})

test("efficiencyCap works when the range is unknown", () => {
  assert.equal(Model.efficiencyCap({ powerDefault: 100, powerMin: null, powerMax: null }), 75)
})

test("profileConfig round-trips through profileMatches", () => {
  const config = { min_core_clock: 210, max_core_clock: 2565 }
  const profile = Model.profileConfig("gpu", config)
  assert.equal(Model.profileMatches(profile, "gpu", config), true)
  assert.equal(Model.profileMatches(profile, "gpu", { min_core_clock: 210, max_core_clock: 2580 }), false)
  assert.equal(Model.profileMatches(profile, "other", config), false)
  assert.equal(Model.profileMatches(null, "gpu", config), false)
})

test("profileMatches ignores LACT's defaults and curve key order", () => {
  const curve = { 3: { clockspeed_offset: 15 }, 12: { clockspeed_offset: 30 } }
  const stored = {
    gpus: { gpu: {
      fan_control_enabled: false, max_core_clock: 2595, min_core_clock: 210,
      nvidia_gpu_vf_curve: { 12: { clockspeed_offset: 30 }, 3: { clockspeed_offset: 15 } },
    } },
  }
  const wanted = { min_core_clock: 210, max_core_clock: 2595, nvidia_gpu_vf_curve: curve }
  assert.equal(Model.profileMatches(stored, "gpu", wanted), true)
})

test("efficientPoint lands on the measured sweet spot of the real curve", () => {
  const point = Model.efficientPoint(curve)
  assert.ok(point.base_voltage >= 960 && point.base_voltage <= 990, `${point.base_voltage} mV`)
  assert.ok(point.base_freq >= 2520 && point.base_freq <= 2595, `${point.base_freq} MHz`)
})

test("efficientPoint needs a usable curve", () => {
  assert.equal(Model.efficientPoint([]), null)
  assert.equal(Model.efficientPoint(null), null)
  const steep = Array.from({ length: 20 }, (_, i) => ({ base_voltage: 900 + i * 50, base_freq: 2000 + i }))
  assert.equal(Model.efficientPoint(steep), null)
})

test("efficiencyPlan prefers a clock cap and leaves the power limit alone", () => {
  const plan = Model.efficiencyPlan(idle, { points: curve, minClock: 210 })
  assert.equal(plan.config.min_core_clock, 210)
  assert.equal(plan.config.max_core_clock, Model.efficientPoint(curve).base_freq)
  assert.equal(plan.config.power_cap, undefined)
  assert.match(plan.label, /^\d+ MHz cap$/)
})

test("efficiencyPlan falls back to a power cap without a curve (AMD, Intel)", () => {
  const plan = Model.efficiencyPlan(idle, { points: [], minClock: null })
  assert.deepEqual(plain(plan), { config: { power_cap: 150 }, label: "150 W cap" })
  assert.equal(Model.efficiencyPlan(idle, null).config.power_cap, 150)
})

test("efficiencyPlan is null when nothing can be lowered", () => {
  assert.equal(Model.efficiencyPlan({ powerDefault: 200, powerMin: 200, powerMax: 200 }, null), null)
})

test("parseClocks reads the NVIDIA table and survives others", () => {
  const data = { table: { type: "nvidia", value: { gpu_vf_curve: curve, gpu_clock_range: [210, 3105] } } }
  assert.equal(Model.parseClocks(data).minClock, 210)
  assert.equal(Model.parseClocks(data).points.length, curve.length)
  assert.deepEqual(plain(Model.parseClocks({ table: { type: "amd", value: {} } })), { points: [], minClock: null })
  assert.deepEqual(plain(Model.parseClocks(null)), { points: [], minClock: null })
})

test("pushSample bounds history and ignores missing values", () => {
  assert.deepEqual(plain(Model.pushSample([1, 2, 3], 4, 3)), [2, 3, 4])
  assert.deepEqual(plain(Model.pushSample([1], null)), [1])
  const original = [1]
  Model.pushSample(original, 2)
  assert.equal(original.length, 1)
})

test("formatters", () => {
  const s = Model.parseStats(stats)
  assert.equal(Model.formatPower(s), "148 / 150 W")
  assert.equal(Model.formatVram(s), "6.0 / 12 GiB")
  assert.equal(Model.formatLimits(s), "Power limit")
  assert.equal(Model.profileStatus("efficiency", "2565 MHz cap"), "Efficiency · 2565 MHz cap")
  assert.equal(Model.profileStatus("efficiency", ""), "Efficiency")
  assert.equal(Model.profileStatus("stock", "2565 MHz cap"), "Stock")
})

const LIMITS = { stepSeconds: 45, soakSeconds: 300, maxOffset: 240 }
const start = () => Model.tunerStart(curve, "gpu", "print", LIMITS)
const pass = (mhz, score = mhz, extra = {}) => ({
  exitCode: 0, score, errors: 0, samples: 30, watts: 150, mhz, mv: 990, temp: 60, ...extra,
})

test("undervolt curve keeps low points stock and stays monotonic at every tuner offset", () => {
  const target = Model.efficientPoint(curve)
  for (let offset = 0; offset <= 240; offset += 15) {
    const shaped = Model.curveOffsets(curve, target.base_voltage, offset)
    assert.ok(Model.isMonotonic(curve, shaped), `+${offset}`)
    for (const point of curve) {
      if (point.base_voltage <= target.base_voltage - Model.RAMP_MV) assert.equal(shaped[point.index], undefined)
      if (offset && point.base_voltage >= target.base_voltage) assert.equal(shaped[point.index].clockspeed_offset, offset)
    }
    for (const entry of Object.values(shaped)) assert.equal(entry.clockspeed_offset % 15, 0)
  }
})

test("isMonotonic catches a curve that steps down", () => {
  const target = Model.efficientPoint(curve)
  const shaped = Model.curveOffsets(curve, target.base_voltage, 120)
  for (const point of curve) if (point.base_voltage > target.base_voltage) delete shaped[point.index]
  assert.equal(Model.isMonotonic(curve, shaped), false)
})

test("tunerStart targets the efficient point and needs a curve", () => {
  const tune = start()
  assert.equal(tune.phase, "baseline")
  assert.equal(tune.targetMv, Model.efficientPoint(curve).base_voltage)
  assert.equal(Model.tunerStart([], "gpu", "print", LIMITS), null)
})

test("tuner climbs, backs off by the margin after a failure, then soaks and finishes", () => {
  let t = start()
  t = Model.tunerAdvance(t, pass(2750, 600000))
  assert.equal(t.phase, "climb")
  assert.equal(t.offset, 0)
  t = Model.tunerAdvance(t, pass(2595, 2595))
  assert.equal(t.offset, 30)
  t = Model.tunerAdvance(t, pass(2625, 2625))
  t = Model.tunerAdvance(t, pass(2655, 2655))
  assert.equal(t.offset, 90)
  t = Model.tunerAdvance(t, pass(2685, 2685, { errors: 1 }))
  assert.equal(t.phase, "soak")
  assert.equal(t.failedAt, 90)
  assert.equal(t.lastGood, 60)
  assert.equal(t.offset, 30)
  t = Model.tunerAdvance(t, pass(2625, 2625))
  assert.equal(t.phase, "done")
  const saved = Model.tunedResult(t, "now")
  assert.equal(saved.offset, 30)
  assert.equal(saved.capMhz, t.baseClock + 30)
  assert.equal(saved.unverified, false)
})

test("tuner stops at the offset limit and still applies the margin", () => {
  let t = Model.tunerStart(curve, "gpu", "print", { ...LIMITS, maxOffset: 60 })
  t = Model.tunerAdvance(t, pass(2750))
  for (const mhz of [2595, 2625, 2655]) t = Model.tunerAdvance(t, pass(mhz))
  assert.equal(t.phase, "soak")
  assert.equal(t.lastGood, 60)
  assert.equal(t.offset, 30)
})

test("each kind of failed step ends the climb", () => {
  const climbing = () => Model.tunerAdvance(Model.tunerAdvance(start(), pass(2750)), pass(2595))
  const cases = [
    [{ errors: 2 }, "GPU error"],
    [{ exitCode: 3 }, "Stress load failed"],
    [{ exitCode: 4 }, "Stress load failed"],
    [{ score: null }, "Stress load gave no result"],
    [{ samples: 5 }, "GPU was not fully loaded"],
  ]
  for (const [fault, reason] of cases) {
    const t = Model.tunerAdvance(climbing(), pass(2625, 2625, fault))
    assert.equal(t.reason, reason)
    assert.notEqual(t.phase, "climb")
  }
})

test("clock stretching ends the climb: clock rose but work did not", () => {
  let t = Model.tunerAdvance(Model.tunerAdvance(start(), pass(2750)), pass(2595, 500000))
  t = Model.tunerAdvance(t, pass(2625, 505000))
  assert.equal(t.phase, "climb")
  t = Model.tunerAdvance(t, pass(2655, 505200))
  assert.equal(t.reason, "Performance stopped rising")
  assert.equal(t.phase, "soak")
})

test("failing at the clock cap itself stops without claiming a result", () => {
  const t = Model.tunerAdvance(Model.tunerAdvance(start(), pass(2750)), pass(2595, 2595, { errors: 1 }))
  assert.equal(t.phase, "stopped")
})

test("a failed baseline stops: nothing was undervolted yet", () => {
  assert.equal(Model.tunerAdvance(start(), pass(2750, 1, { exitCode: 3 })).phase, "stopped")
})

test("a failed soak drops by the margin and soaks again, down to the clock cap", () => {
  let t = Model.tunerAdvance(start(), pass(2750))
  for (const mhz of [2595, 2625, 2655, 2685]) t = Model.tunerAdvance(t, pass(mhz))
  t = Model.tunerAdvance(t, pass(2715, 2715, { errors: 1 }))
  assert.equal(t.phase, "soak")
  assert.equal(t.offset, 60)
  t = Model.tunerAdvance(t, pass(2655, 2655, { errors: 1 }))
  assert.equal(t.offset, 30)
  t = Model.tunerAdvance(t, pass(2625, 2625, { errors: 1 }))
  assert.equal(t.offset, 0)
  t = Model.tunerAdvance(t, pass(2595, 2595, { errors: 1 }))
  assert.equal(t.phase, "stopped")
})

test("recovering from a crash mid-climb keeps the last good step, minus the margin", () => {
  let t = Model.tunerAdvance(start(), pass(2750, 600000))
  for (const mhz of [2595, 2625, 2655]) t = Model.tunerAdvance(t, pass(mhz))
  assert.equal(t.offset, 90)
  const r = Model.tunerRecover({ ...t, running: true })
  assert.equal(r.phase, "done")
  assert.equal(r.running, false)
  assert.equal(r.failedAt, 90)
  assert.equal(r.offset, 30)
  assert.equal(r.unverified, true)
  assert.equal(Model.tunedResult(r, "now").unverified, true)
})

test("recovering from a soak crash lowers below the soaked offset", () => {
  const r = Model.tunerRecover({ ...start(), phase: "soak", offset: 60, lastGood: 90, running: true })
  assert.equal(r.phase, "done")
  assert.equal(r.offset, 30)
})

test("a crash before any step passed keeps nothing", () => {
  assert.equal(Model.tunerRecover({ ...start(), running: true }).phase, "stopped")
  assert.equal(Model.tunerRecover({ ...start(), phase: "climb", running: true }).phase, "stopped")
})

test("summarizeStep ignores warm-up and burst samples", () => {
  const sample = (loadPercent, powerNow) => ({ loadPercent, powerNow, clockMhz: 2600, voltageMv: 990, tempC: 60 })
  const samples = [sample(99, 40), sample(99, 80), sample(99, 120), ...Array(6).fill(sample(99, 160)), sample(30, 50)]
  const result = Model.summarizeStep(samples, 0, 500, 0)
  assert.equal(result.samples, 6)
  assert.equal(result.watts, 160)
  assert.equal(result.mhz, 2600)
})

test("parseScore reads only the stress tool's result line", () => {
  assert.equal(Model.parseScore("Score: 601594"), 601594)
  assert.equal(Model.parseScore("vkmark Score: 5"), null)
  assert.equal(Model.parseScore("noise"), null)
})

test("efficiencyPlan uses a tuned result, and falls back without one", () => {
  const clocks = { points: curve, minClock: 210 }
  const tuned = { targetMv: 990, offset: 60, capMhz: 2655 }
  const plan = Model.efficiencyPlan(idle, clocks, tuned)
  assert.equal(plan.tuned, true)
  assert.equal(plan.config.max_core_clock, 2655)
  assert.equal(plan.config.min_core_clock, 210)
  assert.ok(Object.keys(plan.config.nvidia_gpu_vf_curve).length > 0)
  assert.equal(plan.label, "Tuned")
  assert.equal(Model.efficiencyPlan(idle, clocks, null).tuned, undefined)
})

test("a tuned offset of zero is just the cap, with no curve written", () => {
  const plan = Model.tunedPlan({ targetMv: 990, offset: 0, capMhz: 2595 }, { points: curve, minClock: 210 })
  assert.equal(plan.config.nvidia_gpu_vf_curve, undefined)
})

test("tuned results only apply to the same GPU, driver and vBIOS", () => {
  const tuned = { gpuId: "gpu", fingerprint: "nvidia 615.78.08|95.03" }
  assert.equal(Model.fingerprint({ driver: "nvidia 615.78.08", vbios_version: "95.03" }), tuned.fingerprint)
  assert.equal(Model.tunedUsable(tuned, "gpu", "nvidia 615.78.08|95.03"), true)
  assert.equal(Model.tunedUsable(tuned, "gpu", "nvidia 620.00.00|95.03"), false)
  assert.equal(Model.tunedUsable(tuned, "other", tuned.fingerprint), false)
  assert.equal(Model.tunedUsable(null, "gpu", tuned.fingerprint), false)
})

test("stepDown lowers offset and cap together, and stops at the plain clock cap", () => {
  let tuned = { offset: 15, capMhz: 2610, stepDowns: 0 }
  tuned = Model.stepDown(tuned)
  assert.equal(tuned.offset, 0)
  assert.equal(tuned.capMhz, 2595)
  assert.equal(tuned.stepDowns, 1)
  tuned = Model.stepDown(tuned)
  assert.equal(tuned.offset, 0)
  assert.equal(tuned.capMhz, 2595)
})

test("previousBootHealthy treats a missing shutdown as a crash", () => {
  assert.equal(Model.previousBootHealthy("Reached target Shutdown."), true)
  assert.equal(Model.previousBootHealthy(""), false)
  assert.equal(Model.previousBootHealthy("NVRM: Xid (PCI:0000:01:00): 13\nReached target Shutdown."), false)
  assert.equal(Model.previousBootHealthy("no-previous-boot"), true)
})

// The real log from a boot where one Xid burst was stepped down for live, then
// stepped down for again at the next login.
const handledBoot = [
  "1793780380.771139 B550 kernel: NVRM: Xid (PCI:0000:01:00): 13, Graphics Exception: SKEDCHECK06_REGISTER_COUNT failed",
  "1793780380.771227 B550 kernel: NVRM: Xid (PCI:0000:01:00): 13, pid=47877, name=GameThread, Graphics Exception: channel 0x00000029",
  "1793780491.014818 B550 systemd[1145]: Reached target Shutdown.",
].join("\n")

test("previousBootHealthy does not count a GPU error again once it was handled live", () => {
  assert.equal(Model.previousBootHealthy(handledBoot, 1793780380900), true)
  assert.equal(Model.previousBootHealthy(handledBoot, 1793780380000), false, "an error after the handled time still counts")
  assert.equal(Model.previousBootHealthy(handledBoot, null), false, "an old file without a time counts every error")
  assert.equal(Model.previousBootHealthy("NVRM: Xid (PCI:0000:01:00): 13\nReached target Shutdown.", 1793780380900), false,
    "an error with no readable time counts")
  assert.equal(Model.previousBootHealthy("1793780380.771139 B550 kernel: NVRM: Xid (PCI:0000:01:00): 13", 1793780380900), false,
    "a handled error does not excuse a missing shutdown")
})

test("parseActiveBoot reads the boot id and the handled-until time", () => {
  assert.deepEqual(plain(Model.parseActiveBoot("3a0d4096-6e76 1793780380900\n")), { bootId: "3a0d4096-6e76", since: 1793780380900 })
  assert.deepEqual(plain(Model.parseActiveBoot("3a0d4096-6e76\n")), { bootId: "3a0d4096-6e76", since: null })
  assert.deepEqual(plain(Model.parseActiveBoot("")), { bootId: "", since: null })
})

test("tunedSummary reports the measured cost, or just the point without one", () => {
  const tuned = {
    capMhz: 2655, targetMv: 990,
    baseline: { watts: 197, score: 600000 }, tuned: { watts: 155, score: 582000 },
  }
  assert.equal(Model.tunedSummary(tuned), "2655 MHz at 990 mV: −21% power, −3% speed at full load")
  assert.equal(Model.tunedSummary({ capMhz: 2655, targetMv: 990, baseline: null, tuned: null }), "2655 MHz at 990 mV")
})

test("tuneOutcome tells the user what happened", () => {
  assert.match(Model.tuneOutcome({ phase: "stopped", reason: "Crash" }), /crash/)
  assert.match(Model.tuneOutcome({ phase: "done", unverified: true, failedAt: 90, offset: 30 }), /\+90 MHz.*\+30 MHz/)
  assert.equal(Model.tuneOutcome({ phase: "done", offset: 60 }), "Tuned to +60 MHz.")
})
