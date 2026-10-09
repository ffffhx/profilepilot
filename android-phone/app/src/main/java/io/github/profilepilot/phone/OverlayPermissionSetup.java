package io.github.profilepilot.phone;

import java.util.List;
import io.github.profilepilot.phone.DebuggingSetup.Node;

/** Recognize only our entry in overlay settings, or our app's overlay switch. */
final class OverlayPermissionSetup {
    enum Kind { NONE, OPEN_APP, ENABLE, SCROLL_APP_LIST }
    record Target(Kind kind, int index) { }
    static final Target NONE = new Target(Kind.NONE, -1);
    private static final List<String> LABELS = List.of(
        "Display over other apps", "Allow display over other apps", "Draw over other apps",
        "Appear on top", "Permit drawing over other apps", "显示在其他应用的上层", "在其他应用上层显示",
        "允许显示在其他应用的上层", "允许在其他应用上层显示", "允许显示在其他应用上层",
        "悬浮窗", "悬浮窗权限", "显示悬浮窗", "允许显示悬浮窗", "允许悬浮窗",
        "顯示在其他應用程式上層", "允許顯示在其他應用程式上層");

    private static boolean overlayLabel(String text) {
        return LABELS.stream().anyMatch(label -> label.equalsIgnoreCase(text.trim()));
    }

    private static boolean switchLabel(String text) {
        return overlayLabel(text) || "Allow permission".equalsIgnoreCase(text.trim());
    }

    private static boolean appHeader(Node node) {
        return node.id().endsWith(":id/entity_header_title") || node.id().endsWith(":id/app_name")
            || node.id().endsWith(":id/app_label") || node.id().endsWith(":id/app_title");
    }

    /** Only scroll a recognized overlay application list while our app is off-screen. */
    static Target scrollTarget(List<Node> nodes, int container, String appLabel, String appPackage) {
        if (container < 0 || container >= nodes.size() || DebuggingSetup.dialog(nodes)) return NONE;
        if (nodes.stream().noneMatch(node -> overlayLabel(node.text()))) return NONE;
        int titles = 0;
        for (int i = 0; i < nodes.size(); i++) {
            Node node = nodes.get(i);
            if (appHeader(node) || appLabel.equals(node.text()) || appPackage.equals(node.text())) return NONE;
            if (!inside(nodes, i, container)) continue;
            if (node.toggle()) return NONE;
            if (node.id().equals("android:id/title")) {
                if (node.text().isBlank()) return NONE;
                int row = clickable(nodes, i, container);
                if (row < 0 || row == container) return NONE;
                titles++;
            }
        }
        return titles >= 2 ? new Target(Kind.SCROLL_APP_LIST, container) : NONE;
    }

    static String pageFingerprint(List<Node> nodes) {
        StringBuilder result = new StringBuilder();
        for (Node node : nodes) if (node.id().equals("android:id/title")) result.append(node.text()).append('\n');
        return result.toString();
    }

    static Target target(List<Node> nodes, String appLabel, String appPackage) {
        if (DebuggingSetup.dialog(nodes)) return NONE;
        int own = -1;
        boolean overlayPage = false;
        for (int i = 0; i < nodes.size(); i++) {
            Node node = nodes.get(i);
            overlayPage |= overlayLabel(node.text());
            if (appLabel.equals(node.text()) || appPackage.equals(node.text())) {
                // A duplicated name is ambiguous (e.g. work profile, search results).
                if (own >= 0) return NONE;
                own = i;
            }
        }
        if (own < 0 || !overlayPage) return NONE;
        Node identity = nodes.get(own);
        boolean header = appHeader(identity);
        if (header) {
            // Detail pages must have a single switch and an explicit overlay label in its row.
            int toggle = -1;
            for (int i = 0; i < nodes.size(); i++) if (nodes.get(i).toggle()) {
                if (toggle >= 0) return NONE;
                toggle = i;
            }
            if (toggle < 0 || nodes.get(toggle).checked() || !nodes.get(toggle).enabled()) return NONE;
            for (int row = toggle; row >= 0; row = nodes.get(row).parent()) {
                // Never treat the whole page (including the app header) as a switch row.
                if (inside(nodes, own, row)) return NONE;
                boolean labelled = false;
                for (int i = 0; i < nodes.size(); i++) if (inside(nodes, i, row)) {
                    Node child = nodes.get(i);
                    if (switchLabel(child.text())) labelled = true;
                    else if (child.id().equals("android:id/title") && !child.text().isBlank()) return NONE;
                }
                if (labelled) {
                    int input = clickable(nodes, toggle, row);
                    return input < 0 ? NONE : new Target(Kind.ENABLE, input);
                }
            }
            return NONE;
        }
        if (!identity.id().equals("android:id/title")) return NONE;
        // Android 11+ may open the application list despite the package URI.
        // Click only our exact, unique row. A switch in a list is never changed.
        for (int row = own; row >= 0; row = nodes.get(row).parent()) {
            int titles = 0;
            for (int i = 0; i < nodes.size(); i++) if (inside(nodes, i, row)) {
                Node child = nodes.get(i);
                if (child.toggle()) return NONE;
                if (child.id().equals("android:id/title")) titles++;
            }
            if (titles != 1 || !nodes.get(row).enabled()) return NONE;
            if (nodes.get(row).clickable()) return new Target(Kind.OPEN_APP, row);
        }
        return NONE;
    }

    private static boolean inside(List<Node> nodes, int child, int ancestor) {
        for (int i = child; i >= 0; i = nodes.get(i).parent()) if (i == ancestor) return true;
        return false;
    }

    private static int clickable(List<Node> nodes, int child, int ancestor) {
        for (int i = child; i >= 0; i = nodes.get(i).parent()) {
            if (!nodes.get(i).enabled()) return -1;
            if (nodes.get(i).clickable()) return i;
            if (i == ancestor) break;
        }
        return -1;
    }

    static final class Request {
        private final DebuggingSetup.Request lifetime;
        private boolean openedApp, toggled;
        private int scrolls;
        private String lastPage;
        private long lastScrollAt;
        Request(SessionState owner, long now) { lifetime = new DebuggingSetup.Request(owner, now, 18000); }
        boolean valid(SessionState owner, long now, boolean unlocked) { return lifetime.valid(owner, now, unlocked); }
        boolean consume(Kind kind, SessionState owner, long now, boolean unlocked) {
            if (!valid(owner, now, unlocked) || toggled || kind == Kind.NONE || kind == Kind.SCROLL_APP_LIST) return false;
            if (kind == Kind.OPEN_APP) {
                if (openedApp) return false;
                openedApp = true;
            } else toggled = true;
            return true; // Mark before dispatch: never retry an uncertain click.
        }
        boolean consumeScroll(String page, SessionState owner, long now, boolean unlocked) {
            if (!valid(owner, now, unlocked) || openedApp || toggled || scrolls >= 8
                || page.isBlank() || page.equals(lastPage) || (scrolls > 0 && now - lastScrollAt < 700)) return false;
            lastPage = page;
            lastScrollAt = now;
            scrolls++;
            return true;
        }
    }
}
