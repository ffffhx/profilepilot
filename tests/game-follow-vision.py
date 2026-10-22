import base64
import importlib.util
import io
import json
import math
import pathlib
import sys
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch
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


def label_fixture():
    config, frame, _, _ = fixture()
    rng = np.random.default_rng(42)
    labels = []
    for x, colour in [(260, (40, 220, 50)), (320, (240, 150, 40))]:
        name = np.zeros((14, 42, 3), np.uint8)
        name[rng.random((14, 42)) > .65] = 255
        labels.append(name)
        frame[190:204, x:x+42] = name
        frame[206:211, x-8:x+50] = colour
    config['nearby'] = dict(selfLabel=encoded(labels[0]), targetLabel=encoded(labels[1]),
                            region=dict(x=.35, y=.3, width=.55, height=.45), pixelsPerMapUnit=600)
    return config, frame


def marker_fixture():
    config, frame, own, _ = fixture()
    config['selfMarker'] = dict(hueMin=40, hueMax=85, saturationMin=90, valueMin=130, radiusPixels=12)
    cv2.circle(frame, (54, 99), 12, (40, 220, 50), 2)
    return config, frame, own


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

    def test_cropped_map_preserves_full_frame_tracking_navigation_and_marker(self):
        config, original, _ = marker_fixture()
        # Fractional map edges require the host's floor/ceil coverage, while
        # perception retains its existing round-based map coordinates.
        config['map'] = dict(x=73.25/640, y=51.25/360, width=200.4/640, height=200.4/360)
        region = dict(x=73, y=51, width=201, height=201)
        full, cropped = vision.Follower(config), vision.Follower(config)
        for tick in range(3):
            observed = original.copy()
            if tick == 2:
                observed[82:117, 36:76] = 25
                cv2.circle(observed, (58, 99), 12, (40, 220, 50), 2)
                observed[84:100, 58:74] = 25
            frame = np.full_like(original, 90)
            frame[51:251, 73:273] = observed[:200, :200]
            expected = full.analyze(encoded(frame), 10 + tick * .4)
            found = cropped.analyze(encoded(frame[51:252, 73:274]), 10 + tick * .4, region=region)
            expected.pop('elapsedMs'); found.pop('elapsedMs')
            self.assertEqual(found, expected)
        self.assertEqual(found['phase'], 'following')
        self.assertEqual(found['selfSource'], 'marker')
        self.assertIsNotNone(found['direction'])

    def test_cropped_map_rejects_malformed_out_of_bounds_and_incomplete_regions(self):
        config, frame, _, _ = fixture()
        crop = encoded(frame[:200, :200])
        valid = dict(x=0, y=0, width=200, height=200)
        invalid = [[], {}, {'x': 0}, {**valid, 'x': False}, {**valid, 'y': 0.0},
                   {**valid, 'width': '200'}, {**valid, 'height': float('inf')},
                   {**valid, 'x': -1}, {**valid, 'y': -1}, {**valid, 'width': 0},
                   {**valid, 'height': -1}, {**valid, 'x': 500}, {**valid, 'y': 300}]
        for region in invalid:
            with self.subTest(region=region), self.assertRaises(ValueError):
                vision.Follower(config).analyze(crop, 10, region=region)
        with self.assertRaisesRegex(ValueError, '尺寸与区域'):
            vision.Follower(config).analyze(crop, 10, region={**valid, 'width': 201})
        with self.assertRaisesRegex(ValueError, '完整小地图'):
            vision.Follower(config).analyze(encoded(frame[:200, 1:201]), 10, region={**valid, 'x': 1})
        # Even a crop containing the old rounded map must cover the fractional edge.
        config['map']['width'] = 200.4 / 640
        with self.assertRaisesRegex(ValueError, '完整小地图'):
            vision.Follower(config).analyze(crop, 10, region=valid)
        config['map']['width'] = 200 / 640
        config['map']['height'] = 200.4 / 360
        with self.assertRaisesRegex(ValueError, '完整小地图'):
            vision.Follower(config).analyze(crop, 10, region=valid)

    def test_cropped_frame_cannot_enable_nearby_label_analysis(self):
        config, frame = label_fixture()
        with self.assertRaisesRegex(ValueError, '姓名识别需要完整画面'):
            vision.Follower(config).analyze(encoded(frame[:200, :200]), 10,
                                            region=dict(x=0, y=0, width=200, height=200))
        self.assertEqual(vision.Follower(config).analyze(encoded(frame), 10)['phase'], 'confirming')

    def test_crop_coverage_includes_independently_rounded_map_edges(self):
        for axis, size, dimension in [('x', 'width', 640), ('y', 'height', 360)]:
            with self.subTest(axis=axis):
                config, frame, _, _ = fixture()
                config['map'][axis] = 1.5 / dimension
                config['map'][size] = 201.5 / dimension
                region = dict(x=0, y=0, width=200, height=200)
                region[axis], region[size] = 1, 202
                def crop():
                    return encoded(frame[region['y']:region['y']+region['height'],
                                         region['x']:region['x']+region['width']])
                # ceil(1.5 + 201.5) = 203, but round(1.5) + round(201.5) = 204.
                with self.assertRaisesRegex(ValueError, '完整小地图'):
                    vision.Follower(config).analyze(crop(), 10, region=region)
                region[size] += 1
                self.assertEqual(vision.Follower(config).analyze(crop(), 10, region=region)['phase'], 'confirming')

    def test_crop_coverage_clamps_floating_point_map_edges_to_screen(self):
        config, frame, _, _ = fixture()
        config['map'] = dict(x=0, y=0, width=1.0000000000000002, height=1.0000000000000002)
        config['grid']['blocked'] = []
        region = dict(x=0, y=0, width=640, height=360)
        full = vision.Follower(config).analyze(encoded(frame), 10)
        cropped = vision.Follower(config).analyze(encoded(frame), 10, region=region)
        full.pop('elapsedMs'); cropped.pop('elapsedMs')
        self.assertEqual(full, cropped)

    def test_json_line_worker_accepts_region_and_reports_invalid_crop(self):
        config, frame, _, _ = fixture()
        region = dict(x=0, y=0, width=200, height=200)
        requests = [dict(id=1, op='configure', config=config),
                    dict(id=2, op='analyze', base64=encoded(frame[:200, :200]), region=region),
                    dict(id=3, op='analyze', base64=encoded(frame[:199, :200]), region=region)]
        output = io.StringIO()
        with patch.object(sys, 'stdin', io.StringIO('\n'.join(json.dumps(r) for r in requests))), redirect_stdout(output):
            vision.main()
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([r['id'] for r in replies], [1, 2, 3])
        self.assertTrue(replies[1]['ok'])
        self.assertEqual(replies[1]['data']['phase'], 'confirming')
        self.assertFalse(replies[2]['ok'])
        self.assertIn('尺寸与区域', replies[2]['error'])

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

    def test_brief_occlusion_releases_then_reacquires_without_extra_idle_frame(self):
        config, frame, _, target = fixture()
        f = vision.Follower(config)
        f.analyze(encoded(frame), 10)
        self.assertEqual(f.analyze(encoded(frame), 10.4)['phase'], 'following')
        frame[90:108, 155:173] = 25
        self.assertIsNone(f.analyze(encoded(frame), 10.8)['direction'])
        frame[90:108, 155:173] = target
        self.assertEqual(f.analyze(encoded(frame), 11.2)['phase'], 'following')
        frame[90:108, 155:173] = 25
        self.assertIsNone(f.analyze(encoded(frame), 13)['direction'])
        frame[90:108, 155:173] = target
        self.assertEqual(f.analyze(encoded(frame), 13.4)['phase'], 'confirming')

    def test_tracker_uses_recent_identity_but_never_emits_a_missing_position(self):
        _, frame, _, target = fixture()
        tracker = vision.Tracker(target, False, .9, 1.5)
        first = tracker.locate(frame[:200, :200], 10)
        frame[10:28, 10:28] = target  # Identical distant icon cannot steal a recent track.
        second = tracker.locate(frame[:200, :200], 10.4)
        self.assertAlmostEqual(second['x'], first['x'])
        self.assertIsNone(tracker.locate(frame[:200, :200], 12), 'expired identity must face global ambiguity')
        frame[:] = 25
        found = tracker.locate(frame[:200, :200], 12.4)
        self.assertTrue(found is None or found['confidence'] < .9)

    def test_lookahead_keeps_straight_motion_smooth_and_cannot_cut_a_corner(self):
        walk = np.ones((40, 40), bool)
        own = {'x': .272, 'y': .49}
        points = [{'x': (x+.5)/40, 'y': .4875} for x in range(10, 21)]
        aim = vision.steering(own, points, walk)
        self.assertGreater(aim['x'], points[1]['x'])
        self.assertLess(abs(math.atan2(aim['y']-own['y'], aim['x']-own['x'])), .06)
        corner = np.array([[1, 0], [0, 1]], bool)
        self.assertFalse(vision.visible({'x': .25, 'y': .25}, {'x': .75, 'y': .75}, corner))

    def test_near_distance_has_a_small_hysteresis_band(self):
        config, frame, _, target = fixture()
        config['grid']['blocked'] = []; config['stopDistance'] = .2
        frame[90:108, 155:173] = 25
        frame[90:108, 80:98] = target
        f = vision.Follower(config)
        f.analyze(encoded(frame), 10)
        self.assertEqual(f.analyze(encoded(frame), 10.4)['phase'], 'near')
        frame[90:108, 80:98] = 25; frame[90:108, 88:106] = target
        self.assertEqual(f.analyze(encoded(frame), 10.8)['phase'], 'near')
        frame[90:108, 88:106] = 25; frame[90:108, 99:117] = target
        self.assertEqual(f.analyze(encoded(frame), 11.2)['phase'], 'following')

    def test_visible_names_recover_an_occluded_map_icon_without_bypassing_walls(self):
        config, frame = label_fixture()
        frame[90:108, 155:173] = 25  # Target hidden on minimap; self remains current.
        f = vision.Follower(config)
        self.assertEqual(f.analyze(encoded(frame), 10)['phase'], 'confirming')
        result = f.analyze(encoded(frame), 10.4)
        self.assertEqual(result['source'], 'labels')
        self.assertEqual(result['phase'], 'following')
        self.assertAlmostEqual(result['target']['x']-result['self']['x'], .1)
        config['grid']['blocked'] = [y*40+13 for y in range(40)]
        config['grid']['clearance'] = 0
        self.assertEqual(vision.Follower(config).analyze(encoded(frame), 10)['phase'], 'no-path')

    def test_chat_names_or_dead_heroes_never_replace_a_map_observation(self):
        config, frame = label_fixture()
        frame[90:108, 155:173] = 25
        frame[206:211, 312:370] = 25  # No ally health bar under the matching name.
        result = vision.Follower(config).analyze(encoded(frame), 10)
        self.assertEqual(result['phase'], 'lost')
        self.assertIsNone(result['direction'])

    def test_without_any_map_anchor_labels_only_establish_nearness(self):
        config, frame = label_fixture()
        frame[90:108, 45:63] = 25; frame[90:108, 155:173] = 25
        result = vision.Follower(config).analyze(encoded(frame), 10)
        self.assertEqual(result['phase'], 'lost')
        self.assertIsNone(result['direction'])
        config['stopDistance'] = .12
        result = vision.Follower(config).analyze(encoded(frame), 10)
        self.assertEqual(result['phase'], 'near')
        self.assertEqual(result['source'], 'labels')
        self.assertIsNone(result['direction'])

    def test_self_marker_measures_current_motion_through_partial_avatar_occlusion(self):
        config, frame, _ = marker_fixture()
        f = vision.Follower(config)
        f.analyze(encoded(frame), 10)
        self.assertEqual(f.analyze(encoded(frame), 10.4)['phase'], 'following')
        frame[82:117, 36:76] = 25
        cv2.circle(frame, (58, 99), 12, (40, 220, 50), 2)
        # One quadrant of the coloured ring and the entire portrait are hidden.
        frame[84:100, 58:74] = 25
        result = f.analyze(encoded(frame), 10.8)
        self.assertEqual(result['selfSource'], 'marker')
        self.assertEqual(result['phase'], 'following')
        self.assertGreater(result['self']['x'], .28, 'must measure the new ring, not emit the last avatar point')
        self.assertLess(abs(result['self']['x']-.29), .012)
        frame[82:117, 36:76] = 25
        result = f.analyze(encoded(frame), 11.2)
        self.assertEqual(result['phase'], 'lost')
        self.assertIsNone(result['direction'])

    def test_self_marker_cannot_initialize_identity_or_reacquire_after_a_gap(self):
        config, frame, _ = marker_fixture()
        f = vision.Follower(config)
        f.analyze(encoded(frame), 10)
        frame[90:108, 45:63] = 25
        self.assertEqual(f.analyze(encoded(frame), 10.4)['selfSource'], 'marker')
        self.assertEqual(f.analyze(encoded(frame), 12)['phase'], 'lost')
        self.assertEqual(vision.Follower(config).analyze(encoded(frame), 12)['phase'], 'lost')
        without_marker = {key: value for key, value in config.items() if key != 'selfMarker'}
        self.assertEqual(vision.Follower(without_marker).analyze(encoded(frame), 12)['phase'], 'lost')

    def test_self_marker_rejects_ambiguous_rings_and_unrelated_green_ui(self):
        config, original, _ = marker_fixture()
        def prepared():
            f = vision.Follower(config)
            f.analyze(encoded(original), 10)
            frame = original.copy(); frame[65:135, 15:95] = 25
            return f, frame
        f, frame = prepared()
        for center in [(40, 99), (69, 99)]:
            cv2.circle(frame, center, 12, (40, 220, 50), 2)
        result = f.analyze(encoded(frame), 10.4)
        self.assertEqual(result['phase'], 'lost')
        self.assertIsNone(result['direction'])
        for kind in ('disk', 'square', 'rectangle', 'ellipse', 'line', 'short_arc', 'wrong_radius', 'wrong_colour', 'distant'):
            with self.subTest(kind=kind):
                f, frame = prepared(); green = (40, 220, 50)
                if kind == 'disk': cv2.circle(frame, (54, 99), 12, green, -1)
                if kind == 'square': cv2.rectangle(frame, (42, 87), (66, 111), green, 2)
                if kind == 'rectangle': cv2.rectangle(frame, (39, 90), (69, 108), green, 2)
                if kind == 'ellipse': cv2.ellipse(frame, (54, 99), (16, 9), 0, 0, 360, green, 2)
                if kind == 'line': cv2.line(frame, (42, 87), (66, 111), green, 3)
                if kind == 'short_arc': cv2.ellipse(frame, (54, 99), (12, 12), 0, 0, 100, green, 2)
                if kind == 'wrong_radius': cv2.circle(frame, (54, 99), 22, green, 2)
                if kind == 'wrong_colour': cv2.circle(frame, (54, 99), 12, (240, 150, 40), 2)
                if kind == 'distant': cv2.circle(frame, (120, 40), 12, green, 2)
                result = f.analyze(encoded(frame), 10.4)
                self.assertEqual(result['phase'], 'lost')
                self.assertIsNone(result['direction'])

    def test_self_marker_does_not_substitute_for_the_target(self):
        config, frame, _ = marker_fixture()
        f = vision.Follower(config)
        f.analyze(encoded(frame), 10)
        frame[90:108, 45:63] = 25; frame[90:108, 155:173] = 25
        result = f.analyze(encoded(frame), 10.4)
        self.assertEqual(result['selfSource'], 'marker')
        self.assertEqual(result['phase'], 'lost')
        self.assertIsNone(result['direction'])

    def test_self_marker_can_continue_only_while_each_position_is_currently_visible(self):
        config, original, _ = marker_fixture()
        f = vision.Follower(config)
        f.analyze(encoded(original), 10)
        for i in range(1, 9):
            frame = original.copy(); frame[80:120, 35:90] = 25
            cv2.circle(frame, (54+i*2, 99), 12, (40, 220, 50), 2)
            result = f.analyze(encoded(frame), 10+i*.4)
            self.assertEqual(result['selfSource'], 'marker')
            self.assertLess(abs(result['self']['x']-(54+i*2)/200), .012)
        frame[80:120, 35:90] = 25
        result = f.analyze(encoded(frame), 13.6)
        self.assertEqual(result['phase'], 'lost')
        self.assertIsNone(result['direction'])

    def test_a_new_avatar_observation_that_disagrees_with_the_marker_revokes_it(self):
        config, frame, own = marker_fixture()
        f = vision.Follower(config)
        f.analyze(encoded(frame), 10)
        frame[90:108, 45:63] = 25
        frame[150:168, 100:118] = own
        observed = f.analyze(encoded(frame), 10.4)
        self.assertEqual(observed['selfSource'], 'template')
        self.assertGreater(observed['self']['x'], .5)
        frame[150:168, 100:118] = 25
        result = f.analyze(encoded(frame), 10.8)
        self.assertEqual(result['phase'], 'lost', 'the old visible ring cannot revive a displaced avatar identity')
        self.assertIsNone(result['direction'])

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
