#!/usr/bin/env python3
"""Runs the real tuner against real LACT, with a limit on how far it may climb.

Uses the real stress load and kernel error watching, in a separate headless
Quickshell with temporary state, so the plugin's saved result is not touched and
the GPU returns to stock at the end. This changes real GPU settings: save your work.
"""
import argparse
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--max-offset", type=int, default=60, help="highest offset to try, in MHz")
    parser.add_argument("--step", type=int, default=30, help="seconds per step")
    parser.add_argument("--soak", type=int, default=60, help="seconds for the soak")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="gpu-undervolt-") as tmp:
        tmp = Path(tmp)
        for name in ("run", "state", "shell", "bin"):
            (tmp / name).mkdir(mode=0o700)
        for name in ("Service.qml", "LactClient.qml", "Model.js", "stress.ts"):
            shutil.copy(ROOT / name, tmp / "shell" / name)
        shutil.copy(ROOT / "tests/harness.qml", tmp / "shell/shell.qml")
        notifier = tmp / "bin/omarchy-notification-send"
        notifier.write_text("#!/bin/bash\n")
        notifier.chmod(0o755)
        env = {
            **os.environ,
            "QT_QPA_PLATFORM": "offscreen",
            "XDG_RUNTIME_DIR": str(tmp / "run"),
            "XDG_STATE_HOME": str(tmp / "state"),
            "GPU_UNDERVOLT_SOCKET": "/run/lactd.sock",
            "GPU_UNDERVOLT_STEP_SECONDS": str(args.step),
            "GPU_UNDERVOLT_SOAK_SECONDS": str(args.soak),
            "GPU_UNDERVOLT_MAX_OFFSET": str(args.max_offset),
            "PATH": f"{tmp / 'bin'}:{os.environ['PATH']}",
        }
        shell_qml = str(tmp / "shell/shell.qml")
        shell = subprocess.Popen(["quickshell", "-p", shell_qml], env=env, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, text=True, bufsize=1)

        def call(*words):
            subprocess.run(["quickshell", "ipc", "-p", shell_qml, "call", "test", *words],
                           env=env, check=True, capture_output=True)

        state = {}
        started = False
        printed = ""
        tune_file = tmp / "state/gpu-undervolt/tune.json"
        try:
            for line in shell.stdout:
                marker = line.find("STATE ")
                if marker == -1:
                    continue
                state = json.loads(line[marker + 6:])
                label = f"{state['tunePhase']} +{state['tuneOffset']}"
                if state["tuning"] and label != printed:
                    printed = label
                    print(f"{time.strftime('%H:%M:%S')} {label}", flush=True)
                if not started and state["phase"] == "ready" and state["canTune"] and state["loadTool"] \
                        and state["healthChecked"] and state["power"] is not None:
                    started = True
                    call("tune")
                    continue
                if started and printed and not state["tuning"] and not state["busy"]:
                    if state["error"] or state["notice"]:
                        print("error:", state["error"], "| notice:", state["notice"])
                    break
            result = json.loads(tune_file.read_text())
            knee = result["knees"].get(str(result["offset"]), {})
            print("\nphase", result["phase"], "| reason:", result["reason"] or "none",
                  "| kept", knee.get("capMhz"), "MHz at", knee.get("targetMv"), "mV")
            print(f"{'step':>10} {'offset':>7} {'pass':>5} {'score':>8} {'watts':>7} {'MHz':>6} {'mV':>6}  reason")
            for r in result["results"]:
                print(f"{r['phase']:>10} {r['offset']:>7} {str(r['passed']):>5} {str(r['score']):>8} "
                      f"{(r['watts'] or 0):7.1f} {(r['mhz'] or 0):6.0f} {(r['mv'] or 0):6.0f}  {r['reason']}")
            call("set", "stock")
            time.sleep(1.5)
        finally:
            shell.kill()
            shell.wait()


if __name__ == "__main__":
    main()
