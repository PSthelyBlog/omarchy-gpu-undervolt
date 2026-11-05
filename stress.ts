// Headless GPU stress for the tuner: a WebGPU compute shader that mixes heavy
// float math with scattered memory access. It alternates sustained load with
// bursts, because clock and voltage transitions are where undervolts tend to fail.
//
// Usage: deno run --unstable-webgpu stress.ts <seconds>
// Prints "Score: <work units per second>" and exits non-zero on a device fault.

const cudaBinary = new URL("./stress_cuda", import.meta.url).pathname;
const cudaSource = new URL("./stress.cu", import.meta.url).pathname;

try {
  let hasBinary = false;
  try {
    const stat = await Deno.stat(cudaBinary);
    hasBinary = stat.isFile;
  } catch {
    const nvcc = await new Deno.Command("nvcc", { args: ["--version"] }).output().catch(() => null);
    if (nvcc && nvcc.success) {
      const build = await new Deno.Command("nvcc", {
        args: ["-O3", "-Wno-deprecated-gpu-targets", cudaSource, "-o", cudaBinary],
      }).output().catch(() => null);
      hasBinary = !!(build && build.success);
    }
  }

  if (hasBinary) {
    const p = new Deno.Command(cudaBinary, {
      args: Deno.args,
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const status = await p.status;
    Deno.exit(status.code);
  }
} catch (_) {
  // Fall back to WebGPU below
}

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

const seconds = Number(Deno.args[0] ?? 30)
const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
if (!adapter) {
  console.error("No WebGPU adapter")
  Deno.exit(2)
}

const device = await adapter.requestDevice({
  requiredLimits: {
    maxStorageBufferBindingSize: BUFFER_BYTES,
    maxBufferSize: BUFFER_BYTES,
    maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension,
  },
})

let lost = false
device.lost.then((info: { message: string }) => {
  lost = true
  console.error("Device lost: " + info.message)
})

const buffer = device.createBuffer({
  size: BUFFER_BYTES,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
})
const seed = new Float32Array(1024 * 1024)
for (let i = 0; i < seed.length; i++) seed[i] = Math.random()
for (let offset = 0; offset < BUFFER_BYTES; offset += seed.byteLength) {
  device.queue.writeBuffer(buffer, offset, seed)
}

const pipeline = device.createComputePipeline({
  layout: "auto",
  compute: { module: device.createShaderModule({ code: SHADER }), entryPoint: "main" },
})
const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [{ binding: 0, resource: { buffer } }],
})

// onSubmittedWorkDone resolves without waiting for the GPU, which let the queue
// grow and made the score a measure of the submit rate. Mapping a buffer written
// by the batch cannot finish until the GPU gets there, so it is real backpressure.
const readbacks = Array.from({ length: QUEUE_DEPTH + 1 }, () =>
  device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }))
let nextReadback = 0

function submit(workgroups: number): Promise<void> {
  const readback = readbacks[nextReadback]
  nextReadback = (nextReadback + 1) % readbacks.length
  const encoder = device.createCommandEncoder()
  const pass = encoder.beginComputePass()
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bindGroup)
  pass.dispatchWorkgroups(workgroups)
  pass.end()
  encoder.copyBufferToBuffer(buffer, 0, readback, 0, 16)
  device.queue.submit([encoder.finish()])
  return readback.mapAsync(GPUMapMode.READ).then(() => readback.unmap())
}

async function batch(workgroups: number) {
  await submit(workgroups)
}

// WebGPU reports validation failures out of band and the rejected work "finishes"
// instantly, so without this a broken run would pass with a huge score.
device.pushErrorScope("validation")
await batch(1)
const invalid = await device.popErrorScope()
if (invalid) {
  console.error("Validation failed: " + invalid.message)
  Deno.exit(4)
}

// Size batches to this GPU, so one stays short enough for the driver's watchdog.
let workgroups = 64
for (let i = 0; i < 8; i++) {
  const start = performance.now()
  await batch(workgroups)
  const elapsed = performance.now() - start
  workgroups = Math.max(1, Math.round(workgroups * TARGET_BATCH_MS / Math.max(elapsed, 1)))
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
device.destroy()
Deno.exit(0)
