"""Synthetic frozen viewport contracts; private real-image replay is separate."""
import copy
import importlib.util
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
import cv2
import numpy as np

source = pathlib.Path(__file__).resolve().parents[1]/"public/vision/game_follow_viewport.py"
spec = importlib.util.spec_from_file_location("game_follow_viewport", source)
viewport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(viewport)


def config():
    return {"width": 2772, "height": 1240,
            "map": {"x": 120/2772, "y": 0, "width": 425/2772, "height": 425/1240},
            "cameraViewportGuard": {"version": 1, "referenceWidth": 2772, "referenceHeight": 1240}}


def blank():
    return np.zeros((1240, 2772, 3), np.uint8)


def context(x=300, y=200):
    return {"point": {"x": x, "y": y}, "epoch": 1, "sequence": 2}


def rect(image, x=300, y=200, color=(255, 255, 255)):
    cv2.rectangle(image, (x-56, y-31), (x+56, y+31), color, 2)
    return image


class ViewportTests(unittest.TestCase):
    def setUp(self):
        self.guard = viewport.CameraViewportGuard(config())

    def test_current_white_and_red_each_need_four_edges(self):
        for name, color in (("white", (255, 255, 255)), ("alertRed", (0, 0, 240))):
            with self.subTest(color=name):
                found = self.guard.check(rect(blank(), color=color), context())
                self.assertTrue(found["accepted"])
                self.assertEqual(found["observedBox"]["color"], name)
                self.assertEqual(found["centerDistanceMapPx"], 0)
                self.assertGreater(found["colorEvidence"]["candidateCounts"][name], 0)
                self.assertEqual(set(found), {"accepted", "reason", "observedBox", "centerDistanceMapPx", "colorEvidence"})
                image = rect(blank(), color=color)
                image[165:174, 235:365] = 0
                self.assertFalse(self.guard.check(image, context())["accepted"])

    def test_five_pixel_limit_preserves_point_and_has_no_fallback(self):
        image, current = rect(blank()), context(305)
        before = copy.deepcopy(current)
        self.assertTrue(self.guard.check(image, current)["accepted"])
        self.assertEqual(current, before)
        rejected = self.guard.check(image, context(306))
        self.assertFalse(rejected["accepted"])
        self.assertEqual(rejected["reason"], "current-box-point-mismatch")
        self.assertEqual(rejected["centerDistanceMapPx"], 6)
        self.assertNotIn("point", rejected)
        self.assertTrue(self.guard.check(image, context(303, 204))["accepted"])
        self.assertFalse(self.guard.check(image, context(304, 204))["accepted"])

    def test_absent_box_and_current_context_are_not_inferred(self):
        self.assertFalse(self.guard.check(blank(), context())["accepted"])
        self.assertTrue(self.guard.check(rect(blank()), context())["accepted"])
        self.assertFalse(self.guard.check(blank(), context())["accepted"])
        with patch.object(self.guard, "_detect", side_effect=AssertionError("context required")):
            for current in (None, {}, [], {"point": []}):
                found = self.guard.check(rect(blank()), current)
                self.assertFalse(found["accepted"])
                self.assertIsNone(found["colorEvidence"])

    def test_context_requires_native_integer_point_and_safe_epoch_sequence(self):
        invalid = [context(300.5), context(True), context(119), context(545), context(300, -1), context(300, 425)]
        for key, values in (("epoch", (-1, 2**53, True, 1.0)), ("sequence", (0, 2**53, False, 1.0))):
            for value in values:
                current = context()
                current[key] = value
                invalid.append(current)
        for current in invalid:
            with self.subTest(context=current):
                self.assertEqual(self.guard.check(rect(blank()), current)["reason"], "current-camera-context-invalid")
        valid = context()
        valid.update(epoch=0, sequence=2**53-1)
        self.assertTrue(self.guard.check(rect(blank()), valid)["accepted"])

    def test_red_circles_and_three_edges_cannot_substitute_for_rectangle(self):
        image = blank()
        for x, y in ((270, 170), (330, 170), (270, 230), (330, 230)):
            cv2.circle(image, (x, y), 24, (0, 0, 255), 2)
        self.assertFalse(self.guard.check(image, context())["accepted"])
        image = blank()
        cv2.circle(image, (300, 200), 100, (0, 0, 255), 4)
        self.assertFalse(self.guard.check(image, context())["accepted"])

    def test_colors_never_join_four_partial_edges(self):
        image = blank()
        for y in (169, 231):
            cv2.line(image, (244, y), (356, y), (255, 255, 255), 2)
        for x in (244, 356):
            cv2.line(image, (x, 169), (x, 231), (0, 0, 240), 2)
        self.assertFalse(self.guard.check(image, context())["accepted"])

    def test_same_color_and_cross_color_rivals_compete_before_point_distance(self):
        for color in ((255, 255, 255), (0, 0, 240)):
            image = rect(blank(), x=220, y=120)
            rect(image, x=420, y=300, color=color)
            found = self.guard.check(image, context(220, 120))
            self.assertFalse(found["accepted"])
            self.assertEqual(found["reason"], "current-four-edge-box-ambiguous")
            self.assertIsNone(found["observedBox"])
            self.assertIsNone(found["centerDistanceMapPx"])

    def test_blue_green_yellow_and_dim_white_are_not_viewport_colors(self):
        for color in ((240, 0, 0), (0, 240, 0), (0, 240, 240), (214, 214, 214), (0, 0, 169)):
            with self.subTest(color=color):
                self.assertFalse(self.guard.check(rect(blank(), color=color), context())["accepted"])

    def test_calibration_is_explicit_versioned_closed_and_never_mutated(self):
        for calibration in (None, False, True, {}, {"version": 1}, {**config()["cameraViewportGuard"], "maxCenterDistance": 50}):
            current = config()
            current["cameraViewportGuard"] = calibration
            with self.assertRaises(ValueError):
                viewport.CameraViewportGuard(current)
        current = config()
        del current["cameraViewportGuard"]
        with self.assertRaises(ValueError):
            viewport.CameraViewportGuard(current)
        for key in ("version", "referenceWidth", "referenceHeight"):
            for value in (True, 1.0, "1", -1, 2, None):
                current = config()
                current["cameraViewportGuard"][key] = value
                with self.assertRaises(ValueError):
                    viewport.CameraViewportGuard(current)
        current = config()
        guard = viewport.CameraViewportGuard(current)
        current["map"]["x"] = 0
        current["cameraViewportGuard"]["maxCenterDistance"] = 100
        self.assertFalse(guard.check(rect(blank()), context(310))["accepted"])

    def test_only_calibrated_native_map_with_tiny_float_roundoff_is_supported(self):
        for key in ("width", "height"):
            for value in (True, float(config()[key]), config()[key]+1, 0):
                current = config()
                current[key] = value
                with self.assertRaises(ValueError):
                    viewport.CameraViewportGuard(current)
        for key, scale in (("x", 2772), ("y", 1240), ("width", 2772), ("height", 1240)):
            current = config()
            current["map"][key] += 5e-7/scale
            viewport.CameraViewportGuard(current)
            current["map"][key] += 2e-6/scale
            with self.assertRaises(ValueError):
                viewport.CameraViewportGuard(current)
        for value in (None, {}, {**config()["map"], "extra": 1}, {**config()["map"], "width": 0}):
            current = config()
            current["map"] = value
            with self.assertRaises(ValueError):
                viewport.CameraViewportGuard(current)
        for value in (True, "0", float("nan"), float("inf"), 10**10000):
            current = config()
            current["map"]["x"] = value
            with self.assertRaises(ValueError):
                viewport.CameraViewportGuard(current)

    def test_image_type_dimensions_and_channels_are_checked_even_without_context(self):
        for image in (None, [], np.zeros((100, 100, 3), np.uint8), np.zeros((1240, 2772, 4), np.uint8),
                      np.zeros((1240, 2772), np.uint8), np.zeros((1240, 2772, 3), np.float32)):
            for current in (None, context()):
                with self.assertRaises(ValueError):
                    self.guard.check(image, current)

    def test_dense_crosshatch_rejects_without_selecting_truncated_candidates(self):
        image = blank()
        image[:425:2, 120:545] = 255
        image[:425, 120:545:2] = 255
        found = self.guard.check(image, context())
        self.assertFalse(found["accepted"])
        self.assertEqual(found["reason"], "current-four-edge-box-unverifiable")
        self.assertIsNone(found["observedBox"])
        self.assertIsNone(found["colorEvidence"])


if __name__ == "__main__":
    cv2.setNumThreads(1)
    unittest.main()
