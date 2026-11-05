#!/usr/bin/env python3
"""End-to-end test of Service.qml against tools/mock-lactd.py.

Runs an isolated headless Quickshell with its own runtime and state directories,
so it touches neither the live Omarchy shell nor the GPU (the mock only reads
nvidia-smi). deno, journalctl and the notifier are replaced by scripts on PATH, so
GPU errors, hangs and crashes can be injected. Run with: python3 tests/integration.py
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

STEP_SECONDS = 8

# Each load pops one scenario line: "<score> <exit code> [xid]". "hang" never ends.
FAKE_DENO = r"""#!/bin/bash
seconds="${@: -1}"
line=$(head -n1 "$FAKE_DIR/scenario" 2>/dev/null)
sed -i 1d "$FAKE_DIR/scenario" 2>/dev/null
read -r score code xid <<<"$line"
: > "$FAKE_DIR/load"
trap 'rm -f "$FAKE_DIR/load"' EXIT TERM
[[ $score == hang ]] && seconds=3600
sleep "$seconds" & wait $!
[[ $xid == xid ]] && echo "NVRM: Xid (PCI:0000:01:00): 13" >> "$FAKE_DIR/kernel.log"
echo "Score: ${score:-1000}"
exit "${code:-0}"
"""

FAKE_JOURNALCTL = r"""#!/bin/bash
for arg in "$@"; do
  [[ $arg == -f ]] && exec tail -n0 -F "$FAKE_DIR/kernel.log"
done
[[ " $* " == *" -n 1 "* ]] && exit 0
cat "$FAKE_DIR/previous-boot" 2>/dev/null
exit 0
"""

FAKE_NOTIFY = r"""#!/bin/bash
echo "$*" >> "$FAKE_DIR/notifications"
"""


class Harness:
    def __init__(self, tmp):
        self.tmp = tmp
        self.run_dir = tmp / "run"
        self.state_dir = tmp / "state"
        self.shell_dir = tmp / "shell"
        self.fake_dir = tmp / "fake"
        self.bin_dir = tmp / "bin"
        for path in (self.run_dir, self.state_dir, self.shell_dir, self.fake_dir, self.bin_dir):
            path.mkdir(mode=0o700)
        (self.fake_dir / "kernel.log").touch()
        for name, script in (("deno", FAKE_DENO), ("journalctl", FAKE_JOURNALCTL),
                             ("omarchy-notification-send", FAKE_NOTIFY)):
            (self.bin_dir / name).write_text(script)
            (self.bin_dir / name).chmod(0o755)
        for name in ("Service.qml", "LactClient.qml", "Model.js", "stress.ts"):
            shutil.copy(ROOT / name, self.shell_dir / name)
        shutil.copy(ROOT / "tests/harness.qml", self.shell_dir / "shell.qml")
        self.env = {
            **os.environ,
            "QT_QPA_PLATFORM": "offscreen",
            "XDG_RUNTIME_DIR": str(self.run_dir),
            "XDG_STATE_HOME": str(self.state_dir),
            "GPU_UNDERVOLT_SOCKET": str(self.run_dir / "lactd.sock"),
            "GPU_UNDERVOLT_STEP_SECONDS": str(STEP_SECONDS),
            "GPU_UNDERVOLT_SOAK_SECONDS": str(STEP_SECONDS),
            "PATH": f"{self.bin_dir}:{os.environ['PATH']}",
            "FAKE_DIR": str(self.fake_dir),
        }
        self.state = {}
        self.shell = None
        self.mock = None
        self.mock_log = []

    def start_shell(self):
        self.state = {}
        self.shell = subprocess.Popen(
            ["quickshell", "-p", str(self.shell_dir / "shell.qml")],
            env=self.env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        threading.Thread(target=self._read_shell, args=(self.shell,), daemon=True).start()

    def _read_shell(self, process):
        for line in process.stdout:
            marker = line.find("STATE ")
            if marker != -1:
                self.state = json.loads(line[marker + 6:])
            elif "qml" in line.lower() and ("error" in line.lower() or "warn" in line.lower()):
                print("  [shell]", line.rstrip())

    def start_mock(self):
        self.mock = subprocess.Popen(
            [sys.executable, str(ROOT / "tools/mock-lactd.py"), "--socket", str(self.run_dir / "lactd.sock"),
             "--load-flag", str(self.fake_dir / "load")],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        threading.Thread(target=self._read_mock, args=(self.mock,), daemon=True).start()

    def _read_mock(self, process):
        for line in process.stdout:
            self.mock_log.append(line.rstrip())

    def call(self, *args):
        subprocess.run(
            ["quickshell", "ipc", "-p", str(self.shell_dir / "shell.qml"), "call", "test", *args],
            env=self.env, check=True, capture_output=True,
        )

    def wait(self, description, predicate, timeout=12):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate(self.state):
                print("ok  ", description)
                return
            time.sleep(0.05)
        raise AssertionError(f"{description}: timed out, state={self.state}")

    def count(self, text):
        return sum(text in line for line in self.mock_log)

    def settle(self):
        """Tuning refuses a busy GPU, so wait for a fresh idle sample."""
        deadline = time.time() + 8
        while time.time() < deadline:
            self.call("fast")
            if (self.state.get("power") or 999) < 100:
                return
            time.sleep(0.3)
        raise AssertionError(f"GPU did not settle: {self.state}")

    def scenario(self, *lines):
        (self.fake_dir / "scenario").write_text("".join(line + "\n" for line in lines))

    def notifications(self):
        path = self.fake_dir / "notifications"
        return path.read_text() if path.exists() else ""

    def tuned(self):
        return json.loads((self.state_dir / "gpu-undervolt/tuned.json").read_text())

    def children_alive(self):
        found = subprocess.run(["pgrep", "-f", str(self.fake_dir)], capture_output=True, text=True).stdout.split()
        return [pid for pid in found if int(pid) != self.mock.pid]

    def kill_shell(self):
        self.shell.send_signal(signal.SIGKILL)
        self.shell.wait()

    def stop_shell(self):
        self.shell.terminate()
        self.shell.wait()

    def stop(self):
        for process in (self.shell, self.mock):
            if process and process.poll() is None:
                process.kill()
        subprocess.run(["pkill", "-f", str(self.tmp)])


def main():
    with tempfile.TemporaryDirectory(prefix="gpu-undervolt-") as tmp:
        h = Harness(Path(tmp))
        state_file = h.state_dir / "gpu-undervolt/profile"
        try:
            h.start_shell()
            h.wait("no daemon reports LACT as missing", lambda s: s.get("phase") == "missing")

            h.start_mock()
            h.wait("finds the daemon and the GPU",
                   lambda s: s.get("phase") == "ready" and s.get("gpu") == "NVIDIA GeForce RTX 4070")
            h.call("fast")
            h.wait("reads live stats", lambda s: s.get("cap") == 200 and s.get("samples"))
            assert h.state["active"] == "stock", h.state

            h.call("set", "efficiency")
            h.wait("Efficiency takes the hold", lambda s: s.get("active") == "efficiency")
            h.wait("Efficiency is a clock cap from the VF curve", lambda s: s.get("applied", "").endswith("MHz cap"))
            h.call("fast")
            h.wait("the power limit is left alone", lambda s: s.get("cap") == 200)
            assert state_file.read_text().strip() == "efficiency"
            print("ok   choice persisted to the state file")

            h.call("set", "stock")
            h.wait("Stock releases the hold", lambda s: s.get("active") == "stock")
            h.wait("the clock cap label clears", lambda s: s.get("applied") == "")
            assert h.state["error"] == "", "a planned release must not look like a lost connection"

            h.call("set", "efficiency")
            h.wait("Efficiency can be re-applied", lambda s: s.get("active") == "efficiency")
            assert h.count("<- create_profile") == 1, "an unchanged profile must not be rewritten"
            print("ok   unchanged profile is reused, not rewritten")

            h.mock.kill()
            h.wait("daemon crash clears the hold", lambda s: s.get("active") == "stock" and s.get("phase") != "ready")
            assert h.state["wanted"] == "efficiency", h.state

            h.mock_log.clear()
            h.start_mock()
            h.wait("daemon restart re-applies Efficiency", lambda s: s.get("active") == "efficiency", timeout=20)
            h.wait("clock cap is back after the restart", lambda s: s.get("applied", "").endswith("MHz cap"))

            h.kill_shell()
            deadline = time.time() + 3
            while time.time() < deadline and h.count("auto-releasing hold") == 0:
                time.sleep(0.05)
            assert h.count("auto-releasing hold") == 1, "kill -9 of the shell must drop the hold"
            print("ok   kill -9 of the shell auto-releases the hold")

            h.start_shell()
            h.wait("next session restores Efficiency from the state file",
                   lambda s: s.get("active") == "efficiency")

            h.call("set", "stock")
            h.wait("back to Stock", lambda s: s.get("active") == "stock")
            assert state_file.read_text().strip() == "stock"

            tuner_flow(h, state_file)
        finally:
            h.stop()
    print("PASS")


def tuner_flow(h, state_file):
    idle = lambda s: not s.get("tuning") and not s.get("busy")
    tuned_label = lambda s: s.get("applied") == "Tuned"
    h.wait("tuning is offered on this GPU", lambda s: s.get("canTune") and s.get("loadTool"))

    h.scenario("1000 4")
    h.call("tune")
    h.wait("a load that fails validation stops the run", lambda s: s.get("tunePhase") == "stopped" and idle(s))
    assert not (h.state_dir / "gpu-undervolt/tuned.json").exists(), "a failed run must not save a result"

    h.settle()
    h.scenario("1000 0", "hang 0")
    h.call("tune")
    h.wait("reaches the first undervolt step", lambda s: s.get("tunePhase") == "climb" and s.get("tuning"), timeout=30)
    h.call("stop")
    h.wait("Stop ends the run at once", lambda s: s.get("tunePhase") == "stopped" and idle(s), timeout=8)
    assert h.state["active"] == "stock", h.state

    h.settle()
    h.scenario("100000 0", "95000 0", "96100 0", "97200 0", "98300 0 xid", "96000 0")
    h.call("tune")
    h.wait("the climb starts", lambda s: s.get("tuning"))
    h.wait("a GPU error ends the climb and backs off to soak", lambda s: s.get("tunePhase") == "soak", timeout=70)
    assert h.state["tuneOffset"] == 30, h.state
    h.wait("finishes and applies the result", lambda s: s.get("tunePhase") == "done" and tuned_label(s) and idle(s), timeout=30)
    saved = h.tuned()
    assert saved["offset"] == 30 and not saved["unverified"], saved
    assert saved["baseline"]["score"] == 100000 and saved["tuned"]["score"] == 96000, saved
    assert state_file.read_text().strip() == "efficiency"
    assert "Tuned to 2565 MHz at 965 mV" in h.notifications(), h.notifications()
    print("ok   result saved with its measured cost:", saved["capMhz"], "MHz")
    boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    active_boot = h.state_dir / "gpu-undervolt/active-boot"
    assert active_boot.read_text().split()[0] == boot_id
    print("ok   the tuned hold records the boot it is live in")

    h.call("saveSlot", "1")
    h.wait("the current tune saves to a slot", lambda s: s.get("slots", [None])[0] == saved["capMhz"])
    assert json.loads((h.state_dir / "gpu-undervolt/slots.json").read_text())[0]["offset"] == 30

    xid_at = time.time()
    (h.fake_dir / "kernel.log").open("a").write("NVRM: Xid (PCI:0000:01:00): 13\n")
    h.wait("a GPU error in normal use steps the undervolt down", lambda s: s.get("tunedOffset") == 15)
    h.wait("the lowered profile is applied", lambda s: tuned_label(s) and idle(s))
    assert h.tuned()["capMhz"] == saved["capMhz"] - 15
    assert "Lowered to 2550 MHz at 965 mV" in h.notifications(), h.notifications()
    since = int(active_boot.read_text().split()[1])
    assert since > xid_at * 1000, "the error just handled must be marked as handled"
    print("ok   the handled error is recorded for the next login")

    # That same error, found in the previous boot's log at the next login.
    (h.fake_dir / "previous-boot").write_text(
        f"{xid_at:.6f} B550 kernel: NVRM: Xid (PCI:0000:01:00): 13\n"
        f"{xid_at + 60:.6f} B550 systemd[1]: Reached target Shutdown.\n")
    active_boot.write_text(f"some-earlier-boot {since}\n")
    h.stop_shell()
    h.start_shell()
    h.wait("a clean previous boot whose error was already handled changes nothing",
           lambda s: s.get("healthChecked") and tuned_label(s))
    assert h.state["tunedOffset"] == 15, h.state

    (h.fake_dir / "previous-boot").write_text("")
    (h.state_dir / "gpu-undervolt/active-boot").write_text("some-earlier-boot\n")
    h.stop_shell()
    h.start_shell()
    h.wait("an unclean previous boot steps down before anything is applied",
           lambda s: s.get("healthChecked") and s.get("tunedOffset") == 0)
    h.wait("the stepped-down result is applied", lambda s: tuned_label(s) and idle(s))

    h.call("set", "stock")
    h.wait("Stock again before the crash test", lambda s: s.get("active") == "stock")
    h.settle()
    h.scenario("100000 0", "95000 0", "96100 0", "97200 0", "hang 0")
    h.call("tune")
    h.wait("gets to the step that will crash", lambda s: s.get("tuning") and s.get("tuneOffset") == 90, timeout=70)
    h.mock_log.clear()
    h.kill_shell()
    deadline = time.time() + 3
    while time.time() < deadline and (h.count("auto-releasing hold") == 0 or h.children_alive()):
        time.sleep(0.1)
    assert h.count("auto-releasing hold") == 1, "the crash must drop the undervolt"
    print("ok   a crash mid-step drops the undervolt")
    alive = h.children_alive()
    if alive:
        detail = subprocess.run(["ps", "-o", "pid,ppid,args", "-p", ",".join(alive)], capture_output=True, text=True).stdout
        raise AssertionError(f"children survived the crash:\n{detail}")
    print("ok   the stress load and watcher die with the shell")
    (h.fake_dir / "load").unlink(missing_ok=True)

    h.start_shell()
    h.wait("the crashed step is recognised at next start", lambda s: "crashed at 2625 MHz at 965 mV" in s.get("notice", ""))
    recovered = h.tuned()
    assert recovered["offset"] == 30 and recovered["unverified"], recovered
    print("ok   keeps the last good step minus the margin, flagged as not soak-tested")

    # The result must not outlive the driver it was measured on.
    h.stop_shell()
    recovered["fingerprint"] = "nvidia 999.99.99|95.03.3C.00.50"
    (h.state_dir / "gpu-undervolt/tuned.json").write_text(json.dumps(recovered))
    state_file.write_text("efficiency\n")
    h.start_shell()
    h.wait("after a driver change Efficiency falls back to the safe cap",
           lambda s: s.get("applied", "").endswith("MHz cap") and not s.get("tunedValid"))

    slot_flow(h, saved)

    violations = [line for line in h.mock_log if "VIOLATION" in line]
    assert not violations, violations
    print("ok   no profile was ever edited during a hold")



def slot_flow(h, saved):
    """Slot 1 was saved several shell restarts ago; the current tune is now stale."""
    idle = lambda s: not s.get("tuning") and not s.get("busy")
    assert h.state["slots"][0] == saved["capMhz"], "slots survive restarts"
    h.call("saveSlot", "2")
    h.wait("a tune from another driver is not saved to a slot",
           lambda s: s.get("error", "").startswith("No tune to save"))
    assert h.state["slots"][1] is None, h.state

    h.call("set", "stock")
    h.wait("Stock before applying a slot", lambda s: s.get("active") == "stock" and idle(s))
    h.mock_log.clear()
    h.call("applySlot", "1")
    h.wait("applying a slot restores its tune and switches Efficiency on",
           lambda s: s.get("active") == "efficiency" and s.get("applied") == "Tuned" and s.get("tunedValid") and idle(s))
    assert h.state["tunedOffset"] == saved["offset"], h.state
    assert h.tuned()["capMhz"] == saved["capMhz"]
    applied = [line for line in h.mock_log if "<- create_profile" in line]
    assert applied and f"'max_core_clock': {saved['capMhz']}" in applied[-1], applied
    print("ok   the slot's clock cap is what LACT was given")

    h.call("applySlot", "3")
    time.sleep(0.5)
    assert h.state["active"] == "efficiency" and h.state["error"] == "", "an empty slot changes nothing"


if __name__ == "__main__":
    main()
