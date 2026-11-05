import QtQuick
import Quickshell
import Quickshell.Io

// Hosts Service.qml with no windows and prints each state change for
// tests/integration.py to read.
ShellRoot {
  id: root

  property string last: ""

  Service {
    id: service
  }

  Timer {
    interval: 50
    running: true
    repeat: true
    onTriggered: {
      var stats = service.stats
      var state = JSON.stringify({
        phase: service.phase,
        gpu: service.gpuName,
        active: service.activeProfile,
        wanted: service.wanted,
        cap: stats ? stats.powerCap : null,
        applied: service.appliedLabel,
        power: stats ? stats.powerNow : null,
        samples: service.powerHistory.length > 0,
        busy: service.busy,
        error: service.lastError,
        notice: service.notice,
        tuning: service.tuning,
        tunePhase: service.tune ? service.tune.phase : "",
        tuneOffset: service.tune ? service.tune.offset : null,
        tunedOffset: service.tuned ? service.tuned.offset : null,
        tunedValid: service.tunedValid,
        slots: service.slots.map(function(slot) { return slot ? slot.capMhz : null }),
        canTune: service.canTune,
        loadTool: service.loadToolReady,
        healthChecked: service.healthChecked
      })
      if (state === root.last) return
      root.last = state
      console.log("STATE " + state)
    }
  }

  IpcHandler {
    target: "test"

    function set(name: string): void { service.setProfile(name) }
    function fast(): void { service.keepFast() }
    function tune(): void { service.startTune() }
    function stop(): void { service.stopTune("Cancelled") }
    function saveSlot(slot: int): void { service.saveSlot(slot - 1) }
    function applySlot(slot: int): void { service.applySlot(slot - 1) }
  }
}
