package io.github.profilepilot.phone;

import android.os.Bundle;
import android.view.accessibility.AccessibilityNodeInfo;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Resolves against the current native tree in the same request that performs an action. */
final class PhoneSelector {
    private static final Set<String> STRINGS = Set.of("resourceId", "text", "description", "className", "packageName");
    private static final Set<String> BOOLEANS = Set.of("enabled", "checked", "editable", "clickable", "scrollable");
    private final JSONObject selector;
    private final boolean refreshNodes;
    private final List<AccessibilityNodeInfo> matches = new ArrayList<>();
    private int visited;

    PhoneSelector(JSONObject selector, boolean refreshNodes) throws Exception {
        if (selector.length() == 0) throw new IllegalArgumentException("定位条件不能为空");
        for (Iterator<String> keys = selector.keys(); keys.hasNext();) {
            String key = keys.next(); Object value = selector.get(key);
            if (STRINGS.contains(key)) {
                if (!(value instanceof String) || ((String) value).length() > 500
                        || (!key.equals("text") && ((String) value).isEmpty())) throw new IllegalArgumentException("定位文本无效");
            } else if (!BOOLEANS.contains(key) || !(value instanceof Boolean)) throw new IllegalArgumentException("不支持的定位条件：" + key);
        }
        this.selector = selector; this.refreshNodes = refreshNodes;
    }

    Object execute(AccessibilityNodeInfo root, JSONObject action) throws Exception {
        try {
            visit(root, 0);
            String kind = action.getString("kind");
            if (kind.equals("find")) {
                JSONArray nodes = new JSONArray();
                for (AccessibilityNodeInfo node : matches) nodes.put(PhoneAccessibility.describe(node));
                return new JSONObject().put("count", nodes.length()).put("matches", nodes);
            }
            if (matches.isEmpty()) throw new IllegalStateException("未找到匹配控件，请重新观察页面");
            if (matches.size() != 1) throw new IllegalStateException("定位条件匹配多个控件（" + matches.size() + "），请增加条件");
            AccessibilityNodeInfo node = matches.get(0);
            if (!node.refresh() || !node.isVisibleToUser() || !matches(node)) throw new IllegalStateException("目标控件已变化，请重新观察页面");
            if (!node.isEnabled()) throw new IllegalStateException("目标控件已禁用");
            if (kind.equals("fill")) {
                Object raw = action.get("text");
                if (!(raw instanceof String) || ((String) raw).length() > 2000) throw new IllegalArgumentException("文本长度超出范围");
                if (!node.isEditable()) throw new IllegalStateException("目标不是可编辑输入框");
                Bundle args = new Bundle(); args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, (String) raw);
                if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) throw new IllegalStateException("此输入框不支持文字替换");
                return new JSONObject().put("performed", true);
            }
            if (kind.equals("click")) {
                // Labels often belong to a clickable row. Only use its nearest enabled ancestor.
                AccessibilityNodeInfo candidate = AccessibilityNodeInfo.obtain(node);
                try {
                    for (int level = 0; candidate != null && level < 8; level++) {
                        if (!candidate.refresh() || !candidate.isVisibleToUser() || !candidate.isEnabled()) break;
                        if (candidate.isClickable()) {
                            if (!candidate.performAction(AccessibilityNodeInfo.ACTION_CLICK)) throw new IllegalStateException("系统未接受控件点击，不会重试或改用坐标");
                            return new JSONObject().put("performed", true);
                        }
                        AccessibilityNodeInfo parent = candidate.getParent(); candidate.recycle(); candidate = parent;
                    }
                } finally { if (candidate != null) candidate.recycle(); }
                throw new IllegalStateException("控件及其父级不支持点击");
            }
            if (kind.equals("scroll")) {
                String direction = action.getString("direction");
                if (!direction.equals("forward") && !direction.equals("backward")) throw new IllegalArgumentException("滚动方向无效");
                if (!node.isScrollable()) throw new IllegalStateException("目标不是可滚动容器");
                boolean performed = node.performAction(direction.equals("forward")
                        ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD);
                return new JSONObject().put("performed", performed);
            }
            throw new IllegalArgumentException("不支持此定位操作");
        } finally { for (AccessibilityNodeInfo node : matches) node.recycle(); matches.clear(); }
    }

    private void visit(AccessibilityNodeInfo node, int depth) throws Exception {
        if (++visited > 800 || depth > 40) throw new IllegalStateException("界面过大，无法完整确认定位结果");
        if (refreshNodes && !node.refresh()) throw new IllegalStateException("控件树正在变化，请重新观察页面");
        if (!node.isVisibleToUser()) return;
        if (matches(node)) matches.add(AccessibilityNodeInfo.obtain(node));
        if (node.isPassword()) return;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) throw new IllegalStateException("控件树不完整，请重新观察页面");
            try { visit(child, depth + 1); } finally { child.recycle(); }
        }
    }

    private boolean matches(AccessibilityNodeInfo node) throws Exception {
        for (Iterator<String> keys = selector.keys(); keys.hasNext();) {
            String key = keys.next();
            Object actual = switch (key) {
                case "resourceId" -> string(node.getViewIdResourceName());
                case "text" -> node.isPassword() ? "[密码]" : string(node.getText());
                case "description" -> node.isPassword() ? "" : string(node.getContentDescription());
                case "className" -> string(node.getClassName());
                case "packageName" -> string(node.getPackageName());
                case "enabled" -> node.isEnabled();
                case "checked" -> node.isChecked();
                case "editable" -> node.isEditable();
                case "clickable" -> node.isClickable();
                case "scrollable" -> node.isScrollable();
                default -> null;
            };
            if (key.equals("checked") && !node.isCheckable() || !selector.get(key).equals(actual)) return false;
        }
        return true;
    }
    private static String string(CharSequence value) { return value == null ? "" : value.toString(); }
}
