package io.github.profilepilot.phone;

import java.util.Arrays;
import java.util.stream.Collectors;

/** Only remove our own component; never replace a concurrently edited list. */
final class RecoveryServiceList {
    private static String expanded(String component) {
        int slash = component.indexOf('/');
        return slash >= 0 && component.startsWith(".", slash + 1)
            ? component.substring(0, slash + 1) + component.substring(0, slash) + component.substring(slash + 1)
            : component;
    }
    static boolean contains(String list, String own) {
        return list != null && Arrays.stream(list.split(":")).anyMatch(value -> expanded(value).equals(expanded(own)));
    }
    static String without(String list, String own) {
        return Arrays.stream(list.split(":", -1)).filter(value -> !expanded(value).equals(expanded(own))).collect(Collectors.joining(":"));
    }
    static String with(String list, String own) {
        if (contains(list, own)) return list;
        return list == null || list.isBlank() ? own : list + (list.endsWith(":") ? "" : ":") + own;
    }
    static boolean canRestore(String current, String expected, long now, long startedAt) {
        return current != null && current.equals(expected) && now >= startedAt && now - startedAt <= 10_000;
    }
}
