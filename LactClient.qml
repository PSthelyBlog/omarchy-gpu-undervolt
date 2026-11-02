import QtQuick
import Quickshell.Io
import "Model.js" as Model

// One connection to lactd. Replies arrive in request order, so a FIFO of
// callbacks is all the correlation the protocol needs.
Item {
  id: root

  readonly property bool connected: socket.connected
  property string path: ""
  property var _pending: []

  signal lost()

  function open(target) {
    socket.connected = false
    root.path = target
    socket.connected = true
  }

  function close() {
    socket.connected = false
  }

  function call(command, args, callback) {
    if (!socket.connected) {
      if (callback) callback({ ok: false, data: null, error: "Not connected to LACT" })
      return
    }
    _pending.push(callback || null)
    socket.write(Model.encodeRequest(command, args))
    socket.flush()
  }

  function _failPending() {
    var waiting = _pending
    _pending = []
    for (var i = 0; i < waiting.length; i++) {
      if (waiting[i]) waiting[i]({ ok: false, data: null, error: "Connection to LACT was lost" })
    }
  }

  Socket {
    id: socket
    path: root.path

    parser: SplitParser {
      onRead: function(line) {
        var callback = root._pending.shift()
        if (callback) callback(Model.parseResponse(line))
      }
    }

    onConnectedChanged: {
      if (connected) return
      root._failPending()
      root.lost()
    }
  }
}
