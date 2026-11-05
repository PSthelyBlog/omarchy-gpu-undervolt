.pragma library

var _service = null

function set(service) {
  _service = service
}

function get() {
  return _service
}

function clear(service) {
  if (_service === service) _service = null
}
