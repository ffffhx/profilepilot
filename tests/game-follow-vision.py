import base64
import importlib.util
import json
import pathlib
import sys
import unittest
sys.dont_write_bytecode = True

import cv2
import numpy as np

script = pathlib.Path(__file__).resolve().parents[1] / "public/vision/game_follower.py"
spec = importlib.util.spec_from_file_location("game_follower", script)
vision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vision)


def encoded(image):
    return base64.b64encode(cv2.imencode(".png", image)[1]).decode()


def fixture():
    rng = np.random.default_rng(7)
    own = rng.integers(40, 250, (18, 18, 3), dtype=np.uint8)
    target = rng.integers(20, 240, (18, 18, 3), dtype=np.uint8)
    frame = np.full((360, 640, 3), 25, np.uint8)
    frame[90:108, 45:63] = own
    frame[90:108, 155:173] = target
    config = dict(version=1, name="fixture", width=640, height=360,
                  map=dict(x=0, y=0, width=.3125, height=200/360), selfTemplate=encoded(own),
                  targetTemplate=encoded(target), selfRotates=False,
                  grid=dict(columns=40, rows=40, blocked=[y * 40 + 20 for y in range(6, 34)], clearance=1),
                  joystick=dict(x=.2, y=.8, radius=.07, rotation=0),
                  confidence=.9, stopDistance=.06, intervalMs=350)
    return config, frame, own, target


class VisionTests(unittest.TestCase):
    def test_pixels_are_detected_and_route_goes_around_wall(self):
        config, frame, _, _ = fixture()
        f = vision.Follower(config)
        self.assertEqual(f.analyze(encoded(frame), 10)["phase"], "confirming")
        found = f.analyze(encoded(frame), 10.4)
        self.assertEqual(found["phase"], "following")
        self.assertAlmostEqual(found["self"]["x"], 54/200)
        self.assertGreater(found["target"]["confidence"], .99)
        self.assertTrue(any(p["y"] < .13 or p["y"] > .87 for p in found["path"]))
        for p in found["path"]:
            self.assertTrue(f.walk[int(p["y"] * 40), int(p["x"] * 40)])

    def test_lost_duplicate_and_uniform_targets_never_move(self):
        config, frame, own, target = fixture()
        f = vision.Follower(config)
        f.analyze(encoded(frame), 10)
        frame[90:108, 155:173] = 25
        lost = f.analyze(encoded(frame), 10.4)
        self.assertEqual(lost["phase"], "lost")
        self.assertIsNone(lost["direction"])
        frame[90:108, 155:173] = target
        frame[40:58, 155:173] = target
        self.assertIsNone(vision.match(frame[:200, :200], target))
        self.assertIsNone(vision.match(frame[:200, :200], np.full_like(own, 50)))

    def test_no_path_and_diagonal_corner(self):
        walk = np.array([[1, 0], [0, 1]], bool)
        self.assertEqual(vision.route((0, 0), (1, 1), walk), [])
        config, frame, _, _ = fixture()
        config["grid"]["blocked"] = [y * 40 + 20 for y in range(40)]
        self.assertEqual(vision.Follower(config).analyze(encoded(frame), 10)["phase"], "no-path")

    def test_reacquisition_stuck_and_dimension_change(self):
        config, frame, _, _ = fixture()
        f = vision.Follower(config)
        results = [f.analyze(encoded(frame), 10 + i * .4) for i in range(11)]
        self.assertTrue(any(r["phase"] == "stuck" and r["direction"] is None for r in results))
        self.assertEqual(f.analyze(encoded(frame), 20)["phase"], "confirming")
        with self.assertRaisesRegex(ValueError, "分辨率"):
            f.analyze(encoded(frame[:200, :200]), 21)

    def test_slow_frames_confirm_but_a_long_gap_requires_reacquisition(self):
        config, frame, _, _ = fixture()
        f = vision.Follower(config, max_frame_gap=4)
        self.assertEqual(f.analyze(encoded(frame), 10)["phase"], "confirming")
        self.assertEqual(f.analyze(encoded(frame), 12.1)["phase"], "following")
        late = f.analyze(encoded(frame), 16.2)
        self.assertEqual(late["phase"], "confirming")
        self.assertIsNone(late["direction"])
        self.assertEqual(f.analyze(encoded(frame), 18.3)["phase"], "following")

    def test_stuck_detection_keeps_enough_history_at_low_frame_rates(self):
        config, frame, _, _ = fixture()
        f = vision.Follower(config, max_frame_gap=4)
        results = [f.analyze(encoded(frame), 10 + i * 2.1) for i in range(5)]
        self.assertEqual(results[1]["phase"], "following")
        self.assertEqual(results[-1]["phase"], "stuck")
        self.assertIsNone(results[-1]["direction"])

    def test_fast_frames_do_not_keep_old_movement_in_stuck_history(self):
        config, frame, own, _ = fixture()
        f = vision.Follower(config, max_frame_gap=4)
        for i in range(10):
            frame[90:108, 40:85] = 25
            x = 45 + i * 2
            frame[90:108, x:x+18] = own
            f.analyze(encoded(frame), 10 + i * .4)
        results = [f.analyze(encoded(frame), 14 + i * .4) for i in range(9)]
        self.assertTrue(any(r["phase"] == "stuck" and r["direction"] is None for r in results))

    def test_close_target_stops_after_confirmation(self):
        config, frame, _, target = fixture()
        frame[90:108, 155:173] = 25
        frame[90:108, 70:88] = target
        config["stopDistance"] = .2
        f = vision.Follower(config)
        f.analyze(encoded(frame), 10)
        result = f.analyze(encoded(frame), 10.4)
        self.assertEqual(result["phase"], "near")
        self.assertIsNone(result["direction"])

    def test_closed_loop_reaches_teammate_without_crossing_wall(self):
        config, _, own_icon, target_icon = fixture()
        config["stopDistance"] = .12  # Keep the 18 px icons apart on the 200 px map.
        follower = vision.Follower(config)
        position = np.array([.27, .495], dtype=float)
        target = np.array([.82, .495], dtype=float)
        travelled = []
        for tick in range(220):
            frame = np.full((360, 640, 3), 25, np.uint8)
            for point, icon in [(position, own_icon), (target, target_icon)]:
                x, y = np.rint(point * 200 - 9).astype(int)
                frame[y:y+18, x:x+18] = icon
            result = follower.analyze(encoded(frame), 10 + tick * .2)
            if result["phase"] == "near":
                break
            if result["direction"]:
                direction = result["direction"]
                delta = np.array([direction["x"], direction["y"]]) * .012
                for fraction in np.linspace(0, 1, 8):
                    x, y = ((position + delta * fraction) * 40).astype(int)
                    self.assertTrue(follower.walk[y, x], "movement must stay outside inflated walls")
                position += delta
                travelled.append(position.copy())
        self.assertEqual(result["phase"], "near", "the loop must reach the teammate, not oscillate")
        self.assertLess(np.linalg.norm(position - target), .15)
        self.assertTrue(any(p[1] < .13 or p[1] > .87 for p in travelled))


if __name__ == "__main__":
    if "--fixture" in sys.argv:
        config, frame, _, _ = fixture()
        print(json.dumps(dict(config=config, frame=dict(mime="image/png", base64=encoded(frame), width=640, height=360))))
    else:
        unittest.main()
