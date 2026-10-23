"""Optional current-image consistency check for a host-validated camera hold.

Version 1 is calibrated only for native 2772x1240 BGR frames and the minimap at
(120, 0, 425, 425). Construct this class only when cameraViewportGuard is explicit.
The host still owns proof freshness, sequence, epoch, lease and input authority.
This module does not identify a hero, replace the held point or authorize motion.
A rejection means unverifiable camera geometry, not proof of ignored input.

White and alert-red four-edge proposals use the frozen viewport experiment;
colors never share edges and all proposals compete before point consistency is
checked. The known red-alert-circle false rejection remains unchanged in v1.
"""
import math

import cv2
import numpy as np


# Native-pixel constants, intentionally not configuration knobs in version 1.
_WIDTH, _HEIGHT = 2772, 1240
_LEFT, _TOP, _MAP_WIDTH, _MAP_HEIGHT = 120, 0, 425, 425
_MIN_WIDTH, _MAX_WIDTH, _MIN_HEIGHT, _MAX_HEIGHT = 85, 150, 42, 90
_HORIZONTAL_KERNEL, _VERTICAL_KERNEL = 31, 23
_MIN_HORIZONTAL_PIXELS, _MIN_VERTICAL_PIXELS = 55, 30
_EDGE_TOLERANCE = 2
_MIN_EDGE_COVERAGE, _MIN_MEAN_COVERAGE = .6, .82
_CANDIDATE_SEPARATION, _UNIQUENESS_MARGIN, _MAX_CENTER_DISTANCE = 8, .08, 5
# Fail closed on pathological dense grids instead of blocking the vision worker.
# This bounds proposal work only; no candidate is selected from a truncated set.
_MAX_BOX_COMBINATIONS = 4096


def _groups(values):
    groups = []
    for value in values:
        if not groups or value > groups[-1][-1] + 1:
            groups.append([int(value)])
        else:
            groups[-1].append(int(value))
    return [int(round(sum(group) / len(group))) for group in groups]


def _finite(value):
    if type(value) not in (int, float):
        raise ValueError("map coordinates must be finite numbers")
    try:
        value = float(value)
    except (ValueError, OverflowError) as error:
        raise ValueError("map coordinates must be finite numbers") from error
    if not math.isfinite(value):
        raise ValueError("map coordinates must be finite numbers")
    return value


class CameraViewportGuard:
    def __init__(self, config):
        if not isinstance(config, dict):
            raise ValueError("config must be an object")
        calibration = config.get("cameraViewportGuard")
        if not isinstance(calibration, dict) or set(calibration) != {"version", "referenceWidth", "referenceHeight"}:
            raise ValueError("explicit cameraViewportGuard version/reference dimensions are required")
        for key, expected in (("version", 1), ("referenceWidth", _WIDTH), ("referenceHeight", _HEIGHT)):
            if type(calibration[key]) is not int or calibration[key] != expected:
                raise ValueError("cameraViewportGuard v1 calibration mismatch: " + key)
        for key, expected in (("width", _WIDTH), ("height", _HEIGHT)):
            if type(config.get(key)) is not int or config[key] != expected:
                raise ValueError("cameraViewportGuard v1 requires native 2772x1240 frames")
        rect = config.get("map")
        if not isinstance(rect, dict) or set(rect) != {"x", "y", "width", "height"}:
            raise ValueError("cameraViewportGuard requires a complete normalized map rectangle")
        values = [_finite(rect[key]) for key in ("x", "y", "width", "height")]
        if values[0] < 0 or values[1] < 0 or values[2] <= 0 or values[3] <= 0:
            raise ValueError("cameraViewportGuard map is outside the image or empty")
        native = [values[0] * _WIDTH, values[1] * _HEIGHT, values[2] * _WIDTH, values[3] * _HEIGHT]
        expected = (_LEFT, _TOP, _MAP_WIDTH, _MAP_HEIGHT)
        if any(abs(actual - calibrated) > 1e-6 for actual, calibrated in zip(native, expected)):
            raise ValueError("cameraViewportGuard v1 requires native map (120,0,425,425)")
        # Retain no mutable caller configuration. All v1 geometry is frozen.

    @staticmethod
    def _image(image):
        if not isinstance(image, np.ndarray) or image.dtype != np.uint8 or image.shape != (_HEIGHT, _WIDTH, 3):
            raise ValueError("cameraViewportGuard requires a native 2772x1240 uint8 BGR image")

    @staticmethod
    def _candidates(mask, color):
        horizontal = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((1, _HORIZONTAL_KERNEL), np.uint8))
        vertical = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((_VERTICAL_KERNEL, 1), np.uint8))
        ys = _groups(np.flatnonzero(np.count_nonzero(horizontal, axis=1) >= _MIN_HORIZONTAL_PIXELS))
        xs = _groups(np.flatnonzero(np.count_nonzero(vertical, axis=0) >= _MIN_VERTICAL_PIXELS))
        x_pairs = [(left, right) for left in xs for right in xs if _MIN_WIDTH <= right - left <= _MAX_WIDTH]
        y_pairs = [(top, bottom) for top in ys for bottom in ys if _MIN_HEIGHT <= bottom - top <= _MAX_HEIGHT]
        if len(x_pairs) * len(y_pairs) > _MAX_BOX_COMBINATIONS:
            return None
        candidates = []
        d = _EDGE_TOLERANCE
        for left, right in x_pairs:
            for top, bottom in y_pairs:
                lines = [mask[max(0, top-d):top+d+1, left:right+1].max(axis=0),
                         mask[max(0, bottom-d):bottom+d+1, left:right+1].max(axis=0),
                         mask[top:bottom+1, max(0, left-d):left+d+1].max(axis=1),
                         mask[top:bottom+1, max(0, right-d):right+d+1].max(axis=1)]
                coverage = [float(np.mean(line > 0)) for line in lines]
                if min(coverage) < _MIN_EDGE_COVERAGE or np.mean(coverage) < _MIN_MEAN_COVERAGE:
                    continue
                candidates.append({"color": color, "x": _LEFT+(left+right)/2, "y": _TOP+(top+bottom)/2,
                                   "left": _LEFT+left, "right": _LEFT+right, "top": _TOP+top, "bottom": _TOP+bottom,
                                   "width": right-left, "height": bottom-top,
                                   "confidence": float(np.mean(coverage)), "edgeCoverage": coverage})
        return candidates

    def _detect(self, image):
        crop = image[_TOP:_TOP+_MAP_HEIGHT, _LEFT:_LEFT+_MAP_WIDTH]
        hue, saturation, value = cv2.split(cv2.cvtColor(crop, cv2.COLOR_BGR2HSV))
        masks = {"white": (saturation <= 45) & (value >= 215),
                 "alertRed": ((hue <= 15) | (hue >= 165)) & (saturation >= 100) & (value >= 170)}
        candidates, counts = [], {}
        for color, mask in masks.items():
            found = self._candidates(mask.astype(np.uint8)*255, color)
            if found is None:
                return "current-four-edge-box-unverifiable", None, None
            counts[color] = len(found)
            candidates.extend(found)
        evidence = {"candidateCounts": counts}
        if not candidates:
            return "current-four-edge-box-unverifiable", None, evidence
        candidates.sort(key=lambda box: box["confidence"], reverse=True)
        best = candidates[0]
        if any(math.hypot(box["x"]-best["x"], box["y"]-best["y"]) > _CANDIDATE_SEPARATION
               and box["confidence"] >= best["confidence"]-_UNIQUENESS_MARGIN for box in candidates[1:]):
            return "current-four-edge-box-ambiguous", None, evidence
        return None, best, evidence

    def check(self, image, cameraContext):
        """Return diagnostics only; never replace the host's validated hold point."""
        self._image(image)
        result = {"accepted": False, "reason": "current-camera-context-missing", "observedBox": None,
                  "centerDistanceMapPx": None, "colorEvidence": None}
        if not isinstance(cameraContext, dict) or not isinstance(cameraContext.get("point"), dict):
            return result
        point = cameraContext["point"]
        values = [point.get("x"), point.get("y"), cameraContext.get("epoch"), cameraContext.get("sequence")]
        if (any(type(value) is not int for value in values)
                or not _LEFT <= values[0] < _LEFT+_MAP_WIDTH or not _TOP <= values[1] < _TOP+_MAP_HEIGHT
                or not 0 <= values[2] <= 2**53-1 or not 1 <= values[3] <= 2**53-1):
            result["reason"] = "current-camera-context-invalid"
            return result
        reason, box, evidence = self._detect(image)
        result.update(reason=reason, observedBox=box, colorEvidence=evidence)
        if reason is not None:
            return result
        distance = math.hypot(box["x"]-point["x"], box["y"]-point["y"])
        accepted = distance <= _MAX_CENTER_DISTANCE
        result.update(accepted=accepted, centerDistanceMapPx=distance,
                      reason="current-box-consistent" if accepted else "current-box-point-mismatch")
        return result
