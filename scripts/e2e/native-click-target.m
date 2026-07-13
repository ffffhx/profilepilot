#import <ApplicationServices/ApplicationServices.h>
#import <Cocoa/Cocoa.h>

static NSString *markerPath = nil;

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
