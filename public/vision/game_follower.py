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


class Follower:
    def __init__(self, config):
        self.config = config
        self.templates = [decode(config["selfTemplate"]), decode(config["targetTemplate"])]
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

    def analyze(self, frame, now=None):
        began = time.monotonic()
        now = began if now is None else now
        c = self.config
        image = decode(frame)
        if image.shape[1] != c["width"] or image.shape[0] != c["height"]:
            raise ValueError("手机分辨率或方向已改变，请重新校准")
        r = c["map"]
        x, y = round(r["x"] * c["width"]), round(r["y"] * c["height"])
        w, h = round(r["width"] * c["width"]), round(r["height"] * c["height"])
        minimap = image[y:y+h, x:x+w]
        own = match(minimap, self.templates[0], c["selfRotates"])
        target = match(minimap, self.templates[1])
        result = {"phase": "lost", "message": "未可靠识别自己或队友，已松开摇杆",
                  "self": own, "target": target, "path": [], "direction": None}
        valid = own and target and min(own["confidence"], target["confidence"]) >= c["confidence"]
        if valid and math.dist((own["x"], own["y"]), (target["x"], target["y"])) < 0.015:
            valid = False
        if not valid:
            self.hits = 0
            self.history.clear()
            self.last = None
        else:
            position = (own["x"], own["y"])
            # Teleport, stale input, or a switched target require reacquisition.
            if self.last and (math.dist(self.last, position) > .2 or now - self.last_at > 1.5):
                self.hits = 0
                self.history.clear()
            self.last, self.last_at = position, now
            self.hits += 1
            grid_path = route(nearest(own, self.walk), nearest(target, self.walk), self.walk)
            rows, cols = self.walk.shape
            points = [{"x": (p[0] + .5) / cols, "y": (p[1] + .5) / rows} for p in grid_path]
            result["path"] = points
            length = sum(math.dist((a["x"], a["y"]), (b["x"], b["y"])) for a, b in zip(points, points[1:]))
            if not points:
                result.update(phase="no-path", message="没有可行路线，请检查障碍区域")
                self.history.clear()
            elif self.hits < 2:
                result.update(phase="confirming", message="正在连续确认目标位置")
            elif length <= c["stopDistance"]:
                result.update(phase="near", message="已到达跟随距离")
                self.history.clear()
            else:
                self.history.append((now, position))
                while self.history and now - self.history[0][0] > 3.5:
                    self.history.popleft()
                stuck = (len(self.history) > 3 and now - self.history[0][0] > 2.5
                         and max(math.dist(position, p) for _, p in self.history) < .012)
                if stuck:
                    self.stuck_at = now
                    self.history.clear()
                if now - self.stuck_at < 1:
                    result.update(phase="stuck", message="位置未变化，松开摇杆并重新识别路线")
                else:
                    # Stay on the first grid edge; do not cut across corners.
                    aim = points[min(1, len(points) - 1)]
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
                follower = Follower(request["config"])
                value = {"ready": True}
            elif op == "analyze":
                if follower is None:
                    raise ValueError("请先校准小地图")
                value = follower.analyze(request["base64"])
            else:
                raise ValueError("未知视觉请求")
            response = {"id": request.get("id"), "ok": True, "data": value}
        except Exception as error:
            response = {"id": request.get("id"), "ok": False, "error": str(error)}
        print(json.dumps(response, ensure_ascii=True, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
