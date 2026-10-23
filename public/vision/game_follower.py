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

    def locate(self, image, now, accept=None):
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
                if accept and not accept(image, found):
                    found = None
        if not found or found['confidence'] < self.confidence:
            found = match(image, self.template, self.rotates)
            if found and accept and not accept(image, found):
                found = None
        if found and found['confidence'] >= self.confidence:
            self.last, self.at = found, now
        return found


def team_arc(image, candidate, config):
    """Current calibrated team colour around the selected identity sectors.

    Identity competition happens before this gate. Colour never filters raw
    competing faces to manufacture a unique match.
    """
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    blue = ((hsv[:, :, 0] >= config['hueMin']) & (hsv[:, :, 0] <= config['hueMax'])
            & (hsv[:, :, 1] >= config['saturationMin']) & (hsv[:, :, 2] >= config['valueMin']))
    angles = np.arange(144)*2*math.pi/144
    quadrants = (np.sin(angles) >= 0)*2 + (np.cos(angles) >= 0)
    radii = config['radiusPixels'] + np.arange(-2, 3)
    xx = np.rint(candidate['x']+np.cos(angles[:, None])*radii).astype(int)
    yy = np.rint(candidate['y']+np.sin(angles[:, None])*radii).astype(int)
    inside = (xx >= 0) & (xx < image.shape[1]) & (yy >= 0) & (yy < image.shape[0])
    values = np.zeros_like(inside)
    values[inside] = blue[yy[inside], xx[inside]]
    selected = np.isin(quadrants, candidate['quadrants'])
    matched = np.any(values, axis=1) & selected
    if np.count_nonzero(matched)/max(1, np.count_nonzero(selected)) < .4:
        return False
    longest = run = 0
    for value in np.tile(matched, 2):
        run = run+1 if value else 0
        longest = max(longest, run)
    return min(longest, 144)*2.5 >= 80


class TargetRing:
    """Opt-in team evidence for full portraits, including tracked candidates.

    This does not enable partial-face inference or use history as team evidence.
    A rejected current candidate must not update the portrait tracker's anchor.
    """
    def __init__(self, template, config):
        self.config = config
        if config['radiusPixels']-2 <= max(template.shape[:2])/2:
            raise ValueError("队友颜色圆弧应位于头像模板外侧，请重新校准半径")

    def accept(self, image, found):
        x, y = found['x']*image.shape[1], found['y']*image.shape[0]
        if not team_arc(image, dict(x=x, y=y, quadrants=(0, 1, 2, 3)), self.config):
            return False
        # A neighbouring blue icon can overlap a red enemy ring. Retain the
        # measured private full-avatar gate's red veto rather than treating a
        # blue fragment as sufficient evidence that an otherwise red icon is ally.
        radius = self.config['radiusPixels']
        left, top = max(0, math.floor(x-radius-2)), max(0, math.floor(y-radius-2))
        right = min(image.shape[1], math.ceil(x+radius+3))
        bottom = min(image.shape[0], math.ceil(y+radius+3))
        yy, xx = np.mgrid[top:bottom, left:right]
        distance = (xx-x)**2+(yy-y)**2
        annulus = (distance >= (radius-2)**2) & (distance <= (radius+2)**2)
        hsv = cv2.cvtColor(image[top:bottom, left:right], cv2.COLOR_BGR2HSV)
        red = (((hsv[:, :, 0] <= 10) | (hsv[:, :, 0] >= 170))
               & (hsv[:, :, 1] >= 110) & (hsv[:, :, 2] >= 100))
        return np.count_nonzero(red & annulus)/max(1, np.count_nonzero(annulus)) <= .15


class TargetPartial:
    """Current partial identity plus team colour and a calibrated living HUD.

    Every frame must pass the same fixed gates, even when the ordinary complete
    template wins. History only confirms three consecutive measurements; it
    never supplies a missing coordinate or filters global identity competitors.
    """
    shapes = [tuple(j for j in range(4) if j != i) for i in range(4)] + [
        (0, 1), (2, 3), (0, 2), (1, 3)]

    def __init__(self, template, config, width, height, max_gap):
        h, w = template.shape[:2]
        if h != w or w < 9 or w > 129 or w % 2 != 1 or float(template.std()) < 6:
            raise ValueError("部分头像需要 9–129 像素的奇数边长方形彩色模板")
        self.template, self.width, self.config, self.max_gap = template, w, config, max_gap
        if config['ring']['radiusPixels'] - 2 <= w / 2:
            raise ValueError("队友颜色圆弧应位于头像模板外侧，请重新校准半径")
        yy, xx = np.indices((h, w))
        quadrants = (yy >= h//2)*2 + (xx >= w//2)
        circle = np.zeros((h, w), np.uint8)
        cv2.ellipse(circle, (w//2, h//2), (w//2-1, h//2-1), 0, 0, 360, 1, -1)
        self.prepared = []
        for quadrant in range(4):
            binary = np.repeat(((circle > 0) & (quadrants == quadrant)).astype(np.float32)[:, :, None], 3, axis=2)
            masked = template.astype(np.float32) * binary
            self.prepared.append((binary, masked, float(np.sum(masked*masked))))
        self.angles = np.arange(144)*2*math.pi/144
        self.angle_quadrants = (np.sin(self.angles) >= 0)*2 + (np.cos(self.angles) >= 0)
        alive = config['alive']
        self.portrait = decode(alive['portraitTemplate'])
        self.hud_regions = []
        for key in ('portraitRegion', 'healthBarRegion'):
            r = alive[key]
            x, y, rw, rh = round(r['x']*width), round(r['y']*height), round(r['width']*width), round(r['height']*height)
            if x < 0 or y < 0 or rw < 3 or rh < 3 or x+rw > width or y+rh > height:
                raise ValueError("队友存活提示区域尺寸或边界无效")
            self.hud_regions.append((x, y, rw, rh))
        _, _, pw, ph = self.hud_regions[0]
        if self.portrait.shape[:2] != (ph, pw) or min(pw, ph) < 12 or float(self.portrait.std()) < 6:
            raise ValueError("队友顶部头像模板与校准区域尺寸不一致")
        self.portrait_mask = np.zeros((ph, pw), np.uint8)
        cv2.ellipse(self.portrait_mask, (pw//2, ph//2), (max(1, pw//2-4), max(1, ph//2-4)), 0, 0, 360, 255, -1)
        self.history = deque(maxlen=3)
        self.last_time = None

    def alive(self, frame):
        x, y, w, h = self.hud_regions[0]
        portrait = frame[y:y+h, x:x+w]
        score = 1-float(cv2.matchTemplate(portrait, self.portrait, cv2.TM_SQDIFF_NORMED, mask=self.portrait_mask)[0, 0])
        hsv = cv2.cvtColor(portrait, cv2.COLOR_BGR2HSV)
        colour = (hsv[:, :, 1] >= 50) & (hsv[:, :, 2] >= 50) & (self.portrait_mask != 0)
        if not math.isfinite(score) or score < .9 or np.count_nonzero(colour) < np.count_nonzero(self.portrait_mask)*.1:
            return False
        x, y, w, h = self.hud_regions[1]
        hsv = cv2.cvtColor(frame[y:y+h, x:x+w], cv2.COLOR_BGR2HSV)
        ring = self.config['ring']
        blue = ((hsv[:, :, 0] >= ring['hueMin']) & (hsv[:, :, 0] <= ring['hueMax'])
                & (hsv[:, :, 1] >= ring['saturationMin']) & (hsv[:, :, 2] >= 100))
        return np.count_nonzero(np.sum(blue, axis=1) >= max(8, w*.5)) >= 2

    def candidate(self, image):
        if min(image.shape[:2]) < self.width:
            return None
        pixels = image.astype(np.float32)
        squared = pixels*pixels
        quarters, energies, differences, template_energies = [], [], [], []
        for binary, masked, energy in self.prepared:
            sums = cv2.matchTemplate(squared, binary, cv2.TM_CCORR)
            cross = cv2.matchTemplate(pixels, masked, cv2.TM_CCORR)
            difference = np.maximum(0, sums+energy-2*cross)
            quarters.append(1-difference/np.sqrt(np.maximum(sums*energy, 1e-9)))
            energies.append(sums); differences.append(difference); template_energies.append(energy)
        raw, valid = [], []
        for indices in self.shapes:
            scores = 1-sum(differences[i] for i in indices)/np.sqrt(np.maximum(
                sum(energies[i] for i in indices)*sum(template_energies[i] for i in indices), 1e-9))
            scores = np.nan_to_num(scores, nan=-1, posinf=-1, neginf=-1)
            raw.append(scores)
            filtered = scores.copy()
            filtered[np.minimum.reduce([quarters[i] for i in indices]) < .95] = -1
            valid.append(filtered)
        combined = np.maximum.reduce(valid)
        _, score, _, (x, y) = cv2.minMaxLoc(combined)
        if score < .97:
            return None
        shape = max(range(len(self.shapes)), key=lambda i: float(valid[i][y, x]))
        # Compete against RAW scores for all shapes, including candidates rejected
        # by quadrant/colour/HUD gates. Filtering them would fake uniqueness.
        second = np.maximum.reduce(raw)
        yy, xx = np.ogrid[:second.shape[0], :second.shape[1]]
        second[(xx-x)**2+(yy-y)**2 < (self.width*.61)**2] = -1
        if score-float(second.max()) < .04:
            return None
        return {'x': x+self.width/2, 'y': y+self.width/2, 'confidence': float(min(1, score)),
                'quadrants': self.shapes[shape]}

    def team_arc(self, image, candidate):
        return team_arc(image, candidate, self.config['ring'])

    def locate(self, image, frame, now):
        previous = self.last_time
        self.last_time = now
        if not math.isfinite(now) or previous is not None and now <= previous:
            self.history.clear()
            return None
        if previous is not None and now-previous > self.max_gap:
            self.history.clear()
        candidate = self.candidate(image) if self.alive(frame) else None
        if candidate is None or not self.team_arc(image, candidate):
            self.history.clear()
            return None
        if self.history:
            at, old = self.history[-1]
            delta = math.hypot((candidate['x']-old['x'])/image.shape[1], (candidate['y']-old['y'])/image.shape[0])
            if delta > .035+.18*(now-at):
                self.history.clear()
        self.history.append((now, candidate))
        if len(self.history) < 3 or now-self.history[0][0] > 3:
            return None
        return {'x': candidate['x']/image.shape[1], 'y': candidate['y']/image.shape[0],
                'confidence': candidate['confidence']}


class SelfMarker:
    """An opt-in coloured ring can continue a recently verified self identity.

    Each position is measured in the current image. The marker must first agree
    with the avatar template; it cannot initialize identity or reacquire after a
    long gap. A colour blob, an incomplete arc, or multiple plausible rings do
    not authorize movement.
    """
    def __init__(self, config, max_gap):
        self.config = config
        self.max_gap = min(max_gap, 1.5) if config.get('partialArc') else max_gap
        self.last, self.at, self.offset = None, 0, None
        self.angles = np.linspace(0, 2*math.pi, 72, endpoint=False)
        if config.get('partialArc'):
            radius = config['radiusPixels']
            extent = math.ceil(radius+6)
            yy, xx = np.mgrid[-extent:extent+1, -extent:extent+1]
            self.arc_kernel = (np.abs(np.hypot(xx, yy)-radius) <= 1.8).astype(np.float32)
            angles = np.arange(144)*math.pi/72
            self.arc_cos, self.arc_sin = np.cos(angles), np.sin(angles)

    def partial_arcs(self, image):
        """Fit the calibrated radius to CURRENT colour pixels over the whole map.

        Geometry alone is not identity. locate() still requires a recent full
        avatar anchor, current displacement and uniqueness before using it.
        Competing raw peaks are retained even if their arc checks fail.
        """
        c = self.config
        radius = c['radiusPixels']
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        mask = ((hsv[:, :, 0] >= c['hueMin']) & (hsv[:, :, 0] <= c['hueMax'])
                & (hsv[:, :, 1] >= c['saturationMin']) & (hsv[:, :, 2] >= c['valueMin']))
        votes = cv2.filter2D(mask.astype(np.float32), -1, self.arc_kernel, borderType=cv2.BORDER_CONSTANT)
        h, w = mask.shape
        def hits(x, y, radii):
            xx = np.rint(x+self.arc_cos[:, None]*np.asarray(radii)).astype(int)
            yy = np.rint(y+self.arc_sin[:, None]*np.asarray(radii)).astype(int)
            inside = (xx >= 0) & (xx < w) & (yy >= 0) & (yy < h)
            values = np.zeros_like(inside)
            values[inside] = mask[yy[inside], xx[inside]]
            return values.any(axis=1)
        candidates = []
        suppression = max(3, round(radius*10/24))
        for _ in range(12):
            _, score, _, (x, y) = cv2.minMaxLoc(votes)
            if score < 55*radius/24:
                break
            votes[max(0, y-suppression):y+suppression+1, max(0, x-suppression):x+suppression+1] = -1
            support = hits(x, y, radius+np.array([-1.5, -.5, .5, 1.5]))
            longest = run = 0
            for value in np.tile(support, 2):
                run = run+1 if value else 0
                longest = max(longest, run)
            count = int(np.count_nonzero(support))
            quadrants = [int(np.count_nonzero(part)) for part in np.split(support, 4)]
            valid = (min(longest, 144)*2.5 >= 100 and count >= 44
                     and sum(count >= 8 for count in quadrants) >= 2
                     and np.count_nonzero(hits(x, y, [radius*.65])) <= 36
                     and np.count_nonzero(hits(x, y, [radius*1.3])) <= 36)
            candidates.append(dict(x=x, y=y, score=score, confidence=count/144, valid=valid))
        eligible = [p for p in candidates if p['valid']]
        if not eligible:
            return []
        best = max(eligible, key=lambda p: p['score'])
        competitors = [p['score'] for p in candidates
                       if math.hypot(p['x']-best['x'], p['y']-best['y']) >= max(5, radius*15/24)]
        if best['score']-max(competitors, default=0) < 25*radius/24:
            return []
        return [dict(x=best['x']/w, y=best['y']/h, confidence=best['confidence'])]

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
        if self.config.get('partialArc'):
            # Global competition must happen before the recent-identity filter;
            # cropping first could make a second visible marker disappear.
            candidates = self.partial_arcs(image)
        else:
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
        self.partial = TargetPartial(self.templates[1], config['targetPartial'], config['width'], config['height'], max_frame_gap) if config.get('targetPartial') else None
        ring = config.get('targetRing')
        if ring is None and config.get('targetPartial'):
            ring = config['targetPartial']['ring']
        self.target_ring = TargetRing(self.templates[1], ring) if ring is not None else None
        self.camera = None
        self.self_camera = None
        if config.get('cameraAssist') or config.get('selfCameraAssist'):
            # Also supports offline callers loading this worker by absolute path.
            import importlib.util
            from pathlib import Path
            spec = importlib.util.spec_from_file_location('game_follow_camera', Path(__file__).with_name('game_follow_camera.py'))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            if config.get('cameraAssist'):
                self.camera = module.CameraLocator(config)
            if config.get('selfCameraAssist'):
                self.self_camera = module.CameraLocator(config, 'selfCameraAssist')
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

    def analyze(self, frame, now=None, region=None, cameraContext=None):
        try:
            return self._analyze(frame, now, region, cameraContext)
        except Exception:
            # Invalid frame metadata or pixels also break strict consecutiveness.
            # Preview callers can submit another frame after an analysis error.
            if self.partial:
                self.partial.history.clear()
                self.partial.last_time = None
            raise

    def _analyze(self, frame, now=None, region=None, cameraContext=None):
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
            if self.partial:
                raise ValueError("部分队友识别需要完整画面中的存活提示，不能使用裁剪图像")
            if self.camera or self.self_camera:
                raise ValueError("镜头辅助需要完整画面")
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
        own = self.trackers[0].locate(minimap, now)
        target = self.trackers[1].locate(minimap, now, self.target_ring.accept if self.target_ring else None)
        own_reliable = own and own['confidence'] >= c['confidence']
        marker = self.marker.locate(minimap, own if own_reliable else None, now) if self.marker else None
        if marker:
            own, own_reliable = marker, True
            self.trackers[0].last, self.trackers[0].at = own, now
        self_source = 'marker' if marker else 'template'
        # Both camera identities use this exact frame/context independently.
        # Complete current name/HP evidence does not teach either portrait or
        # marker history, and its confidence is not an avatar-template score.
        camera_own = self.self_camera.locate(image, cameraContext) if self.self_camera and cameraContext and not own_reliable else None
        if camera_own:
            own = dict(x=(camera_own['x']-x)/w, y=(camera_own['y']-y)/h,
                       confidence=camera_own['confidence'])
            own_reliable, self_source = True, 'camera'
        target_source = 'template'
        target_reliable = target and target['confidence'] >= c['confidence']
        # Maintain strict partial evidence on every frame, without replacing a
        # reliable complete avatar or teaching the complete tracker partial history.
        partial = self.partial.locate(minimap, image, now) if self.partial else None
        if not target_reliable and partial:
            target, target_reliable, target_source = partial, True, 'partial'
        # The host supplies a context only when this frame proves the previously
        # acknowledged camera hold. This current-image path never teaches the
        # portrait tracker a projected position or reuses an old name location.
        camera_target = self.camera.locate(image, cameraContext) if self.camera and cameraContext else None
        if not target_reliable and camera_target:
            target = dict(x=(camera_target['x']-x)/w, y=(camera_target['y']-y)/h,
                          confidence=camera_target['confidence'])
            target_reliable = True
            target_source = 'camera'
        result = {"phase": "lost", "message": "未可靠识别自己或队友，已松开摇杆",
                  "self": own, "selfSource": self_source, "target": target, "targetSource": target_source,
                  "path": [], "direction": None}
        valid = own_reliable and target_reliable
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
                    reliable_target = target_reliable
                    # One current map anchor plus two visible names recovers the
                    # occluded icon. Navigation still uses the calibrated walls.
                    if reliable_own and not reliable_target:
                        target = dict(x=own['x']+dx, y=own['y']+dy, confidence=min(n['confidence'] for n in names))
                        result['targetSource'] = 'labels'
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
                value = follower.analyze(request["base64"], region=request.get("region"), cameraContext=request.get('cameraContext'))
            else:
                raise ValueError("未知视觉请求")
            response = {"id": request.get("id"), "ok": True, "data": value}
        except Exception as error:
            response = {"id": request.get("id"), "ok": False, "error": str(error)}
        print(json.dumps(response, ensure_ascii=True, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
