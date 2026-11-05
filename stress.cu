// The CUDA build of stress.ts's load, for NVIDIA GPUs that WebGPU cannot set up
// on. The same kernel, buffer, batch sizing, queue depth and bursts, so its score
// is in the same units. stress.ts builds it with nvcc and runs it.
//
// Usage: stress_cuda <seconds>
// Prints "Score: <work units per second>". Exits 3 on a device fault, and 5 when
// CUDA cannot run on this GPU at all, before any load.

#include <cuda_runtime.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#define BUFFER_BYTES (512u * 1024u * 1024u)
#define WORKGROUP_SIZE 256
#define TARGET_BATCH_MS 40.0
#define QUEUE_DEPTH 3
#define BURST_EVERY_SECONDS 20.0
#define BURST_SECONDS 5.0

#define EXIT_SETUP 1
#define EXIT_FAULT 3
#define EXIT_UNAVAILABLE 5

__device__ float4 fract4(float4 v) {
  return make_float4(v.x - floorf(v.x), v.y - floorf(v.y), v.z - floorf(v.z), v.w - floorf(v.w));
}

__global__ void stressKernel(float4 *data, unsigned int size) {
  unsigned int id = blockIdx.x * blockDim.x + threadIdx.x;
  unsigned int index = (id * 2654435761u) % size;
  float4 value = data[index];
  float4 other = make_float4(value.w + 0.11f, value.z + 0.11f, value.y + 0.11f, value.x + 0.11f);
  for (unsigned int round = 0; round < 1024u; round++) {
    value = fract4(make_float4(
      value.x * other.x + other.y * value.w + 0.31f,
      value.y * other.y + other.z * value.z + 0.73f,
      value.z * other.z + other.w * value.y + 1.13f,
      value.w * other.w + other.x * value.x + 1.37f));
    other = fract4(make_float4(
      other.x * other.w + value.x * 0.618034f + sqrtf(fabsf(value.y)),
      other.y * other.x + value.y * 0.618034f + sqrtf(fabsf(value.z)),
      other.z * other.y + value.z * 0.618034f + sqrtf(fabsf(value.w)),
      other.w * other.z + value.w * 0.618034f + sqrtf(fabsf(value.x))));
    if ((round & 255u) == 0u) {
      index = (index * 1664525u + 1013904223u + (unsigned int)(value.x * 65535.0f)) % size;
      float4 sample = data[index];
      value.x += sample.x * 0.015625f;
      value.y += sample.y * 0.015625f;
      value.z += sample.z * 0.015625f;
      value.w += sample.w * 0.015625f;
    }
  }
  data[id % size] = make_float4(value.x + other.x, value.y + other.y, value.z + other.z, value.w + other.w);
}

static double now(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec + ts.tv_nsec * 1e-9;
}

static void pause60ms(void) {
  struct timespec pause = { 0, 60L * 1000L * 1000L };
  nanosleep(&pause, NULL);
}

// Errors meaning this build cannot run on this GPU or driver at all.
static int unavailable(cudaError_t err) {
  return err == cudaErrorNoDevice || err == cudaErrorInsufficientDriver
    || err == cudaErrorNoKernelImageForDevice || err == cudaErrorUnsupportedPtxVersion
    || err == cudaErrorInvalidDeviceFunction;
}

static void checkSetup(cudaError_t err) {
  if (err == cudaSuccess) return;
  fprintf(stderr, "CUDA setup failed: %s\n", cudaGetErrorString(err));
  exit(unavailable(err) ? EXIT_UNAVAILABLE : EXIT_SETUP);
}

// A failed launch returns at once, so counting it as work would turn a broken
// run into a huge score. Every call during the load is checked.
static void checkLoad(cudaError_t err) {
  if (err == cudaSuccess) return;
  fprintf(stderr, "CUDA error: %s\n", cudaGetErrorString(err));
  exit(EXIT_FAULT);
}

static void launch(float4 *data, unsigned int size, unsigned int blocks) {
  stressKernel<<<blocks, WORKGROUP_SIZE>>>(data, size);
  checkLoad(cudaGetLastError());
}

int main(int argc, char **argv) {
  double seconds = argc > 1 ? atof(argv[1]) : 30.0;
  unsigned int size = BUFFER_BYTES / sizeof(float4);

  // Waits for the GPU without spinning a CPU core.
  checkSetup(cudaSetDeviceFlags(cudaDeviceScheduleBlockingSync));
  float4 *data;
  checkSetup(cudaMalloc((void **)&data, BUFFER_BYTES));

  // Random data, as in stress.ts, so the math runs on real values.
  size_t seedCount = 1024 * 1024;
  size_t seedBytes = seedCount * sizeof(float);
  float *seed = (float *)malloc(seedBytes);
  if (!seed) return EXIT_SETUP;
  srand((unsigned int)time(NULL));
  for (size_t i = 0; i < seedCount; i++) seed[i] = (float)rand() / (float)RAND_MAX;
  for (size_t offset = 0; offset < BUFFER_BYTES; offset += seedBytes) {
    checkSetup(cudaMemcpy((char *)data + offset, seed, seedBytes, cudaMemcpyHostToDevice));
  }
  free(seed);

  cudaEvent_t done[QUEUE_DEPTH];
  for (int i = 0; i < QUEUE_DEPTH; i++) {
    checkSetup(cudaEventCreateWithFlags(&done[i], cudaEventDisableTiming | cudaEventBlockingSync));
  }

  // One small batch first: a GPU this build has no kernel for fails here.
  stressKernel<<<1, WORKGROUP_SIZE>>>(data, size);
  checkSetup(cudaGetLastError());
  checkSetup(cudaDeviceSynchronize());

  // Size batches to this GPU, so one stays short enough for the driver's watchdog.
  unsigned int blocks = 64;
  for (int i = 0; i < 8; i++) {
    double start = now();
    launch(data, size, blocks);
    checkLoad(cudaDeviceSynchronize());
    double elapsedMs = (now() - start) * 1000.0;
    blocks = (unsigned int)fmax(1.0, round(blocks * TARGET_BATCH_MS / fmax(elapsedMs, 1.0)));
  }

  double started = now();
  double busy = 0;
  long long work = 0;
  int inFlight = 0;
  int next = 0;
  for (;;) {
    double elapsed = now() - started;
    if (elapsed >= seconds) break;
    if (fmod(elapsed, BURST_EVERY_SECONDS) >= BURST_EVERY_SECONDS - BURST_SECONDS) {
      checkLoad(cudaDeviceSynchronize());
      inFlight = 0;
      launch(data, size, blocks);
      checkLoad(cudaDeviceSynchronize());
      pause60ms();
      continue;
    }
    // Queue ahead so the GPU never waits on this process between batches.
    double batchStart = now();
    launch(data, size, blocks);
    checkLoad(cudaEventRecord(done[next], 0));
    next = (next + 1) % QUEUE_DEPTH;
    if (++inFlight >= QUEUE_DEPTH) {
      checkLoad(cudaEventSynchronize(done[next]));
      inFlight--;
    }
    busy += now() - batchStart;
    work += blocks;
  }
  checkLoad(cudaDeviceSynchronize());

  printf("Score: %lld\n", busy > 0 ? (long long)llround(work / busy) : 0LL);
  fflush(stdout);
  return 0;
}
