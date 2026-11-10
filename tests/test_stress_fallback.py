"""stress.ts's CUDA fallback, without a GPU or a CUDA toolkit.

DENO_WEBGPU_BACKEND=dx12 leaves Linux with no WebGPU adapter, so stress.ts takes
the fallback. A fake nvcc "builds" a script that stands in for stress_cuda.
Deno runs with the permissions Service.qml gives it, so this also checks that
they are enough.
"""

import os
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

FAKE_NVCC = r"""#!/bin/bash
[[ $1 == --version ]] && exit 0
echo "$*" >> "$FAKE_DIR/nvcc.log"
[[ -e $FAKE_DIR/nvcc-fails ]] && { echo "nvcc fatal: unsupported gpu architecture" >&2; exit 1; }
while [[ $# -gt 0 ]]; do [[ $1 == -o ]] && { out=$2; shift; }; shift; done
cat > "$out" <<'EOF'
#!/bin/bash
echo $$ > "$FAKE_DIR/helper-pid"
case $(cat "$FAKE_DIR/helper-mode" 2>/dev/null) in
  unavailable) exit 5 ;;
  fault) echo "CUDA error: unspecified launch failure" >&2; exit 3 ;;
  hang) exec sleep 60 ;;
esac
echo "Score: 4242"
EOF
chmod +x "$out"
"""


@unittest.skipUnless(shutil.which("deno") and shutil.which("setpriv"), "needs deno and setpriv")
class StressFallbackTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="gpu-undervolt-stress-"))
        self.plugin = self.tmp / "plugin"
        self.fake = self.tmp / "fake"
        self.bin = self.tmp / "bin"
        self.cache = self.tmp / "cache/gpu-undervolt"
        for path in (self.plugin, self.fake, self.bin):
            path.mkdir()
        for name in ("stress.ts", "stress.cu"):
            shutil.copy(ROOT / name, self.plugin / name)
        nvcc = self.bin / "nvcc"
        nvcc.write_text(FAKE_NVCC)
        nvcc.chmod(0o755)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def command(self, with_cache=True, with_nvcc=True):
        source = self.plugin / "stress.cu"
        cmd = ["deno", "run", "--quiet", "--unstable-webgpu", "--no-check", "--no-prompt",
               f"--allow-read={source},{self.cache}", f"--allow-write={self.cache}",
               "--allow-run=setpriv,nvcc,/opt/cuda/bin/nvcc", str(self.plugin / "stress.ts"), "1"]
        if with_cache:
            cmd.append(str(self.cache))
        path = os.environ["PATH"] if with_nvcc else "/usr/bin"
        env = {**os.environ, "DENO_WEBGPU_BACKEND": "dx12", "FAKE_DIR": str(self.fake),
               "PATH": f"{self.bin}:{path}" if with_nvcc else path}
        return cmd, env

    def run_stress(self, **kwargs):
        cmd, env = self.command(**kwargs)
        return subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=60)

    def builds(self):
        log = self.fake / "nvcc.log"
        return len(log.read_text().splitlines()) if log.exists() else 0

    def test_without_a_cache_dir_there_is_no_fallback(self):
        result = self.run_stress(with_cache=False)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(self.builds(), 0)

    @unittest.skipIf(Path("/opt/cuda/bin/nvcc").exists(), "a real CUDA toolkit is installed")
    def test_without_a_toolkit_the_webgpu_failure_stands(self):
        result = self.run_stress(with_nvcc=False)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("No CUDA toolkit", result.stderr)
        self.assertFalse(self.cache.exists(), "nothing to build, so no cache")

    def test_builds_once_for_this_gpu_and_reuses_the_build(self):
        first = self.run_stress()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIn("Score: 4242", first.stdout)
        self.assertIn("-arch=native", (self.fake / "nvcc.log").read_text())
        second = self.run_stress()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(self.builds(), 1)

    def test_a_changed_source_is_rebuilt(self):
        self.run_stress()
        with open(self.plugin / "stress.cu", "a") as source:
            source.write("// changed\n")
        result = self.run_stress()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.builds(), 2)

    def test_a_failed_build_leaves_the_webgpu_failure(self):
        (self.fake / "nvcc-fails").touch()
        result = self.run_stress()
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("unsupported gpu architecture", result.stderr)

    def test_a_fault_during_the_load_is_reported(self):
        (self.fake / "helper-mode").write_text("fault")
        result = self.run_stress()
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(self.builds(), 1)

    def test_a_build_this_gpu_cannot_run_is_rebuilt_once_then_given_up(self):
        self.run_stress()
        (self.fake / "helper-mode").write_text("unavailable")
        result = self.run_stress()
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(self.builds(), 2)

    def test_the_cuda_load_dies_with_stress_ts(self):
        (self.fake / "helper-mode").write_text("hang")
        cmd, env = self.command()
        deno = subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        pid_file = self.fake / "helper-pid"
        deadline = time.time() + 20
        while time.time() < deadline and not pid_file.exists():
            time.sleep(0.1)
        helper = int(pid_file.read_text())
        deno.send_signal(signal.SIGKILL)
        deno.wait()
        deadline = time.time() + 3
        while time.time() < deadline and Path(f"/proc/{helper}").exists():
            time.sleep(0.1)
        alive = Path(f"/proc/{helper}").exists()
        if alive:
            os.kill(helper, signal.SIGKILL)
        self.assertFalse(alive, "the CUDA load outlived stress.ts")


if __name__ == "__main__":
    unittest.main()
