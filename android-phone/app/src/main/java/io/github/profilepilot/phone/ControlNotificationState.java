package io.github.profilepilot.phone;

/** Stable notification status: connection evidence is separate from control authority. */
record ControlNotificationState(Kind kind, String title, String text, String details, boolean canStop) {
    enum Kind { WAITING, CONNECTED, VIEWING, CONTROLLING, PAUSED, DISCONNECTED }

    boolean canPause() { return kind == Kind.VIEWING || kind == Kind.CONTROLLING; }
    boolean canResume() { return kind == Kind.PAUSED; }

    static ControlNotificationState from(ConnectionState connection, SessionState session) {
        boolean active = session.sessionId != null && session.active();
        boolean paused = session.sessionId != null && session.phase.equals("paused");
        boolean viewing = session.mode.equals("view");
        Kind kind;
        if (!connection.connected())
            kind = connection.seenConnected() || session.sessionId != null ? Kind.DISCONNECTED : Kind.WAITING;
        else if (paused) kind = Kind.PAUSED;
        else if (active) kind = viewing ? Kind.VIEWING : Kind.CONTROLLING;
        else kind = Kind.CONNECTED;
        String title = switch (kind) {
            case WAITING -> "等待电脑连接";
            case CONNECTED -> "电脑已连接";
            case VIEWING -> "电脑正在查看";
            case CONTROLLING -> "电脑正在控制";
            case PAUSED -> viewing ? "查看已暂停" : "控制已暂停";
            case DISCONNECTED -> "电脑连接中断";
        };
        String summary = switch (kind) {
            case WAITING -> "请保持电脑端运行";
            case CONNECTED -> "当前未控制手机";
            case VIEWING -> "仅查看屏幕，不能点击或输入";
            case CONTROLLING -> "可读取屏幕、点击和输入，随时可暂停";
            case PAUSED -> "当前由你操作，需手动继续";
            case DISCONNECTED -> "已停止接受指令，等待电脑重新连接";
        };
        String computer = session.computer.isBlank() ? "电脑" : session.computer;
        boolean showTask = kind == Kind.VIEWING || kind == Kind.CONTROLLING || kind == Kind.PAUSED;
        String owner = computer;
        if (showTask && !session.controller.isBlank() && !session.controller.equals(computer))
            owner += " · " + session.controller;
        String text = showTask && !session.task.isBlank() ? owner + " · " + session.task : owner + " · " + summary;
        String details = owner + "\n" + summary;
        if (showTask && !session.task.isBlank()) details += "\n任务：" + session.task;
        boolean canStop = active || paused;
        return new ControlNotificationState(kind, title, text, details, canStop);
    }
}
