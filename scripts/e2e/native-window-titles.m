#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2) {
      fprintf(stderr, "Usage: %s <pid>\n", argv[0]);
      return 2;
    }
    const pid_t targetPid = (pid_t)strtol(argv[1], NULL, 10);
    NSMutableArray<NSString *> *titles = [NSMutableArray array];
    CFArrayRef windows = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID);
    if (windows != NULL) {
      for (NSDictionary *window in (__bridge NSArray *)windows) {
        const NSNumber *ownerPid = window[(__bridge NSString *)kCGWindowOwnerPID];
        const NSNumber *layer = window[(__bridge NSString *)kCGWindowLayer];
        const NSString *title = window[(__bridge NSString *)kCGWindowName];
        if (ownerPid.intValue == targetPid && layer.intValue == 0 && title.length > 0) {
          [titles addObject:title];
        }
      }
      CFRelease(windows);
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:titles options:0 error:nil];
    if (json == nil) return 3;
    fwrite(json.bytes, 1, json.length, stdout);
    fputc('\n', stdout);
  }
  return 0;
}
