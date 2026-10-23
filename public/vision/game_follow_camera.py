"""Current-frame name/complete-team-HP camera observations; no device access.

CameraLocator takes the complete follow config and an optional assist_key:
cameraAssist (default, target) or selfCameraAssist (own hero). Both use independent
templates, geometry, matrix and bounds. targetLabel names the own hero when used
in selfCameraAssist. team defaults to blue; selfCameraAssist requires explicit
green. referenceWidth/referenceHeight must equal config.width/height. Templates
are base64 PNG pixels.
region and config.map are normalized full-image rectangles; anchorBounds and
healthBar.{width,height,offsetX,offsetY} use native image pixels. HP offsets locate
its top-left corner relative to the name-template center (not remaining fill).

locate accepts a uint8 BGR full image and a host-validated cameraContext containing
point {x,y} in native minimap/screen pixels, integer epoch >= 0, sequence >= 1.
The host, not this stateless detector, verifies the context's freshness/ownership.
The projected native minimap point is context.point + [nameX,nameY,1] @ matrix,
where matrix is 3x2 and outputs native minimap-pixel displacement. No previous
coordinate, gesture inference, prediction, or fallback is used. Invalid config
or image representation raises ValueError; missing evidence/context returns None.
"""
import base64
import binascii
import math
import struct

import cv2
import numpy as np


def _number(value, field):
    if type(value) not in (int, float):
        raise ValueError(field + " must be finite")
    try:
        result = float(value)
    except (ValueError, OverflowError) as error:
        raise ValueError(field + " must be finite") from error
    if not math.isfinite(result):
        raise ValueError(field + " must be finite")
    return result


def _integer(value, field, minimum=0, maximum=16384):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(field + " must be an integer in range")
    return value


def _object(value, field):
    if not isinstance(value, dict):
        raise ValueError(field + " must be an object")
    return value


def _rectangle(value, field, width, height, normalized=False):
    value = _object(value, field)
    x, y, w, h = [_number(value.get(k), field + "." + k) for k in ("x", "y", "width", "height")]
    limit_x, limit_y = (1., 1.) if normalized else (width, height)
    if x < 0 or y < 0 or w <= 0 or h <= 0 or x+w > limit_x+1e-9 or y+h > limit_y+1e-9:
        raise ValueError(field + " is outside the image or empty")
    if normalized:
        x, y, w, h = x*width, y*height, w*width, h*height
    return x, y, min(x+w, width), min(y+h, height)


def _template(encoded, field):
    # Read PNG dimensions before decompression. Tiny compressed inputs can still
    # describe enormous bitmaps; neither byte size alone nor imdecode is a guard.
    if not isinstance(encoded, str) or not encoded or len(encoded) > 2_000_000:
        raise ValueError(field + " must be bounded base64 PNG data")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError(field + " has invalid base64") from error
    if len(raw) < 33 or raw[:8] != b"\x89PNG\r\n\x1a\n" or raw[12:16] != b"IHDR":
        raise ValueError(field + " must be a PNG image")
    w, h = struct.unpack(">II", raw[16:24])
    if not 1 <= w <= 2048 or not 1 <= h <= 512 or w*h > 262144:
        raise ValueError(field + " dimensions are too large or empty")
    image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None or image.dtype != np.uint8 or image.shape[:2] != (h, w):
        raise ValueError(field + " could not be decoded as an 8-bit image")
    if image.ndim == 2:
        return image
    if image.ndim != 3 or image.shape[2] not in (3, 4):
        raise ValueError(field + " has unsupported channels")
    return cv2.cvtColor(image, cv2.COLOR_BGRA2GRAY if image.shape[2] == 4 else cv2.COLOR_BGR2GRAY)


def _colour(image, team):
    h, s, v = cv2.split(cv2.cvtColor(image, cv2.COLOR_BGR2HSV))
    if team == "green":
        return (h >= 35) & (h <= 85) & (s >= 95) & (v >= 95)
    if team == "blue":
        return (h >= 85) & (h <= 130) & (s >= 75) & (v >= 100)
    raise ValueError("camera team must be blue or green")


def _blue(image):
    return _colour(image, "blue")


def _longest_run(binary):
    maximum = run = 0
    for value in binary:
        run = run+1 if value else 0
        maximum = max(maximum, run)
    return maximum


def _frame_evidence(image, x, y, w, h, reference, team="blue"):
    if x < 4 or y < 4 or x+w+4 > image.shape[1] or y+h+4 > image.shape[0]:
        return None
    patch = image[y:y+h, x:x+w]
    gray = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY)
    delta = (gray.astype(np.float64)-reference)**2
    edges = {"top": gray[0, 4:-4] <= 85, "bottom": gray[-1, 4:-4] <= 85,
             "right": gray[2:-2, -1] <= 35}
    for key, edge in edges.items():
        # A short right border can have fewer than 25 samples: .96 then
        # accidentally requires every pixel to be dark. Permit one isolated
        # raster outlier there, while retaining the full-column RMSE and the
        # exterior contrast checks below. Other edges keep their original gate.
        covered = float(edge.mean()) >= .96 or (key == "right" and np.count_nonzero(~edge) == 1)
        if not covered or _longest_run(~edge) > 3:
            return None
    rmses = {"top": float(np.sqrt(delta[0, 4:-4].mean())),
             "bottom": float(np.sqrt(delta[-1, 4:-4].mean())),
             "leftEndpoint": float(np.sqrt(delta[:, :3].mean())),
             "rightEndpoint": float(np.sqrt(delta[:, -1:].mean()))}
    if max(rmses[k] for k in ("top", "bottom", "rightEndpoint")) > 18 or rmses["leftEndpoint"] > 75:
        return None
    if float(_colour(patch[4:-4, 5:14], team).mean()) < .45 or float(_colour(patch[4:-4, :2], team).mean()) > .20:
        return None
    outside = cv2.cvtColor(image[y+2:y+h-2, x+w:x+w+4], cv2.COLOR_BGR2GRAY)
    contrast = float(np.median(outside)-np.median(gray[2:-2, -1]))
    if contrast < 6:
        return None
    whole = cv2.cvtColor(patch[1:-1, :], cv2.COLOR_BGR2HSV)
    neutral = (whole[:, :, 1] < 30) & (whole[:, :, 2] > 145)
    if _longest_run(np.sum(neutral, axis=0) >= 2) > 4:
        return None
    inside = patch[3:-3, 5:-5]
    colour = _colour(inside, team)
    hsv = cv2.cvtColor(inside, cv2.COLOR_BGR2HSV)
    red = ((hsv[:, :, 0] < 13) | (hsv[:, :, 0] > 165)) & (hsv[:, :, 1] >= 95) & (hsv[:, :, 2] >= 120)
    if float(red.mean()) > .03:
        return None
    columns = colour.mean(axis=0) >= .25
    selected = np.flatnonzero(columns)
    if len(selected) < max(12, inside.shape[1]*.12) or selected[0] > 8:
        return None
    if _longest_run(~columns[:selected[-1]+1]) > 9 or colour.sum() < inside.shape[0]*12:
        return None
    foreign = (hsv[:, :, 1] >= 100) & (hsv[:, :, 2] >= 130) & ~colour
    if float(foreign.mean()) > .04:
        return None
    return {"edgeCoverage": {k: float(v.mean()) for k, v in edges.items()}, "edgeRmse": rmses,
            "rightBoundaryContrast": contrast, "remainingColourFraction": float(colour.mean())}


def _frame_candidates(area, reference, team="blue"):
    """Vectorize necessary gates before detailed checks, preserving competitors.

    A dense field with over 400 survivors is rejected, rather than checking only
    a sorted prefix that could hide a second complete bar. Threshold tolerances
    here only absorb float convolution roundoff; the exact checks still follow.
    """
    h, w = reference.shape
    gray = cv2.cvtColor(area, cv2.COLOR_BGR2GRAY).astype(np.float32)
    ref = reference.astype(np.float32)
    border = np.zeros((h, w), np.uint8)
    border[0, :] = border[-1, :] = 255
    border[:, 0] = border[:, -1] = 255
    distances = cv2.matchTemplate(gray, ref, cv2.TM_SQDIFF, mask=border)/np.count_nonzero(border)
    possible = np.isfinite(distances) & (distances <= 36**2)
    masks = {}
    for key in ("top", "bottom", "right", "left"):
        masks[key] = np.zeros((h, w), np.float32)
    masks["top"][0, 4:-4] = 1
    masks["bottom"][-1, 4:-4] = 1
    masks["right"][2:-2, -1] = 1
    masks["left"][:, :3] = 1
    corr = lambda source, mask: cv2.matchTemplate(source, mask, cv2.TM_CCORR)
    for key in ("top", "bottom", "right"):
        mask = masks[key]
        dark = (gray <= (35 if key == "right" else 85)).astype(np.float32)
        minimum = min(.96, 1-1/mask.sum()) if key == "right" else .96
        possible &= corr(dark, mask)/mask.sum() >= minimum-1e-6
    # Necessary current blue-to-dark left endpoint transition. Uniform dark or
    # blue UI fields cannot generate hundreds of expensive frame candidates.
    colour = _colour(area, team).astype(np.float32)
    fill = np.zeros((h, w), np.float32)
    fill[4:-4, 5:14] = 1
    endpoint = np.zeros((h, w), np.float32)
    endpoint[4:-4, :2] = 1
    possible &= corr(colour, fill)/fill.sum() >= .45-1e-6
    possible &= corr(colour, endpoint)/endpoint.sum() <= .20+1e-6
    # The exact endpoint RMSE uses the entire last column, unlike dark coverage.
    masks["right"][:, -1] = 1
    for key, limit in (("top", 18), ("bottom", 18), ("right", 18), ("left", 75)):
        mask = masks[key]
        error = corr(gray*gray, mask)-2*corr(gray, ref*mask)+float(np.sum(ref*ref*mask))
        possible &= error/mask.sum() <= limit**2+.05
    points = np.argwhere(possible)
    if len(points) > 400:
        return None
    return [(int(x), int(y), float(distances[y, x])) for y, x in points]


class CameraLocator:
    def __init__(self, config, assist_key="cameraAssist"):
        config = _object(config, "config")
        if assist_key not in ("cameraAssist", "selfCameraAssist"):
            raise ValueError("camera assist key must be cameraAssist or selfCameraAssist")
        self.width = _integer(config.get("width"), "width", 1)
        self.height = _integer(config.get("height"), "height", 1)
        if self.width*self.height > 8_000_000:
            raise ValueError("camera image dimensions exceed the pixel budget")
        assist = _object(config.get(assist_key), assist_key)
        self.team = assist.get("team", "blue")
        if self.team not in ("blue", "green"):
            raise ValueError(assist_key + ".team must be blue or green")
        if assist_key == "selfCameraAssist" and self.team != "green":
            raise ValueError("selfCameraAssist.team must be explicitly green")
        if assist_key == "cameraAssist" and self.team != "blue":
            raise ValueError("cameraAssist.team must be blue")
        if (_integer(assist.get("referenceWidth"), "referenceWidth", 1) != self.width
                or _integer(assist.get("referenceHeight"), "referenceHeight", 1) != self.height):
            raise ValueError("camera reference dimensions do not match config")
        self.map = _rectangle(config.get("map"), "map", self.width, self.height, True)
        bounds = _rectangle(assist.get("region"), assist_key + ".region", self.width, self.height, True)
        self.region = (math.floor(bounds[0]), math.floor(bounds[1]), math.ceil(bounds[2]), math.ceil(bounds[3]))
        self.anchor_bounds = _rectangle(assist.get("anchorBounds"), assist_key + ".anchorBounds", self.width, self.height)
        self.name_template = _template(assist.get("targetLabel"), "targetLabel")
        nh, nw = self.name_template.shape
        if not 12 <= nh <= 70 or not 24 <= nw <= 500 or float(self.name_template.std()) < 15:
            raise ValueError("targetLabel must contain a complete textured name")
        if nw > self.region[2]-self.region[0] or nh > self.region[3]-self.region[1]:
            raise ValueError("targetLabel is larger than its search region")
        hp = _object(assist.get("healthBar"), "healthBar")
        self.hp_width = _integer(hp.get("width"), "healthBar.width", 24, min(2048, self.width))
        self.hp_height = _integer(hp.get("height"), "healthBar.height", 12, min(512, self.height))
        self.hp_dx = _number(hp.get("offsetX"), "healthBar.offsetX")
        self.hp_dy = _number(hp.get("offsetY"), "healthBar.offsetY")
        if abs(self.hp_dx) > self.width or abs(self.hp_dy) > self.height:
            raise ValueError("healthBar offset exceeds image dimensions")
        self.hp_template = _template(assist.get("healthBarTemplate"), "healthBarTemplate")
        if self.hp_template.shape != (self.hp_height, self.hp_width):
            raise ValueError("healthBar template dimensions do not match geometry")
        if float(self.hp_template.std()) < 3:
            raise ValueError("healthBar template is uninformative")
        matrix = assist.get("matrix")
        if not isinstance(matrix, list) or len(matrix) != 3 or any(not isinstance(row, list) or len(row) != 2 for row in matrix):
            raise ValueError("camera matrix must be 3x2")
        self.matrix = np.array([[_number(v, "camera matrix") for v in row] for row in matrix], np.float64)

    def _context(self, context):
        if not isinstance(context, dict) or not isinstance(context.get("point"), dict):
            return None
        point = context["point"]
        values = [point.get("x"), point.get("y"), context.get("epoch"), context.get("sequence")]
        if any(type(value) is not int for value in values):
            return None
        x, y, epoch, sequence = values
        if not 0 <= epoch <= 2**53-1 or not 1 <= sequence <= 2**53-1:
            return None
        if not self.map[0] <= x < self.map[2] or not self.map[1] <= y < self.map[3]:
            return None
        return {"point": {"x": x, "y": y}, "epoch": epoch, "sequence": sequence}

    def locate(self, image, cameraContext):
        if not isinstance(image, np.ndarray) or image.dtype != np.uint8 or image.shape != (self.height, self.width, 3):
            raise ValueError("camera frame must be a native uint8 BGR image matching config dimensions")
        context = self._context(cameraContext)
        if context is None:
            return None
        left, top, right, bottom = self.region
        gray = cv2.cvtColor(image[top:bottom, left:right], cv2.COLOR_BGR2GRAY)
        template = self.name_template
        scores = cv2.matchTemplate(gray, template, cv2.TM_CCOEFF_NORMED)
        scores = np.nan_to_num(scores, nan=-1., neginf=-1., posinf=-1.)
        _, score, _, (x, y) = cv2.minMaxLoc(scores)
        other = scores.copy()
        rx, ry = max(8, template.shape[1]//5), max(5, template.shape[0]//3)
        other[max(0, y-ry):y+ry+1, max(0, x-rx):x+rx+1] = -1
        runner = float(other.max())
        if score < .90 or score-runner < .12:
            return None
        nx, ny = x+left+template.shape[1]/2, y+top+template.shape[0]/2
        if not self.anchor_bounds[0] <= nx <= self.anchor_bounds[2] or not self.anchor_bounds[1] <= ny <= self.anchor_bounds[3]:
            return None
        w, h = self.hp_width, self.hp_height
        ex, ey = round(nx+self.hp_dx), round(ny+self.hp_dy)
        # Native-pixel detector tolerances preserve the strict reference method;
        # screen resolution and all measured HUD geometry come from config.
        left, top = max(0, ex-45), max(0, ey-18)
        right, bottom = min(self.width, ex+w+46), min(self.height, ey+h+44)
        if right-left < w or bottom-top < h:
            return None
        candidates = _frame_candidates(image[top:bottom, left:right], self.hp_template, self.team)
        if candidates is None:
            return None
        accepted = []
        for xx, yy, distance in candidates:
            bx, by = left+xx, top+yy
            evidence = _frame_evidence(image, bx, by, w, h, self.hp_template, self.team)
            if evidence:
                accepted.append({"x": bx+(w-1)/2, "y": by+(h-1)/2, "left": bx, "top": by,
                                 "width": w, "height": h, "rmse": math.sqrt(max(0., distance)), **evidence})
        if not accepted:
            return None
        accepted.sort(key=lambda p: (math.hypot(p["left"]-ex, p["top"]-ey), p["rmse"]))
        hp = accepted[0]
        if abs(hp["left"]-ex) > 8 or abs(hp["top"]-ey) > 6:
            return None
        if any(math.hypot(p["x"]-hp["x"], p["y"]-hp["y"]) > 5 for p in accepted[1:]):
            return None
        with np.errstate(over="ignore", invalid="ignore"):
            delta = np.array([nx, ny, 1.]) @ self.matrix
            projected = delta+np.array([context["point"]["x"], context["point"]["y"]])
        if not np.all(np.isfinite(projected)):
            return None
        px, py = map(float, projected)
        if not self.map[0] <= px < self.map[2] or not self.map[1] <= py < self.map[3]:
            return None
        return {"x": px, "y": py, "confidence": float(score),
                "name": {"x": nx, "y": ny, "left": x+self.region[0], "top": y+self.region[1],
                         "width": template.shape[1], "height": template.shape[0], "confidence": float(score), "margin": float(score-runner)},
                "hp": hp, "camera": context, "relativeMapPixels": delta.tolist()}
