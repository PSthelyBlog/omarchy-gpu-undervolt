// Headless GPU stress for the tuner: a WebGPU compute shader that mixes heavy
// float math with scattered memory access. It alternates sustained load with
// bursts, because clock and voltage transitions are where undervolts tend to fail.
//
// Usage: deno run --unstable-webgpu stress.ts <seconds> [cache dir]
// Prints "Score: <work units per second>" and exits non-zero on a device fault.
//
// Given a cache dir, a GPU that WebGPU cannot set up on runs the same load built
// with CUDA instead (stress.cu), if the CUDA toolkit is installed. That needs
// --allow-read for stress.cu and the cache dir, --allow-write for the cache dir,
// and --allow-run=setpriv,nvcc,/opt/cuda/bin/nvcc.

const SHADER = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> data: array<vec4<f32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = arrayLength(&data);
  var index = (id.x * 2654435761u) % size;
  var value = data[index];
  var other = value.wzyx + vec4<f32>(0.11);
  for (var round = 0u; round < 1024u; round++) {
    value = fract(value * other + other.yzwx * value.wzyx + vec4<f32>(0.31, 0.73, 1.13, 1.37));
    other = fract(other * other.wxyz + value * 0.618034 + sqrt(abs(value.yzwx)));
    if ((round & 255u) == 0u) {
      index = (index * 1664525u + 1013904223u + u32(value.x * 65535.0)) % size;
      value += data[index] * 0.015625;
    }
  }
  data[id.x % size] = value + other;
}
`

const BUFFER_BYTES = 512 * 1024 * 1024
const TARGET_BATCH_MS = 40
const QUEUE_DEPTH = 3
const BURST_EVERY_SECONDS = 20
const BURST_SECONDS = 5
// stress.cu's exit code when CUDA cannot run on this GPU at all, before any load.
const CUDA_UNAVAILABLE = 5

const seconds = Number(Deno.args[0] ?? 30)
const cacheDir = Deno.args[1] ?? ""

class SetupError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
  }
}

let device: GPUDevice | null = null
let lost = false
let pipeline: GPUComputePipeline
let bindGroup: GPUBindGroup
let buffer: GPUBuffer
let readbacks: GPUBuffer[] = []
let nextReadback = 0
let workgroups = 64

// onSubmittedWorkDone resolves without waiting for the GPU, which let the queue
// grow and made the score a measure of the submit rate. Mapping a buffer written
// by the batch cannot finish until the GPU gets there, so it is real backpressure.
function submit(workgroups: number): Promise<void> {
  const readback = readbacks[nextReadback]
  nextReadback = (nextReadback + 1) % readbacks.length
  const encoder = device!.createCommandEncoder()
  const pass = encoder.beginComputePass()
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bindGroup)
  pass.dispatchWorkgroups(workgroups)
  pass.end()
  encoder.copyBufferToBuffer(buffer, 0, readback, 0, 16)
  device!.queue.submit([encoder.finish()])
  return readback.mapAsync(GPUMapMode.READ).then(() => readback.unmap())
}

async function batch(workgroups: number) {
  await submit(workgroups)
}

async function setUp() {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" })
  if (!adapter) throw new SetupError(2, "No WebGPU adapter")

  const gpu = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: BUFFER_BYTES,
      maxBufferSize: BUFFER_BYTES,
      maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension,
    },
  })
  device = gpu
  gpu.lost.then((info: { reason: string; message: string }) => {
    if (info.reason === "destroyed") return
    lost = true
    console.error("Device lost: " + info.message)
  })

  // WebGPU reports these out of band and the rejected work "finishes" instantly,
  // so without them a broken run would pass with a huge score.
  gpu.pushErrorScope("validation")
  gpu.pushErrorScope("out-of-memory")

  buffer = gpu.createBuffer({
    size: BUFFER_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  })
  const seed = new Float32Array(1024 * 1024)
  for (let i = 0; i < seed.length; i++) seed[i] = Math.random()
  for (let offset = 0; offset < BUFFER_BYTES; offset += seed.byteLength) {
    gpu.queue.writeBuffer(buffer, offset, seed)
  }

  pipeline = gpu.createComputePipeline({
    layout: "auto",
    compute: { module: gpu.createShaderModule({ code: SHADER }), entryPoint: "main" },
  })
  bindGroup = gpu.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer } }],
  })
  readbacks = Array.from({ length: QUEUE_DEPTH + 1 }, () =>
    gpu.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }))

  const mapped = batch(1).then(() => null, (error) => error)
  const noMemory = await gpu.popErrorScope()
  if (noMemory) throw new SetupError(4, "Out of GPU memory: " + noMemory.message)
  const invalid = await gpu.popErrorScope()
  if (invalid) throw new SetupError(4, "Validation failed: " + invalid.message)
  const failed = await mapped
  if (failed) throw failed

  // Size batches to this GPU, so one stays short enough for the driver's watchdog.
  for (let i = 0; i < 8; i++) {
    const start = performance.now()
    await batch(workgroups)
    const elapsed = performance.now() - start
    workgroups = Math.max(1, Math.round(workgroups * TARGET_BATCH_MS / Math.max(elapsed, 1)))
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function readText(path: string): Promise<string> {
  try {
    return (await Deno.readTextFile(path)).trim()
  } catch {
    return ""
  }
}

// Arch adds /opt/cuda/bin to PATH in /etc/profile.d, which not every session reads.
async function findNvcc(): Promise<string | null> {
  for (const nvcc of ["nvcc", "/opt/cuda/bin/nvcc"]) {
    try {
      const probe = await new Deno.Command(nvcc, { args: ["--version"], stdout: "null", stderr: "null" }).output()
      if (probe.success) return nvcc
    } catch {
      // Not installed there.
    }
  }
  return null
}

// Builds stress.cu for the GPUs in this machine only, so a toolkit that no longer
// supports this GPU fails here instead of at launch.
async function buildCuda(source: string, binary: string, stamp: string, hash: string): Promise<boolean> {
  const nvcc = await findNvcc()
  if (!nvcc) {
    console.error("No CUDA toolkit for the fallback")
    return false
  }
  await Deno.mkdir(cacheDir, { recursive: true })
  const built = await new Deno.Command(nvcc, {
    args: ["-O3", "-arch=native", "-o", binary + ".partial", source],
    stdout: "null",
    stderr: "piped",
  }).output()
  if (!built.success) {
    console.error("CUDA build failed:\n" + new TextDecoder().decode(built.stderr).trim())
    return false
  }
  await Deno.rename(binary + ".partial", binary)
  await Deno.writeTextFile(stamp, hash + "\n")
  return true
}

// pdeathsig ends the CUDA load with this process, as Service.qml does for this
// one: a cancelled step or a shell crash must not leave the GPU loaded.
async function runHelper(binary: string): Promise<number> {
  const helper = new Deno.Command("setpriv", {
    args: ["--pdeathsig", "TERM", "--", binary, String(seconds)],
    stdout: "inherit",
    stderr: "inherit",
  }).spawn()
  return (await helper.status).code
}

// Runs the CUDA build of this load, rebuilding it whenever stress.cu changes.
// Returns its exit code, or null if there is no CUDA build that can run here.
async function runCuda(): Promise<number | null> {
  try {
    const source = decodeURIComponent(new URL("./stress.cu", import.meta.url).pathname)
    const binary = cacheDir + "/stress_cuda"
    const stamp = binary + ".source"
    const hash = await sha256(await Deno.readFile(source))
    let fresh = false
    if (await readText(stamp) !== hash || !(await Deno.stat(binary).catch(() => null))) {
      if (!(await buildCuda(source, binary, stamp, hash))) return null
      fresh = true
    }
    console.error("WebGPU could not start, running the CUDA build of the load")
    let code = await runHelper(binary)
    // Built for a GPU or driver this machine no longer has.
    if (code === CUDA_UNAVAILABLE && !fresh && (await buildCuda(source, binary, stamp, hash))) {
      code = await runHelper(binary)
    }
    return code === CUDA_UNAVAILABLE ? null : code
  } catch (error) {
    console.error("CUDA fallback failed: " + (error instanceof Error ? error.message : String(error)))
    return null
  }
}

// Only a failure before any load falls back to CUDA. A fault during the load is a
// result, and running something else instead would hide it.
try {
  await setUp()
} catch (error) {
  if (lost) Deno.exit(3)
  console.error(error instanceof Error ? error.message : String(error))
  device?.destroy()
  const code = error instanceof SetupError ? error.code : 1
  Deno.exit((cacheDir ? await runCuda() : null) ?? code)
}

const started = performance.now()
let done = 0
let busyMs = 0
let inFlight: Promise<void>[] = []
while (!lost) {
  const elapsed = (performance.now() - started) / 1000
  if (elapsed >= seconds) break
  const bursting = elapsed % BURST_EVERY_SECONDS >= BURST_EVERY_SECONDS - BURST_SECONDS
  if (bursting) {
    await Promise.all(inFlight)
    inFlight = []
    await batch(workgroups)
    await new Promise((resolve) => setTimeout(resolve, 60))
    continue
  }
  // Queue ahead so the GPU never waits on this process between batches.
  const batchStart = performance.now()
  inFlight.push(submit(workgroups))
  if (inFlight.length >= QUEUE_DEPTH) await inFlight.shift()
  busyMs += performance.now() - batchStart
  done += workgroups
}
await Promise.all(inFlight)

if (lost) Deno.exit(3)
console.log("Score: " + Math.round(done / (busyMs / 1000)))
device!.destroy()
Deno.exit(0)
