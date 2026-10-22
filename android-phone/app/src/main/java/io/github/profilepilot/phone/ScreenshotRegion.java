package io.github.profilepilot.phone;

import org.json.JSONException;
import org.json.JSONObject;

/** Native pixel bounds only. Region captures never change the screen coordinate system. */
record ScreenshotRegion(int x, int y, int width, int height) {
    ScreenshotRegion {
        if (x < 0 || y < 0 || width <= 0 || height <= 0)
            throw new IllegalArgumentException("截图区域必须使用有效的整数像素范围");
    }
    static ScreenshotRegion from(JSONObject value) throws JSONException {
        if (value.length() != 4) throw new IllegalArgumentException("截图区域参数无效");
        return new ScreenshotRegion(integer(value.get("x")), integer(value.get("y")),
            integer(value.get("width")), integer(value.get("height")));
    }
    private static int integer(Object value) {
        if (!(value instanceof Number number)) throw new IllegalArgumentException("截图区域必须使用整数像素");
        double n = number.doubleValue();
        if (!Double.isFinite(n) || n != Math.floor(n) || n < 0 || n > Integer.MAX_VALUE)
            throw new IllegalArgumentException("截图区域必须使用有效的整数像素范围");
        return (int) n;
    }
    void requireWithin(int screenWidth, int screenHeight) {
        // Subtraction avoids overflow for untrusted coordinates near Integer.MAX_VALUE.
        if (screenWidth <= 0 || screenHeight <= 0 || x >= screenWidth || y >= screenHeight
            || width > screenWidth - x || height > screenHeight - y)
            throw new IllegalArgumentException("截图区域超出当前原始画面");
    }
    JSONObject toJson() throws JSONException {
        return new JSONObject().put("x", x).put("y", y).put("width", width).put("height", height);
    }
}
