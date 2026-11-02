"""Curve builder checks against this RTX 4070's real VF curve.

Run with: python3 -m unittest discover tests
"""
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("spike", ROOT / "tools/spike.py")
spike = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spike)

POINTS = json.loads((ROOT / "tests/fixtures/rtx4070-vf-curve.json").read_text())
TARGET_MV = 975


def build(offset):
    return spike.curve_config(POINTS, TARGET_MV, offset, 210)


def nearest_target():
    return min(POINTS, key=lambda p: abs(p["base_voltage"] - TARGET_MV))


class CurveConfig(unittest.TestCase):
    def test_zero_offset_is_only_a_clock_cap(self):
        config = build(0)
        self.assertNotIn("nvidia_gpu_vf_curve", config)
        self.assertEqual(config["max_core_clock"], nearest_target()["base_freq"])

    def test_min_and_max_are_always_set_together(self):
        # LACT bails with "Min and max GPU clock must be set together".
        config = build(60)
        self.assertEqual(config["min_core_clock"], 210)
        self.assertIn("max_core_clock", config)

    def test_cap_rises_by_the_offset(self):
        self.assertEqual(build(60)["max_core_clock"], nearest_target()["base_freq"] + 60)

    def test_low_voltage_points_stay_at_stock(self):
        curve = build(60)["nvidia_gpu_vf_curve"]
        low = [p for p in POINTS if p["base_voltage"] <= TARGET_MV - spike.RAMP_MV]
        self.assertTrue(low)
        for point in low:
            self.assertNotIn(str(point["index"]), curve)

    def test_points_at_and_above_target_get_the_full_offset(self):
        curve = build(60)["nvidia_gpu_vf_curve"]
        for point in POINTS:
            if point["base_voltage"] >= nearest_target()["base_voltage"]:
                self.assertEqual(curve[str(point["index"])]["clockspeed_offset"], 60)

    def test_offsets_land_on_clock_bins(self):
        for entry in build(60)["nvidia_gpu_vf_curve"].values():
            self.assertEqual(entry["clockspeed_offset"] % spike.CLOCK_STEP_MHZ, 0)

    def test_curve_stays_monotonic_at_every_spike_offset(self):
        for offset in range(0, spike.MAX_SPIKE_OFFSET_MHZ + 1, spike.CLOCK_STEP_MHZ):
            self.assertTrue(spike.is_monotonic(POINTS, build(offset)), f"+{offset}")

    def test_monotonic_check_catches_a_step_down(self):
        # Offsetting only up to the target, as a naive builder would, must fail.
        config = build(120)
        for point in POINTS:
            if point["base_voltage"] > nearest_target()["base_voltage"]:
                config["nvidia_gpu_vf_curve"].pop(str(point["index"]), None)
        self.assertFalse(spike.is_monotonic(POINTS, config))

    def test_rejects_offsets_off_the_clock_grid(self):
        with self.assertRaises(ValueError):
            build(20)


if __name__ == "__main__":
    unittest.main()
