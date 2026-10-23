"""Current-pixel proposals for bounded camera SEARCH, never hero detections.

Coordinates returned by candidates() are native full-image pixels including the
minimap origin. The caller supplies this exact frame's independently reliable
non-camera self and the existing TargetRing.accept / TargetPartial.alive gates.
No history, confidence fallback, movement, or tracker update exists here. The
host must additionally enforce frame age < 1000 ms, input authority, at most two
visits in the original search budget, and fresh proof/identity before movement.
"""
import math

import cv2
import numpy as np


class WeakCameraSearch:
    def __init__(self, config, template, ring_accept, alive_check):
        if not isinstance(config, dict):
            raise ValueError("weak camera search requires a config object")
        search = config.get("targetWeakSearch")
        if (not isinstance(search, dict) or set(search) != {"version", "alive"}
                or type(search.get("version")) is not int or search["version"] != 1
                or not isinstance(search.get("alive"), dict)):
            raise ValueError("explicit version 1 weak search and living HUD calibration required")
        if not all(isinstance(config.get(key), dict) for key in ("cameraAssist", "targetRing", "cameraViewportGuard")):
            raise ValueError("weak search requires camera identity, team ring and viewport calibration")
        if not callable(ring_accept) or not callable(alive_check):
            raise ValueError("current team and living HUD gates required")
        self.width, self.height = config.get("width"), config.get("height")
        if (any(type(v) is not int or v <= 0 or v > 16384 for v in (self.width, self.height))
                or self.width*self.height > 8_000_000):
            raise ValueError("invalid native frame dimensions")
        rect = config.get("map")
        if not isinstance(rect, dict) or set(rect) != {"x", "y", "width", "height"}:
            raise ValueError("complete normalized minimap required")
        values = [rect[key] for key in ("x", "y", "width", "height")]
        try:
            finite = all(type(v) in (int, float) and math.isfinite(v) for v in values)
        except (OverflowError, ValueError):
            finite = False
        if not finite:
            raise ValueError("invalid minimap coordinates")
        x, y, w, h = values
        if x < 0 or y < 0 or w <= 0 or h <= 0 or x+w > 1.00001 or y+h > 1.00001:
            raise ValueError("minimap outside native image")
        self.left, self.top = round(x*self.width), round(y*self.height)
        right = min(self.width, self.left+round(w*self.width))
        bottom = min(self.height, self.top+round(h*self.height))
        self.map_width, self.map_height = right-self.left, bottom-self.top
        if (not isinstance(template, np.ndarray) or template.dtype != np.uint8
                or template.shape != (41, 41, 3) or float(template.std()) < 6
                or min(self.map_width, self.map_height) < 41):
            raise ValueError("weak search v1 requires an informative native 41px avatar")
        self.template = template.copy()
        self.mask = np.zeros((41, 41), np.uint8)
        cv2.ellipse(self.mask, (20, 20), (19, 19), 0, 0, 360, 255, -1)
        self.ring_accept, self.alive_check = ring_accept, alive_check

    def candidates(self, minimap, image, own_reliable):
        """Return <=2 id1-only proposals from this image; never infer identity.

        Inspect only the first two RAW global peaks, with the same +/-20px
        suppression as full matching. Colour filtering cannot promote an
        arbitrarily weak lower-ranked peak or manufacture raw uniqueness.
        """
        if (not isinstance(image, np.ndarray) or image.dtype != np.uint8
                or image.shape != (self.height, self.width, 3)
                or not isinstance(minimap, np.ndarray) or minimap.dtype != np.uint8
                or minimap.shape != (self.map_height, self.map_width, 3)):
            raise ValueError("weak search requires the full native image and matching minimap")
        if own_reliable is not True:
            return []
        # Do not accept a separately supplied stale or masked map as this frame.
        actual = image[self.top:self.top+self.map_height, self.left:self.left+self.map_width]
        if not np.array_equal(minimap, actual):
            raise ValueError("weak search minimap must come from the current full image")
        if not self.alive_check(image):
            return []
        scores = 1-cv2.matchTemplate(minimap, self.template, cv2.TM_SQDIFF_NORMED, mask=self.mask)
        scores = np.nan_to_num(scores, nan=-1, posinf=-1, neginf=-1)
        proposals = []
        for _ in range(2):
            _, score, _, (x, y) = cv2.minMaxLoc(scores)
            if score < .8:
                break
            scores[max(0, y-20):y+21, max(0, x-20):x+21] = -1
            candidate = {"x": (x+20.5)/self.map_width, "y": (y+20.5)/self.map_height,
                         "confidence": float(min(1, score))}
            if self.ring_accept(minimap, candidate):
                proposals.append({"x": self.left+x+20.5, "y": self.top+y+20.5,
                                  "score": float(min(1, score))})
        return proposals
