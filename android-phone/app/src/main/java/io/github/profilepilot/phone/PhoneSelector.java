package io.github.profilepilot.phone;

import android.content.Context;
import android.view.accessibility.AccessibilityNodeInfo;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Resolves against the current native tree in the same request that performs an action. */
final class PhoneSelector {
    static final int MAX_NODES = 5000;
    static final int MAX_DEPTH = 70;
    private static final Set<String> STRINGS = Set.of("ref", "resourceId", "text", "description", "className", "packageName");
    private static final Set<String> BOOLEANS = Set.of("enabled", "checked", "editable", "clickable", "scrollable");

    private record MatchedNode(AccessibilityNodeInfo node, String ref) { }

    private final Context context;
    private final JSONObject selector;
    private final String expectedRef;
    private final boolean refreshNodes;
    private final List<MatchedNode> matches = new ArrayList<>();
    private int visited;
    private int refCounter;

    PhoneSelector(JSONObject selector, boolean refreshNodes) throws Exception {
        this(null, selector, refreshNodes);
    }

    PhoneSelector(Context context, JSONObject selector, boolean refreshNodes) throws Exception {
        if (selector.length() == 0) throw new IllegalArgumentException("定位条件不能为空");
        String normalizedRef = null;
        for (Iterator<String> keys = selector.keys(); keys.hasNext();) {
            String key = keys.next(); Object value = selector.get(key);
            if (STRINGS.contains(key)) {
                if (!(value instanceof String) || ((String) value).length() > 500
                        || (!key.equals("text") && ((String) value).isEmpty())) throw new IllegalArgumentException("定位文本无效");
                if (key.equals("ref")) {
                    String rawRef = ((String) value).trim();
                    if (!rawRef.matches("^@?e[1-9][0-9]{0,4}$")) throw new IllegalArgumentException("控件引用格式无效");
                    normalizedRef = rawRef.startsWith("@") ? rawRef : "@" + rawRef;
                }
            } else if (!BOOLEANS.contains(key) || !(value instanceof Boolean)) throw new IllegalArgumentException("不支持的定位条件：" + key);
        }
        this.context = context;
        this.selector = selector;
        this.expectedRef = normalizedRef;
        this.refreshNodes = refreshNodes;
    }

    Object execute(AccessibilityNodeInfo root, JSONObject action) throws Exception {
        return execute(List.of(root), action);
    }

    Object execute(List<AccessibilityNodeInfo> roots, JSONObject action) throws Exception {
        try {
            for (AccessibilityNodeInfo root : roots) {
                visit(root, 0);
            }
            String kind = action.getString("kind");
            if (kind.equals("find")) {
                JSONArray nodes = new JSONArray();
                for (MatchedNode item : matches) {
                    JSONObject described = PhoneAccessibility.describe(item.node);
                    if (!item.ref.isEmpty()) described.put("ref", item.ref);
                    nodes.put(described);
                }
                return new JSONObject().put("count", nodes.length()).put("matches", nodes);
            }
            if (matches.isEmpty()) throw new IllegalStateException("未找到匹配控件，请重新观察页面");
            if (matches.size() != 1) throw new IllegalStateException("定位条件匹配多个控件（" + matches.size() + "），请增加条件");
            MatchedNode target = matches.get(0);
            AccessibilityNodeInfo node = target.node;
            if (!node.refresh() || !node.isVisibleToUser() || !matches(node, target.ref)) throw new IllegalStateException("目标控件已变化，请重新观察页面");
            if (!node.isEnabled()) throw new IllegalStateException("目标控件已禁用");
            if (kind.equals("fill")) {
                Object raw = action.get("text");
                if (!(raw instanceof String) || ((String) raw).length() > 2000) throw new IllegalArgumentException("文本长度超出范围");
                if (!node.isEditable()) throw new IllegalStateException("目标不是可编辑输入框");
                if (!PhoneAccessibility.replaceNodeText(context, node, (String) raw)) {
                    throw new IllegalStateException("此输入框不支持文字替换");
                }
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
        } finally {
            for (MatchedNode item : matches) item.node.recycle();
            matches.clear();
        }
    }

    private void visit(AccessibilityNodeInfo node, int depth) throws Exception {
        if (++visited > MAX_NODES || depth > MAX_DEPTH) throw new IllegalStateException("界面过大，无法完整确认定位结果");
        if (refreshNodes && !node.refresh()) throw new IllegalStateException("控件树正在变化，请重新观察页面");
        if (!node.isVisibleToUser()) return;
        String ref = PhoneAccessibility.isMeaningfulNode(node) ? "@e" + (++refCounter) : "";
        if (matches(node, ref)) matches.add(new MatchedNode(AccessibilityNodeInfo.obtain(node), ref));
        if (node.isPassword()) return;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) throw new IllegalStateException("控件树不完整，请重新观察页面");
            try { visit(child, depth + 1); } finally { child.recycle(); }
        }
    }

    private boolean matches(AccessibilityNodeInfo node, String currentRef) throws Exception {
        if (expectedRef != null && !expectedRef.equals(currentRef)) return false;
        for (Iterator<String> keys = selector.keys(); keys.hasNext();) {
            String key = keys.next();
            if (key.equals("ref")) continue;
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
