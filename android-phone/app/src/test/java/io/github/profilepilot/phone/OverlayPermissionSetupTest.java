package io.github.profilepilot.phone;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.Test;
import static org.junit.Assert.*;
import io.github.profilepilot.phone.DebuggingSetup.Node;
import io.github.profilepilot.phone.OverlayPermissionSetup.Kind;
import io.github.profilepilot.phone.OverlayPermissionSetup.Target;

public class OverlayPermissionSetupTest {
    private static final String APP = "ProfilePilot 移动版", PACKAGE = "io.github.profilepilot.phone";
    private Node text(int parent, String text, String id, boolean clickable) {
        return new Node(parent, text, id, false, false, true, clickable);
    }
    private List<Node> detail(boolean checked) {
        return new ArrayList<>(List.of(
            text(-1, "", "", false),
            text(0, "显示在其他应用的上层", "com.android.settings:id/action_bar_title", false),
            text(0, APP, "com.android.settings:id/entity_header_title", false),
            text(0, "", "", true),
            text(3, "允许显示在其他应用的上层", "android:id/title", false),
            new Node(3, "", "android:id/switch_widget", true, checked, true, true)));
    }
    private List<Node> appList() {
        return new ArrayList<>(List.of(
            text(-1, "", "", false),
            text(0, "显示在其他应用的上层", "com.android.settings:id/action_bar_title", false),
            text(0, "", "", true),
            text(2, "其他应用", "android:id/title", false),
            text(0, "", "", true),
            text(4, APP, "android:id/title", false)));
    }
    private Target target(List<Node> nodes) { return OverlayPermissionSetup.target(nodes, APP, PACKAGE); }
    @Test public void opensOnlyOwnRowOnAndroid11ApplicationList() {
        assertEquals(new Target(Kind.OPEN_APP, 4), target(appList()));
    }
    @Test public void enablesOnlyOwnExplicitOverlaySwitch() {
        assertEquals(new Target(Kind.ENABLE, 5), target(detail(false)));
        List<Node> nodes = detail(false);
        nodes.set(5, new Node(3, "", "android:id/switch_widget", true, false, true, false));
        assertEquals(new Target(Kind.ENABLE, 3), target(nodes));
    }
    @Test public void acceptsEnglishDetailLabels() {
        List<Node> nodes = detail(false);
        nodes.set(1, text(0, "Display over other apps", "com.android.settings:id/action_bar_title", false));
        nodes.set(4, text(3, "Allow display over other apps", "android:id/title", false));
        assertEquals(Kind.ENABLE, target(nodes).kind());
    }
    @Test public void recognizesRealmeOverlayPermissionForDevelopmentApp() {
        List<Node> nodes = detail(false);
        nodes.set(1, text(0, "悬浮窗", "", false));
        nodes.set(2, text(0, "ProfilePilot 开发版", "com.android.settings:id/entity_header_title", false));
        nodes.set(4, text(3, "授予悬浮窗权限", "android:id/title", false));
        nodes.set(5, new Node(3, "关闭", "android:id/switch_widget", true, false, true, false));
        assertEquals(new Target(Kind.ENABLE, 3), OverlayPermissionSetup.target(nodes,
            "ProfilePilot 开发版", PACKAGE + ".debug"));
        assertEquals(Kind.NONE, target(nodes).kind());
        nodes.set(5, new Node(3, "开启", "android:id/switch_widget", true, true, true, false));
        assertEquals(Kind.NONE, OverlayPermissionSetup.target(nodes,
            "ProfilePilot 开发版", PACKAGE + ".debug").kind());
    }
    @Test public void distinguishesDevelopmentAndOriginalAppInSameList() {
        List<Node> nodes = appList();
        nodes.set(3, text(2, "ProfilePilot 开发版", "android:id/title", false));
        assertEquals(new Target(Kind.OPEN_APP, 2), OverlayPermissionSetup.target(nodes,
            "ProfilePilot 开发版", PACKAGE + ".debug"));
        assertEquals(new Target(Kind.OPEN_APP, 4), target(nodes));
    }
    @Test public void doesNotDisableCheckedSwitchOrClickDisabledSwitch() {
        assertEquals(Kind.NONE, target(detail(true)).kind());
        List<Node> nodes = detail(false);
        nodes.set(5, new Node(3, "", "android:id/switch_widget", true, false, false, true));
        assertEquals(Kind.NONE, target(nodes).kind());
    }
    @Test public void rejectsOtherAppAndUnrelatedPermissionOnOwnDetailPage() {
        List<Node> nodes = detail(false);
        nodes.set(2, text(0, "其他应用", "com.android.settings:id/entity_header_title", false));
        assertEquals(Kind.NONE, target(nodes).kind());
        nodes = detail(false);
        nodes.set(4, text(3, "允许安装未知应用", "android:id/title", false));
        assertEquals(Kind.NONE, target(nodes).kind());
    }
    @Test public void rejectsOwnAppNameWithoutRecognizedDetailHeader() {
        List<Node> nodes = detail(false);
        nodes.set(2, text(0, APP, "android:id/title", false));
        assertEquals(Kind.NONE, target(nodes).kind());
    }
    @Test public void genericAllowPermissionLabelNeedsExplicitOverlayPage() {
        List<Node> nodes = detail(false);
        nodes.set(4, text(3, "Allow permission", "android:id/title", false));
        assertEquals(Kind.ENABLE, target(nodes).kind());
        nodes.set(1, text(0, "Install unknown apps", "", false));
        assertEquals(Kind.NONE, target(nodes).kind());
    }
    @Test public void rejectsMultipleSwitchesAndSystemConfirmation() {
        List<Node> nodes = detail(false);
        nodes.add(new Node(0, "", "", true, false, true, true));
        assertEquals(Kind.NONE, target(nodes).kind());
        nodes = detail(false);
        nodes.add(text(0, "允许", "android:id/button1", true));
        assertEquals(Kind.NONE, target(nodes).kind());
    }
    @Test public void duplicatedAppOrNoOverlayPageCannotBeSelected() {
        List<Node> nodes = appList();
        nodes.add(text(0, APP, "android:id/title", true));
        assertEquals(Kind.NONE, target(nodes).kind());
        nodes = appList();
        nodes.set(1, text(0, "应用管理", "", false));
        assertEquals(Kind.NONE, target(nodes).kind());
    }
    @Test public void neverClicksListSwitchOrNeighboringAppContainer() {
        List<Node> nodes = appList();
        nodes.add(new Node(4, "", "", true, false, true, true));
        assertEquals(Kind.NONE, target(nodes).kind());
        nodes = appList();
        nodes.set(4, text(0, "", "", false));
        nodes.set(0, text(-1, "", "", true));
        assertEquals(Kind.NONE, target(nodes).kind());
    }
    @Test public void switchRowCannotAbsorbUnrelatedPreference() {
        List<Node> nodes = detail(false);
        nodes.set(4, text(0, "允许显示在其他应用的上层", "android:id/title", false));
        assertEquals(Kind.NONE, target(nodes).kind());
    }
    @Test public void navigationAndToggleCanEachBeDispatchedOnlyOnce() {
        OverlayPermissionSetup.Request request = new OverlayPermissionSetup.Request(null, 0);
        assertTrue(request.consume(Kind.OPEN_APP, null, 100, true));
        assertFalse(request.consume(Kind.OPEN_APP, null, 200, true));
        assertTrue(request.consume(Kind.ENABLE, null, 300, true));
        assertFalse(request.consume(Kind.ENABLE, null, 400, true));
        assertFalse(request.consume(Kind.OPEN_APP, null, 400, true));
        assertTrue(request.valid(null, 500, true)); // Still observe actual permission; click is not success.
    }
    @Test public void directDetailCannotReturnToListAfterToggle() {
        OverlayPermissionSetup.Request request = new OverlayPermissionSetup.Request(null, 0);
        assertTrue(request.consume(Kind.ENABLE, null, 100, true));
        assertFalse(request.consume(Kind.OPEN_APP, null, 200, true));
    }
    @Test public void expiredLockedOrChangedSessionCannotClick() {
        OverlayPermissionSetup.Request request = new OverlayPermissionSetup.Request(null, 0);
        assertFalse(request.consume(Kind.ENABLE, null, 100, false));
        assertFalse(request.consume(Kind.ENABLE, null, OverlayPermissionSetup.REQUEST_TIMEOUT_MS, true));
        AtomicLong clock = new AtomicLong(1);
        SessionState session = new SessionState(clock::get);
        session.start(session.instanceId, 0, UUID.randomUUID().toString(), "control", "pc", "agent", "setup", 1);
        request = new OverlayPermissionSetup.Request(session, 0);
        assertTrue(request.consume(Kind.OPEN_APP, session, 100, true));
        session.pause("takeover");
        assertFalse(request.consume(Kind.ENABLE, session, 200, true));
        session.resume();
        assertFalse(request.consume(Kind.ENABLE, session, 300, true));
        assertFalse(request.consume(Kind.ENABLE, null, 400, true));
    }
    @Test public void searchesRecognizedApplicationListOnlyWhenOwnEntryIsOffscreen() {
        List<Node> nodes = appList();
        assertEquals(Kind.NONE, OverlayPermissionSetup.scrollTarget(nodes, 0, APP, PACKAGE).kind());
        nodes.set(5, text(4, "第二个应用", "android:id/title", false));
        assertEquals(Kind.SCROLL_APP_LIST, OverlayPermissionSetup.scrollTarget(nodes, 0, APP, PACKAGE).kind());
        nodes.set(1, text(0, "应用管理", "", false));
        assertEquals(Kind.NONE, OverlayPermissionSetup.scrollTarget(nodes, 0, APP, PACKAGE).kind());
        assertEquals(Kind.NONE, OverlayPermissionSetup.scrollTarget(detail(false), 0, APP, PACKAGE).kind());
    }
    @Test public void scrollingNeverClicksOrTogglesNeighboringApps() {
        List<Node> nodes = appList();
        nodes.set(5, text(4, "第二个应用", "android:id/title", false));
        nodes.add(new Node(4, "", "", true, false, true, true));
        assertEquals(Kind.NONE, OverlayPermissionSetup.scrollTarget(nodes, 0, APP, PACKAGE).kind());
    }
    @Test public void scrollRequiresChangedPageAndSettlingTimeAndHasAHardLimit() {
        OverlayPermissionSetup.Request request = new OverlayPermissionSetup.Request(null, 0);
        assertTrue(request.consumeScroll("page0", null, 100, true));
        assertFalse(request.consumeScroll("page0", null, 1000, true));
        assertFalse(request.consumeScroll("page1", null, 200, true));
        for (int i = 1; i < OverlayPermissionSetup.MAX_SCROLLS; i++)
            assertTrue(request.consumeScroll("page" + i, null, i * 1000, true));
        long finished = OverlayPermissionSetup.MAX_SCROLLS * 1000L;
        assertFalse(request.consumeScroll("limit", null, finished, true));
        assertTrue(request.consume(Kind.OPEN_APP, null, finished + 500, true));
        assertFalse(request.consumeScroll("later", null, finished + 1000, true));
        assertTrue(request.consume(Kind.ENABLE, null, finished + 1500, true));
        assertFalse(request.consume(Kind.ENABLE, null, finished + 1600, true));
    }
    @Test public void reachesLatinAppAfterMoreThanEightPagesAndSlowSettingsTransitions() {
        OverlayPermissionSetup.Request request = new OverlayPermissionSetup.Request(null, 0);
        for (int page = 0; page < 12; page++)
            assertTrue(request.consumeScroll("Chinese apps " + page, null, 100 + page * 1600L, true));
        assertTrue(request.consume(Kind.OPEN_APP, null, 21000, true));
        assertTrue(request.consume(Kind.ENABLE, null, 23000, true));
    }
}
