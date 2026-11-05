// Pure logic with no QML dependencies, so tests/model.test.mjs can run it under
// Node. Everything that knows about LACT's wire format lives here.

// The LACT profile this plugin owns. Stock is deliberately not a profile: it is
// the absence of a hold, which is what makes it the crash-safe state.
var PROFILE_NAME = "gpu-undervolt-efficiency"

// Fallback for GPUs with no VF curve: this share of the default power limit.
var EFFICIENCY_RATIO = 0.75

// Untuned Efficiency stops climbing the stock curve where 1% more clock starts
// costing more than this many percent of core power (P ~ f * V^2). On an RTX 4070
// that lands on the 975 mV point: -25% power for -7% performance when measured.
var ELASTICITY_LIMIT = 3.5
// Clocks move in steps, so the slope is taken across a span of points.
var ELASTICITY_SPAN = 8

var HISTORY_LENGTH = 60

// Undervolt shape. Points below the ramp keep their stock clocks, which avoids the
// low-voltage instability a global offset causes.
var CLOCK_STEP_MHZ = 15
var RAMP_MV = 100

// Tuner. Climbs in steps until something fails, then backs off by a margin.
var TUNE_STEP_MHZ = 30
var TUNE_MARGIN_MHZ = 30
var TUNE_MAX_OFFSET_MHZ = 240
var TUNE_STEP_SECONDS = 45
var TUNE_SOAK_SECONDS = 300
var TUNE_WARMUP_SAMPLES = 3
var TUNE_BUSY_PERCENT = 90
// Work per MHz is constant while the clock is real. When the silicon runs out of
// margin it stretches clocks: the reported clock holds but the work falls. Score per
// MHz varied by about 0.4% between steps on the RTX 4070, so 1% is past the noise.
var TUNE_WORK_DROP = 0.01
var ICON_GPU = String.fromCodePoint(0xF08AE)
var ICON_STOCK = String.fromCodePoint(0xF04C5)
var ICON_EFFICIENCY = String.fromCodePoint(0xF032A)

var LIMIT_LABELS = {
  SW_POWER_CAP: "Power limit",
  HW_SLOWDOWN: "Hardware slowdown",
  HW_POWER_BRAKE_SLOWDOWN: "Power brake",
  SW_THERMAL_SLOWDOWN: "Thermal limit",
  HW_THERMAL_SLOWDOWN: "Thermal limit",
  APPLICATIONS_CLOCKS_SETTING: "Clock cap",
  DISPLAY_CLOCK_SETTING: "Display clock",
  SYNC_BOOST: "Sync boost"
}

function number(value) {
  return typeof value === "number" && isFinite(value) ? value : null
}

// LACT answers {"status":"ok","data":...}. Errors carry a serialized error
// object whose text is in `description`.
function parseResponse(line) {
  var parsed
  try {
    parsed = JSON.parse(line)
  } catch (err) {
    return { ok: false, data: null, error: "Unreadable reply from LACT" }
  }
  if (!parsed || parsed.status !== "ok") {
    var data = parsed ? parsed.data : null
    var message = data && data.description ? data.description : String(data || "LACT reported an error")
    return { ok: false, data: null, error: message }
  }
  return { ok: true, data: parsed.data === undefined ? null : parsed.data, error: "" }
}

function encodeRequest(command, args) {
  var request = { command: command }
  if (args !== undefined && args !== null) request.args = args
  return JSON.stringify(request) + "\n"
}

// Dedicated cards only: integrated GPUs have nothing to tune.
function pickGpu(devices) {
  var list = Array.isArray(devices) ? devices : []
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id && list[i].device_type !== "Integrated") return list[i]
  }
  return null
}

// "AD104 [GeForce RTX 4070]" -> "GeForce RTX 4070"
function shortName(name) {
  var text = String(name || "").trim()
  var match = text.match(/\[([^\]]+)\]\s*$/)
  return match ? match[1] : (text || "GPU")
}

// LACT ids end in the PCI address: "10DE:2709-1462:5138-0000:01:00.0".
function pciAddress(id) {
  var match = String(id || "").match(/([0-9a-fA-F]{4}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-9a-fA-F])$/)
  return match ? match[1].toLowerCase() : ""
}

function primaryTemp(temps) {
  if (!temps || typeof temps !== "object") return null
  if (temps.GPU && number(temps.GPU.current) !== null) return temps.GPU.current
  var keys = Object.keys(temps)
  for (var i = 0; i < keys.length; i++) {
    var entry = temps[keys[i]]
    if (entry && entry.primary === true && number(entry.current) !== null) return entry.current
  }
  for (var j = 0; j < keys.length; j++) {
    var fallback = temps[keys[j]]
    if (fallback && number(fallback.current) !== null) return fallback.current
  }
  return null
}

function fanPercent(fan) {
  var pwm = fan ? number(fan.pwm_current) : null
  return pwm === null ? null : Math.round(pwm / 2.55)
}

function limitLabels(info) {
  if (!info || typeof info !== "object") return []
  var labels = []
  var keys = Object.keys(info)
  for (var i = 0; i < keys.length; i++) {
    var label = LIMIT_LABELS[keys[i]] || keys[i].replace(/_/g, " ").toLowerCase()
    if (labels.indexOf(label) === -1) labels.push(label)
  }
  return labels
}

// Normalize device_stats. A missing metric stays null so the UI can hide it
// rather than show a made-up value.
function parseStats(data) {
  var d = data || {}
  var power = d.power || {}
  var clocks = d.clockspeed || {}
  var vram = d.vram || {}
  var voltage = d.voltage || {}
  var now = number(power.current)
  return {
    powerNow: now !== null ? now : number(power.average),
    powerCap: number(power.cap_current),
    powerDefault: number(power.cap_default),
    powerMin: number(power.cap_min),
    powerMax: number(power.cap_max),
    clockMhz: number(clocks.gpu_clockspeed),
    memClockMhz: number(clocks.vram_clockspeed),
    voltageMv: number(voltage.gpu),
    tempC: primaryTemp(d.temps),
    fanPercent: fanPercent(d.fan),
    loadPercent: number(d.busy_percent),
    vramUsed: number(vram.used),
    vramTotal: number(vram.total),
    limits: limitLabels(d.throttle_info)
  }
}

// The Efficiency power cap, or null when the card cannot go lower than default.
function efficiencyCap(stats) {
  if (!stats || stats.powerDefault === null) return null
  var cap = Math.round(stats.powerDefault * EFFICIENCY_RATIO)
  if (stats.powerMin !== null) cap = Math.max(cap, Math.ceil(stats.powerMin))
  if (stats.powerMax !== null) cap = Math.min(cap, Math.floor(stats.powerMax))
  return cap < stats.powerDefault ? cap : null
}

// Reads device_clocks_info. Only NVIDIA reports a VF curve today.
function parseClocks(data) {
  var table = data && data.table ? data.table.value : null
  var points = table && Array.isArray(table.gpu_vf_curve) ? table.gpu_vf_curve : []
  var range = table ? table.gpu_clock_range : null
  return { points: points, minClock: Array.isArray(range) ? range[0] : null }
}

// The highest point on the stock curve that is still worth its power.
function efficientPoint(points) {
  var list = Array.isArray(points) ? points : []
  var best = null
  for (var i = 0; i + ELASTICITY_SPAN < list.length; i++) {
    var low = list[i]
    var high = list[i + ELASTICITY_SPAN]
    if (high.base_freq <= low.base_freq) break
    var voltage = Math.log(high.base_voltage / low.base_voltage)
    var clock = Math.log(high.base_freq / low.base_freq)
    if (1 + 2 * voltage / clock > ELASTICITY_LIMIT) break
    best = low
  }
  return best
}

// What Efficiency applies: { config, label }, or null if this GPU has no option.
// A clock cap only stops the card climbing its stock curve, so unlike an undervolt
// it carries no stability risk, and unlike a power cap it works at any load.
function efficiencyPlan(stats, clocks, tuned) {
  var fromTuner = tunedPlan(tuned, clocks)
  if (fromTuner) return fromTuner
  var point = clocks && clocks.minClock !== null ? efficientPoint(clocks.points) : null
  if (point) {
    return {
      config: { min_core_clock: clocks.minClock, max_core_clock: point.base_freq },
      label: point.base_freq + " MHz cap"
    }
  }
  var cap = efficiencyCap(stats)
  return cap === null ? null : { config: { power_cap: cap }, label: cap + " W cap" }
}

function profileConfig(gpuId, config) {
  var gpus = {}
  gpus[gpuId] = config
  return { gpus: gpus }
}

// Canonical form of the settings this plugin owns, ignoring LACT's own defaults.
function configKey(config) {
  var c = config || {}
  var curve = c.nvidia_gpu_vf_curve || {}
  var offsets = Object.keys(curve).sort(function(a, b) { return Number(a) - Number(b) }).map(function(index) {
    return index + ":" + curve[index].clockspeed_offset
  })
  return [c.power_cap, c.min_core_clock, c.max_core_clock, offsets.join(",")].join("|")
}

function profileMatches(profile, gpuId, config) {
  var gpu = profile && profile.gpus ? profile.gpus[gpuId] : null
  return !!gpu && configKey(gpu) === configKey(config)
}

function pushSample(history, value, limit) {
  var next = Array.isArray(history) ? history.slice() : []
  if (number(value) === null) return next
  next.push(value)
  var max = limit === undefined ? HISTORY_LENGTH : limit
  return next.length > max ? next.slice(next.length - max) : next
}

function formatWatts(value) {
  return value === null ? "—" : Math.round(value) + " W"
}

function formatPower(stats) {
  if (!stats || stats.powerNow === null) return "—"
  if (stats.powerCap === null) return formatWatts(stats.powerNow)
  return Math.round(stats.powerNow) + " / " + Math.round(stats.powerCap) + " W"
}

function formatClock(value) {
  return value === null ? "—" : Math.round(value) + " MHz"
}

function formatVoltage(value) {
  return value === null ? "—" : Math.round(value) + " mV"
}

function formatTemp(value) {
  return value === null ? "—" : Math.round(value) + " °C"
}

function formatPercent(value) {
  return value === null ? "—" : Math.round(value) + "%"
}

function formatGib(bytes) {
  var gib = bytes / (1024 * 1024 * 1024)
  return gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)
}

function formatVram(stats) {
  if (!stats || stats.vramUsed === null || stats.vramTotal === null) return "—"
  return formatGib(stats.vramUsed) + " / " + formatGib(stats.vramTotal) + " GiB"
}

function formatLimits(stats) {
  return stats && stats.limits.length > 0 ? stats.limits.join(", ") : "None"
}

function profileStatus(profile, label) {
  if (profile !== "efficiency") return "Stock"
  return label ? "Efficiency · " + label : "Efficiency"
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch (err) {
    return null
  }
}

function copy(value) {
  return JSON.parse(JSON.stringify(value))
}

function nearestPoint(points, millivolts) {
  var best = null
  for (var i = 0; i < points.length; i++) {
    if (!best || Math.abs(points[i].base_voltage - millivolts) < Math.abs(best.base_voltage - millivolts)) best = points[i]
  }
  return best
}

// Offsets for a clock gain at targetMv. Points above the target keep the full
// offset so the curve never steps down; the clock cap stops the card climbing them.
function curveOffsets(points, targetMv, offset) {
  var target = nearestPoint(points, targetMv)
  var curve = {}
  for (var i = 0; i < points.length; i++) {
    var distance = target.base_voltage - points[i].base_voltage
    if (distance >= RAMP_MV) continue
    var share = distance <= 0 ? 1 : 1 - distance / RAMP_MV
    var value = Math.floor(Math.floor(offset * share) / CLOCK_STEP_MHZ) * CLOCK_STEP_MHZ
    if (value !== 0) curve[String(points[i].index)] = { clockspeed_offset: value }
  }
  return curve
}

function isMonotonic(points, curve) {
  var previous = -Infinity
  for (var i = 0; i < points.length; i++) {
    var entry = curve[String(points[i].index)]
    var freq = points[i].base_freq + (entry ? entry.clockspeed_offset : 0)
    if (freq < previous) return false
    previous = freq
  }
  return true
}

function undervoltPlan(points, minClock, targetMv, offset, capMhz, label) {
  var curve = curveOffsets(points, targetMv, offset)
  if (!isMonotonic(points, curve)) return null
  var config = { min_core_clock: minClock, max_core_clock: capMhz }
  if (Object.keys(curve).length > 0) config.nvidia_gpu_vf_curve = curve
  return { config: config, label: label, tuned: true }
}

function tunedPlan(tuned, clocks) {
  if (!tuned || !clocks || clocks.minClock === null || clocks.points.length === 0) return null
  return undervoltPlan(clocks.points, clocks.minClock, tuned.targetMv, tuned.offset, tuned.capMhz, "Tuned")
}

// A result only holds for the exact driver and vBIOS it was measured on: the base
// curve can change underneath it.
function fingerprint(info) {
  return info ? String(info.driver || "") + "|" + String(info.vbios_version || "") : ""
}

function tunedUsable(tuned, gpuId, print) {
  return !!tuned && tuned.gpuId === gpuId && tuned.fingerprint === print
}

// Where Efficiency runs once the curve gains `offset` MHz: the knee rule of the
// untuned clock cap, applied to the tuned curve. A larger margin moves the knee to a
// higher clock and a lower voltage, so it buys both speed and power, not just one.
function kneeFor(points, offset) {
  var shifted = points.map(function(p) {
    return { index: p.index, base_voltage: p.base_voltage, base_freq: p.base_freq + offset }
  })
  var knee = efficientPoint(shifted)
  return knee ? { targetMv: knee.base_voltage, capMhz: knee.base_freq } : null
}

// The operating point a step at this offset runs at, from the table built at start.
function kneeAt(tune, offset) {
  var knee = tune.knees ? tune.knees[String(offset)] : null
  if (knee) return knee
  // Runs saved before the knee tuner held the stock curve's knee voltage throughout.
  return { targetMv: tune.targetMv, capMhz: tune.baseClock + offset }
}

function kneeText(knee) {
  return knee.capMhz + " MHz at " + knee.targetMv + " mV"
}

// Every offset the run can reach or keep is in the table, so a crash can be
// recovered before the curve has been read.
function tunerStart(points, gpuId, print, limits) {
  if (!efficientPoint(points)) return null
  var knees = {}
  for (var offset = 0; offset <= limits.maxOffset; offset += CLOCK_STEP_MHZ) {
    var knee = kneeFor(points, offset)
    if (!knee) break
    knees[String(offset)] = knee
  }
  return {
    running: false,
    phase: "baseline",
    gpuId: gpuId,
    fingerprint: print,
    knees: knees,
    offset: 0,
    lastGood: null,
    failedAt: null,
    baseline: null,
    best: null,
    topWork: null,
    final: null,
    reason: "",
    unverified: false,
    limits: limits,
    results: []
  }
}

function tuneStepPlan(tune, clocks) {
  var knee = kneeAt(tune, tune.offset)
  return undervoltPlan(clocks.points, clocks.minClock, knee.targetMv, tune.offset, knee.capMhz, kneeText(knee))
}

function parseScore(line) {
  var match = String(line).match(/^Score:\s*(\d+)\s*$/)
  return match ? Number(match[1]) : null
}

function mean(samples, key) {
  var values = samples.map(function(s) { return s[key] }).filter(function(v) { return v !== null })
  if (values.length === 0) return null
  return values.reduce(function(a, b) { return a + b }, 0) / values.length
}

// Only samples under real load count: the first few catch the GPU still boosting,
// and the stress load's burst phases sit well below the busy threshold.
function summarizeStep(samples, exitCode, score, errors) {
  var loaded = samples.filter(function(s) { return s.loadPercent !== null && s.loadPercent >= TUNE_BUSY_PERCENT })
  loaded = loaded.slice(TUNE_WARMUP_SAMPLES)
  return {
    exitCode: exitCode,
    score: score,
    errors: errors,
    samples: loaded.length,
    watts: mean(loaded, "powerNow"),
    mhz: mean(loaded, "clockMhz"),
    mv: mean(loaded, "voltageMv"),
    temp: mean(loaded, "tempC")
  }
}

function judgeStep(tune, result) {
  if (result.errors > 0) return { passed: false, reason: "GPU error" }
  if (result.exitCode !== 0) return { passed: false, reason: "Stress load failed" }
  if (result.score === null) return { passed: false, reason: "Stress load gave no result" }
  if (result.samples < Math.floor(tune.limits.stepSeconds / 2)) return { passed: false, reason: "GPU was not fully loaded" }
  if (tune.phase === "climb" && tune.topWork && result.mhz && result.score / result.mhz < tune.topWork * (1 - TUNE_WORK_DROP)) {
    return { passed: false, reason: "Performance fell behind the clock" }
  }
  return { passed: true, reason: "" }
}

function tuneStopped(next, reason) {
  next.phase = "stopped"
  next.reason = reason
  return next
}

function tuneToSoak(next) {
  next.phase = "soak"
  next.offset = Math.max(0, next.lastGood - TUNE_MARGIN_MHZ)
  return next
}

// One tuner transition: returns the state after a step's result.
function tunerAdvance(tune, result) {
  var next = copy(tune)
  var verdict = judgeStep(tune, result)
  next.results.push({
    phase: tune.phase, offset: tune.offset, passed: verdict.passed, reason: verdict.reason,
    score: result.score, watts: result.watts, mhz: result.mhz, mv: result.mv
  })

  if (tune.phase === "baseline") {
    if (!verdict.passed) return tuneStopped(next, verdict.reason)
    next.baseline = result
    next.phase = "climb"
    return next
  }

  if (tune.phase === "climb") {
    if (verdict.passed) {
      next.lastGood = tune.offset
      next.best = result
      if (result.mhz) next.topWork = Math.max(tune.topWork || 0, result.score / result.mhz)
      var further = tune.offset + TUNE_STEP_MHZ
      if (further > tune.limits.maxOffset || (tune.knees && !tune.knees[String(further)])) return tuneToSoak(next)
      next.offset = further
      return next
    }
    next.failedAt = tune.offset
    next.reason = verdict.reason
    if (tune.lastGood === null) return tuneStopped(next, verdict.reason)
    return tuneToSoak(next)
  }

  if (verdict.passed) {
    next.phase = "done"
    next.final = result
    return next
  }
  next.reason = verdict.reason
  if (tune.offset === 0) return tuneStopped(next, verdict.reason)
  next.offset = Math.max(0, tune.offset - TUNE_MARGIN_MHZ)
  return next
}

// A run still marked running at startup never finished, so the step in progress
// is assumed to have taken the system down. What passed before it can still be
// kept, with the margin, but it has not been soak-tested.
function tunerRecover(tune) {
  var next = copy(tune)
  next.running = false
  next.failedAt = tune.offset
  next.reason = "Crash"
  if (tune.phase === "baseline") return tuneStopped(next, "Crash")
  if (tune.phase === "climb" && tune.lastGood === null) return tuneStopped(next, "Crash")
  var keep = tune.phase === "climb" ? tune.lastGood : tune.offset
  next.offset = Math.max(0, keep - TUNE_MARGIN_MHZ)
  next.phase = "done"
  next.unverified = true
  next.final = tune.best
  return next
}

function tunedResult(tune, savedAt) {
  var knee = kneeAt(tune, tune.offset)
  var pick = function(step) { return step ? { score: step.score, watts: step.watts } : null }
  return {
    gpuId: tune.gpuId,
    fingerprint: tune.fingerprint,
    targetMv: knee.targetMv,
    baseClock: knee.capMhz - tune.offset,
    offset: tune.offset,
    capMhz: knee.capMhz,
    baseline: pick(tune.baseline),
    tuned: pick(tune.final),
    unverified: tune.unverified === true,
    stepDowns: 0,
    savedAt: savedAt
  }
}

function stepDown(tuned) {
  var next = copy(tuned)
  var lowered = Math.max(0, tuned.offset - CLOCK_STEP_MHZ)
  next.capMhz = tuned.capMhz - (tuned.offset - lowered)
  next.offset = lowered
  next.stepDowns = (tuned.stepDowns || 0) + 1
  return next
}

// The active-boot file reads "<boot id> <ms>" while a tuned profile is applied.
// The time is when that boot's GPU errors stopped being handled live: errors up to
// then came before the profile was applied, or were already stepped down for.
// An older file holds only the boot id, so every error in that boot counts.
function parseActiveBoot(text) {
  var parts = String(text || "").trim().split(/\s+/)
  var since = Number(parts[1])
  return { bootId: parts[0] || "", since: since > 0 ? since : null }
}

// Output of the previous-boot check in Service.qml, as journalctl short-unix lines.
// A clean shutdown logs its target; a hard freeze cannot, so a missing marker means
// the session died. A GPU error counts unless it is known to be from before `since`.
function previousBootHealthy(text, since) {
  var log = String(text)
  if (log.indexOf("no-previous-boot") !== -1) return true
  var lines = log.split("\n")
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf("NVRM: Xid") === -1) continue
    var stamp = lines[i].match(/^(\d+(?:\.\d+)?)\s/)
    if (!since || !stamp || Number(stamp[1]) * 1000 > since) return false
  }
  return log.indexOf("Reached target Shutdown") !== -1
}

function signedPercent(value) {
  var rounded = Math.round(value)
  return (rounded > 0 ? "+" : rounded < 0 ? "\u2212" : "") + Math.abs(rounded) + "%"
}

function tunedSummary(tuned) {
  var head = kneeText(tuned)
  if (!tuned.baseline || !tuned.tuned || !tuned.baseline.watts || !tuned.baseline.score) return head
  var power = 100 * (tuned.tuned.watts / tuned.baseline.watts - 1)
  var speed = 100 * (tuned.tuned.score / tuned.baseline.score - 1)
  return head + ": " + signedPercent(power) + " power, " + signedPercent(speed) + " speed at full load"
}

function tuneStepLabel(tune) {
  if (!tune) return ""
  if (tune.phase === "baseline") return "Measuring stock"
  if (tune.phase === "soak") return "Soak test at " + kneeText(kneeAt(tune, tune.offset))
  if (tune.phase === "climb") return "Testing " + kneeText(kneeAt(tune, tune.offset))
  return ""
}

function tuneOutcome(tune) {
  if (tune.phase === "stopped") {
    return tune.reason === "Crash"
      ? "Tuning stopped after a crash. Efficiency keeps its safe clock cap."
      : "Tuning stopped: " + tune.reason + ". Efficiency keeps its safe clock cap."
  }
  if (tune.unverified) {
    return "Tuning crashed at " + kneeText(kneeAt(tune, tune.failedAt)) + ". Kept " + kneeText(kneeAt(tune, tune.offset)) +
      ", without a soak test. Re-tune to verify it."
  }
  return "Tuned to " + kneeText(kneeAt(tune, tune.offset)) + "."
}

function stepDownNotice(tuned) {
  return "Lowered to " + kneeText(tuned) + "."
}

// Quick slots: snapshots of tuned results, saved and applied from the panel. Each
// keeps its fingerprint, so a slot from another driver is never applied.
var SLOT_COUNT = 4

function parseSlots(text) {
  var parsed = parseJson(text)
  var list = Array.isArray(parsed) ? parsed : []
  var slots = []
  for (var i = 0; i < SLOT_COUNT; i++) {
    var slot = list[i]
    slots.push(slot && typeof slot === "object" && typeof slot.capMhz === "number" ? slot : null)
  }
  return slots
}

function withSlot(slots, index, tuned) {
  var next = slots.slice()
  next[index] = copy(tuned)
  return next
}

// Whether two results run the same operating point on the same card and driver.
function sameTune(a, b) {
  return !!a && !!b && a.gpuId === b.gpuId && a.fingerprint === b.fingerprint &&
    a.targetMv === b.targetMv && a.offset === b.offset && a.capMhz === b.capMhz
}

function slotLabel(slot) {
  return slot ? slot.capMhz + " MHz" : "Empty"
}

function slotTooltip(index, slot, usable) {
  var name = "Slot " + (index + 1)
  if (!slot) return name + " is empty. Right-click to save the current tune here."
  if (!usable) return name + ": " + kneeText(slot) + ", tuned on another GPU, driver or vBIOS. Right-click to replace it."
  return name + ": " + tunedSummary(slot) + ". Click to apply, right-click to replace it with the current tune."
}
