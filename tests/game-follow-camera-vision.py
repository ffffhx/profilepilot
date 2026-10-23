"""Synthetic camera-anchor contracts; no phone images or hardware acceptance."""
import base64
import copy
import importlib.util
import pathlib
import struct
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
import cv2
import numpy as np

path = pathlib.Path(__file__).resolve().parents[1]/"public/vision/game_follow_camera.py"
spec = importlib.util.spec_from_file_location("game_follow_camera", path)
camera = importlib.util.module_from_spec(spec)
spec.loader.exec_module(camera)
worker_spec = importlib.util.spec_from_file_location("game_follower", path.with_name("game_follower.py"))
worker = importlib.util.module_from_spec(worker_spec)
worker_spec.loader.exec_module(worker)
cv2.setNumThreads(2)


def encoded(image):
    return base64.b64encode(cv2.imencode(".png", image)[1]).decode()


def fixture(shift_x=0, shift_y=0, gray_template=False, team="blue", assist_key="cameraAssist", seed=17):
    rng = np.random.default_rng(seed)
    name = np.zeros((20, 120, 3), np.uint8)
    name[rng.random((20, 120)) > .6] = 235
    hp = np.full((24, 220, 3), 30, np.uint8)
    hp[0, :] = hp[-1, :] = 0
    hp[:, 0] = hp[:, -1] = 0
    hp[4:-4, 5:-5] = (35, 220, 45) if team == "green" else (235, 150, 35)
    image = np.full((500, 900, 3), 80, np.uint8)
    nx, ny, bx, by = 500+shift_x, 200+shift_y, 390+shift_x, 230+shift_y
    image[ny-10:ny+10, nx-60:nx+60] = name
    image[by:by+24, bx:bx+220] = hp
    template = cv2.cvtColor(hp, cv2.COLOR_BGR2GRAY) if gray_template else hp
    config = dict(width=900, height=500, map=dict(x=0, y=0, width=200/900, height=.4), cameraAssist=dict(
        referenceWidth=900, referenceHeight=500, targetLabel=encoded(name), healthBarTemplate=encoded(template),
        healthBar=dict(width=220, height=24, offsetX=-110, offsetY=30),
        region=dict(x=.25, y=.15, width=.75, height=.8),
        anchorBounds=dict(x=300, y=120, width=400, height=240),
        matrix=[[.05, 0], [0, .05], [-25, -10]]))
    if team != "blue":
        config["cameraAssist"]["team"] = team
    if assist_key != "cameraAssist":
        config[assist_key] = config.pop("cameraAssist")
    return config, image, (bx, by, 220, 24), name


def context(x=100, y=100):
    return dict(point=dict(x=x, y=y), epoch=0, sequence=1)


def following_own_fixture():
    config, image, hp, _ = fixture(team="green", assist_key="selfCameraAssist")
    rng = np.random.default_rng(821)
    own = rng.integers(20, 240, (18, 18, 3), dtype=np.uint8)
    target = rng.integers(20, 240, (18, 18, 3), dtype=np.uint8)
    image[90:108, 155:173] = target
    # A realistic high but non-perfect name score deliberately differs from the
    # configured avatar threshold. Its own fixed name/HP gates must decide it.
    patch_name = image[190:210, 440:560].astype(float)
    image[190:210, 440:560] = np.clip(patch_name+rng.normal(0, 43, patch_name.shape), 0, 255).astype(np.uint8)
    config['selfCameraAssist']['matrix'] = [[.05, 0], [0, .05], [-71, -11]]
    config.update(version=1, name="self camera fixture", selfTemplate=encoded(own), targetTemplate=encoded(target),
        selfRotates=False, confidence=.99, stopDistance=.06, intervalMs=350,
        grid=dict(columns=40, rows=40, blocked=[], clearance=0),
        joystick=dict(x=.2, y=.8, radius=.07, rotation=0))
    return config, image, hp, own


class CameraTests(unittest.TestCase):
    def test_follower_viewport_guard_blocks_only_camera_coordinates_and_preserves_full_portraits(self):
        config, small, _, own = following_own_fixture()
        image = np.full((1240, 2772, 3), 80, np.uint8)
        image[:500, :900] = small
        config.update(width=2772, height=1240,
                      map=dict(x=120/2772, y=0, width=425/2772, height=425/1240),
                      cameraViewportGuard=dict(version=1, referenceWidth=2772, referenceHeight=1240))
        assist = config['selfCameraAssist']
        assist.update(referenceWidth=2772, referenceHeight=1240,
                      region=dict(x=225/2772, y=75/1240, width=675/2772, height=400/1240))
        good = image.copy()
        cv2.rectangle(good, (244, 169), (356, 231), (255, 255, 255), 2)
        shifted = image.copy()
        cv2.rectangle(shifted, (264, 169), (376, 231), (255, 255, 255), 2)
        for frame, accepted in [(good, True), (image, False), (shifted, False)]:
            with self.subTest(accepted=accepted, shifted=frame is shifted):
                follower = worker.Follower(copy.deepcopy(config))
                with patch.object(follower.self_camera, 'locate', wraps=follower.self_camera.locate) as locate:
                    result = follower.analyze(encoded(frame), 10, cameraContext=context(300, 200))
                    self.assertEqual(result['cameraViewport']['accepted'], accepted)
                    self.assertEqual(result['selfSource'] == 'camera', accepted)
                    self.assertEqual(locate.call_count, int(accepted))
                self.assertIsNone(follower.trackers[0].last, 'camera coordinates never teach full identity history')
        # Missing viewport must not discard current independent full identity.
        image[310:328, 380:398] = own
        follower = worker.Follower(config)
        follower.analyze(encoded(image), 10, cameraContext=context(300, 200))
        result = follower.analyze(encoded(image), 10.4, cameraContext=context(300, 200))
        self.assertFalse(result['cameraViewport']['accepted'])
        self.assertEqual(result['selfSource'], 'template')
        self.assertEqual(result['targetSource'], 'template')
        self.assertEqual(result['phase'], 'following')
        self.assertIsNotNone(result['direction'])

    def test_follower_current_self_camera_can_follow_without_teaching_avatar_history(self):
        config, image, _, _ = following_own_fixture()
        follower = worker.Follower(config)
        first = follower.analyze(encoded(image), 10, cameraContext=context())
        self.assertEqual(first['phase'], 'confirming')
        second = follower.analyze(encoded(image), 10.4, cameraContext=context())
        self.assertEqual(second['selfSource'], 'camera')
        self.assertEqual(second['targetSource'], 'template')
        self.assertEqual(second['phase'], 'following')
        self.assertGreater(second['self']['confidence'], .9)
        self.assertLess(second['self']['confidence'], config['confidence'])
        self.assertAlmostEqual(second['self']['x'], 54/200)
        self.assertAlmostEqual(second['self']['y'], 99/200)
        self.assertIsNone(follower.trackers[0].last)

    def test_follower_self_camera_needs_current_identity_context_and_target_after_gap(self):
        config, image, (x, y, w, h), _ = following_own_fixture()
        follower = worker.Follower(config)
        follower.analyze(encoded(image), 10, cameraContext=context())
        follower.analyze(encoded(image), 10.4, cameraContext=context())
        no_context = follower.analyze(encoded(image), 10.8)
        self.assertEqual(no_context['phase'], 'lost')
        self.assertEqual(no_context['selfSource'], 'template')
        self.assertIsNone(no_context['direction'])
        missing = image.copy(); missing[y:y+h, x:x+w] = 80
        no_hp = follower.analyze(encoded(missing), 11.2, cameraContext=context())
        self.assertEqual(no_hp['phase'], 'lost')
        self.assertNotEqual(no_hp['selfSource'], 'camera')
        restored = follower.analyze(encoded(image), 20, cameraContext=context())
        self.assertEqual(restored['phase'], 'confirming')
        no_target = image.copy(); no_target[90:108, 155:173] = 80
        stopped = follower.analyze(encoded(no_target), 20.4, cameraContext=context())
        self.assertEqual(stopped['selfSource'], 'camera')
        self.assertEqual(stopped['phase'], 'lost')
        self.assertIsNone(stopped['direction'])

    def test_follower_full_self_has_precedence_and_self_camera_requires_full_frame(self):
        config, image, _, own = following_own_fixture()
        image[30:48, 30:48] = own
        found = worker.Follower(config).analyze(encoded(image), 10, cameraContext=context())
        self.assertEqual(found['selfSource'], 'template')
        self.assertAlmostEqual(found['self']['x'], 39/200)
        with self.assertRaisesRegex(ValueError, '完整画面'):
            worker.Follower(config).analyze(encoded(image[:200, :200]), 10,
                region=dict(x=0, y=0, width=200, height=200), cameraContext=context())

    def test_current_own_green_hp_uses_separate_profile_and_same_native_context(self):
        config, image, _, _ = fixture(40, 20, team="green", assist_key="selfCameraAssist")
        locator = camera.CameraLocator(config, "selfCameraAssist")
        found = locator.locate(image, context())
        self.assertIsNotNone(found)
        self.assertAlmostEqual(found["x"], 102)
        self.assertAlmostEqual(found["y"], 101)
        self.assertEqual(found["camera"], context())
        self.assertIsNone(locator.locate(image, None))
        with self.assertRaises(ValueError):
            camera.CameraLocator(config)

    def test_own_team_cannot_silently_fall_back_to_blue_or_unknown_profile(self):
        base, _, _, _ = fixture(team="green", assist_key="selfCameraAssist")
        for team in (None, "blue", "red", True, [], {}):
            with self.subTest(team=team):
                cfg = copy.deepcopy(base)
                cfg["selfCameraAssist"]["team"] = team
                with self.assertRaises(ValueError):
                    camera.CameraLocator(cfg, "selfCameraAssist")
        del base["selfCameraAssist"]["team"]
        with self.assertRaises(ValueError):
            camera.CameraLocator(base, "selfCameraAssist")
        with self.assertRaises(ValueError):
            camera.CameraLocator(base, "unknown")

    def test_own_green_requires_complete_unique_current_bar(self):
        config, image, (x, y, w, h), name = fixture(team="green", assist_key="selfCameraAssist")
        locator = camera.CameraLocator(config, "selfCameraAssist")
        self.assertIsNotNone(locator.locate(image, context()))
        variants = {}
        for key, colour in (("blue", (235, 150, 35)), ("red", (20, 25, 235))):
            a = image.copy(); a[y+4:y+h-4, x+5:x+w-5] = colour; variants[key] = a
        a = image.copy(); a[y-1:y+h+1, x+w-7:x+w+2] = 180; variants["right-occluded"] = a
        a = image.copy(); a[y+3:y+h-3, x+55:x+80] = 240; variants["white-overlay"] = a
        a = image.copy(); a[y:y+h, x:x+w] = 80; variants["missing-current-hp"] = a
        a = image.copy(); a[400:420, 730:850] = name; variants["global-name-competitor"] = a
        for key, current in variants.items():
            with self.subTest(variant=key):
                self.assertIsNone(locator.locate(current, context()))

    def test_own_and_target_profiles_do_not_leak_identity_or_projection(self):
        config, image, _, _ = fixture()
        own_config, own_image, (x, y, w, h), own_name = fixture(-90, 100, team="green", assist_key="selfCameraAssist", seed=29)
        own_config["selfCameraAssist"]["matrix"] = [[.05, 0], [0, .05], [-30, -12]]
        config["selfCameraAssist"] = own_config["selfCameraAssist"]
        image[290:310, 350:470] = own_name
        image[y:y+h, x:x+w] = own_image[y:y+h, x:x+w]
        target = camera.CameraLocator(config)
        own = camera.CameraLocator(config, "selfCameraAssist")
        target_found, own_found = target.locate(image, context()), own.locate(image, context())
        self.assertIsNotNone(target_found)
        self.assertIsNotNone(own_found)
        self.assertEqual((target_found["x"], target_found["y"]), (100, 100))
        self.assertEqual((own_found["x"], own_found["y"]), (90.5, 103))
        image[290:310, 350:470] = 80
        self.assertIsNone(own.locate(image, context()))
        target_after = target.locate(image, context())
        self.assertIsNotNone(target_after)
        self.assertEqual((target_after["x"], target_after["y"]), (target_found["x"], target_found["y"]))
        self.assertAlmostEqual(target_after["confidence"], target_found["confidence"], places=6)

    def test_current_name_complete_blue_bar_and_native_projection(self):
        for gray in (False, True):
            config, image, _, _ = fixture(40, 20, gray)
            found = camera.CameraLocator(config).locate(image, context())
            self.assertIsNotNone(found)
            self.assertAlmostEqual(found["x"], 102)
            self.assertAlmostEqual(found["y"], 101)
            self.assertEqual(found["name"]["x"], 540)
            self.assertEqual(found["hp"]["left"], 430)
            self.assertGreater(found["name"]["margin"], .12)
            self.assertEqual(found["camera"], context())

    def test_health_loss_keeps_anchor_but_extremely_low_or_empty_health_is_rejected(self):
        config, image, (x, y, w, h), _ = fixture()
        locator = camera.CameraLocator(config)
        initial = locator.locate(image, context())
        for ratio in (.75, .5, .25, .15, .05, 0):
            with self.subTest(ratio=ratio):
                current = image.copy()
                cut = x+5+round((w-10)*ratio)
                current[y+1:y+h-1, cut:x+w-3] = 25
                found = locator.locate(current, context())
                if ratio >= .15:
                    self.assertIsNotNone(found)
                    self.assertEqual((found["hp"]["x"], found["hp"]["y"]), (initial["hp"]["x"], initial["hp"]["y"]))
                    self.assertEqual(found["relativeMapPixels"], initial["relativeMapPixels"])
                else:
                    self.assertIsNone(found)

    def test_missing_foreign_and_partial_hp_frames_are_rejected(self):
        config, image, (x, y, w, h), _ = fixture()
        locator = camera.CameraLocator(config)
        variants = {}
        a = image.copy(); a[y-2:y+h+2, x-2:x+w+3] = 25; variants["missing"] = a
        a = image.copy(); a[y+4:y+h-4, x+5:x+w-5] = (20, 25, 235); variants["red"] = a
        a = image.copy(); a[y+4:y+h-4, x+5:x+w-5] = (20, 220, 35); variants["green"] = a
        a = image.copy(); a[y-1:y+h+1, x-1:x+8] = 180; variants["left-occluded"] = a
        a = image.copy(); a[y-1:y+h+1, x+w-7:x+w+2] = 180; variants["right-occluded"] = a
        a = image.copy(); a[y-1:y+3, x+90:x+115] = 240; variants["top-occluded"] = a
        a = image.copy(); a[y+2:y+h-2, x+55:x+80] = 25; variants["internal-gap"] = a
        a = image.copy(); a[y+3:y+h-3, x+55:x+80] = 240; variants["white-overlay"] = a
        a = image.copy(); a[y+3:y+h-3, x+55:x+80] = (220, 30, 220); variants["foreign-overlay"] = a
        for name, current in variants.items():
            with self.subTest(variant=name):
                self.assertIsNone(locator.locate(current, context()))

    def test_nearby_second_complete_bar_is_a_competitor(self):
        config, image, (x, y, w, h), _ = fixture()
        patch_hp = image[y-3:y+h+4, x-4:x+w+5].copy()
        image[y+29:y+29+patch_hp.shape[0], x-4:x+w+5] = patch_hp
        self.assertIsNone(camera.CameraLocator(config).locate(image, context()))

    def test_single_short_right_edge_raster_outlier_preserves_full_hp_evidence(self):
        for team in ("blue", "green"):
            with self.subTest(team=team):
                key = "cameraAssist" if team == "blue" else "selfCameraAssist"
                config, image, (x, y, w, h), _ = fixture(team=team, assist_key=key)
                locator = camera.CameraLocator(config, key)
                image[y+3, x+w-1] = 38  # One dark raster pixel just beyond <=35.
                found = locator.locate(image, context())
                self.assertIsNotNone(found)
                evidence = camera._frame_evidence(image, x, y, w, h, locator.hp_template, team)
                self.assertEqual(evidence["edgeCoverage"]["right"], .95)
                self.assertLess(evidence["edgeRmse"]["rightEndpoint"], 18)
                self.assertEqual((found["hp"]["left"], found["hp"]["top"]), (x, y))
                candidates = camera._frame_candidates(image[y-4:y+h+5, x-4:x+w+5], locator.hp_template, team)
                self.assertIn((4, 4), {(xx, yy) for xx, yy, _ in candidates})

    def test_right_edge_exception_cannot_hide_two_pixels_or_bright_occlusion(self):
        for team in ("blue", "green"):
            key = "cameraAssist" if team == "blue" else "selfCameraAssist"
            config, image, (x, y, w, h), _ = fixture(team=team, assist_key=key)
            locator = camera.CameraLocator(config, key)
            for offsets, value in (((3, 4), 38), ((3, 13), 38), ((3,), 255)):
                with self.subTest(team=team, offsets=offsets, value=value):
                    current = image.copy()
                    for offset in offsets:
                        current[y+offset, x+w-1] = value
                    self.assertIsNone(camera._frame_evidence(current, x, y, w, h, locator.hp_template, team))
                    self.assertIsNone(locator.locate(current, context()))

    def test_right_edge_exception_keeps_top_bottom_and_exterior_contrast_gates(self):
        config, image, (x, y, w, h), _ = fixture()
        locator = camera.CameraLocator(config)
        image[y+3, x+w-1] = 38
        for edge in ("top", "bottom", "contrast"):
            with self.subTest(edge=edge):
                current = image.copy()
                if edge == "contrast":
                    current[y+2:y+h-2, x+w:x+w+4] = 5
                else:
                    yy = y if edge == "top" else y+h-1
                    # Nine separate outliers exceed 4%, with no long run and
                    # RMSE still <=18. The right-only exception must not apply.
                    current[yy, x+10:x+190:20] = 86
                self.assertIsNone(camera._frame_evidence(current, x, y, w, h, locator.hp_template))
                self.assertIsNone(locator.locate(current, context()))

    def test_name_global_competitor_is_not_hidden_by_anchor_bounds(self):
        config, image, _, name = fixture()
        image[400:420, 730:850] = name  # Outside accepted anchorBounds, inside name search region.
        self.assertIsNone(camera.CameraLocator(config).locate(image, context()))

    def test_visible_name_requires_current_hp_and_current_context_every_call(self):
        config, image, (x, y, w, h), _ = fixture()
        locator = camera.CameraLocator(config)
        self.assertIsNotNone(locator.locate(image, context()))
        self.assertIsNone(locator.locate(image, None))
        image[y:y+h, x:x+w] = 80
        self.assertIsNone(locator.locate(image, context()))

    def test_context_is_strict_and_has_no_implicit_defaults(self):
        config, image, _, _ = fixture()
        locator = camera.CameraLocator(config)
        invalid = [None, {}, [], {"point": {}}, {**context(), "epoch": -1}, {**context(), "sequence": 0},
                   {**context(), "epoch": True}, {**context(), "sequence": 1.0},
                   {**context(), "sequence": 2**53}, {**context(), "point": {"x": 1.0, "y": 100}},
                   {**context(), "point": {"x": float("nan"), "y": 100}}, context(200, 100), context(-1, 100)]
        for value in invalid:
            with self.subTest(context=value):
                self.assertIsNone(locator.locate(image, value))

    def test_projection_and_name_anchor_bounds_reject_outside_without_clamping(self):
        config, image, _, _ = fixture()
        config["cameraAssist"]["matrix"] = [[0, 0], [0, 0], [100, 0]]
        self.assertIsNone(camera.CameraLocator(config).locate(image, context()))
        config["cameraAssist"]["matrix"] = [[1e308, 0], [0, 0], [0, 0]]
        self.assertIsNone(camera.CameraLocator(config).locate(image, context()))
        config, image, _, _ = fixture()
        config["cameraAssist"]["anchorBounds"] = dict(x=600, y=120, width=100, height=200)
        self.assertIsNone(camera.CameraLocator(config).locate(image, context()))

    def test_hp_offset_and_complete_patch_dimensions_are_not_guessed(self):
        config, image, _, _ = fixture()
        config["cameraAssist"]["healthBar"]["offsetX"] += 20
        self.assertIsNone(camera.CameraLocator(config).locate(image, context()))
        config, image, _, _ = fixture()
        config["cameraAssist"]["healthBar"]["offsetY"] = -500
        self.assertIsNone(camera.CameraLocator(config).locate(image, context()))

    def test_invalid_configuration_fields_fail_before_matching(self):
        base, _, _, _ = fixture()
        changes = [("width", True), ("height", 0), ("width", 16385), ("cameraAssist", None),
                   ("cameraAssist.referenceWidth", 901), ("cameraAssist.referenceHeight", 500.0),
                   ("cameraAssist.matrix", [[1, 2], [3, 4]]),
                   ("cameraAssist.matrix", [[1, 2], [3, 4], [5, float("nan")]]),
                   ("cameraAssist.matrix", [[1, 2], [3, 4], [5, True]]),
                   ("cameraAssist.healthBar.width", 219), ("cameraAssist.healthBar.height", 0),
                   ("cameraAssist.healthBar.offsetX", float("inf")),
                   ("cameraAssist.healthBar.offsetX", 10**400),
                   ("cameraAssist.healthBar.offsetY", 501), ("cameraAssist.region.width", 1),
                   ("cameraAssist.anchorBounds.width", 0), ("map.x", -1)]
        for dotted, value in changes:
            with self.subTest(field=dotted, value=value):
                config = copy.deepcopy(base); at = config
                keys = dotted.split(".")
                for key in keys[:-1]: at = at[key]
                at[keys[-1]] = value
                with self.assertRaises(ValueError): camera.CameraLocator(config)

    def test_template_bytes_channels_and_dimensions_are_validated(self):
        base, _, _, _ = fixture()
        corrupt = [None, True, "not base64", base64.b64encode(b"not an image").decode(), "A"*2_000_001,
                   encoded(np.zeros((20, 120), np.uint8)), encoded(np.zeros((20, 120), np.uint16)),
                   encoded(np.zeros((71, 120), np.uint8))]
        for value in corrupt:
            with self.subTest(template=str(value)[:30]):
                config = copy.deepcopy(base); config["cameraAssist"]["targetLabel"] = value
                with self.assertRaises(ValueError): camera.CameraLocator(config)
        # Header guard must reject a compressed-size bomb before calling OpenCV.
        raw = bytearray(base64.b64decode(base["cameraAssist"]["targetLabel"]))
        raw[16:24] = struct.pack(">II", 1_000_000, 1_000_000)
        with patch.object(camera.cv2, "imdecode", side_effect=AssertionError("must not decode huge header")):
            with self.assertRaises(ValueError): camera._template(base64.b64encode(raw).decode(), "targetLabel")

    def test_current_image_type_and_native_dimensions_are_validated(self):
        config, image, _, _ = fixture()
        locator = camera.CameraLocator(config)
        for current in (None, b"png", image[:, :, 0], image[:-1], image.astype(np.float32), image.astype(np.uint16)):
            with self.subTest(kind=type(current).__name__):
                with self.assertRaises(ValueError): locator.locate(current, context())

    def test_vector_prefilter_preserves_all_actual_complete_frame_candidates(self):
        for team in ("blue", "green"):
            with self.subTest(team=team):
                key = "cameraAssist" if team == "blue" else "selfCameraAssist"
                config, image, (x, y, w, h), _ = fixture(team=team, assist_key=key)
                ref = camera.CameraLocator(config, key).hp_template
                left, top, right, bottom = x-8, y-6, x+w+9, y+h+7
                candidates = camera._frame_candidates(image[top:bottom, left:right], ref, team)
                self.assertIsNotNone(candidates)
                actual = {(xx, yy) for xx in range(right-left-w+1) for yy in range(bottom-top-h+1)
                          if camera._frame_evidence(image, left+xx, top+yy, w, h, ref, team)}
                self.assertTrue(actual)
                self.assertTrue(actual.issubset({(xx, yy) for xx, yy, _ in candidates}))


if __name__ == "__main__":
    unittest.main()
