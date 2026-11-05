#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <cuda_runtime.h>
#include <math.h>

__device__ float4 fract4(float4 v) {
    return make_float4(v.x - floorf(v.x), v.y - floorf(v.y), v.z - floorf(v.z), v.w - floorf(v.w));
}

__global__ void stressKernel(float4 *data, unsigned int size) {
    unsigned int idx = blockIdx.x * blockDim.x + threadIdx.x;
    unsigned int index = (idx * 2654435761u) % size;
    float4 value = data[index];
    float4 other = make_float4(value.w + 0.11f, value.z + 0.11f, value.y + 0.11f, value.x + 0.11f);

    for (unsigned int round = 0; round < 1024; round++) {
        float4 v1 = make_float4(
            value.x * other.x + other.y * value.w + 0.31f,
            value.y * other.y + other.z * value.z + 0.73f,
            value.z * other.z + other.w * value.y + 1.13f,
            value.w * other.w + other.x * value.x + 1.37f
        );
        value = fract4(v1);

        float4 v2 = make_float4(
            other.x * other.w + value.x * 0.618034f + sqrtf(fabsf(value.y)),
            other.y * other.x + value.y * 0.618034f + sqrtf(fabsf(value.z)),
            other.z * other.y + value.z * 0.618034f + sqrtf(fabsf(value.w)),
            other.w * other.z + value.w * 0.618034f + sqrtf(fabsf(value.x))
        );
        other = fract4(v2);

        if ((round & 255u) == 0) {
            index = (index * 1664525u + 1013904223u + (unsigned int)(value.x * 65535.0f)) % size;
            float4 d = data[index];
            value.x += d.x * 0.015625f;
            value.y += d.y * 0.015625f;
            value.z += d.z * 0.015625f;
            value.w += d.w * 0.015625f;
        }
    }
    data[idx % size] = make_float4(value.x + other.x, value.y + other.y, value.z + other.z, value.w + other.w);
}

double getTimeSec() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec * 1e-9;
}

int main(int argc, char **argv) {
    double duration = argc > 1 ? atof(argv[1]) : 5.0;
    if (duration <= 0) duration = 5.0;

    unsigned int numElements = 4 * 1024 * 1024; // 64 MB
    size_t bytes = numElements * sizeof(float4);
    float4 *d_data;
    if (cudaMalloc(&d_data, bytes) != cudaSuccess) {
        fprintf(stderr, "CUDA malloc failed\n");
        return 1;
    }

    int blockSize = 256;
    int numBlocks = 1024; // 262,144 threads

    double start = getTimeSec();
    long long totalIterations = 0;

    while (1) {
        double now = getTimeSec();
        double elapsed = now - start;
        if (elapsed >= duration) break;

        stressKernel<<<numBlocks, blockSize>>>(d_data, numElements);
        cudaDeviceSynchronize();
        totalIterations += numBlocks * blockSize;
    }

    cudaFree(d_data);
    double elapsed = getTimeSec() - start;
    long long score = (long long)(totalIterations / elapsed);
    printf("Score: %lld\n", score);
    return 0;
}
