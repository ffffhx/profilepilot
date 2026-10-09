package io.github.profilepilot.phone;

import java.util.List;

/** Conservative, one-shot input policy for a user-requested Settings shortcut. */
final class DebuggingSetup {
    enum Setting {
        WIRELESS("无线调试", "toggle_adb_wireless", "无线调试", "無線偵錯", "無線調試", "Wireless debugging"),
        USB("USB 调试", "enable_adb", "USB 调试", "USB 偵錯", "USB 調試", "USB debugging");
        final String label, preferenceKey;
        private final List<String> titles;
        Setting(String label, String preferenceKey, String... titles) {
            this.label = label;
            this.preferenceKey = preferenceKey;
            this.titles = List.of(titles);
        }
        boolean matches(String title) { return titles.stream().anyMatch(value -> value.equalsIgnoreCase(title)); }
    }
    static final int ALREADY_ENABLED = -2;
    record Node(int parent, String text, String id, boolean toggle, boolean checked,
                boolean enabled, boolean clickable) { }

    static boolean dialog(List<Node> nodes) {
        return nodes.stream().anyMatch(node -> node.id.equals("android:id/button1")
            || node.id.equals("android:id/button2") || node.id.equals("android:id/button3"));
    }

    /** Return only the switch or its own clickable container, never a neighboring preference. */
    static int target(List<Node> nodes, Setting setting) {
        if (dialog(nodes)) return -1;
        int title = -1;
        for (int i = 0; i < nodes.size(); i++) {
            Node node = nodes.get(i);
            if (node.id.equals("android:id/title") && setting.matches(node.text)) {
                if (title != -1) return -1;
                title = i;
            }
        }
        if (title < 0) return -1;
        for (int row = nodes.get(title).parent; row >= 0; row = nodes.get(row).parent) {
            int titles = 0, switches = 0, toggle = -1;
            for (int i = 0; i < nodes.size(); i++) if (inside(nodes, i, row)) {
                if (nodes.get(i).id.equals("android:id/title")) titles++;
                if (nodes.get(i).toggle) { switches++; toggle = i; }
            }
            if (titles != 1 || switches > 1) return -1;
            if (switches == 0) continue;
            Node state = nodes.get(toggle);
            if (state.checked) return ALREADY_ENABLED;
            if (!state.enabled) return -1;
            for (int input = toggle; input >= 0; input = nodes.get(input).parent) {
                Node candidate = nodes.get(input);
                if (!candidate.enabled) return -1;
                if (candidate.clickable) return input;
                if (input == row) break;
            }
            return -1;
        }
        return -1;
    }

    private static boolean inside(List<Node> nodes, int child, int parent) {
        for (int i = child; i >= 0; i = nodes.get(i).parent) if (i == parent) return true;
        return false;
    }

    static final class Request {
        private final SessionState owner;
        private final long generation, deadline;
        private final boolean remote;
        private boolean consumed;
        Request(SessionState owner, long now) {
            this(owner, now, 6000);
        }
        Request(SessionState owner, long now, long duration) {
            this.owner = owner;
            if (owner != null) owner.expire();
            generation = owner == null ? 0 : owner.generation;
            remote = owner != null && owner.active();
            deadline = now + duration;
        }
        boolean valid(SessionState current, long now, boolean unlocked) {
            if (current != null) current.expire();
            return !consumed && now < deadline && unlocked && current == owner
                && (current == null || current.generation == generation)
                && (!remote || (current.active() && current.mode.equals("control")));
        }
        boolean consume(SessionState current, long now, boolean unlocked) {
            boolean allowed = valid(current, now, unlocked);
            consumed = true; // An uncertain result must never be retried.
            return allowed;
        }
    }
}
