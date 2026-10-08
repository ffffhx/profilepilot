package io.github.profilepilot.phone;

/** Route setup using evidence, not the number of times the user opened our app. */
final class DeveloperOptionsRoute {
    enum Destination { DEVELOPER_OPTIONS, BUILD_NUMBER }

    static boolean rememberEnabled(boolean previouslyEnabled, String currentState) {
        return previouslyEnabled || "enabled".equals(currentState);
    }

    static Destination choose(String currentState, boolean previouslyEnabled, boolean entryAvailable) {
        if (!entryAvailable) return Destination.BUILD_NUMBER;
        if (rememberEnabled(previouslyEnabled, currentState)) return Destination.DEVELOPER_OPTIONS;
        if ("disabled".equals(currentState)) return Destination.BUILD_NUMBER;
        // A masked zero or missing permission is not evidence of first-time use.
        // Try the available developer entry; its actual launch can still fall back.
        return Destination.DEVELOPER_OPTIONS;
    }
}
