package io.github.profilepilot.phone;

import static org.junit.Assert.*;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Run this same class on API 30-32 (node-refresh fallback) and API 33+ (clearCache).
 * The test never enables services or changes device settings. UiAutomation explicitly leaves
 * enabled accessibility services running. Android may terminate the target's existing service
 * when starting instrumentation; an isolated-device harness can rebind that already enabled
 * service externally after the BENCHMARK_ACCESSIBILITY_WAITING status marker. Missing service
 * setup is a test failure, never a skipped test or a passing run with no assertions executed.
 */
@RunWith(AndroidJUnit4.class)
public final class AccessibilitySnapshotTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private final Context context = instrumentation.getTargetContext();
    private ActivityScenario<ControlBenchmarkActivity> activity;
    private PhoneAccessibility service;

    private interface Condition { boolean ready() throws Exception; }

    @Before public void openFixtureWithoutSuppressingService() throws Exception {
        assertNotNull(instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES));
        activity = ActivityScenario.launch(new Intent(context, ControlBenchmarkActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("bench_reset", true));
        awaitView(R.id.bench_open_form);
        awaitServiceInitialization();
        // Only initial window/service attachment is polled. Assertions after actions below use
        // exactly one snapshot, so retrying cannot conceal stale accessibility-cache entries.
        await("benchmark window initialization", () -> {
            try { return optionalNode(snapshot(), R.id.bench_open_form) != null; }
            catch (Exception unavailableDuringAttach) { return false; }
        });
    }

    private void awaitServiceInitialization() {
        long timeout = Long.parseLong(InstrumentationRegistry.getArguments()
                .getString("accessibilityServiceTimeoutMs", "30000"));
        assertTrue("accessibilityServiceTimeoutMs must be between 1 and 120000", timeout > 0 && timeout <= 120000);
        if (PhoneAccessibility.current == null) {
            String marker = "BENCHMARK_ACCESSIBILITY_WAITING: fixture is ready; waiting for the "
                    + "isolated-device harness to bind PhoneAccessibility after instrumentation startup.";
            Log.i("AccessibilitySnapshot", marker);
            Bundle status = new Bundle();
            status.putString("stream", "\n" + marker + "\n");
            instrumentation.sendStatus(2, status);
        }
        long deadline = SystemClock.elapsedRealtime() + timeout;
        while (PhoneAccessibility.current == null && SystemClock.elapsedRealtime() < deadline) {
            SystemClock.sleep(25);
        }
        service = PhoneAccessibility.current;
        assertNotNull("PhoneAccessibility did not bind. Instrumentation can force-stop the target "
                + "service at startup; the isolated-device harness must rebind it after "
                + "BENCHMARK_ACCESSIBILITY_WAITING. No freshness assertions have run.", service);
    }

    @After public void closeFixture() {
        if (activity != null) activity.close();
    }

    @Test public void textReplacementIsVisibleInTheVeryNextSnapshot() throws Exception {
        click(R.id.bench_open_form);
        awaitView(R.id.bench_input);
        JSONObject initial = snapshot();
        assertEquals("", node(initial, R.id.bench_input).getString("text"));
        assertText(initial, R.id.bench_mirror, "Mirror: (empty)");
        assertTrue(node(initial, R.id.bench_input).getBoolean("editable"));
        tap(node(initial, R.id.bench_input));
        await("input focus", () -> {
            AtomicBoolean focused = new AtomicBoolean();
            activity.onActivity(a -> focused.set(a.findViewById(R.id.bench_input).hasFocus()));
            return focused.get();
        });
        String previous = "";
        for (String value : new String[]{
                "https://example.test/api?mode=debug&count=12", "蓝牙测试", "Replacement complete"}) {
            perform(new JSONObject().put("kind", "text").put("text", value));
            // Confirm the actual UI mutation completed, then assert the first snapshot immediately.
            activity.onActivity(a -> assertEquals(value,
                    ((EditText) a.findViewById(R.id.bench_input)).getText().toString()));
            JSONObject fresh = snapshot();
            assertText(fresh, R.id.bench_input, value);
            assertText(fresh, R.id.bench_mirror, "Mirror: " + value);
            assertText(fresh, R.id.bench_form_status, "Form status: editing");
            if (!previous.isEmpty()) assertFalse("Old text survived replacement", fresh.toString().contains(previous));
            previous = value;
        }
    }

    @Test public void counterCheckboxAndDisabledStateAreFresh() throws Exception {
        click(R.id.bench_open_state);
        awaitView(R.id.bench_increment);
        JSONObject initial = snapshot();
        assertText(initial, R.id.bench_counter, "Counter: 0");
        assertFalse(node(initial, R.id.bench_checkbox).getBoolean("checked"));
        assertTrue(node(initial, R.id.bench_checkbox).getBoolean("checkable"));
        assertFalse(node(initial, R.id.bench_disabled).getBoolean("enabled"));
        for (int count = 1; count <= 4; count++) {
            click(R.id.bench_increment);
            assertText(snapshot(), R.id.bench_counter, "Counter: " + count);
        }
        click(R.id.bench_checkbox);
        JSONObject checked = snapshot();
        assertTrue(node(checked, R.id.bench_checkbox).getBoolean("checked"));
        assertText(checked, R.id.bench_checkbox_status, "Checkbox: checked");
        click(R.id.bench_checkbox);
        JSONObject unchecked = snapshot();
        assertFalse(node(unchecked, R.id.bench_checkbox).getBoolean("checked"));
        assertText(unchecked, R.id.bench_checkbox_status, "Checkbox: unchecked");
    }

    @Test public void scrollDropsOldRowsAndExposesNewRowsThenOpensDetail() throws Exception {
        click(R.id.bench_open_list);
        awaitView(R.id.bench_case_01);
        JSONObject initial = snapshot();
        assertText(initial, R.id.bench_case_01, "Case 01");
        assertNull(optionalNode(initial, R.id.bench_case_30));
        assertTrue(node(initial, R.id.bench_list).getBoolean("scrollable"));
        Set<String> initialRows = visibleRowIds(initial);
        swipeList(initial);
        JSONObject afterSwipe = snapshot();
        assertNull("Offscreen Case 01 was retained in the snapshot", optionalNode(afterSwipe, R.id.bench_case_01));
        Set<String> introduced = visibleRowIds(afterSwipe);
        introduced.removeAll(initialRows);
        assertFalse("No newly visible rows after a completed swipe", introduced.isEmpty());
        assertVisibleRowsMatchUi(afterSwipe);
        JSONObject current = afterSwipe;
        for (int attempt = 0; optionalNode(current, R.id.bench_case_30) == null && attempt < 10; attempt++) {
            swipeList(current);
            current = snapshot();
            assertVisibleRowsMatchUi(current);
        }
        JSONObject target = node(current, R.id.bench_case_30);
        tap(target);
        awaitView(R.id.bench_detail);
        JSONObject detail = snapshot();
        assertText(detail, R.id.bench_detail, "Detail: Case 30");
        assertNull(optionalNode(detail, R.id.bench_list));
        click(R.id.bench_back_to_list);
        awaitView(R.id.bench_list);
        JSONObject returned = snapshot();
        assertNotNull(node(returned, R.id.bench_case_30));
        assertNull(optionalNode(returned, R.id.bench_detail));
    }

    @Test public void passwordIsMaskedInSnapshot() throws Exception {
        click(R.id.bench_open_state);
        awaitView(R.id.bench_password);
        JSONObject current = snapshot();
        JSONObject password = node(current, R.id.bench_password);
        assertTrue(password.getBoolean("password"));
        assertEquals("[密码]", password.getString("text"));
        assertEquals("", password.getString("description"));
        // This ordinary EditText verifies masking throughout the returned
        // snapshot; it does not simulate a password node with virtual children.
        assertFalse("Synthetic secret leaked into the snapshot", current.toString()
                .contains(context.getString(R.string.bench_synthetic_password)));
        JSONObject found = find(selector(R.id.bench_password));
        assertEquals(1, found.getInt("count"));
        assertEquals("[密码]", found.getJSONArray("matches").getJSONObject(0).getString("text"));
        assertEquals(0, find(new JSONObject().put("text", context.getString(R.string.bench_synthetic_password))).getInt("count"));
    }

    @Test public void selectorClickUsesFreshTextAndCheckedState() throws Exception {
        select("click", selector(R.id.bench_open_state));
        awaitView(R.id.bench_increment);
        select("click", new JSONObject().put("text", "Increment counter").put("clickable", true));
        assertEquals(1, find(selector(R.id.bench_counter).put("text", "Counter: 1")).getInt("count"));
        select("click", selector(R.id.bench_checkbox).put("checked", false));
        assertEquals(1, find(selector(R.id.bench_checkbox).put("checked", true)).getInt("count"));
        assertEquals(0, find(selector(R.id.bench_checkbox).put("checked", false)).getInt("count"));
        activity.onActivity(a -> {
            assertEquals("Counter: 1", ((TextView) a.findViewById(R.id.bench_counter)).getText().toString());
            assertTrue(((CompoundButton) a.findViewById(R.id.bench_checkbox)).isChecked());
        });
    }

    @Test public void selectorFillReplacesChineseAndClearsWithoutFocus() throws Exception {
        select("click", selector(R.id.bench_open_form));
        awaitView(R.id.bench_input);
        activity.onActivity(a -> a.findViewById(R.id.bench_root).requestFocus());
        for (String value : new String[]{"蓝牙测试 & API=1", ""}) {
            perform(new JSONObject().put("kind", "fill").put("selector", selector(R.id.bench_input)).put("text", value));
            activity.onActivity(a -> assertEquals(value, ((EditText) a.findViewById(R.id.bench_input)).getText().toString()));
            assertEquals(1, find(selector(R.id.bench_input).put("text", value).put("editable", true)).getInt("count"));
            assertText(snapshot(), R.id.bench_mirror, value.isEmpty() ? "Mirror: (empty)" : "Mirror: " + value);
        }
    }

    @Test public void selectorRefusesAmbiguousMissingAndDisabledTargets() throws Exception {
        assertEquals(4, find(new JSONObject().put("className", "android.widget.Button")).getInt("count"));
        assertRejected("click", new JSONObject().put("className", "android.widget.Button"), "多个控件");
        assertRejected("click", new JSONObject().put("text", "not a fixture control"), "未找到");
        assertNotNull(node(snapshot(), R.id.bench_open_state));
        select("click", selector(R.id.bench_open_state));
        awaitView(R.id.bench_disabled);
        assertRejected("click", selector(R.id.bench_disabled), "已禁用");
        assertText(snapshot(), R.id.bench_counter, "Counter: 0");
    }

    @Test public void selectorScrollFindsOffscreenRowAndOpensDetail() throws Exception {
        select("click", selector(R.id.bench_open_list));
        awaitView(R.id.bench_list);
        JSONObject target = selector(R.id.bench_case_30).put("text", "Case 30");
        assertEquals(0, find(target).getInt("count"));
        int scrolls = 0;
        while (find(target).getInt("count") == 0 && scrolls++ < 10) {
            JSONObject result = (JSONObject) perform(new JSONObject().put("kind", "scroll")
                    .put("selector", selector(R.id.bench_list).put("scrollable", true)).put("direction", "forward"));
            assertTrue("Scroll should progress before Case 30", result.getBoolean("performed"));
            instrumentation.waitForIdleSync();
        }
        assertEquals(1, find(target).getInt("count"));
        select("click", target);
        awaitView(R.id.bench_detail);
        assertText(snapshot(), R.id.bench_detail, "Detail: Case 30");
    }

    private JSONObject selector(int id) throws Exception {
        return new JSONObject().put("resourceId", context.getResources().getResourceName(id));
    }

    private JSONObject find(JSONObject selector) throws Exception {
        return (JSONObject) perform(new JSONObject().put("kind", "find").put("selector", selector));
    }

    private void select(String kind, JSONObject selector) throws Exception {
        JSONObject result = (JSONObject) perform(new JSONObject().put("kind", kind).put("selector", selector));
        assertTrue(result.getBoolean("performed"));
        instrumentation.waitForIdleSync();
    }

    private void assertRejected(String kind, JSONObject selector, String message) throws Exception {
        try {
            perform(new JSONObject().put("kind", kind).put("selector", selector));
            fail("Selector unexpectedly performed an action");
        } catch (java.util.concurrent.ExecutionException expected) {
            assertTrue(expected.getCause().getMessage(), expected.getCause().getMessage().contains(message));
        }
    }

    @Test public void dialogReplacesTheActiveRootAndDismissalRestoresThePage() throws Exception {
        click(R.id.bench_open_state);
        awaitView(R.id.bench_open_dialog);
        JSONObject page = snapshot();
        int pageWindow = page.getInt("windowId");
        click(R.id.bench_open_dialog);
        await("dialog window focus", () -> {
            AtomicBoolean hasFocus = new AtomicBoolean();
            activity.onActivity(a -> hasFocus.set(a.hasWindowFocus()));
            return !hasFocus.get();
        });
        JSONObject opened = snapshot();
        assertNotEquals("Snapshot retained the old active window", pageWindow, opened.getInt("windowId"));
        assertText(opened, R.id.bench_dialog_message, "Confirm a local benchmark action?");
        assertNull(optionalNode(opened, R.id.bench_counter));
        tap(node(opened, android.R.id.button1));
        await("dialog dismissal", () -> {
            AtomicBoolean restored = new AtomicBoolean();
            activity.onActivity(a -> restored.set(a.hasWindowFocus()
                    && ((TextView) a.findViewById(R.id.bench_dialog_result)).getText()
                    .toString().equals("Dialog result: confirmed")));
            return restored.get();
        });
        JSONObject returned = snapshot();
        assertEquals(pageWindow, returned.getInt("windowId"));
        assertText(returned, R.id.bench_dialog_result, "Dialog result: confirmed");
        assertNull(optionalNode(returned, R.id.bench_dialog_message));
    }

    private Object perform(JSONObject action) throws Exception {
        AtomicReference<CompletableFuture<Object>> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> result.set(service.perform(action)));
        return result.get().get(5, TimeUnit.SECONDS);
    }

    private JSONObject snapshot() throws Exception {
        JSONObject result = (JSONObject) perform(new JSONObject().put("kind", "snapshot"));
        assertEquals(context.getPackageName(), result.getString("package"));
        return result;
    }

    private void click(int id) {
        activity.onActivity(a -> {
            View control = a.findViewById(id);
            assertNotNull("Missing fixture control " + id, control);
            assertTrue("Fixture control is disabled " + id, control.isEnabled());
            assertTrue("Fixture control is not clickable " + id, control.isClickable());
            boolean previouslyChecked = control instanceof CompoundButton
                    && ((CompoundButton) control).isChecked();
            // CompoundButton toggles before delegating to View.performClick(); its return value
            // can be false when no OnClickListener is registered, even though the toggle succeeded.
            control.performClick();
            if (control instanceof CompoundButton) {
                assertEquals("Native checkbox did not toggle", !previouslyChecked,
                        ((CompoundButton) control).isChecked());
            }
        });
        instrumentation.waitForIdleSync();
    }

    private void tap(JSONObject target) throws Exception {
        JSONArray bounds = target.getJSONArray("bounds");
        perform(new JSONObject().put("kind", "tap")
                .put("x", (bounds.getInt(0) + bounds.getInt(2)) / 2)
                .put("y", (bounds.getInt(1) + bounds.getInt(3)) / 2));
        instrumentation.waitForIdleSync();
    }

    private void swipeList(JSONObject current) throws Exception {
        JSONArray bounds = node(current, R.id.bench_list).getJSONArray("bounds");
        int x = (bounds.getInt(0) + bounds.getInt(2)) / 2;
        int top = bounds.getInt(1), bottom = bounds.getInt(3);
        int margin = Math.max(20, (bottom - top) / 10);
        perform(new JSONObject().put("kind", "swipe").put("x", x).put("y", bottom - margin)
                .put("toX", x).put("toY", top + margin).put("duration", 500));
        instrumentation.waitForIdleSync();
        activity.onActivity(a -> assertTrue("The completed gesture did not scroll the actual view",
                ((ScrollView) a.findViewById(R.id.bench_list)).getScrollY() > 0));
    }

    private void awaitView(int id) throws Exception {
        await("fixture view " + id, () -> {
            AtomicBoolean ready = new AtomicBoolean();
            activity.onActivity(a -> {
                View view = a.findViewById(id);
                ready.set(view != null && view.isShown() && view.getWidth() > 0);
            });
            return ready.get();
        });
        instrumentation.waitForIdleSync();
    }

    private void await(String description, Condition condition) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 3000;
        do {
            if (condition.ready()) return;
            SystemClock.sleep(25);
        } while (SystemClock.elapsedRealtime() < deadline);
        fail("Timed out waiting for " + description);
    }

    private JSONObject optionalNode(JSONObject snapshot, int resource) throws Exception {
        String id = context.getResources().getResourceName(resource);
        JSONArray nodes = snapshot.getJSONArray("nodes");
        for (int i = 0; i < nodes.length(); i++) {
            JSONObject node = nodes.getJSONObject(i);
            if (id.equals(node.optString("resourceId"))) return node;
        }
        return null;
    }

    private JSONObject node(JSONObject snapshot, int resource) throws Exception {
        JSONObject result = optionalNode(snapshot, resource);
        assertNotNull("Missing node/resourceId " + context.getResources().getResourceName(resource), result);
        assertFalse(result.getString("resourceId").isEmpty());
        return result;
    }

    private void assertText(JSONObject snapshot, int resource, String text) throws Exception {
        assertEquals(text, node(snapshot, resource).getString("text"));
    }

    private Set<String> visibleRowIds(JSONObject snapshot) throws Exception {
        Set<String> result = new HashSet<>();
        JSONArray nodes = snapshot.getJSONArray("nodes");
        for (int i = 0; i < nodes.length(); i++) {
            String id = nodes.getJSONObject(i).optString("resourceId");
            if (id.contains(":id/bench_case_")) result.add(id);
        }
        return result;
    }

    private void assertVisibleRowsMatchUi(JSONObject snapshot) throws Exception {
        Set<String> expected = new HashSet<>();
        activity.onActivity(a -> {
            android.view.ViewGroup rows = a.findViewById(R.id.bench_rows);
            for (int i = 0; i < rows.getChildCount(); i++) {
                View row = rows.getChildAt(i);
                Rect visible = new Rect();
                if (row.getGlobalVisibleRect(visible) && !visible.isEmpty()) {
                    expected.add(context.getResources().getResourceName(row.getId()));
                }
            }
        });
        assertEquals("Snapshot rows differ from the completed native scroll position",
                expected, visibleRowIds(snapshot));
    }
}
