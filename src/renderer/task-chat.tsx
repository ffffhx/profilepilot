import React, { createContext, memo, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createPortal, flushSync } from "react-dom";
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState, useExternalStoreRuntime, type AppendMessage, type ThreadMessageLike } from "@assistant-ui/react";
import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { cjk } from "@streamdown/cjk";
import type { BrowserTask, TaskAttachment, TaskSettings, TaskStream } from "../shared/tasks";
import { TERMINAL_TASKS } from "../shared/tasks";
import { taskLinkUrl } from "../shared/task-link";
import { draftKey, messageDelivery, messageKeyAction, type MessageDraft, type MessageDrafts } from "./task-interaction-model";
import { isAtTaskLatest, scrollToTaskLatest } from "./task-interaction-dom";
import { renderTaskEvents } from "./task-events";
import { ChatRowCache, taskChatRows, type ChatRow } from "./task-chat-model";

export interface TaskChatProps {
  task: BrowserTask; stream?: TaskStream; drafts: MessageDrafts; attachments: TaskAttachment[]; settings: TaskSettings;
  send(taskId: string, draft: MessageDraft, action: "queue" | "steer" | "resume"): Promise<void>;
  notify(message: string, error?: boolean): void;
}
const Context = createContext<TaskChatProps>(null!);
const plugins = { code, cjk };
const security = { allowedProtocols: ["http", "https"], allowedImagePrefixes: [] as string[], allowDataImages: false };
const components = {
  a: ({ href, children }: React.ComponentProps<"a">) => {
    const url = taskLinkUrl(href || "");
    return url ? <a href={url} className="task-link" data-task-link target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
  },
  img: ({ alt }: React.ComponentProps<"img">) => <span className="chat-image-label">{alt ? `[图片：${alt}]` : "[图片]"}</span>
};
const MarkdownText = memo(function MarkdownText() {
  return <StreamdownTextPrimitive plugins={plugins} components={components} security={security} linkSafety={{ enabled: false }}
    controls={{ code: true, table: false, mermaid: false }} defer caret="block" />;
});
const partComponents = { Text: MarkdownText };
const ChatMessage = memo(function ChatMessage() {
  const message = useAuiState(s => s.message);
  const row = message.metadata.custom.row as ChatRow;
  if (row.events) return <details id={row.domId} className="tool-group task-process-group">
    <summary>执行过程 · {row.events.length} 条记录{row.events.some(event => event.kind === "error") ? " · 有错误" : ""}</summary>
    <div className="tool-group-body">{row.events.map(event => <div key={event.id} id={`event-${event.id}`} dangerouslySetInnerHTML={{ __html: renderTaskEvents([event]) }} />)}</div>
  </details>;
  return <MessagePrimitive.Root asChild><article id={row.domId} data-message-id={row.sourceId || row.id}
    data-chat-message-id={row.id} className={`${row.role === "user" ? "history-request" : "history-answer"}${row.streaming ? " task-stream" : ""}${row.final ? " task-final-answer" : ""}`}>
    <div className="history-agent">{row.role === "user" ? "你" : row.streaming ? "Agent · 正在回复" : "Agent"}</div>
    <div className="task-markdown"><MessagePrimitive.Parts components={partComponents} /></div>
    {(row.supplement || row.final && row.domId !== "task-result") && <div id={row.final ? "task-result" : undefined} className="task-result-supplement">
      {row.supplement && <Streamdown components={components} plugins={plugins} mode="static">{row.supplement}</Streamdown>}
    </div>}
    {row.aliasId && <span id={`event-${row.aliasId}`} className="sr-only">上次结果与上方回复一致。</span>}
    {row.sourceId && <div className="actions chat-message-actions">
      <button type="button" data-copy-message={row.sourceId}>复制</button>
      {row.role === "user" ? <button type="button" data-edit-message={row.sourceId}>载入输入框编辑</button> : <button type="button" data-quote-message={row.sourceId}>引用回复</button>}
    </div>}
  </article></MessagePrimitive.Root>;
});
const messageComponents = { UserMessage: ChatMessage, AssistantMessage: ChatMessage, SystemMessage: ChatMessage };
const convertMessage = (row: ChatRow): ThreadMessageLike => ({
  id: row.id, role: row.role, content: [{ type: "text", text: row.text || " " }],
  ...(row.role === "assistant" ? { status: row.streaming ? { type: "running" as const } : { type: "complete" as const, reason: "stop" as const } } : {}),
  metadata: { custom: { row } }
});

async function deliverDraft(props: TaskChatProps): Promise<void> {
  const key = draftKey(props.task.id, "steer-task"), draft = props.drafts.get(key);
  if (!draft.text.trim() && !draft.attachments.length) return;
  const action = messageDelivery(props.task, draft.mode);
  const sent = props.drafts.prepare(key, `chat:${action}`, () => crypto.randomUUID());
  await props.send(props.task.id, sent, action);
  props.drafts.acknowledge(key, sent);
}

function ChatComposer({ runtime }: { runtime: ReturnType<typeof useExternalStoreRuntime> }) {
  const props = useContext(Context), { task, drafts } = props;
  const key = draftKey(task.id, "steer-task"), draft = drafts.get(key);
  const [sending, setSending] = useState(false), [error, setError] = useState("");
  const [, refresh] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null), composing = useRef(false), lock = useRef(false);
  useLayoutEffect(() => {
    if (runtime.thread.composer.getState().text !== draft.text && !composing.current) runtime.thread.composer.setText(draft.text);
  }, [draft.text, runtime]);
  const submit = async () => {
    if (lock.current || composing.current) return;
    const current = drafts.get(key);
    if (!current.text.trim() && !current.attachments.length) return;
    lock.current = true; setSending(true); setError("");
    try {
      await deliverDraft(props);
      runtime.thread.composer.setText(drafts.get(key).text);
      refresh(v => v + 1);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { lock.current = false; setSending(false); }
  };
  const compact = TERMINAL_TASKS.has(task.status) && !task.pending && !task.messageQueue?.length;
  return <form id="steer-task" className={`task-composer chat-composer${compact ? " task-composer-compact" : ""}`} data-task-id={task.id} data-draft-key={key}
    aria-label="发送消息" onSubmit={event => { event.preventDefault(); event.stopPropagation(); void submit(); }}>
    <label htmlFor="steering" className="sr-only">发送消息</label>
    <ComposerPrimitive.Input ref={input} id="steering" name="steering" data-editor-key={key} placeholder="继续补充任务…"
      submitMode="none" rows={1} minRows={1} maxRows={8} cancelOnEscape={false} addAttachmentOnPaste={false}
      unstable_focusOnRunStart={false} unstable_focusOnScrollToBottom={false} unstable_focusOnThreadSwitched={false}
      onChange={event => { drafts.set(key, { text: event.target.value }); refresh(v => v + 1); }}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => { composing.current = false; drafts.set(key, { text: event.currentTarget.value }); }}
      onKeyDown={event => {
        event.stopPropagation();
        const action = messageKeyAction(event.nativeEvent, composing.current, false);
        if (action === "submit" || action === "consume") { event.preventDefault(); if (action === "submit") void submit(); }
        else if (action === "newline" && (event.ctrlKey || event.metaKey || event.altKey)) {
          event.preventDefault(); document.execCommand("insertText", false, "\n");
        }
      }} aria-describedby="steering-help" />
    {!!draft.attachments.length && <div className="chosen-files">{draft.attachments.map(id => <span className="file-chip" key={id}>
      {props.attachments.find(file => file.id === id)?.name || id}<button type="button" data-message-remove={id} data-draft-key={key} aria-label="移除附件">×</button>
    </span>)}</div>}
    <div className="compose-toolbar task-followup-actions">
      <button type="button" data-action="attach-message" data-draft-key={key} aria-label="添加附件" title="添加附件"><svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2" /></svg></button>
      <label className="task-followup-options"><span>发送时机</span><select name="sendMode" data-native-select aria-label="发送时机" value={draft.mode} onChange={event => {
        drafts.set(key, { mode: event.target.value === "steer" ? "steer" : "queue" }); refresh(v => v + 1);
      }}><option value="queue">下一轮</option><option value="steer" disabled={!!task.pending}>立即调整</option></select></label>
      <button type="submit" className="primary send-task" disabled={sending || !draft.text.trim() && !draft.attachments.length} aria-label="发送">{sending ? "发送中…" : "发送 ↑"}</button>
    </div>
    {error && <p className="field-error" role="alert">{error} <button type="submit" disabled={sending}>重试发送</button></p>}
    <div className="composer-meta task-context-line"><span title={task.profileName}>{task.profileName}</span><span title={task.model || props.settings.model}>{task.model || props.settings.model}</span>
      <button type="button" data-action="session-settings">会话设置</button></div>
    <small id="steering-help" className="chat-input-hint">Enter 发送 · Shift+Enter 换行{task.pending ? " · 当前消息将排队" : ""}</small>
  </form>;
}

function Chat({ props, composer, rows }: { props: TaskChatProps; composer: HTMLElement; rows: ChatRow[] }) {
  const onNew = useCallback(async (message: AppendMessage) => {
    props.drafts.set(draftKey(props.task.id, "steer-task"), { text: message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") });
    await deliverDraft(props);
  }, [props]);
  const runtime = useExternalStoreRuntime({ messages: rows, convertMessage, isRunning: !!props.stream?.text, onNew });
  return <Context.Provider value={props}><AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Root className="task-chat-thread"><ThreadPrimitive.Messages components={messageComponents} /></ThreadPrimitive.Root>
    {createPortal(<ChatComposer runtime={runtime} />, composer)}
  </AssistantRuntimeProvider></Context.Provider>;
}

export class TaskChat {
  private root?: Root;
  private container?: HTMLElement;
  private taskId = "";
  private cache = new ChatRowCache();
  private observer?: ResizeObserver;
  private workspace?: HTMLElement;
  private following = true;
  private scheduled?: number;
  private props?: TaskChatProps;
  private onScroll = () => { if (this.workspace) this.following = isAtTaskLatest(this.workspace, 64); };
  update(props: TaskChatProps, immediate = false): void {
    this.props = props;
    const container = document.getElementById("task-chat"), composer = document.getElementById("task-chat-composer");
    if (!container || !composer) { this.dispose(); return; }
    if (this.container !== container || this.taskId !== props.task.id) {
      this.dispose(); this.props = props; this.taskId = props.task.id; this.container = container;
      this.root = createRoot(container); this.cache = new ChatRowCache();
      this.workspace = container.closest<HTMLElement>(".workspace") || undefined;
      this.following = this.workspace ? isAtTaskLatest(this.workspace, 64) : true;
      this.workspace?.addEventListener("scroll", this.onScroll, { passive: true });
      this.observer = new ResizeObserver(() => {
        if (this.following && this.workspace && !window.getSelection()?.toString() && !this.workspace.querySelector("#reply-task")) scrollToTaskLatest(this.workspace);
      });
      this.observer.observe(container); this.observer.observe(composer);
      immediate = true;
    }
    if (immediate) { if (this.scheduled) cancelAnimationFrame(this.scheduled); this.scheduled = undefined; flushSync(() => this.render(composer)); }
    else if (!this.scheduled) this.scheduled = requestAnimationFrame(() => { this.scheduled = undefined; this.render(composer); });
  }
  private render(composer: HTMLElement): void {
    if (!this.props || !this.root) return;
    const rows = this.cache.update(taskChatRows(this.props.task, this.props.stream));
    this.root.render(<Chat key={this.taskId} props={this.props} composer={composer} rows={rows} />);
  }
  dispose(): void {
    if (this.scheduled) cancelAnimationFrame(this.scheduled);
    this.scheduled = undefined; this.observer?.disconnect(); this.workspace?.removeEventListener("scroll", this.onScroll);
    this.root?.unmount(); this.root = undefined; this.container = undefined; this.props = undefined; this.workspace = undefined;
  }
}
