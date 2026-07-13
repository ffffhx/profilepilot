#include <ApplicationServices/ApplicationServices.h>

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static int parse_coordinate(const char *value, double *result) {
  errno = 0;
  char *end = NULL;
  const double parsed = strtod(value, &end);
  if (errno != 0 || end == value || *end != '\0') {
    return 0;
  }
  *result = parsed;
  return 1;
}

static void report_windows_at_point(CGPoint point) {
  CFArrayRef windows = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
  if (windows == NULL) return;
  const CFIndex count = CFArrayGetCount(windows);
  for (CFIndex index = 0; index < count; index += 1) {
    CFDictionaryRef info = (CFDictionaryRef)CFArrayGetValueAtIndex(windows, index);
    CGRect bounds = CGRectZero;
    CFDictionaryRef bounds_value = (CFDictionaryRef)CFDictionaryGetValue(info, kCGWindowBounds);
    int layer = 0;
    int owner_pid = 0;
    CFNumberRef layer_value = (CFNumberRef)CFDictionaryGetValue(info, kCGWindowLayer);
    CFNumberRef pid_value = (CFNumberRef)CFDictionaryGetValue(info, kCGWindowOwnerPID);
    if (layer_value != NULL) CFNumberGetValue(layer_value, kCFNumberIntType, &layer);
    if (pid_value != NULL) CFNumberGetValue(pid_value, kCFNumberIntType, &owner_pid);
    if (layer == 0 && bounds_value != NULL && CGRectMakeWithDictionaryRepresentation(bounds_value, &bounds) &&
        CGRectContainsPoint(bounds, point)) {
      int window_id = 0;
      CFNumberRef id_value = (CFNumberRef)CFDictionaryGetValue(info, kCGWindowNumber);
      if (id_value != NULL) CFNumberGetValue(id_value, kCFNumberIntType, &window_id);
      fprintf(stderr, "hit-window pid=%d id=%d bounds=%.0f,%.0f %.0fx%.0f\n", owner_pid, window_id,
              bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height);
      break;
    }
  }
  CFRelease(windows);
}

static void post_mouse(pid_t target_pid, CGEventType type, CGPoint point) {
  CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
  if (source != NULL) CGEventSourceSetLocalEventsSuppressionInterval(source, 0);
  CGEventRef event = CGEventCreateMouseEvent(source, type, point, kCGMouseButtonLeft);
  if (event == NULL) {
    if (source != NULL) CFRelease(source);
    fprintf(stderr, "Unable to create mouse event\n");
    exit(3);
  }
  CGEventSetIntegerValueField(event, kCGMouseEventClickState, 1);
  if (target_pid > 0) {
    CGEventPostToPid(target_pid, event);
  } else {
    CGEventPost(kCGHIDEventTap, event);
  }
  CFRelease(event);
  if (source != NULL) CFRelease(source);
}

int main(int argc, char **argv) {
  if (argc != 4) {
    fprintf(stderr, "Usage: %s <target-pid> <screen-x> <screen-y>\n", argv[0]);
    return 2;
  }
  const pid_t target_pid = (pid_t)strtol(argv[1], NULL, 10);
  double x = 0;
  double y = 0;
  if (target_pid < 0 || !parse_coordinate(argv[2], &x) || !parse_coordinate(argv[3], &y)) {
    fprintf(stderr, "Coordinates must be finite numbers\n");
    return 2;
  }
  fprintf(stderr, "accessibility=%d post=%d point=%.0f,%.0f\n", AXIsProcessTrusted(), CGPreflightPostEventAccess(), x, y);
  const CGPoint point = CGPointMake(x, y);
  report_windows_at_point(point);
  post_mouse(target_pid, kCGEventMouseMoved, point);
  usleep(40 * 1000);
  post_mouse(target_pid, kCGEventLeftMouseDown, point);
  usleep(40 * 1000);
  post_mouse(target_pid, kCGEventLeftMouseUp, point);
  usleep(40 * 1000);
  CGEventRef current = CGEventCreate(NULL);
  if (current != NULL) {
    const CGPoint actual = CGEventGetLocation(current);
    fprintf(stderr, "actual=%.0f,%.0f\n", actual.x, actual.y);
    CFRelease(current);
  }
  return 0;
}
