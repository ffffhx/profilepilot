"""Local OpenCV perception and navigation. JSON-lines in/out; no device access."""
import base64
import heapq
import json
import math
import sys
import time
from collections import deque

import cv2
import numpy as np

cv2.setNumThreads(2)


def decode(encoded):
    raw = base64.b64decode(encoded, validate=True)
    image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if image is None or image.size > 24000000:
        raise ValueError("无法读取图像，或图像尺寸过大")
    return image


def match(image, template, rotates=False):
    """Masked colour matching, suppressing non-finite and ambiguous matches."""
    th, tw = template.shape[:2]
    if th < 5 or tw < 5 or th > image.shape[0] or tw > image.shape[1]:
        return None
    if float(template.std()) < 6:
        return None
    mask = np.zeros((th, tw), np.uint8)
    cv2.ellipse(mask, (tw // 2, th // 2), (max(1, tw // 2 - 1), max(1, th // 2 - 1)), 0, 0, 360, 255, -1)
    combined = None
    for angle in range(0, 360, 30) if rotates else [0]:
        rotated = template if not angle else cv2.warpAffine(
            template, cv2.getRotationMatrix2D((tw / 2, th / 2), angle, 1), (tw, th))
        scores = 1 - cv2.matchTemplate(image, rotated, cv2.TM_SQDIFF_NORMED, mask=mask)
        scores = np.nan_to_num(scores, nan=-1, neginf=-1, posinf=-1)
        combined = scores if combined is None else np.maximum(combined, scores)
    _, score, _, point = cv2.minMaxLoc(combined)
    x, y = point
    other = combined.copy()
    rx, ry = max(3, tw // 2), max(3, th // 2)
    other[max(0, y - ry):y + ry + 1, max(0, x - rx):x + rx + 1] = -1
    # Identical icons or an uninformative template must not move the phone.
    if score - float(other.max()) < 0.025:
        return None
    return {"x": (x + tw / 2) / image.shape[1], "y": (y + th / 2) / image.shape[0],
            "confidence": float(max(0, min(1, score)))}


class Tracker:
    """Use recent measured positions to bound search; never extrapolate input."""
    def __init__(self, template, rotates, confidence, max_gap):
        self.template, self.rotates = template, rotates
        self.confidence, self.max_gap = confidence, max_gap
        self.last, self.at = None, 0

    def locate(self, image, now):
        h, w = image.shape[:2]
        th, tw = self.template.shape[:2]
        found = None
        if self.last and 0 <= now - self.at <= self.max_gap:
            # Include the whole icon and a generous movement envelope. A jump
            # outside it must be reacquired globally; no old location is emitted.
            radius = .035 + .18 * (now - self.at)
            px, py = self.last['x'] * w, self.last['y'] * h
            x, y = max(0, int(px-radius*w-tw/2)), max(0, int(py-radius*h-th/2))
            right, bottom = min(w, math.ceil(px+radius*w+tw/2)), min(h, math.ceil(py+radius*h+th/2))
            found = match(image[y:bottom, x:right], self.template, self.rotates)
            if found:
                found['x'] = (x + found['x'] * (right-x)) / w
                found['y'] = (y + found['y'] * (bottom-y)) / h
        if not found or found['confidence'] < self.confidence:
            found = match(image, self.template, self.rotates)
        if found and found['confidence'] >= self.confidence:
            self.last, self.at = found, now
        return found


class SelfMarker:
    """An opt-in coloured ring can continue a recently verified self identity.

    Each position is measured in the current image. The marker must first agree
    with the avatar template; it cannot initialize identity or reacquire after a
    long gap. A colour blob, an incomplete arc, or multiple plausible rings do
    not authorize movement.
    """
    def __init__(self, config, max_gap):
        self.config, self.max_gap = config, max_gap
        self.last, self.at, self.offset = None, 0, None
        self.angles = np.linspace(0, 2*math.pi, 72, endpoint=False)

    def rings(self, image):
        c = self.config
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        mask = ((hsv[:, :, 0] >= c['hueMin']) & (hsv[:, :, 0] <= c['hueMax'])
                & (hsv[:, :, 1] >= c['saturationMin']) & (hsv[:, :, 2] >= c['valueMin'])).astype(np.uint8)
        radius = c['radiusPixels']
        tolerance = max(1, radius*.12)
        circles = cv2.HoughCircles(mask*255, cv2.HOUGH_GRADIENT, 1, max(5, radius*.6),
                                  param1=80, param2=7, minRadius=max(2, math.floor(radius-tolerance)),
                                  maxRadius=math.ceil(radius+tolerance))
        if circles is None:
            return []
        h, w = mask.shape
        ys, xs = np.nonzero(mask)
        results = []
        def hits(x, y, radial):
            xx = np.rint(x+np.cos(self.angles[:, None])*radial).astype(int)
            yy = np.rint(y+np.sin(self.angles[:, None])*radial).astype(int)
            inside = (xx >= 0) & (xx < w) & (yy >= 0) & (yy < h)
            values = np.zeros_like(inside)
            values[inside] = mask[yy[inside], xx[inside]] != 0
            return np.any(values, axis=1)
        for x, y, r in circles[0]:
            # Refine Hough's quantized center using only current ring pixels.
            # Half a circumference across three quadrants constrains this fit;
            # the fitted radius and the inner/outer colour checks below reject
            # a green line, rectangle, solid badge, or unrelated larger circle.
            annulus = np.abs(np.hypot(xs-x, ys-y)-r) <= max(3, radius*.5)
            px, py = xs[annulus], ys[annulus]
            if len(px) < max(12, radius):
                continue
            a = np.column_stack((px-x, py-y, np.ones(len(px))))
            coefficients, _, rank, _ = np.linalg.lstsq(a, -((px-x)**2+(py-y)**2), rcond=None)
            if rank < 3:
                continue
            dx, dy = -coefficients[:2]/2
            squared = dx*dx+dy*dy-coefficients[2]
            if squared <= 0:
                continue
            fitted = math.sqrt(squared)
            if abs(fitted-radius) > tolerance or math.hypot(dx, dy) > max(3, radius*.2):
                continue
            x, y, r = float(x+dx), float(y+dy), fitted
            support = hits(x, y, np.arange(-2, 3)+r)
            quadrants = [np.count_nonzero(part) for part in np.split(support, 4)]
            if np.count_nonzero(support) < 39 or sum(count >= 4 for count in quadrants) < 3:
                continue
            if np.count_nonzero(hits(x, y, np.array([r*.65]))) > 18 or np.count_nonzero(hits(x, y, np.array([r*1.3]))) > 18:
                continue
            results.append({'x': x/w, 'y': y/h, 'confidence': float(np.mean(support))})
        return results

    def locate(self, image, own, now):
        if not 0 <= now-self.at <= self.max_gap:
            self.last, self.offset = None, None
        if own is None and self.last is None:
            return None
        h, w = image.shape[:2]
        radius = .035+.18*(now-self.at) if own is None else 0
        center = own if own is not None else dict(x=self.last['x']-self.offset[0], y=self.last['y']-self.offset[1])
        margin = self.config['radiusPixels']*1.6+4
        x, y = max(0, math.floor((center['x']-radius)*w-margin)), max(0, math.floor((center['y']-radius)*h-margin))
        right, bottom = min(w, math.ceil((center['x']+radius)*w+margin)), min(h, math.ceil((center['y']+radius)*h+margin))
        candidates = self.rings(image[y:bottom, x:right])
        candidates = [dict(p, x=(p['x']*(right-x)+x)/w, y=(p['y']*(bottom-y)+y)/h) for p in candidates]
        if own is not None:
            distance = max(4, self.config['radiusPixels']*.25)
            candidates = [p for p in candidates if math.hypot((p['x']-own['x'])*w, (p['y']-own['y'])*h) <= distance]
            if len(candidates) == 1:
                ring = candidates[0]
                self.offset = own['x']-ring['x'], own['y']-ring['y']
                self.last, self.at = own, now
            else:
                self.last, self.offset = None, None
            return None
        candidates = [dict(p, x=p['x']+self.offset[0], y=p['y']+self.offset[1]) for p in candidates]
        candidates = [p for p in candidates if 0 <= p['x'] <= 1 and 0 <= p['y'] <= 1
                      and math.dist((p['x'], p['y']), (self.last['x'], self.last['y'])) <= radius]
        if len(candidates) != 1:
            return None
        self.last, self.at = candidates[0], now
        return self.last


def white_text(image):
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    return ((hsv[:, :, 1] < 65) & (hsv[:, :, 2] > 175)).astype(np.uint8) * 255


def label_position(image, template, region, own):
    """Current white name plus its own green / ally blue health bar."""
    h, w = image.shape[:2]
    x, y = round(region['x']*w), round(region['y']*h)
    rw, rh = round(region['width']*w), round(region['height']*h)
    th, tw = template.shape
    if th > rh or tw > rw or template.std() < 10:
        return None
    scores = cv2.matchTemplate(white_text(image[y:y+rh, x:x+rw]), template, cv2.TM_CCOEFF_NORMED)
    scores = np.nan_to_num(scores, nan=-1, neginf=-1, posinf=-1)
    candidates = []
    for _ in range(5):
        _, score, _, pt = cv2.minMaxLoc(scores)
        if score < .74:
            break
        px, py = pt
        scores[max(0, py-th//2):py+th//2+1, max(0, px-tw//2):px+tw//2+1] = -1
        ax, ay = x+px, y+py
        bar = image[min(h, ay+th):min(h, ay+th+45), max(0, ax-40):min(w, ax+tw+40)]
        if bar.size == 0:
            continue
        hsv = cv2.cvtColor(bar, cv2.COLOR_BGR2HSV)
        low, high = (35, 85) if own else (85, 125)
        colour = (hsv[:, :, 0] > low) & (hsv[:, :, 0] < high) & (hsv[:, :, 1] > 80) & (hsv[:, :, 2] > 90)
        # A name in chat or a menu has no matching living hero health bar.
        if np.count_nonzero(np.sum(colour, axis=1) >= max(30, tw*.5)) < 2:
            continue
        candidates.append({'x': ax+tw/2, 'y': ay+th/2, 'confidence': float(score)})
    if not candidates or len(candidates) > 1 and candidates[0]['confidence']-candidates[1]['confidence'] < .06:
        return None
    return candidates[0]


def neighbours(cell, walk):
    x, y = cell
    h, w = walk.shape
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
        nx, ny = x + dx, y + dy
        if not (0 <= nx < w and 0 <= ny < h and walk[ny, nx]):
            continue
        if dx and dy and (not walk[y, nx] or not walk[ny, x]):
            continue
        yield (nx, ny), math.hypot(dx, dy)


def nearest(point, walk):
    h, w = walk.shape
    x, y = min(w - 1, int(point["x"] * w)), min(h - 1, int(point["y"] * h))
    options = [(math.hypot(dx, dy), (x + dx, y + dy)) for dy in range(-2, 3) for dx in range(-2, 3)
               if 0 <= x + dx < w and 0 <= y + dy < h and walk[y + dy, x + dx]]
    return min(options)[1] if options else None


def route(start, goal, walk):
    if start is None or goal is None:
        return []
    queue = [(0, start)]
    costs, parent = {start: 0}, {}
    closed = set()
    while queue:
        _, cell = heapq.heappop(queue)
        if cell in closed:
            continue
        if cell == goal:
            result = [cell]
            while cell in parent:
                cell = parent[cell]
                result.append(cell)
            return result[::-1]
        closed.add(cell)
        for nxt, step in neighbours(cell, walk):
            cost = costs[cell] + step
            if cost < costs.get(nxt, math.inf):
                costs[nxt], parent[nxt] = cost, cell
                heapq.heappush(queue, (cost + math.dist(nxt, goal), nxt))
    return []


def visible(start, end, walk):
    """Super-sampled grid segment, including both sides of diagonal corners."""
    h, w = walk.shape
    ax, ay, bx, by = start['x']*w, start['y']*h, end['x']*w, end['y']*h
    steps = max(1, math.ceil(max(abs(bx-ax), abs(by-ay))*8))
    previous = None
    for n in range(steps+1):
        x, y = int(ax+(bx-ax)*n/steps), int(ay+(by-ay)*n/steps)
        if not (0 <= x < w and 0 <= y < h and walk[y, x]):
            return False
        if previous and x != previous[0] and y != previous[1]:
            if not walk[previous[1], x] or not walk[y, previous[0]]:
                return False
        previous = x, y
    return True


def steering(own, points, walk):
    aim = points[min(1, len(points)-1)]
    # Aim beyond a single tiny cell to avoid reversing direction at every grid
    # boundary. Every shortcut is checked against walls and diagonal corners.
    for candidate in points[1:]:
        if math.dist((own['x'], own['y']), (candidate['x'], candidate['y'])) > .08:
            break
        if not visible(own, candidate, walk):
            break
        aim = candidate
    return aim


class Follower:
    def __init__(self, config, max_frame_gap=1.5):
        self.config = config
        self.max_frame_gap = max_frame_gap
        self.templates = [decode(config["selfTemplate"]), decode(config["targetTemplate"])]
        self.trackers = [Tracker(t, config['selfRotates'] if i == 0 else False,
                                 config['confidence'], max_frame_gap) for i, t in enumerate(self.templates)]
        self.marker = SelfMarker(config['selfMarker'], max_frame_gap) if config.get('selfMarker') else None
        self.labels = [white_text(decode(config['nearby'][key])) for key in ('selfLabel', 'targetLabel')] if config.get('nearby') else None
        grid = config["grid"]
        blocked = np.zeros((grid["rows"], grid["columns"]), np.uint8)
        for cell in grid["blocked"]:
            blocked.flat[cell] = 1
        radius = grid["clearance"]
        if radius:
            blocked = cv2.dilate(blocked, np.ones((radius * 2 + 1, radius * 2 + 1), np.uint8))
        self.walk = blocked == 0
        self.history = deque()
        self.hits = 0
        self.last = None
        self.last_at = 0
        self.stuck_at = 0
        self.near = False
        self.target_last = None

    def analyze(self, frame, now=None, region=None):
        began = time.monotonic()
        now = began if now is None else now
        c = self.config
        image = decode(frame)
        if region is not None:
            if not isinstance(region, dict) or any(type(region.get(key)) is not int
                                                   for key in ('x', 'y', 'width', 'height')):
                raise ValueError("裁剪区域必须包含整数像素坐标和尺寸")
            rx, ry, rw, rh = (region[key] for key in ('x', 'y', 'width', 'height'))
            if rx < 0 or ry < 0 or rw <= 0 or rh <= 0 or rx + rw > c['width'] or ry + rh > c['height']:
                raise ValueError("裁剪区域超出校准画面边界")
            if image.shape[:2] != (rh, rw):
                raise ValueError("裁剪图像尺寸与区域不一致")
            if c.get('nearby') is not None:
                raise ValueError("姓名识别需要完整画面，不能使用裁剪图像")
            r = c['map']
            left, top = math.floor(r['x'] * c['width']), math.floor(r['y'] * c['height'])
            right = min(c['width'], max(math.ceil((r['x'] + r['width']) * c['width']),
                                       round(r['x'] * c['width']) + round(r['width'] * c['width'])))
            bottom = min(c['height'], max(math.ceil((r['y'] + r['height']) * c['height']),
                                         round(r['y'] * c['height']) + round(r['height'] * c['height'])))
            if rx > left or ry > top or rx + rw < right or ry + rh < bottom:
                raise ValueError("裁剪区域必须覆盖完整小地图")
            if c['width'] * c['height'] * 3 > 24000000:
                raise ValueError("校准画面尺寸过大")
            # Preserve the existing pixel coordinates and map rounding exactly.
            canvas = np.zeros((c['height'], c['width'], 3), np.uint8)
            canvas[ry:ry+rh, rx:rx+rw] = image
            image = canvas
        if image.shape[1] != c["width"] or image.shape[0] != c["height"]:
            raise ValueError("手机分辨率或方向已改变，请重新校准")
        r = c["map"]
        x, y = round(r["x"] * c["width"]), round(r["y"] * c["height"])
        w, h = round(r["width"] * c["width"]), round(r["height"] * c["height"])
        minimap = image[y:y+h, x:x+w]
        own, target = [tracker.locate(minimap, now) for tracker in self.trackers]
        own_reliable = own and own['confidence'] >= c['confidence']
        marker = self.marker.locate(minimap, own if own_reliable else None, now) if self.marker else None
        if marker:
            own, own_reliable = marker, True
            self.trackers[0].last, self.trackers[0].at = own, now
        result = {"phase": "lost", "message": "未可靠识别自己或队友，已松开摇杆",
                  "self": own, "target": target, "path": [], "direction": None}
        if self.marker:
            result['selfSource'] = 'marker' if marker else 'template'
        valid = own_reliable and target and target['confidence'] >= c['confidence']
        if valid and math.dist((own["x"], own["y"]), (target["x"], target["y"])) < 0.015:
            valid = False
        result['source'] = 'minimap'
        if self.labels and not valid:
            nearby = c['nearby']
            names = [label_position(image, t, nearby['region'], i == 0) for i, t in enumerate(self.labels)]
            if all(names):
                dx, dy = [(names[1][axis]-names[0][axis])/nearby['pixelsPerMapUnit'] for axis in ('x', 'y')]
                distance = math.hypot(dx, dy)
                if .003 < distance < .16:
                    reliable_own = own_reliable
                    reliable_target = target and target['confidence'] >= c['confidence']
                    # One current map anchor plus two visible names recovers the
                    # occluded icon. Navigation still uses the calibrated walls.
                    if reliable_own and not reliable_target:
                        target = dict(x=own['x']+dx, y=own['y']+dy, confidence=min(n['confidence'] for n in names))
                    elif reliable_target and not reliable_own:
                        own = dict(x=target['x']-dx, y=target['y']-dy, confidence=min(n['confidence'] for n in names))
                    elif not reliable_own and not reliable_target:
                        # Without an absolute map anchor, names may prove that
                        # the teammate is already close; they never justify a
                        # blind shortcut through unknown terrain.
                        if distance <= c['stopDistance']:
                            result.update(phase='near', message='画面中已确认队友在跟随距离内', source='labels', distance=distance)
                            result['elapsedMs'] = round((time.monotonic()-began)*1000, 1)
                            return result
                    if bool(reliable_own) != bool(reliable_target) and all(0 <= point[a] <= 1 for point in (own, target) for a in ('x', 'y')):
                        valid = True
                        result.update(self=own, target=target, source='labels', distance=distance)
        if not valid:
            self.history.clear()
            # A missing frame always releases input. A brief occlusion need not
            # discard identity continuity and add another idle confirmation frame.
            if now - self.last_at > self.max_frame_gap:
                self.hits = 0
                self.last = None
                self.target_last = None
                self.near = False
        else:
            position = (own["x"], own["y"])
            target_position = (target['x'], target['y'])
            # Teleport, stale input, or a switched target require reacquisition.
            if self.last and (math.dist(self.last, position) > .2 or now - self.last_at > self.max_frame_gap
                             or self.target_last and math.dist(self.target_last, target_position) > .2):
                self.hits = 0
                self.history.clear()
                self.near = False
            self.last, self.last_at = position, now
            self.target_last = target_position
            self.hits += 1
            grid_path = route(nearest(own, self.walk), nearest(target, self.walk), self.walk)
            rows, cols = self.walk.shape
            points = [{"x": (p[0] + .5) / cols, "y": (p[1] + .5) / rows} for p in grid_path]
            result["path"] = points
            length = sum(math.dist((a["x"], a["y"]), (b["x"], b["y"])) for a, b in zip(points, points[1:]))
            result['distance'] = length
            if not points:
                result.update(phase="no-path", message="没有可行路线，请检查障碍区域")
                self.history.clear()
            elif self.hits < 2:
                result.update(phase="confirming", message="正在连续确认目标位置")
            elif length <= c["stopDistance"] + (max(.012, 1/max(rows, cols)) if self.near else 0):
                result.update(phase="near", message="已到达跟随距离")
                self.near = True
                self.history.clear()
            else:
                self.near = False
                self.history.append((now, position))
                # Retain four observations even when emulator captures are slow.
                while len(self.history) > 4 and now - self.history[0][0] > 3.5:
                    self.history.popleft()
                stuck = (len(self.history) > 3 and now - self.history[0][0] > 2.5
                         and max(math.dist(position, p) for _, p in self.history) < .012)
                if stuck:
                    self.stuck_at = now
                    self.history.clear()
                if now - self.stuck_at < 1:
                    result.update(phase="stuck", message="位置未变化，松开摇杆并重新识别路线")
                else:
                    aim = steering(own, points, self.walk)
                    dx, dy = aim["x"] - own["x"], aim["y"] - own["y"]
                    norm = math.hypot(dx, dy)
                    if norm > 1e-5:
                        result.update(phase="following", message="正在沿路线跟随",
                                      direction={"x": dx / norm, "y": dy / norm})
        result["elapsedMs"] = round((time.monotonic() - began) * 1000, 1)
        return result


def main():
    follower = None
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            op = request.get("op")
            if op == "probe":
                value = {"version": cv2.__version__}
            elif op == "configure":
                follower = Follower(request["config"], request.get("maxFrameGapMs", 1500) / 1000)
                value = {"ready": True}
            elif op == "analyze":
                if follower is None:
                    raise ValueError("请先校准小地图")
                value = follower.analyze(request["base64"], region=request.get("region"))
            else:
                raise ValueError("未知视觉请求")
            response = {"id": request.get("id"), "ok": True, "data": value}
        except Exception as error:
            response = {"id": request.get("id"), "ok": False, "error": str(error)}
        print(json.dumps(response, ensure_ascii=True, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
