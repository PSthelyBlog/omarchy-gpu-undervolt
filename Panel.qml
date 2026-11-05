import QtQuick
import Quickshell
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "io.github.psthelyblog.gpu-undervolt"
  ipcTarget: "gpu-undervolt"

  property var service: null
  property int profileIndex: 0
  property bool cursorActive: false

  readonly property string phase: service ? service.phase : "connecting"
  readonly property bool ready: phase === "ready"
  readonly property var stats: service ? service.stats : null
  readonly property var history: service ? service.powerHistory : []
  readonly property string activeProfile: service ? service.activeProfile : "stock"
  readonly property bool asleep: service ? service.gpuAsleep : false
  readonly property string lastError: service ? service.lastError : ""
  readonly property bool settingUp: service ? service.settingUp : false
  readonly property bool efficiency: activeProfile === "efficiency"
  readonly property bool tuning: service ? service.tuning : false
  readonly property bool canTune: service ? service.canTune : false
  readonly property bool loadToolReady: service ? service.loadToolReady : false
  readonly property string notice: service ? service.notice : ""
  property bool confirmingTune: false
  readonly property bool hasPower: stats !== null && stats.powerNow !== null
  readonly property bool showPower: setting("showPower", true) === true && ready && hasPower && !asleep
  readonly property string barIcon: efficiency ? Model.ICON_EFFICIENCY : Model.ICON_GPU
  readonly property var profiles: [
    { id: "stock", label: "Stock", icon: Model.ICON_STOCK },
    { id: "efficiency", label: "Efficiency", icon: Model.ICON_EFFICIENCY }
  ]
  readonly property string title: service && service.gpuName !== "" ? service.gpuName : "GPU"
  readonly property string statusText: {
    if (phase === "missing") return "LACT is not running"
    if (phase === "connecting") return "Connecting"
    if (asleep) return "GPU asleep"
    if (tuning) return "Tuning"
    return Model.profileStatus(activeProfile, service ? service.appliedLabel : "")
  }

  readonly property string tuneText: {
    if (!service) return ""
    if (tuning) return Model.tuneStepLabel(service.tune) + ". Efficiency switches on when this finishes."
    if (confirmingTune) return "Takes up to about 13 minutes at full GPU load. Close games and save your work first: a GPU fault can end your session."
    if (service.tunedStale) return "Driver changed since tuning. Efficiency is using the safe clock cap until you re-tune."
    if (service.tunedValid) return Model.tunedSummary(service.tuned)
    return "Not tuned yet. Efficiency uses a safe clock cap."
  }

  visible: phase !== "unsupported"
  implicitWidth: visible ? button.implicitWidth : 0
  implicitHeight: button.implicitHeight

  function resolveService() {
    var found = bar && bar.shell ? bar.shell.serviceFor("io.github.psthelyblog.gpu-undervolt") : null
    if (found) service = found
  }

  function activateSelected() {
    if (!service) return
    if (phase === "missing") { service.setUp(); return }
    if (ready) service.setProfile(profiles[profileIndex].id)
  }

  function moveCursor(delta) {
    profileIndex = Math.max(0, Math.min(profiles.length - 1, profileIndex + delta))
  }

  onOpenedChanged: {
    confirmingTune = false
    if (!opened) return
    profileIndex = efficiency ? 1 : 0
    cursorActive = false
    sparkline.requestPaint()
  }

  onHistoryChanged: if (opened) sparkline.requestPaint()

  // Third-party services start after the bar can already be up.
  Timer {
    interval: 500
    running: root.service === null
    repeat: true
    triggeredOnStart: true
    onTriggered: root.resolveService()
  }

  Timer {
    interval: 1000
    running: root.opened && root.service !== null
    repeat: true
    triggeredOnStart: true
    onTriggered: root.service.keepFast()
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // The shell scales `text` to icon size, so the power reading goes in the label.
    text: root.barIcon
    labelText: root.showPower && !vertical ? Math.round(root.stats.powerNow) + "W" : ""
    slotSize: Style.bar.iconSlot * (root.showPower && !vertical ? 2 : 1)
    tooltipText: ""
    onPressed: function(b) {
      if (b === Qt.RightButton && root.ready && root.service) root.service.toggleProfile()
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(340))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        root.moveCursor(dx !== 0 ? dx : dy)
      }
      onActivateRequested: if (root.cursorActive || root.phase === "missing") root.activateSelected()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(14)

        Item {
          width: parent.width
          implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight, heroPower.implicitHeight)

          Text {
            id: heroIcon
            textFormat: Text.PlainText
            text: root.barIcon
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.display
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
          }

          Column {
            id: heroLabels
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(14)
            anchors.right: heroPower.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              text: root.title
              textFormat: Text.PlainText
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
              elide: Text.ElideRight
              width: parent.width
            }

            Text {
              text: root.statusText.toUpperCase()
              textFormat: Text.PlainText
              color: Qt.darker(root.bar.foreground, 1.4)
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
              elide: Text.ElideRight
              width: parent.width
            }
          }

          Text {
            id: heroPower
            visible: root.ready && root.hasPower && !root.asleep
            textFormat: Text.PlainText
            text: root.hasPower ? Model.formatWatts(root.stats.powerNow) : ""
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.displayLarge
            font.bold: true
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
          }
        }

        Text {
          visible: root.phase === "missing"
          width: parent.width
          wrapMode: Text.WordWrap
          textFormat: Text.PlainText
          text: "GPU Undervolt uses LACT to read and tune your GPU. Setting up installs it and starts its service, so you will be asked for your password once."
          color: root.bar.foreground
          opacity: 0.7
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
        }

        Button {
          visible: root.phase === "missing"
          width: parent.width
          text: root.settingUp ? "Setting up…" : "Set up"
          fontSize: Style.font.bodySmall
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily
          bordered: true
          enabled: !root.settingUp
          onClicked: root.service.setUp()
        }

        Canvas {
          id: sparkline
          visible: root.ready && root.history.length > 1
          width: parent.width
          height: visible ? Style.space(44) : 0

          onPaint: {
            var ctx = getContext("2d")
            ctx.reset()
            var samples = root.history
            if (samples.length < 2 || width <= 0 || height <= 0) return
            var ceiling = Math.max.apply(null, samples.concat([root.stats && root.stats.powerDefault !== null ? root.stats.powerDefault : 1]))
            var step = width / (Math.max(samples.length, Model.HISTORY_LENGTH) - 1)
            var color = root.bar.foreground
            var offset = width - step * (samples.length - 1)

            function y(value) { return height - 1 - (height - 2) * value / ceiling }

            // The cap gives the trace a reference, so idle reads as "far below
            // the limit" rather than as an empty chart.
            var cap = root.stats ? root.stats.powerCap : null
            if (cap !== null) {
              // Snap to a pixel center: straddling two rows halves the alpha of each.
              var capY = Math.round(y(cap)) + 0.5
              ctx.beginPath()
              ctx.moveTo(0, capY)
              ctx.lineTo(width, capY)
              ctx.lineWidth = 1
              ctx.strokeStyle = Qt.rgba(color.r, color.g, color.b, 0.4)
              ctx.stroke()
            }

            ctx.beginPath()
            ctx.moveTo(offset, y(samples[0]))
            for (var i = 1; i < samples.length; i++) ctx.lineTo(offset + step * i, y(samples[i]))
            ctx.lineWidth = 1.5
            ctx.strokeStyle = color
            ctx.stroke()
            ctx.lineTo(width, height)
            ctx.lineTo(offset, height)
            ctx.closePath()
            ctx.fillStyle = Qt.rgba(color.r, color.g, color.b, 0.12)
            ctx.fill()
          }
        }

        Grid {
          id: metrics
          visible: root.ready && root.stats !== null && !root.asleep
          width: parent.width
          columns: 2
          columnSpacing: Style.space(18)
          rowSpacing: Style.space(6)

          readonly property real cellWidth: (width - columnSpacing) / 2

          Metric { label: "Clock"; value: root.stats ? Model.formatClock(root.stats.clockMhz) : "—" }
          Metric { label: "Voltage"; value: root.stats ? Model.formatVoltage(root.stats.voltageMv) : "—" }
          Metric { label: "Power cap"; value: root.stats ? Model.formatWatts(root.stats.powerCap) : "—" }
          Metric { label: "Temp"; value: root.stats ? Model.formatTemp(root.stats.tempC) : "—" }
          Metric { label: "Load"; value: root.stats ? Model.formatPercent(root.stats.loadPercent) : "—" }
          Metric { label: "Fan"; value: root.stats ? Model.formatPercent(root.stats.fanPercent) : "—" }
          Metric { label: "VRAM"; value: Model.formatVram(root.stats) }
          Metric { label: "Limited by"; value: root.stats ? Model.formatLimits(root.stats) : "—" }
        }

        PanelSeparator {
          visible: root.ready
          foreground: root.bar.foreground
        }

        Row {
          id: profileRow
          visible: root.ready
          width: parent.width
          spacing: Style.space(6)

          readonly property real cellWidth: (width - spacing * (root.profiles.length - 1)) / root.profiles.length

          Repeater {
            model: root.profiles

            Button {
              required property var modelData
              required property int index

              width: profileRow.cellWidth
              iconText: modelData.icon
              iconSize: Style.font.title
              text: modelData.label
              fontSize: Style.font.bodySmall
              foreground: root.bar.foreground
              fontFamily: root.bar.fontFamily
              verticalPadding: Style.spacing.controlPaddingY + Style.space(2)
              bordered: true
              active: root.activeProfile === modelData.id
              hasCursor: root.cursorActive && root.profileIndex === index
              enabled: !root.tuning && (modelData.id === "stock" || (root.service !== null && root.service.efficiencyAvailable))
              onClicked: root.service.setProfile(modelData.id)
              onHovered: function(isHovered) {
                if (!isHovered) return
                root.cursorActive = true
                root.profileIndex = index
              }
            }
          }
        }

        Column {
          visible: root.ready && root.canTune
          width: parent.width
          spacing: Style.space(8)

          Text {
            width: parent.width
            wrapMode: Text.WordWrap
            textFormat: Text.PlainText
            text: root.tuneText
            color: root.bar.foreground
            opacity: 0.7
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          Button {
            visible: !root.tuning && !root.confirmingTune
            width: parent.width
            text: !root.loadToolReady ? "Set up tuning" : (root.service && root.service.tuned !== null ? "Re-tune" : "Tune for this GPU")
            fontSize: Style.font.bodySmall
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
            bordered: true
            enabled: !root.settingUp
            onClicked: {
              if (root.loadToolReady) root.confirmingTune = true
              else root.service.setUp()
            }
          }

          Row {
            id: confirmRow
            visible: root.confirmingTune && !root.tuning
            width: parent.width
            spacing: Style.space(6)

            readonly property real cellWidth: (width - spacing) / 2

            Button {
              width: confirmRow.cellWidth
              text: "Start tuning"
              fontSize: Style.font.bodySmall
              foreground: root.bar.foreground
              fontFamily: root.bar.fontFamily
              bordered: true
              onClicked: {
                root.confirmingTune = false
                root.service.startTune()
              }
            }

            Button {
              width: confirmRow.cellWidth
              text: "Cancel"
              fontSize: Style.font.bodySmall
              foreground: root.bar.foreground
              fontFamily: root.bar.fontFamily
              bordered: true
              onClicked: root.confirmingTune = false
            }
          }

          Button {
            visible: root.tuning
            width: parent.width
            text: "Stop tuning"
            fontSize: Style.font.bodySmall
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
            bordered: true
            onClicked: root.service.stopTune("Cancelled")
          }
        }

        // Shown once there is a tune to save or a slot to apply.
        Column {
          visible: root.ready && root.canTune && root.service !== null
            && (root.service.tuned !== null || root.service.slots.some(function(slot) { return slot !== null }))
          width: parent.width
          spacing: Style.space(6)

          Text {
            width: parent.width
            textFormat: Text.PlainText
            text: "Tune slots: click to apply, right-click to save"
            color: root.bar.foreground
            opacity: 0.6
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
            // Wraps rather than cutting off the hint with a wider font or a narrower panel.
            wrapMode: Text.WordWrap
          }

          Row {
            id: slotRow
            width: parent.width
            spacing: Style.space(6)

            readonly property real cellWidth: (width - spacing * (Model.SLOT_COUNT - 1)) / Model.SLOT_COUNT

            Repeater {
              model: Model.SLOT_COUNT

              Button {
                required property int index
                readonly property var slot: root.service ? root.service.slots[index] : null
                readonly property bool usable: slot !== null && root.service.slotUsable(slot)

                width: slotRow.cellWidth
                text: Model.slotLabel(slot)
                fontSize: Style.font.bodySmall
                foreground: root.bar.foreground
                fontFamily: root.bar.fontFamily
                bordered: true
                // Lit while this slot's tune is the one applied.
                active: usable && root.service.appliedTuned && Model.sameTune(slot, root.service.tuned)
                opacity: slot === null || usable ? 1 : 0.5
                enabled: !root.tuning
                tooltipText: Model.slotTooltip(index, slot, usable)
                onClicked: root.service.applySlot(index)
                onRightClicked: root.service.saveSlot(index)
              }
            }
          }
        }

        Text {
          visible: root.notice !== ""
          width: parent.width
          wrapMode: Text.WordWrap
          textFormat: Text.PlainText
          text: root.notice
          color: root.bar.foreground
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
        }

        Text {
          visible: root.lastError !== ""
          width: parent.width
          wrapMode: Text.WordWrap
          textFormat: Text.PlainText
          text: root.lastError
          color: root.bar.urgent
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
        }
      }
    }
  }

  // Hidden when the GPU cannot report the value, so nothing is ever faked.
  component Metric: Item {
    property string label: ""
    property string value: ""

    visible: value !== "—"
    width: metrics.cellWidth
    implicitHeight: valueText.implicitHeight

    Text {
      anchors.left: parent.left
      textFormat: Text.PlainText
      text: parent.label
      color: root.bar.foreground
      opacity: 0.6
      font.family: root.bar.fontFamily
      font.pixelSize: Style.font.bodySmall
    }

    Text {
      id: valueText
      anchors.right: parent.right
      textFormat: Text.PlainText
      text: parent.value
      color: root.bar.foreground
      font.family: root.bar.fontFamily
      font.pixelSize: Style.font.bodySmall
    }
  }
}
