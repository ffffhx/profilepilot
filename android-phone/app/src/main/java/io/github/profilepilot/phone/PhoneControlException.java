package io.github.profilepilot.phone;

/** Stable rejection codes. Only use before input dispatch is known to have happened. */
public final class PhoneControlException extends IllegalStateException {
    public final String code;
    public final String actionOutcome;
    public PhoneControlException(String code, String message) { this(code, message, "not-executed"); }
    public PhoneControlException(String code, String message, String actionOutcome) {
        super(message); this.code = code; this.actionOutcome = actionOutcome;
    }
}
