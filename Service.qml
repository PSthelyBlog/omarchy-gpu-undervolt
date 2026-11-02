import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.UPower
import "Model.js" as Model

// Singleton owner of the GPU state. The bar exists once per monitor, so anything
// that must happen exactly once (above all, taking the hold) lives here.
//
// Efficiency is applied with LACT's hold_profile: the profile stays active only
// while this connection is open and is never written to disk as the current
// profile. If the shell dies the hold is released, and a reboot always comes up
// on Stock. Saving LACT's config during a hold would persist it, so profiles are
// only ever edited while no hold exists.
//
// The tuner lives here for the same reason. A GPU fault can take this whole process
// down mid-step, so each step records itself on disk before it touches the GPU: on
// the next start, a run still marked as running means that step crashed.
Item {
  id: root

  // "connecting" | "missing" (no LACT) | "unsupported" (no dedicated GPU) | "ready"
  property string phase: "connecting"
  property string gpuId: ""
  property string gpuName: ""
  property var stats: null
  property var clocks: null
  property var powerHistory: []
  property bool gpuAsleep: false
  property string lastError: ""
  property bool busy: false
  property bool settingUp: false
  // Why something changed without being asked: a crash, an error, a finished run.
  property string notice: ""

  // What the user asked for. Compared against holdCookie by reconcile().
  property string wanted: "stock"
  property var holdCookie: null
  property string appliedKey: ""
  property string appliedLabel: ""

  readonly property string activeProfile: holdCookie !== null ? "efficiency" : "stock"
  readonly property var plan: stats !== null ? Model.efficiencyPlan(stats, clocks, tunedValid ? tuned : null) : null
  readonly property bool efficiencyAvailable: plan !== null

  // tuned is the saved result; tune is the run in progress, or the last one.
  property var tuned: null
  property var tune: null
  property bool tuning: false
  property bool loadToolReady: false
  property string deviceFingerprint: ""
  readonly property bool tunedValid: Model.tunedUsable(tuned, gpuId, deviceFingerprint)
  readonly property bool tunedStale: tuned !== null && deviceFingerprint !== "" && !tunedValid
  readonly property bool canTune: phase === "ready" && clocks !== null && clocks.minClock !== null
    && Model.efficientPoint(clocks.points) !== null

  // GPU_UNDERVOLT_SOCKET pins one socket, so tests cannot reach the real daemon.
  readonly property var socketCandidates: {
    var pinned = Quickshell.env("GPU_UNDERVOLT_SOCKET")
    if (pinned) return [pinned]
    return ["/run/lactd.sock", Quickshell.env("XDG_RUNTIME_DIR") + "/lactd.sock"]
  }
  readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")) + "/gpu-undervolt"
  readonly property string pciAddress: Model.pciAddress(gpuId)

  property int connectAttempts: 0
  property bool polling: false
  property int ticks: 0
  property real fastPollUntil: 0
  property real retryHoldAt: 0
  property var pendingPlan: null
  property var pendingDone: null
  property bool holdOpening: false
  property bool appliedTuned: false

  property bool healthStarted: false
  property bool healthChecked: false
  property real lastStepDownAt: 0

  property var stepSamples: []
  property int stepErrors: 0
  property var stepScore: null
  property int stepExit: 0
  property string stopReason: ""

  readonly property string stressPath: String(Qt.resolvedUrl("stress.ts")).replace("file://", "")
  // Tests shorten these. The offset limit also bounds a run on real hardware.
  readonly property int stepSeconds: envNumber("GPU_UNDERVOLT_STEP_SECONDS", Model.TUNE_STEP_SECONDS)
  readonly property int soakSeconds: envNumber("GPU_UNDERVOLT_SOAK_SECONDS", Model.TUNE_SOAK_SECONDS)
  readonly property int maxOffset: envNumber("GPU_UNDERVOLT_MAX_OFFSET", Model.TUNE_MAX_OFFSET_MHZ)

  function envNumber(name, fallback) {
    var value = Number(Quickshell.env(name))
    return value > 0 ? value : fallback
  }

  // Ends a child with this process. Otherwise a crash leaves a full-load soak
  // running with nobody watching it.
  function withParent(command) {
    return ["setpriv", "--pdeathsig", "TERM", "--"].concat(command)
  }

  function notify(message, urgency) {
    Quickshell.execDetached(["omarchy-notification-send", "-g", Model.ICON_GPU, "-u", urgency, "GPU Undervolt", message])
  }

  // The panel calls this while open to get one-second updates.
  function keepFast() {
    fastPollUntil = Date.now() + 2500
    if (phase === "ready" && stats === null) poll()
  }

  function setProfile(name) {
    if (tuning) return
    if (name !== "stock" && name !== "efficiency") return
    if (name === "efficiency" && !efficiencyAvailable) return
    lastError = ""
    retryHoldAt = 0
    wanted = name
    stateFile.setText(name + "\n")
    reconcile()
  }

  function toggleProfile() {
    setProfile(wanted === "efficiency" ? "stock" : "efficiency")
  }

  function setUp() {
    if (settingUp) return
    settingUp = true
    lastError = ""
    setupProcess.running = true
  }

  function tryConnect() {
    connectAttempts++
    if (connectAttempts > socketCandidates.length) phase = "missing"
    control.open(socketCandidates[connectAttempts % socketCandidates.length])
  }

  function loadDevice() {
    control.call("list_devices", null, function(reply) {
      if (!reply.ok) { lastError = reply.error; return }
      var gpu = Model.pickGpu(reply.data)
      if (!gpu) { phase = "unsupported"; return }
      gpuId = gpu.id
      gpuName = Model.shortName(gpu.name)
      control.call("device_info", { id: gpuId }, function(info) {
        deviceFingerprint = Model.fingerprint(info.ok ? info.data : null)
        control.call("device_clocks_info", { id: gpuId }, function(table) {
          clocks = Model.parseClocks(table.ok ? table.data : null)
          phase = "ready"
          loadToolCheck.running = true
          checkPreviousBoot()
          poll()
        })
      })
    })
  }

  // Efficiency only starts in a session once the last one is known to have ended
  // well. A freeze would otherwise repeat itself on every login.
  function checkPreviousBoot() {
    if (healthStarted) return
    healthStarted = true
    var active = activeBootFile.text().trim()
    if (active === "" || active === bootIdFile.text().trim()) {
      healthChecked = true
      return
    }
    bootCheck.running = true
  }

  function onBootChecked(text) {
    activeBootFile.setText("")
    healthChecked = true
    if (!Model.previousBootHealthy(text)) stepDownTuned("The last session ended badly while tuned.")
    reconcile()
  }

  function onGpuError() {
    if (tuning) stepErrors++
    else if (appliedTuned) stepDownTuned("A GPU error was logged while tuned.")
  }

  function stepDownTuned(message) {
    if (!tunedValid || tuned.offset === 0) return
    if (Date.now() - lastStepDownAt < 60000) return
    lastStepDownAt = Date.now()
    saveTuned(Model.stepDown(tuned))
    notice = message + " Lowered to +" + tuned.offset + " MHz."
    notify(notice, "critical")
    reconcile()
  }

  function saveTuned(result) {
    tuned = result
    tunedFile.setText(JSON.stringify(result))
  }

  function saveTune(running) {
    var state = Model.copy(tune)
    state.running = running
    tune = state
    tuneFile.setText(JSON.stringify(state))
  }

  function restoreTuning() {
    tuned = Model.parseJson(tunedFile.text())
    var previous = Model.parseJson(tuneFile.text())
    if (previous === null) return
    tune = previous
    if (previous.running !== true) return
    tune = Model.tunerRecover(previous)
    saveTune(false)
    notice = Model.tuneOutcome(tune)
    if (tune.phase === "done") saveTuned(Model.tunedResult(tune, new Date().toISOString()))
    notify(notice, "critical")
  }

  function startTune() {
    if (tuning || busy || !canTune || stats === null) return
    lastError = ""
    notice = ""
    if (!loadToolReady) { lastError = "Tuning needs Deno. Use Set up tuning."; return }
    if (UPower.onBattery) { lastError = "Plug in before tuning."; return }
    if (stats.loadPercent !== null && stats.loadPercent > 30) { lastError = "Close GPU-heavy apps before tuning."; return }
    tune = Model.tunerStart(clocks.points, gpuId, deviceFingerprint, {
      stepSeconds: stepSeconds, soakSeconds: soakSeconds, maxOffset: maxOffset
    })
    stopReason = ""
    tuning = true
    dropHold(runStep)
  }

  function runStep() {
    stepSamples = []
    stepErrors = 0
    stepScore = null
    // Blocking write, so a crash in this step always finds it on disk.
    saveTune(true)
    if (tune.phase === "baseline") {
      startLoad()
      return
    }
    var next = Model.tuneStepPlan(tune, clocks)
    if (next === null) { stopTune("Curve would be invalid"); finishStopped(); return }
    applyPlan(next, function(applied) {
      if (!tuning) return
      if (applied) startLoad()
      else { stopTune("Could not apply settings"); finishStopped() }
    })
  }

  function startLoad() {
    var seconds = tune.phase === "soak" ? soakSeconds : stepSeconds
    loadProcess.command = root.withParent(["deno", "run", "--unstable-webgpu", "--no-check", "--no-prompt", stressPath, String(seconds)])
    loadProcess.running = true
    stepWatchdog.interval = (seconds + 60) * 1000
    stepWatchdog.restart()
  }

  function finishStep() {
    stepWatchdog.stop()
    if (stopReason !== "") { finishStopped(); return }
    tune = Model.tunerAdvance(tune, Model.summarizeStep(stepSamples, stepExit, stepScore, stepErrors))
    if (tune.phase === "done" || tune.phase === "stopped") endTune()
    else dropHold(runStep)
  }

  function endTune() {
    saveTune(false)
    tuning = false
    notice = Model.tuneOutcome(tune)
    if (tune.phase === "done") {
      saveTuned(Model.tunedResult(tune, new Date().toISOString()))
      wanted = "efficiency"
      stateFile.setText("efficiency\n")
    }
    notify(notice, tune.phase === "done" ? "normal" : "critical")
    dropHold(reconcile)
  }

  function stopTune(reason) {
    if (!tuning || stopReason !== "") return
    stopReason = reason
    if (loadProcess.running) loadProcess.signal(15)
  }

  function finishStopped() {
    stepWatchdog.stop()
    tune = Model.tuneStopped(Model.copy(tune), stopReason)
    endTune()
  }

  // Polling a runtime-suspended GPU would wake it and defeat hybrid laptop power
  // saving, and LACT has no such guard of its own.
  function gpuIsSuspended() {
    if (pciAddress === "") return false
    runtimeStatus.reload()
    return runtimeStatus.text().trim() === "suspended"
  }

  function poll() {
    if (polling || gpuId === "") return
    gpuAsleep = gpuIsSuspended()
    if (gpuAsleep) return
    polling = true
    control.call("device_stats", { id: gpuId }, function(reply) {
      polling = false
      if (!reply.ok) return
      stats = Model.parseStats(reply.data)
      powerHistory = Model.pushSample(powerHistory, stats.powerNow)
      if (tuning && loadProcess.running) stepSamples.push(stats)
      reconcile()
    })
  }

  function reconcile() {
    if (phase !== "ready" || busy || stats === null || tuning || !healthChecked) return
    if (wanted === "efficiency" && plan === null) {
      wanted = "stock"
      lastError = "This GPU has no efficiency setting to apply"
    }
    var desired = wanted === "efficiency" ? plan : null
    if (desired !== null && holdCookie === null) {
      if (Date.now() >= retryHoldAt) applyPlan(desired)
    } else if (holdCookie !== null && (desired === null || Model.configKey(desired.config) !== appliedKey)) {
      dropHold()
    }
  }

  function beginWork() {
    busy = true
    busyWatchdog.restart()
  }

  function endWork() {
    busy = false
    busyWatchdog.stop()
  }

  function failHold(message) {
    endWork()
    lastError = message
    retryHoldAt = Date.now() + 30000
    finishApply(false)
  }

  function finishApply(applied) {
    var done = pendingDone
    pendingDone = null
    if (done) done(applied)
  }

  // Only ever called with no hold active: this can save LACT's config.
  function applyPlan(next, done) {
    beginWork()
    pendingPlan = next
    pendingDone = done || null
    control.call("get_profile", { name: Model.PROFILE_NAME }, function(existing) {
      if (existing.ok && Model.profileMatches(existing.data, gpuId, next.config)) { openHold(); return }
      if (!existing.ok) { createProfile(next); return }
      control.call("delete_profile", { name: Model.PROFILE_NAME }, function(deleted) {
        if (!deleted.ok) { failHold(deleted.error); return }
        createProfile(next)
      })
    })
  }

  function createProfile(next) {
    control.call("create_profile", {
      name: Model.PROFILE_NAME,
      base: { provided: Model.profileConfig(gpuId, next.config) }
    }, function(created) {
      if (!created.ok) { failHold(created.error); return }
      openHold()
    })
  }

  function openHold() {
    holdOpening = true
    if (hold.connected) takeHold()
    else hold.open(control.path)
  }

  function takeHold() {
    hold.call("hold_profile", { name: Model.PROFILE_NAME }, function(reply) {
      holdOpening = false
      if (!reply.ok) { failHold(reply.error); return }
      holdCookie = reply.data
      appliedKey = Model.configKey(pendingPlan.config)
      appliedLabel = pendingPlan.label
      appliedTuned = pendingPlan.tuned === true && !tuning
      if (appliedTuned) activeBootFile.setText(bootIdFile.text().trim() + "\n")
      endWork()
      finishApply(true)
      poll()
    })
  }

  function dropHold(done) {
    if (holdCookie === null) {
      if (done) done()
      return
    }
    beginWork()
    hold.call("release_profile", { cookie: holdCookie }, function(reply) {
      // A failed release still ends here: closing the connection releases it.
      clearHold()
      hold.close()
      endWork()
      activeBootFile.setText("")
      if (done) done()
      else poll()
    })
  }

  function clearHold() {
    holdCookie = null
    appliedKey = ""
    appliedLabel = ""
    appliedTuned = false
  }

  LactClient {
    id: control

    onConnectedChanged: {
      if (!connected) return
      connectAttempts = 0
      root.loadDevice()
    }

    onLost: {
      root.polling = false
      root.stopTune("Lost connection to LACT")
      root.gpuId = ""
      root.gpuName = ""
      root.stats = null
      root.clocks = null
      root.powerHistory = []
      if (root.phase === "ready" || root.phase === "unsupported") root.phase = "connecting"
    }
  }

  LactClient {
    id: hold

    onConnectedChanged: if (connected && root.busy) root.takeHold()

    onLost: {
      // dropHold closes this connection on purpose, after clearing the cookie.
      var planned = root.holdCookie === null && !root.holdOpening
      root.clearHold()
      if (planned) return
      root.holdOpening = false
      if (root.busy) root.failHold("Lost connection to LACT")
      root.stopTune("Lost connection to LACT")
    }
  }

  Timer {
    interval: 3000
    running: !control.connected
    repeat: true
    triggeredOnStart: true
    onTriggered: root.tryConnect()
  }

  Timer {
    interval: 1000
    running: root.phase === "ready"
    repeat: true
    onTriggered: {
      root.ticks++
      if (root.tuning || Date.now() < root.fastPollUntil || root.ticks % 5 === 0) root.poll()
    }
  }

  // A hung daemon, or a hold connection that never opens, must not wedge the UI.
  Timer {
    id: busyWatchdog
    interval: 8000
    onTriggered: if (root.busy) root.failHold("LACT did not respond")
  }

  Timer {
    id: stepEnd
    interval: 300
    onTriggered: root.finishStep()
  }

  // A hung GPU can leave the load running forever without any error appearing.
  Timer {
    id: stepWatchdog
    onTriggered: if (loadProcess.running) { root.stepExit = 124; root.stopReason = "Stress load hung"; loadProcess.signal(9) }
  }

  Process {
    id: loadProcess

    stdout: SplitParser {
      onRead: function(line) {
        var score = Model.parseScore(line)
        if (score !== null) root.stepScore = score
      }
    }

    onExited: function(exitCode) {
      root.stepExit = exitCode
      // Lets the last stdout line and any final kernel error arrive first.
      stepEnd.restart()
    }
  }

  // Runs whenever the GPU is usable: a fault should be noticed the moment it lands,
  // both during tuning and for the life of a tuned profile.
  Process {
    id: errorWatch
    command: root.withParent(["journalctl", "-k", "-f", "-n", "0", "-o", "cat", "-g", "NVRM: Xid"])
    running: root.phase === "ready"

    stdout: SplitParser {
      onRead: function(line) { root.onGpuError() }
    }

    onExited: errorWatchRestart.restart()
  }

  Timer {
    id: errorWatchRestart
    interval: 5000
    onTriggered: if (root.phase === "ready") errorWatch.running = true
  }

  Process {
    id: bootCheck
    command: ["bash", "-c", "journalctl -b -1 -n 1 -q -o cat >/dev/null 2>&1 || { echo no-previous-boot; exit 0; }; journalctl -b -1 -o cat --no-pager -g 'NVRM: Xid|^Reached target Shutdown\\.$'; true"]

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.onBootChecked(text)
    }
  }

  Process {
    id: loadToolCheck
    command: ["bash", "-c", "command -v deno"]
    onExited: function(exitCode) { root.loadToolReady = exitCode === 0 }
  }

  FileView {
    id: runtimeStatus
    path: root.pciAddress !== "" ? "/sys/bus/pci/devices/" + root.pciAddress + "/power/runtime_status" : ""
    blockLoading: true
    printErrors: false
  }

  FileView {
    id: stateFile
    path: root.stateDir + "/profile"
    blockLoading: true
    printErrors: false
  }

  // blockWrites: a step's record must be on disk before the GPU is touched.
  FileView {
    id: tuneFile
    path: root.stateDir + "/tune.json"
    blockLoading: true
    blockWrites: true
    printErrors: false
  }

  FileView {
    id: tunedFile
    path: root.stateDir + "/tuned.json"
    blockLoading: true
    blockWrites: true
    printErrors: false
  }

  // Holds the boot id while a tuned profile is applied, so the next boot knows
  // whether the tuned profile was live when that session ended.
  FileView {
    id: activeBootFile
    path: root.stateDir + "/active-boot"
    blockLoading: true
    blockWrites: true
    printErrors: false
  }

  FileView {
    id: bootIdFile
    path: "/proc/sys/kernel/random/boot_id"
    blockLoading: true
    printErrors: false
  }

  Process {
    id: stateDirProcess
    command: ["mkdir", "-p", root.stateDir]
    running: true
  }

  Process {
    id: setupProcess
    command: ["pkexec", "/usr/bin/bash", "-c", "pacman -S --needed --noconfirm -- lact deno && systemctl enable --now lactd"]

    onExited: function(exitCode) {
      root.settingUp = false
      if (exitCode !== 0) root.lastError = "Setup did not finish"
      root.connectAttempts = 0
      if (root.phase === "ready") loadToolCheck.running = true
    }
  }

  // For keybindings and scripts: omarchy-shell gpu-undervolt.profile set efficiency
  IpcHandler {
    target: "gpu-undervolt.profile"

    function get(): string { return root.activeProfile }
    function set(name: string): void { root.setProfile(name) }
    function toggle(): void { root.toggleProfile() }
    function tune(): void { root.startTune() }
    function stopTune(): void { root.stopTune("Cancelled") }
  }

  Component.onCompleted: {
    if (stateFile.text().trim() === "efficiency") wanted = "efficiency"
    restoreTuning()
  }
}
