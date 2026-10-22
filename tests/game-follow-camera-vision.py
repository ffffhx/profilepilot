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
cv2.setNumThreads(2)


def encoded(image):
    return base64.b64encode(cv2.imencode(".png", image)[1]).decode()


def fixture(shift_x=0, shift_y=0, gray_template=False):
    rng = np.random.default_rng(17)
    name = np.zeros((20, 120, 3), np.uint8)
    name[rng.random((20, 120)) > .6] = 235
    hp = np.full((24, 220, 3), 30, np.uint8)
    hp[0, :] = hp[-1, :] = 0
    hp[:, 0] = hp[:, -1] = 0
    hp[4:-4, 5:-5] = (235, 150, 35)
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
    return config, image, (bx, by, 220, 24), name


def context(x=100, y=100):
    return dict(point=dict(x=x, y=y), epoch=0, sequence=1)


class CameraTests(unittest.TestCase):
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
        config, image, (x, y, w, h), _ = fixture()
        ref = camera.CameraLocator(config).hp_template
        left, top, right, bottom = x-8, y-6, x+w+9, y+h+7
        candidates = camera._frame_candidates(image[top:bottom, left:right], ref)
        self.assertIsNotNone(candidates)
        actual = {(xx, yy) for xx in range(right-left-w+1) for yy in range(bottom-top-h+1)
                  if camera._frame_evidence(image, left+xx, top+yy, w, h, ref)}
        self.assertTrue(actual)
        self.assertTrue(actual.issubset({(xx, yy) for xx, yy, _ in candidates}))


if __name__ == "__main__":
    unittest.main()
