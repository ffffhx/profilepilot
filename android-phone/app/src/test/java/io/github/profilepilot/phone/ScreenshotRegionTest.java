package io.github.profilepilot.phone;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;

public class ScreenshotRegionTest {
    private JSONObject input() throws Exception {
        return new JSONObject().put("x", 40).put("y", 30).put("width", 425).put("height", 425);
    }
    @Test public void preservesNativePixelBoundsAndAllowsExactScreenEdges() throws Exception {
        ScreenshotRegion region = ScreenshotRegion.from(input());
        region.requireWithin(2772, 1240);
        assertEquals(40, region.x()); assertEquals(425, region.width());
        assertEquals(region, ScreenshotRegion.from(region.toJson()));
        new ScreenshotRegion(0, 0, 2772, 1240).requireWithin(2772, 1240);
        new ScreenshotRegion(2771, 1239, 1, 1).requireWithin(2772, 1240);
    }
    @Test public void rejectsOutOfBoundsInsteadOfClampingOrChangingCoordinates() {
        for (ScreenshotRegion region : new ScreenshotRegion[] {
            new ScreenshotRegion(2772, 0, 1, 1), new ScreenshotRegion(0, 1240, 1, 1),
            new ScreenshotRegion(2500, 0, 425, 425), new ScreenshotRegion(0, 1000, 425, 425),
            new ScreenshotRegion(Integer.MAX_VALUE, 0, Integer.MAX_VALUE, 1),
            new ScreenshotRegion(1, 0, Integer.MAX_VALUE, 1) })
            assertThrows(IllegalArgumentException.class, () -> region.requireWithin(2772, 1240));
        assertThrows(IllegalArgumentException.class, () -> new ScreenshotRegion(0, 0, 1, 1).requireWithin(0, 1));
    }
    @Test public void rejectsFractionalCoercedEmptyOrUnexpectedRequestValues() throws Exception {
        for (Object value : new Object[] { -1, 0, .5, "425", true, JSONObject.NULL, 1e30 }) {
            JSONObject invalid = input().put("width", value);
            assertThrows(IllegalArgumentException.class, () -> ScreenshotRegion.from(invalid));
        }
        assertThrows(IllegalArgumentException.class, () -> ScreenshotRegion.from(input().put("unexpected", 1)));
        JSONObject missing = input(); missing.remove("x");
        assertThrows(IllegalArgumentException.class, () -> ScreenshotRegion.from(missing));
        assertThrows(IllegalArgumentException.class, () -> new ScreenshotRegion(-1, 0, 1, 1));
    }
}
