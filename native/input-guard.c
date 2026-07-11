#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#define MAX_GUARDED_PIDS 128
#define INPUT_BUFFER_SIZE 8192

typedef struct {
  pid_t pid;
  CFMachPortRef tap;
  CFRunLoopSourceRef source;
} GuardTap;

static GuardTap *guard_taps[MAX_GUARDED_PIDS];
static size_t guard_tap_count = 0;
static char input_buffer[INPUT_BUFFER_SIZE];
static size_t input_buffer_length = 0;
static const char *server_socket_path = NULL;

static void emit_status(const char *status, pid_t pid) {
  printf("{\"type\":\"status\",\"status\":\"%s\",\"pid\":%d}\n", status, pid);
}

static bool check_accessibility_access(bool prompt) {
  bool trusted = false;
  if (prompt) {
    const void *keys[] = {kAXTrustedCheckOptionPrompt};
    const void *values[] = {kCFBooleanTrue};
    CFDictionaryRef options = CFDictionaryCreate(
        kCFAllocatorDefault,
        keys,
        values,
        1,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks);
    trusted = options != NULL && AXIsProcessTrustedWithOptions(options);
    if (options != NULL) {
      CFRelease(options);
    }
  } else {
    // Normal launches only inspect trust. The explicit command-line flag is
    // the sole path that may foreground the one-time system permission UI.
    trusted = AXIsProcessTrusted();
  }
  emit_status(trusted ? "accessibility-access-granted" : "accessibility-access-denied", 0);
  emit_status(CGPreflightListenEventAccess() ? "listen-access-granted" : "listen-access-denied", 0);
  return trusted;
}

static bool copy_window_bounds(CGWindowID window_id, pid_t expected_pid, CGRect *bounds) {
  if (window_id == 0 || bounds == NULL) {
    return false;
  }

  CFArrayRef windows = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, window_id);
  if (windows == NULL || CFArrayGetCount(windows) < 1) {
    if (windows != NULL) {
      CFRelease(windows);
    }
    return false;
  }

  CFDictionaryRef info = (CFDictionaryRef)CFArrayGetValueAtIndex(windows, 0);
  pid_t owner_pid = 0;
  CFNumberRef owner = (CFNumberRef)CFDictionaryGetValue(info, kCGWindowOwnerPID);
  if (owner != NULL) {
    CFNumberGetValue(owner, kCFNumberIntType, &owner_pid);
  }
  CFDictionaryRef bounds_value = (CFDictionaryRef)CFDictionaryGetValue(info, kCGWindowBounds);
  const bool valid =
      (owner_pid == 0 || owner_pid == expected_pid) && bounds_value != NULL &&
      CGRectMakeWithDictionaryRepresentation(bounds_value, bounds) &&
      bounds->size.width > 0 && bounds->size.height > 0;
  CFRelease(windows);
  return valid;
}

static double display_scale_for_window(CGRect window_bounds) {
  CGDirectDisplayID displays[32];
  uint32_t display_count = 0;
  if (CGGetActiveDisplayList(32, displays, &display_count) != kCGErrorSuccess || display_count == 0) {
    return 1.0;
  }

  CGDirectDisplayID best_display = displays[0];
  double best_area = -1.0;
  for (uint32_t index = 0; index < display_count; index += 1) {
    const CGRect intersection = CGRectIntersection(window_bounds, CGDisplayBounds(displays[index]));
    const double area = CGRectIsNull(intersection) ? 0.0 : intersection.size.width * intersection.size.height;
    if (area > best_area) {
      best_area = area;
      best_display = displays[index];
    }
  }

  const CGRect display_bounds = CGDisplayBounds(best_display);
  CGDisplayModeRef mode = CGDisplayCopyDisplayMode(best_display);
  if (display_bounds.size.width <= 0 || mode == NULL) {
    return 1.0;
  }
  const size_t pixel_width = CGDisplayModeGetPixelWidth(mode);
  CFRelease(mode);
  if (pixel_width == 0) {
    return 1.0;
  }
  const double scale = (double)pixel_width / display_bounds.size.width;
  return scale >= 0.5 && scale <= 8.0 ? scale : 1.0;
}

static void emit_mouse_event(GuardTap *entry, CGEventType type, CGEventRef event) {
  const char *phase = NULL;
  if (type == kCGEventLeftMouseDown || type == kCGEventRightMouseDown || type == kCGEventOtherMouseDown) {
    phase = "down";
  } else if (type == kCGEventLeftMouseUp || type == kCGEventRightMouseUp || type == kCGEventOtherMouseUp) {
    phase = "up";
  } else {
    return;
  }

  const CGPoint point = CGEventGetLocation(event);
  const int64_t button = CGEventGetIntegerValueField(event, kCGMouseEventButtonNumber);
  const int64_t raw_window_id = CGEventGetIntegerValueField(event, kCGMouseEventWindowUnderMousePointer);
  const CGWindowID window_id = raw_window_id > 0 ? (CGWindowID)raw_window_id : 0;
  CGRect bounds = CGRectZero;
  const bool has_bounds = copy_window_bounds(window_id, entry->pid, &bounds);
  const double display_scale = has_bounds ? display_scale_for_window(bounds) : 1.0;
  const uint64_t timestamp = CGEventGetTimestamp(event);

  if (has_bounds) {
    printf(
        "{\"type\":\"mouse\",\"pid\":%d,\"phase\":\"%s\",\"button\":%lld,"
        "\"x\":%.6f,\"y\":%.6f,\"windowId\":%u,\"timestamp\":%llu,\"displayScale\":%.6f,"
        "\"window\":{\"x\":%.6f,\"y\":%.6f,\"width\":%.6f,\"height\":%.6f}}\n",
        entry->pid,
        phase,
        (long long)button,
        point.x,
        point.y,
        window_id,
        (unsigned long long)timestamp,
        display_scale,
        bounds.origin.x,
        bounds.origin.y,
        bounds.size.width,
        bounds.size.height);
    return;
  }

  printf(
      "{\"type\":\"mouse\",\"pid\":%d,\"phase\":\"%s\",\"button\":%lld,"
      "\"x\":%.6f,\"y\":%.6f,\"windowId\":%u,\"timestamp\":%llu,\"displayScale\":%.6f,\"window\":null}\n",
      entry->pid,
      phase,
      (long long)button,
      point.x,
      point.y,
      window_id,
      (unsigned long long)timestamp,
      display_scale);
}

static CGEventRef guard_callback(
    CGEventTapProxy proxy,
    CGEventType type,
    CGEventRef event,
    void *user_info) {
  (void)proxy;
  GuardTap *entry = (GuardTap *)user_info;
  if (entry == NULL) {
    return event;
  }

  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    CGEventTapEnable(entry->tap, true);
    emit_status("tap-reenabled", entry->pid);
    return event;
  }

  emit_mouse_event(entry, type, event);
  // A default event tap suppresses an event by returning NULL. Mouse movement is
  // deliberately not in the mask, so the pointer can still move normally.
  return NULL;
}

static CGEventMask guarded_event_mask(void) {
  return CGEventMaskBit(kCGEventLeftMouseDown) |
         CGEventMaskBit(kCGEventLeftMouseUp) |
         CGEventMaskBit(kCGEventRightMouseDown) |
         CGEventMaskBit(kCGEventRightMouseUp) |
         CGEventMaskBit(kCGEventOtherMouseDown) |
         CGEventMaskBit(kCGEventOtherMouseUp) |
         CGEventMaskBit(kCGEventLeftMouseDragged) |
         CGEventMaskBit(kCGEventRightMouseDragged) |
         CGEventMaskBit(kCGEventOtherMouseDragged) |
         CGEventMaskBit(kCGEventScrollWheel);
}

static ssize_t index_for_pid(pid_t pid) {
  for (size_t index = 0; index < guard_tap_count; index += 1) {
    if (guard_taps[index] != NULL && guard_taps[index]->pid == pid) {
      return (ssize_t)index;
    }
  }
  return -1;
}

static bool contains_pid(const pid_t *pids, size_t count, pid_t pid) {
  for (size_t index = 0; index < count; index += 1) {
    if (pids[index] == pid) {
      return true;
    }
  }
  return false;
}

static void remove_tap_at(size_t index) {
  if (index >= guard_tap_count || guard_taps[index] == NULL) {
    return;
  }
  GuardTap *entry = guard_taps[index];
  if (entry->tap != NULL) {
    CGEventTapEnable(entry->tap, false);
  }
  if (entry->source != NULL) {
    CFRunLoopRemoveSource(CFRunLoopGetCurrent(), entry->source, kCFRunLoopCommonModes);
    CFRelease(entry->source);
  }
  if (entry->tap != NULL) {
    CFMachPortInvalidate(entry->tap);
    CFRelease(entry->tap);
  }
  emit_status("tap-removed", entry->pid);
  free(entry);

  for (size_t cursor = index + 1; cursor < guard_tap_count; cursor += 1) {
    guard_taps[cursor - 1] = guard_taps[cursor];
  }
  guard_tap_count -= 1;
  guard_taps[guard_tap_count] = NULL;
}

static bool add_tap(pid_t pid) {
  if (pid <= 0 || guard_tap_count >= MAX_GUARDED_PIDS || index_for_pid(pid) >= 0) {
    return false;
  }

  GuardTap *entry = (GuardTap *)calloc(1, sizeof(GuardTap));
  if (entry == NULL) {
    emit_status("allocation-failed", pid);
    return false;
  }
  entry->pid = pid;
  entry->tap = CGEventTapCreateForPid(
      pid,
      kCGHeadInsertEventTap,
      kCGEventTapOptionDefault,
      guarded_event_mask(),
      guard_callback,
      entry);
  if (entry->tap == NULL) {
    emit_status("tap-create-failed", pid);
    free(entry);
    return false;
  }

  entry->source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, entry->tap, 0);
  if (entry->source == NULL) {
    emit_status("source-create-failed", pid);
    CFMachPortInvalidate(entry->tap);
    CFRelease(entry->tap);
    free(entry);
    return false;
  }

  CFRunLoopAddSource(CFRunLoopGetCurrent(), entry->source, kCFRunLoopCommonModes);
  CGEventTapEnable(entry->tap, true);
  guard_taps[guard_tap_count++] = entry;
  emit_status("tap-active", pid);
  return true;
}

static void set_guarded_pids(const pid_t *pids, size_t count) {
  size_t index = guard_tap_count;
  while (index > 0) {
    index -= 1;
    GuardTap *entry = guard_taps[index];
    if (entry == NULL || !contains_pid(pids, count, entry->pid)) {
      remove_tap_at(index);
    }
  }

  for (size_t cursor = 0; cursor < count; cursor += 1) {
    if (index_for_pid(pids[cursor]) < 0) {
      add_tap(pids[cursor]);
    }
  }
  printf("{\"type\":\"status\",\"status\":\"sync-complete\",\"activeCount\":%zu}\n", guard_tap_count);
}

static void process_command(char *line) {
  while (*line == ' ' || *line == '\t') {
    line += 1;
  }
  if (strcmp(line, "QUIT") == 0) {
    CFRunLoopStop(CFRunLoopGetCurrent());
    return;
  }
  if (strncmp(line, "SET", 3) != 0 || (line[3] != '\0' && line[3] != ' ' && line[3] != '\t')) {
    emit_status("invalid-command", 0);
    return;
  }

  pid_t pids[MAX_GUARDED_PIDS];
  size_t count = 0;
  char *cursor = line + 3;
  while (*cursor != '\0' && count < MAX_GUARDED_PIDS) {
    while (*cursor == ' ' || *cursor == '\t') {
      cursor += 1;
    }
    if (*cursor == '\0') {
      break;
    }
    errno = 0;
    char *end = NULL;
    const long value = strtol(cursor, &end, 10);
    if (errno != 0 || end == cursor || value <= 0 || value > INT32_MAX) {
      emit_status("invalid-pid", 0);
      return;
    }
    if (!contains_pid(pids, count, (pid_t)value)) {
      pids[count++] = (pid_t)value;
    }
    cursor = end;
  }
  set_guarded_pids(pids, count);
}

static void process_input_bytes(const char *bytes, size_t count) {
  for (size_t index = 0; index < count; index += 1) {
    const char byte = bytes[index];
    if (byte == '\n') {
      input_buffer[input_buffer_length] = '\0';
      process_command(input_buffer);
      input_buffer_length = 0;
      continue;
    }
    if (byte == '\r') {
      continue;
    }
    if (input_buffer_length + 1 < INPUT_BUFFER_SIZE) {
      input_buffer[input_buffer_length++] = byte;
    } else {
      input_buffer_length = 0;
      emit_status("command-too-long", 0);
    }
  }
}

static void stdin_callback(CFFileDescriptorRef descriptor, CFOptionFlags call_back_types, void *info) {
  (void)info;
  if ((call_back_types & kCFFileDescriptorReadCallBack) == 0) {
    return;
  }

  char bytes[2048];
  while (true) {
    const ssize_t count = read(STDIN_FILENO, bytes, sizeof(bytes));
    if (count > 0) {
      process_input_bytes(bytes, (size_t)count);
      continue;
    }
    if (count == 0) {
      CFRunLoopStop(CFRunLoopGetCurrent());
      return;
    }
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      break;
    }
    CFRunLoopStop(CFRunLoopGetCurrent());
    return;
  }
  CFFileDescriptorEnableCallBacks(descriptor, kCFFileDescriptorReadCallBack);
}

static void remove_all_taps(void) {
  while (guard_tap_count > 0) {
    remove_tap_at(guard_tap_count - 1);
  }
}

static bool connect_socket_stdio(const char *socket_path) {
  if (socket_path == NULL || socket_path[0] == '\0') {
    return false;
  }
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  const size_t path_length = strlen(socket_path);
  if (path_length >= sizeof(address.sun_path)) {
    return false;
  }
  memcpy(address.sun_path, socket_path, path_length + 1);

  const int server = socket(AF_UNIX, SOCK_STREAM, 0);
  if (server < 0) {
    return false;
  }
  unlink(socket_path);
  const mode_t previous_mask = umask(0077);
  const int bind_result = bind(server, (struct sockaddr *)&address, sizeof(address));
  umask(previous_mask);
  if (bind_result < 0 || chmod(socket_path, 0600) < 0 || listen(server, 1) < 0) {
    close(server);
    unlink(socket_path);
    return false;
  }

  const int client = accept(server, NULL, NULL);
  close(server);
  if (client < 0) {
    unlink(socket_path);
    return false;
  }
  if (dup2(client, STDIN_FILENO) < 0 || dup2(client, STDOUT_FILENO) < 0) {
    close(client);
    unlink(socket_path);
    return false;
  }
  if (client != STDIN_FILENO && client != STDOUT_FILENO) {
    close(client);
  }
  return true;
}

int main(int argc, char **argv) {
  bool prompt_for_accessibility = false;
  for (int index = 1; index < argc; index += 1) {
    if (strcmp(argv[index], "--request-accessibility") == 0) {
      prompt_for_accessibility = true;
    } else if (strcmp(argv[index], "--socket") == 0 && index + 1 < argc) {
      server_socket_path = argv[index + 1];
      index += 1;
    }
  }
  if (server_socket_path != NULL && !connect_socket_stdio(server_socket_path)) {
    return 2;
  }
  setvbuf(stdout, NULL, _IOLBF, 0);
  if (prompt_for_accessibility) {
    const bool trusted = check_accessibility_access(true);
    if (!trusted) {
      // The system prompt is asynchronous. Keep the short-lived setup process
      // alive long enough for System Settings to receive and present it.
      CFRunLoopRunInMode(kCFRunLoopDefaultMode, 1.5, false);
    }
    return trusted ? 0 : 3;
  }
  // 启动时只检查 macOS“辅助功能”权限。没有权限时 active event tap 会直接创建失败；
  // 不能让 helper 继续存活却让上层误以为 Chrome 已经被锁定，也不能自动打断用户请求授权。
  check_accessibility_access(false);
  const int flags = fcntl(STDIN_FILENO, F_GETFL, 0);
  if (flags < 0 || fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK) < 0) {
    emit_status("stdin-setup-failed", 0);
    return 2;
  }

  CFFileDescriptorContext context = {0, NULL, NULL, NULL, NULL};
  CFFileDescriptorRef descriptor = CFFileDescriptorCreate(
      kCFAllocatorDefault,
      STDIN_FILENO,
      false,
      stdin_callback,
      &context);
  if (descriptor == NULL) {
    emit_status("stdin-descriptor-failed", 0);
    return 2;
  }

  CFRunLoopSourceRef input_source = CFFileDescriptorCreateRunLoopSource(kCFAllocatorDefault, descriptor, 0);
  if (input_source == NULL) {
    emit_status("stdin-source-failed", 0);
    CFRelease(descriptor);
    return 2;
  }

  CFRunLoopAddSource(CFRunLoopGetCurrent(), input_source, kCFRunLoopCommonModes);
  CFFileDescriptorEnableCallBacks(descriptor, kCFFileDescriptorReadCallBack);
  emit_status("ready", 0);
  CFRunLoopRun();

  remove_all_taps();
  CFRunLoopRemoveSource(CFRunLoopGetCurrent(), input_source, kCFRunLoopCommonModes);
  CFRelease(input_source);
  CFFileDescriptorInvalidate(descriptor);
  CFRelease(descriptor);
  if (server_socket_path != NULL) {
    unlink(server_socket_path);
  }
  return 0;
}
