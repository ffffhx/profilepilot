#import <ApplicationServices/ApplicationServices.h>
#import <Cocoa/Cocoa.h>

static NSString *markerPath = nil;
static CFMachPortRef processEventTap = NULL;
static CFRunLoopSourceRef processEventTapSource = NULL;

static CGEventRef observeProcessMouse(
    CGEventTapProxy proxy,
    CGEventType type,
    CGEventRef event,
    void *userInfo) {
  (void)proxy;
  (void)userInfo;
  if (type == kCGEventLeftMouseDown) {
    [@"clicked\n" writeToFile:markerPath atomically:YES encoding:NSUTF8StringEncoding error:nil];
    printf("{\"type\":\"clicked\",\"source\":\"process-event-tap\"}\n");
    fflush(stdout);
  }
  return event;
}

@interface ClickTargetView : NSView
@end

@implementation ClickTargetView
- (void)mouseDown:(NSEvent *)event {
  (void)event;
  [@"clicked\n" writeToFile:markerPath atomically:YES encoding:NSUTF8StringEncoding error:nil];
  printf("{\"type\":\"clicked\"}\n");
  fflush(stdout);
}
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2) {
      fprintf(stderr, "Usage: %s <marker-path>\n", argv[0]);
      return 2;
    }
    markerPath = [NSString stringWithUTF8String:argv[1]];
    NSApplication *application = [NSApplication sharedApplication];
    [application setActivationPolicy:NSApplicationActivationPolicyRegular];
    NSWindow *window = [[NSWindow alloc]
        initWithContentRect:NSMakeRect(300, 300, 320, 200)
                  styleMask:NSWindowStyleMaskBorderless
                    backing:NSBackingStoreBuffered
                      defer:NO];
    [window setBackgroundColor:[NSColor colorWithRed:0.12 green:0.75 blue:0.52 alpha:1.0]];
    [window setContentView:[[ClickTargetView alloc] initWithFrame:NSMakeRect(0, 0, 320, 200)]];
    [window makeKeyAndOrderFront:nil];
    [application activateIgnoringOtherApps:YES];

    processEventTap = CGEventTapCreateForPid(
        getpid(),
        kCGTailAppendEventTap,
        kCGEventTapOptionListenOnly,
        CGEventMaskBit(kCGEventLeftMouseDown),
        observeProcessMouse,
        NULL);
    if (processEventTap == NULL) {
      fprintf(stderr, "Unable to create target process event tap\n");
      return 3;
    }
    processEventTapSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, processEventTap, 0);
    if (processEventTapSource == NULL) {
      fprintf(stderr, "Unable to create target process event tap source\n");
      return 3;
    }
    CFRunLoopAddSource(CFRunLoopGetCurrent(), processEventTapSource, kCFRunLoopCommonModes);
    CGEventTapEnable(processEventTap, true);

    const CGWindowID windowId = (CGWindowID)[window windowNumber];
    CFArrayRef infoArray = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, windowId);
    CGRect bounds = CGRectZero;
    if (infoArray != NULL && CFArrayGetCount(infoArray) > 0) {
      CFDictionaryRef info = (CFDictionaryRef)CFArrayGetValueAtIndex(infoArray, 0);
      CFDictionaryRef value = (CFDictionaryRef)CFDictionaryGetValue(info, kCGWindowBounds);
      if (value != NULL) CGRectMakeWithDictionaryRepresentation(value, &bounds);
    }
    if (infoArray != NULL) CFRelease(infoArray);
    if (bounds.size.width <= 0 || bounds.size.height <= 0) {
      const NSRect windowFrame = [window frame];
      const NSRect screenFrame = [[window screen] ?: [NSScreen mainScreen] frame];
      bounds = CGRectMake(
          windowFrame.origin.x,
          NSMaxY(screenFrame) - NSMaxY(windowFrame),
          windowFrame.size.width,
          windowFrame.size.height);
    }
    printf(
        "{\"type\":\"ready\",\"pid\":%d,\"windowId\":%u,\"bounds\":{\"x\":%.0f,\"y\":%.0f,\"width\":%.0f,\"height\":%.0f}}\n",
        getpid(), windowId, bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height);
    fflush(stdout);
    [application run];
  }
  return 0;
}
