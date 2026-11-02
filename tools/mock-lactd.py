#!/usr/bin/env python3
"""Stand-in for lactd, for developing the plugin without touching the GPU.

Speaks LACT's newline-delimited JSON at $XDG_RUNTIME_DIR/lactd.sock, where LACT's
own non-root daemon listens. Metrics are real (nvidia-smi); power caps and profiles
only exist in this process. Nothing here ever writes to the GPU.
"""
import argparse
import asyncio
import json
import os
import subprocess
from pathlib import Path

GPU_ID = "10DE:2709-1462:5138-0000:01:00.0"
CURVE = json.loads((Path(__file__).resolve().parent.parent / "tests/fixtures/rtx4070-vf-curve.json").read_text())
QUERY = "power.draw,clocks.gr,clocks.mem,temperature.gpu,fan.speed,utilization.gpu,memory.used,memory.total,power.default_limit,power.min_limit,power.max_limit"
MIB = 1024 * 1024


class Mock:
    def __init__(self, voltage, load_flag):
        self.voltage = voltage
        self.load_flag = load_flag
        self.profiles = {}
        self.holds = {}
        self.next_cookie = 1
        self.current = None

    def stats(self):
        out = subprocess.run(
            ["nvidia-smi", f"--query-gpu={QUERY}", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, check=True,
        ).stdout
        draw, clock, mem, temp, fan, load, used, total, default, low, high = (
            float(v) for v in out.strip().split(",")
        )
        applied = self.profiles[self.current]["gpus"][GPU_ID] if self.current else {}
        cap = applied.get("power_cap", default)
        stats = {
            "fan": {"control_enabled": False, "pwm_current": round(fan * 2.55)},
            "clockspeed": {"gpu_clockspeed": clock, "vram_clockspeed": mem, "sensors": {}},
            "voltage": {"sensors": {}},
            "vram": {"total": total * MIB, "used": used * MIB},
            "power": {"current": draw, "cap_current": cap, "cap_max": high, "cap_min": low,
                      "cap_default": default, "sensors": {}},
            "temps": {"GPU": {"current": temp, "crit": 90, "crit_hyst": None,
                              "primary": True, "display_only": False}},
            "busy_percent": int(load),
            "throttle_info": {},
        }
        if self.voltage:
            stats["voltage"]["gpu"] = self.voltage
        if self.load_flag and os.path.exists(self.load_flag):
            stats["busy_percent"] = 99
            stats["power"]["current"] = 150.0
            stats["clockspeed"]["gpu_clockspeed"] = min(applied.get("max_core_clock", 2775), 2775)
        return stats

    def release(self, cookie):
        del self.holds[cookie]
        self.current = list(self.holds.values())[-1] if self.holds else None

    def handle(self, request, owned):
        command, args = request.get("command"), request.get("args") or {}
        if command == "ping":
            return None
        if command == "list_devices":
            return [{"id": GPU_ID, "name": "NVIDIA GeForce RTX 4070", "device_type": "Dedicated"}]
        if command == "device_stats":
            return self.stats()
        if command == "device_info":
            return {"driver": "nvidia 615.78.08", "vbios_version": "95.03.3C.00.50"}
        if command == "device_clocks_info":
            return {"table": {"type": "nvidia", "value": {"gpu_vf_curve": CURVE, "gpu_clock_range": [210, 3105]}}}
        if command == "list_profiles":
            return {"profiles": {n: None for n in self.profiles}, "current_profile": self.current,
                    "auto_switch": False, "watcher_state": None}
        if command == "get_profile":
            if args["name"] not in self.profiles:
                raise ValueError(f"Profile {args['name']} not found")
            return self.profiles[args["name"]]
        if command in ("create_profile", "delete_profile") and self.holds:
            # Real LACT accepts this, then saves the held profile to disk, which
            # silently removes the crash protection. Make it impossible to miss.
            print("VIOLATION: profile edited during a hold", flush=True)
            raise ValueError("profile edited during a hold")
        if command == "create_profile":
            if args["name"] in self.profiles:
                raise ValueError(f"Profile {args['name']} already exists")
            self.profiles[args["name"]] = args["base"]["provided"]
            return None
        if command == "delete_profile":
            self.profiles.pop(args["name"], None)
            return None
        if command == "hold_profile":
            if args["name"] not in self.profiles:
                raise ValueError(f"Profile {args['name']} not found")
            cookie = self.next_cookie
            self.next_cookie += 1
            self.holds[cookie] = args["name"]
            self.current = args["name"]
            owned.add(cookie)
            return cookie
        if command == "release_profile":
            if args["cookie"] not in self.holds:
                raise ValueError(f"Unknown profile hold cookie {args['cookie']}")
            self.release(args["cookie"])
            owned.discard(args["cookie"])
            return None
        raise ValueError(f"unknown variant `{command}`")


async def serve(mock, reader, writer):
    owned = set()
    try:
        while line := await reader.readline():
            request = json.loads(line)
            print("<-", request.get("command"), request.get("args") or "", flush=True)
            try:
                reply = {"status": "ok", "data": mock.handle(request, owned)}
            except ValueError as err:
                reply = {"status": "error", "data": {"description": str(err), "source": None}}
            writer.write(json.dumps(reply).encode() + b"\n")
            await writer.drain()
    finally:
        for cookie in list(owned):
            print("-- connection dropped, auto-releasing hold", cookie, flush=True)
            mock.release(cookie)
        writer.close()


async def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--socket", default=os.path.join(os.environ["XDG_RUNTIME_DIR"], "lactd.sock"))
    parser.add_argument("--voltage", type=int, default=865, help="mV to report; 0 hides the metric")
    parser.add_argument("--load-flag", help="report a fully loaded GPU while this file exists")
    args = parser.parse_args()
    if os.path.exists(args.socket):
        os.unlink(args.socket)
    mock = Mock(args.voltage, args.load_flag)
    server = await asyncio.start_unix_server(lambda r, w: serve(mock, r, w), path=args.socket)
    print("mock lactd on", args.socket, flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
