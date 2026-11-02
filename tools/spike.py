#!/usr/bin/env python3
"""Spike: prove on real hardware what the design assumes about LACT.

  status   Read-only. Devices, live stats, VF curve, saved config.
  hold     Power cap only, so no stability risk. Proves a hold applies, is never
           saved to disk, and is released when the client dies without warning.
  measure  Runs a load at stock, then at a clock cap, then at mild undervolts.
           Stops at the first GPU error. Everything is applied through a hold,
           so exiting for any reason returns the GPU to stock.

The curve builder here is what the auto-tuner will be ported from.
"""
import argparse
import json
import re
import shlex
import socket
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path

PROFILE = "gpu-undervolt-spike"
CONFIG = Path("/etc/lact/config.yaml")
CLOCK_STEP_MHZ = 15
RAMP_MV = 100
MAX_SPIKE_OFFSET_MHZ = 120
WARMUP_SAMPLES = 3
# The only vkmark scene found to be GPU-bound on an RTX 4070 (97% busy, FPS tracks
# the GPU). It draws about 140 W, so passing it says nothing about 200 W loads.
DEFAULT_LOAD = (
    "vkmark --fullscreen -p immediate "
    "-b desktop:background-resolution=1920x1080:windows=32:window-size=0.9:duration=30"
)


class LactError(RuntimeError):
    pass


class Lact:
    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.connect(path)
        self.stream = self.sock.makefile("rw")

    def call(self, command, args=None):
        request = {"command": command}
        if args is not None:
            request["args"] = args
        self.stream.write(json.dumps(request) + "\n")
        self.stream.flush()
        reply = json.loads(self.stream.readline())
        if reply.get("status") != "ok":
            data = reply.get("data")
            raise LactError(data.get("description") if isinstance(data, dict) else str(data))
        return reply.get("data")

    def close(self):
        self.stream.close()
        self.sock.close()


def gpu(lact):
    devices = lact.call("list_devices")
    return next(d for d in devices if d.get("device_type") != "Integrated")


def stats(lact, gpu_id):
    return lact.call("device_stats", {"id": gpu_id})


def vf_curve(lact, gpu_id):
    table = (lact.call("device_clocks_info", {"id": gpu_id}) or {}).get("table") or {}
    value = table.get("value") or {}
    return value.get("gpu_vf_curve") or [], value.get("gpu_clock_range")


def saved_current_profile(config):
    """The name saved on disk, or None. Raises if the file cannot be read."""
    match = re.search(r"^current_profile:\s*(.+?)\s*$", config.read_text(), re.M)
    return match.group(1).strip("'\"") if match else None


def xid_count():
    log = subprocess.run(["journalctl", "-k", "-b", "-o", "cat", "--no-pager"], capture_output=True, text=True).stdout
    return log.count("NVRM: Xid")


def curve_config(points, target_mv, offset_mhz, min_clock):
    """Undervolt at target_mv: same clock, offset_mhz earlier on the curve.

    Points below the ramp stay at stock, which avoids the low-voltage instability
    of a global offset. Points above the target keep the full offset so the curve
    never steps down; the clock cap is what stops the card climbing to them.
    """
    if offset_mhz % CLOCK_STEP_MHZ:
        raise ValueError(f"offset must be a multiple of {CLOCK_STEP_MHZ} MHz")
    target = min(points, key=lambda p: abs(p["base_voltage"] - target_mv))
    config = {"min_core_clock": min_clock, "max_core_clock": target["base_freq"] + offset_mhz}
    curve = {}
    for point in points:
        distance = target["base_voltage"] - point["base_voltage"]
        if distance >= RAMP_MV:
            continue
        share = 1 if distance <= 0 else 1 - distance / RAMP_MV
        offset = int(offset_mhz * share) // CLOCK_STEP_MHZ * CLOCK_STEP_MHZ
        if offset:
            curve[str(point["index"])] = {"clockspeed_offset": offset}
    if curve:
        config["nvidia_gpu_vf_curve"] = curve
    return config


def is_monotonic(points, config):
    curve = config.get("nvidia_gpu_vf_curve", {})
    freqs = [p["base_freq"] + curve.get(str(p["index"]), {}).get("clockspeed_offset", 0) for p in points]
    return all(a <= b for a, b in zip(freqs, freqs[1:]))


def install_profile(lact, gpu_id, config):
    try:
        lact.call("delete_profile", {"name": PROFILE})
    except LactError:
        pass
    lact.call("create_profile", {"name": PROFILE, "base": {"provided": {"gpus": {gpu_id: config}}}})


def remove_profile(lact):
    try:
        lact.call("delete_profile", {"name": PROFILE})
    except LactError:
        pass


def cmd_status(args):
    lact = Lact(args.socket)
    device = gpu(lact)
    print("gpu:", device)
    s = stats(lact, device["id"])
    print("power:", s.get("power"))
    print("clock:", s.get("clockspeed"))
    print("voltage:", s.get("voltage"))
    print("vram:", s.get("vram"))
    print("fan:", {k: s["fan"].get(k) for k in ("pwm_current", "speed_current")})
    print("temps:", s.get("temps"))
    print("limits:", s.get("throttle_info"))
    points, clock_range = vf_curve(lact, device["id"])
    print("vf points:", len(points), "clock range:", clock_range)
    print("profiles:", lact.call("list_profiles", {"include_state": False}))
    try:
        print("saved current_profile:", saved_current_profile(args.config))
    except OSError as err:
        print("config unreadable:", err)
    print("Xid errors this boot:", xid_count())


def cmd_hold(args):
    observer = Lact(args.socket)
    gpu_id = gpu(observer)["id"]
    power = stats(observer, gpu_id)["power"]
    default = power["cap_default"]
    print(f"baseline cap {power['cap_current']} W, default {default} W")
    if power["cap_current"] != default:
        sys.exit("cap is not at default, refusing to start")
    target = float(round(default * 0.75))
    install_profile(observer, gpu_id, {"power_cap": target})

    holder = Lact(args.socket)
    cookie = holder.call("hold_profile", {"name": PROFILE})
    time.sleep(1)
    held = stats(observer, gpu_id)["power"]["cap_current"]
    print(f"held (cookie {cookie}): cap is {held} W")
    assert held == target, f"expected {target} W"

    saved = saved_current_profile(args.config)
    print("saved current_profile during hold:", saved)
    assert saved != PROFILE, "the hold reached disk, a hard freeze would not recover"

    print("dropping the connection without releasing, as a crashed shell would")
    holder.close()
    deadline = time.time() + 5
    while time.time() < deadline and stats(observer, gpu_id)["power"]["cap_current"] != default:
        time.sleep(0.1)
    after = stats(observer, gpu_id)["power"]["cap_current"]
    print(f"after drop: cap is {after} W")
    assert after == default, "the hold did not auto-release"

    remove_profile(observer)
    assert saved_current_profile(args.config) != PROFILE
    print("PASS: applied, stayed off disk, auto-released, cleaned up")


def cmd_curve(args):
    """First use of the undocumented write path: at idle, with a small offset."""
    observer = Lact(args.socket)
    gpu_id = gpu(observer)["id"]
    points, clock_range = vf_curve(observer, gpu_id)
    if not points:
        sys.exit("LACT reports no VF curve for this GPU")
    if any(p.get("freq_offset") for p in points):
        sys.exit("the curve already has offsets, refusing to start")
    config = curve_config(points, args.mv, args.offset, clock_range[0] if clock_range else 210)
    if not is_monotonic(points, config):
        sys.exit("that offset would make the curve step down, refusing")
    wanted = {int(i): e["clockspeed_offset"] for i, e in config.get("nvidia_gpu_vf_curve", {}).items()}
    print(f"cap {config['max_core_clock']} MHz, offsets on {len(wanted)} of {len(points)} points")
    install_profile(observer, gpu_id, config)

    holder = Lact(args.socket)
    holder.call("hold_profile", {"name": PROFILE})
    time.sleep(2)
    applied, _ = vf_curve(observer, gpu_id)
    actual = {p["index"]: p.get("freq_offset", 0) for p in applied}
    wrong = {i: (o, actual.get(i)) for i, o in wanted.items() if actual.get(i) != o}
    stray = {i: o for i, o in actual.items() if o and i not in wanted}
    print("written and read back:", len(wanted) - len(wrong), "of", len(wanted), "| stray offsets:", len(stray))
    top = max(wanted)
    point = next(p for p in applied if p["index"] == top)
    print("sample point:", point)
    print("saved current_profile during hold:", saved_current_profile(args.config))
    assert not wrong, f"offsets differ from what was written: {wrong}"
    assert not stray, f"unexpected offsets: {stray}"

    print("dropping the connection without releasing")
    holder.close()
    time.sleep(2)
    after, _ = vf_curve(observer, gpu_id)
    leftover = [p for p in after if p.get("freq_offset")]
    print("offsets left after drop:", len(leftover))
    assert not leftover, "Stock is not stock: offsets survived the release"
    remove_profile(observer)
    print("PASS: curve written, verified, and fully reset")


def run_load(lact, gpu_id, command, label):
    """Runs the load once and summarizes the samples taken under real load."""
    samples = []
    process = subprocess.Popen(shlex.split(command), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    output = []
    reader = threading.Thread(target=lambda: output.extend(process.stdout), daemon=True)
    reader.start()
    while process.poll() is None:
        s = stats(lact, gpu_id)
        if (s.get("busy_percent") or 0) >= 90:
            samples.append(s)
        time.sleep(1)
    reader.join(timeout=2)
    samples = samples[WARMUP_SAMPLES:]
    score = next((m.group(1) for line in output if (m := re.search(r"[Ss]core:\s*(\d+)", line))), None)
    mean = lambda values: round(statistics.mean(values), 1) if values else None
    return {
        "label": label,
        "exit": process.returncode,
        "score": int(score) if score else None,
        "samples": len(samples),
        "watts": mean([s["power"]["current"] for s in samples if s["power"].get("current")]),
        "mhz": mean([s["clockspeed"]["gpu_clockspeed"] for s in samples if s["clockspeed"].get("gpu_clockspeed")]),
        "mv": mean([s["voltage"]["gpu"] for s in samples if s["voltage"].get("gpu")]),
        "temp": mean([s["temps"]["GPU"]["current"] for s in samples if "GPU" in s.get("temps", {})]),
    }


def cmd_measure(args):
    offsets = [int(o) for o in args.offsets.split(",") if o]
    caps = [float(c) for c in args.caps.split(",") if c]
    if max(offsets, default=0) > MAX_SPIKE_OFFSET_MHZ:
        sys.exit(f"the spike stays at or below +{MAX_SPIKE_OFFSET_MHZ} MHz")
    lact = Lact(args.socket)
    device = gpu(lact)
    gpu_id = device["id"]
    if (stats(lact, gpu_id).get("busy_percent") or 0) > 15:
        sys.exit("GPU is busy, close games and video before measuring")
    points, clock_range = vf_curve(lact, gpu_id)
    if not points:
        sys.exit("LACT reports no VF curve for this GPU, the curve path is unavailable")
    min_clock = clock_range[0] if clock_range else 210

    configs = [curve_config(points, args.mv, offset, min_clock) for offset in offsets]
    for offset, config in zip(offsets, configs):
        if not is_monotonic(points, config):
            sys.exit(f"+{offset} MHz would make the curve step down, refusing")

    runs = [(f"{c['max_core_clock']} MHz @ ~{args.mv} mV (+{o})", c) for o, c in zip(offsets, configs)]
    runs += [(f"{cap:.0f} W power cap", {"power_cap": cap}) for cap in caps]

    before = xid_count()
    results = [run_load(lact, gpu_id, args.load, "stock")]
    print(results[-1], flush=True)

    for label, config in runs:
        install_profile(lact, gpu_id, config)
        holder = Lact(args.socket)
        try:
            holder.call("hold_profile", {"name": PROFILE})
            time.sleep(1)
            results.append(run_load(lact, gpu_id, args.load, label))
        finally:
            holder.close()
        print(results[-1], flush=True)
        time.sleep(2)
        errors = xid_count() - before
        if errors or results[-1]["exit"] != 0:
            print(f"STOP: {errors} new Xid errors, load exit {results[-1]['exit']}")
            break

    remove_profile(lact)
    stock = results[0]
    print(f"\n{'config':34} {'score':>7} {'watts':>7} {'MHz':>7} {'mV':>7} {'°C':>6}  vs stock")
    for r in results:
        versus = ""
        if r is not stock and r["watts"] and stock["watts"]:
            versus = f"{100 * (r['watts'] / stock['watts'] - 1):+.1f}% W"
            if r["score"] and stock["score"]:
                versus += f", {100 * (r['score'] / stock['score'] - 1):+.1f}% score"
        print(f"{r['label']:34} {str(r['score']):>7} {str(r['watts']):>7} {str(r['mhz']):>7} {str(r['mv']):>7} {str(r['temp']):>6}  {versus}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--socket", default="/run/lactd.sock")
    parser.add_argument("--config", type=Path, default=CONFIG, help="LACT's saved config")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status").set_defaults(run=cmd_status)
    commands.add_parser("hold").set_defaults(run=cmd_hold)
    curve = commands.add_parser("curve")
    curve.add_argument("--mv", type=int, default=975, help="target voltage")
    curve.add_argument("--offset", type=int, default=30, help="MHz above stock at the target voltage")
    curve.set_defaults(run=cmd_curve)
    measure = commands.add_parser("measure")
    measure.add_argument("--mv", type=int, default=975, help="target voltage")
    measure.add_argument("--offsets", default="0,30,60", help="MHz above stock at the target voltage")
    measure.add_argument("--caps", default="", help="also run these power caps in watts, on the stock curve")
    measure.add_argument("--load", default=DEFAULT_LOAD, help="command to run as the load")
    measure.set_defaults(run=cmd_measure)
    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
