// Real renderer and IPC; all tasks are disposable and never call a model or browser.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { TaskStore } = require('../../../dist/main/tasks/store');
const { startE2eDriver } = require('../../../dist/main/e2e-driver');
const fixture = process.env.TASK_CHAT_FIXTURE;
if (!fixture || !process.env.TASK_CHAT_SOCKET) throw new Error('Run scripts/e2e-task-chat.mjs');
app.setPath('userData', path.join(fixture, 'electron'));
const store = new TaskStore(path.join(fixture, 'tasks'));
const task = store.create({ profileId:'chat-test', prompt:'请整理这份资料，保留代码和来源。' }, '测试浏览器');
task.status = 'running'; task.model = 'test-model';
store.event(task, 'assistant', '已经整理好第一部分。\n\n**中文与 English** 都应正常显示。\n\n[来源](https://example.com/report)');
store.event(task, 'action', '正在读取资料');
const other = store.create({ profileId:'chat-test', prompt:'另一份任务的草稿' }, '测试浏览器'); other.status = 'paused';
let window, driverClose, stream, failNext = false, holdNext = false, releaseSend, streamId = 'live-response';
const calls = [], errors = [];
const snapshot = () => ({...store.snapshot(), streams:stream ? {[task.id]:stream} : {}});
const changed = () => window.webContents.send('chat-fixture:changed', snapshot());
ipcMain.handle('chat-fixture:request', async (_, method, ...args) => {
  if (method === 'snapshot') return snapshot();
  if (method === 'listModels') return ['test-model'];
  if (method === 'watchPreview' || method === 'ackPreview') return;
  if (method === 'control') {
    calls.push({method, args});
    if (holdNext) { holdNext = false; await new Promise(resolve => releaseSend = resolve); }
    if (failNext) { failNext = false; throw new Error('测试网络中断'); }
    return;
  }
  if (method === 'openLink') { calls.push({method,args}); return; }
  if (method === 'reply') { calls.push({method,args}); task.pending = undefined; task.status = 'running'; changed(); return; }
  if (method === 'fixture') {
    const [action, value] = args;
    if (action === 'stream') { stream = {id:streamId, text:value, updatedAt:new Date().toISOString()}; window.webContents.send('chat-fixture:stream', {taskId:task.id,stream}); }
    if (action === 'continue') { streamId = 'next-response'; task.status = 'running'; task.pending = undefined; task.result = undefined; changed(); }
    if (action === 'finish') { store.event(task,'assistant',stream.text,stream.id); task.status = 'completed'; task.result = {kind:'answer',summary:stream.text,evidence:[],remaining:[]}; stream = undefined; changed(); }
    if (action === 'snapshot') changed();
    if (action === 'fail') failNext = true;
    if (action === 'hold') holdNext = true;
    if (action === 'release') releaseSend?.();
    if (action === 'pending') { task.status = 'waiting_user'; task.pending = {id:'confirm-fixture',kind:'confirmation',title:'确认发送',details:'只有点击允许才能继续',createdAt:new Date().toISOString()}; changed(); }
    return {calls, errors, taskId:task.id, otherId:other.id};
  }
  throw new Error(`Unsupported fixture method: ${method}`);
});
app.whenReady().then(async () => {
  window = new BrowserWindow({width:1440,height:1000,show:false,webPreferences:{preload:path.join(__dirname,'task-chat-preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  window.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  window.webContents.on('render-process-gone', (_, detail) => { console.error(detail); app.exit(1); });
  await window.loadFile(path.join(__dirname,'../../../public/tasks.html'), {query:{task:task.id}});
  driverClose = startE2eDriver({socketPath:process.env.TASK_CHAT_SOCKET, mode:'background', getWindow:()=>window, getWindowSnapshot:()=>({main:{visible:window.isVisible(),focused:window.isFocused()}}),triggerMiniHotkeyHandler:async()=>{}});
}).catch(error => {console.error(error); app.exit(1);});
app.on('will-quit', () => driverClose?.());
