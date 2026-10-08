package io.github.profilepilot.phone;

import static org.junit.Assert.*;

import android.app.Instrumentation;
import android.content.*;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.SystemClock;
import android.view.*;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.*;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class MobileWorkflowTest {
  private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
  private final Context context = instrumentation.getTargetContext();

  private interface Check {
    boolean check() throws Exception;
  }

  private void until(Check check) throws Exception {
    long until = SystemClock.elapsedRealtime() + 60000;
    while (SystemClock.elapsedRealtime() < until) {
      if (check.check()) return;
      SystemClock.sleep(300);
    }
    fail("Timed out waiting for mobile workflow");
  }

  private View find(View view, String label) {
    if (view instanceof TextView && ((TextView) view).getText().toString().equals(label))
      return view;
    if (label.contentEquals(
        view.getContentDescription() == null ? "" : view.getContentDescription())) return view;
    if (view instanceof ViewGroup) {
      ViewGroup parent = (ViewGroup) view;
      for (int i = 0; i < parent.getChildCount(); i++) {
        View result = find(parent.getChildAt(i), label);
        if (result != null) return result;
      }
    }
    return null;
  }

  private EditText edit(View view) {
    if (view instanceof EditText) return (EditText) view;
    if (view instanceof ViewGroup) {
      ViewGroup parent = (ViewGroup) view;
      for (int i = 0; i < parent.getChildCount(); i++) {
        EditText result = edit(parent.getChildAt(i));
        if (result != null) return result;
      }
    }
    return null;
  }

  private void click(ActivityScenario<MainActivity> activity, String label) {
    activity.onActivity(
        a -> {
          View view = find(a.getWindow().getDecorView(), label);
          assertNotNull("Missing control: " + label, view);
          view.performClick();
        });
  }

  private void screen(String name) throws Exception {
    SystemClock.sleep(500);
    Bitmap bitmap = instrumentation.getUiAutomation().takeScreenshot();
    assertNotNull(bitmap);
    File root = new File(context.getFilesDir(), "mobile-verification");
    assertTrue(root.isDirectory() || root.mkdirs());
    try (FileOutputStream out = new FileOutputStream(new File(root, name + ".png"))) {
      bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
    }
    bitmap.recycle();
  }

  @Test
  public void mobileAndPcShareTasksAndPreserveTheirTrustBoundary() throws Exception {
    String uri = InstrumentationRegistry.getArguments().getString("pairing");
    assertNotNull("Pass the isolated fixture pairing URI", uri);
    JSONObject pair = RemoteClient.parsePair(uri);
    String pc = pair.getString("id");
    ComputerStore store = new ComputerStore(context);
    Intent intent =
        new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(intent)) {
      instrumentation.waitForIdleSync();
      activity.onActivity(a -> {
        View root = a.getWindow().getDecorView();
        for (String label : new String[] {"电脑连接", "开发者选项", "USB 调试", "Wi-Fi 无线调试", "屏幕解锁", "悬浮窗 · 顶部胶囊", "控制状态通知", "无障碍服务"}) {
          assertNotNull("Setup status must be directly on home: " + label, find(root, label));
        }
        assertNotNull("Pairing management remains available", find(root, "配对与连接管理"));
        assertNull("Opening home must not start a control session", ControlService.current);
      });
      screen("android-home");
      Instrumentation.ActivityMonitor permissions = instrumentation.addMonitor(
          PermissionsActivity.class.getName(), null, false);
      try {
        click(activity, "配对与连接管理");
        android.app.Activity opened = instrumentation.waitForMonitorWithTimeout(permissions, 5000);
        assertNotNull("Home must open local authorization directly", opened);
        screen("android-permissions");
        instrumentation.runOnMainSync(() -> {
          View back = find(opened.getWindow().getDecorView(), "返回工作区");
          assertNotNull("Authorization page must provide in-app back navigation", back);
          back.performClick();
        });
        instrumentation.waitForIdleSync();
      } finally {
        instrumentation.removeMonitor(permissions);
      }
      click(activity, "设备");
      click(activity, "粘贴配对链接");
      until(() -> {
        AccessibilityNodeInfo root = instrumentation.getUiAutomation().getRootInActiveWindow();
        AccessibilityNodeInfo edit = accessibleEdit(root);
        if (edit == null) return false;
        android.os.Bundle arguments = new android.os.Bundle();
        arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, uri);
        return edit.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
      });
      dialogClick("继续");
      until(
          () -> {
            AccessibilityNodeInfo root = instrumentation.getUiAutomation().getRootInActiveWindow();
            if (root == null) return false;
            for (AccessibilityNodeInfo node : root.findAccessibilityNodeInfosByText("连接"))
              if ("连接".contentEquals(node.getText()) && node.isClickable()) {
                node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                return true;
              }
            return false;
          });
      until(() -> store.find(pc) != null);
      JSONObject computer = store.find(pc);
      assertEquals(
          pc,
          RemoteClient.read(computer, RemoteClient.object("action", "sync"))
              .getString("computerId"));
      JSONObject wrong = new JSONObject(computer.toString()).put("fingerprint", "0".repeat(64));
      try {
        RemoteClient.read(wrong, RemoteClient.object("action", "sync"));
        fail("Wrong certificate pin accepted");
      } catch (javax.net.ssl.SSLException expected) {
        /* expected */
      }
      String raw =
          context
              .getSharedPreferences("mobile-workspace", Context.MODE_PRIVATE)
              .getString("computers", "");
      assertFalse("Token must be encrypted", raw.contains(computer.getString("token")));
      until(
          () -> {
            AtomicBoolean ready = new AtomicBoolean();
            activity.onActivity(
                a -> {
                  View root = a.getWindow().getDecorView();
                  ready.set(contains(root, "已连接"));
                });
            return ready.get();
          });
      screen("android-agent");
      String prompt = "Android native UI task " + System.currentTimeMillis();
      activity.onActivity(
          a -> {
            EditText field = edit(a.getWindow().getDecorView());
            assertNotNull(field);
            field.setText(prompt);
          });
      click(activity, "任务");
      click(activity, "首页");
      click(activity, "Agent");
      activity.onActivity(
          a -> assertEquals(prompt, edit(a.getWindow().getDecorView()).getText().toString()));
      click(activity, "发送到电脑  ↗");
      final String[] taskId = {null};
      until(
          () -> {
            JSONArray tasks =
                RemoteClient.read(computer, RemoteClient.object("action", "task.list"))
                    .getJSONArray("tasks");
            for (int i = 0; i < tasks.length(); i++) {
              JSONObject task = tasks.getJSONObject(i);
              if (task.getString("title").contains(prompt)) {
                taskId[0] = task.getString("id");
                return true;
              }
            }
            return false;
          });
      until(
          () -> {
            AtomicBoolean ready = new AtomicBoolean();
            activity.onActivity(a -> ready.set(find(a.getWindow().getDecorView(), "暂停") != null));
            return ready.get();
          });
      click(activity, "暂停");
      until(
          () ->
              RemoteClient.read(
                      computer, RemoteClient.object("action", "task.get", "id", taskId[0]))
                  .getJSONObject("task")
                  .getString("status")
                  .equals("paused"));
      until(
          () -> {
            AtomicBoolean ready = new AtomicBoolean();
            activity.onActivity(a -> ready.set(find(a.getWindow().getDecorView(), "继续") != null));
            return ready.get();
          });
      screen("android-task-paused");
      click(activity, "继续");
      until(
          () ->
              RemoteClient.read(
                      computer, RemoteClient.object("action", "task.get", "id", taskId[0]))
                  .getJSONObject("task")
                  .getString("status")
                  .equals("queued"));
      JSONObject create =
          RemoteClient.object(
              "action",
              "task.create",
              "profile",
              "isolated:android",
              "input",
              RemoteClient.object("prompt", "Lost response replay test"));
      JSONObject envelope = RemoteClient.envelope(create);
      store.pending(pc, envelope);
      JSONObject first = RemoteClient.post(computer, "/v1/request", envelope, true);
      JSONObject retry = RemoteClient.mutation(store, computer, null, true);
      assertEquals(
          first.getJSONObject("task").getString("id"), retry.getJSONObject("task").getString("id"));
      assertNull(store.pending(pc));
      click(activity, "任务");
      screen("android-tasks");
      click(activity, "设备");
      screen("android-devices");
      click(activity, "我的");
      screen("android-settings");
      if (android.os.Build.VERSION.SDK_INT >= 33) instrumentation.getUiAutomation().grantRuntimePermission(context.getPackageName(), android.Manifest.permission.POST_NOTIFICATIONS);
      click(activity, "开启后台任务通知");
      until(() -> RemoteSyncService.running && context.getSystemService(android.app.NotificationManager.class).getActiveNotifications().length > 1);
      click(activity, "停止后台任务通知");
      JSONArray tasks =
          RemoteClient.read(computer, RemoteClient.object("action", "task.list"))
              .getJSONArray("tasks");
      JSONObject question = null;
      for (int i = 0; i < tasks.length(); i++) {
        JSONObject item =
            RemoteClient.read(
                    computer,
                    RemoteClient.object(
                        "action", "task.get", "id", tasks.getJSONObject(i).getString("id")))
                .getJSONObject("task");
        if (item.has("pending")) question = item;
      }
      assertNotNull(question);
      String questionId = question.getString("id");
      click(activity, "任务");
      click(activity, "打开任务：" + question.getString("title"));
      until(() -> { AtomicBoolean ready = new AtomicBoolean(); activity.onActivity(a -> ready.set(find(a.getWindow().getDecorView(), "提交回答") != null)); return ready.get(); });
      screen("android-confirmation");
      activity.onActivity(a -> edit(a.getWindow().getDecorView()).setText("Markdown"));
      click(activity, "提交回答");
      until(() -> !RemoteClient.read(computer, RemoteClient.object("action", "task.get", "id", questionId)).getJSONObject("task").has("pending"));
      RemoteClient.mutation(
          store, computer, RemoteClient.object("action", "device.disconnect"), false);
      try {
        RemoteClient.read(computer, RemoteClient.object("action", "sync"));
        fail("Revoked credential accepted");
      } catch (RemoteClient.ApiError expected) {
        assertEquals("MOBILE_UNAUTHORIZED", expected.code);
      }
      store.remove(pc);
    }
  }

  private boolean contains(View view, String text) {
    if (view instanceof TextView && ((TextView) view).getText().toString().contains(text))
      return true;
    if (view instanceof ViewGroup) {
      ViewGroup parent = (ViewGroup) view;
      for (int i = 0; i < parent.getChildCount(); i++)
        if (contains(parent.getChildAt(i), text)) return true;
    }
    return false;
  }

  private AccessibilityNodeInfo accessibleEdit(AccessibilityNodeInfo node) {
    if (node == null) return null;
    if ("android.widget.EditText".contentEquals(node.getClassName())) return node;
    for (int i = 0; i < node.getChildCount(); i++) {
      AccessibilityNodeInfo result = accessibleEdit(node.getChild(i));
      if (result != null) return result;
    }
    return null;
  }

  private void dialogClick(String label) throws Exception {
    until(() -> {
      AccessibilityNodeInfo root = instrumentation.getUiAutomation().getRootInActiveWindow();
      if (root == null) return false;
      for (AccessibilityNodeInfo node : root.findAccessibilityNodeInfosByText(label))
        if (label.contentEquals(node.getText()) && node.isClickable())
          return node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
      return false;
    });
  }
}
