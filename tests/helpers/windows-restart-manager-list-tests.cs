using System;
using System.Collections.Generic;

public static partial class ProfilePilotRestartManager {
  private sealed class Reply {
    public int Status; public uint Needed, Count; public int[] Pids;
    public Reply(int status, uint needed, uint count, params int[] pids) { Status = status; Needed = needed; Count = count; Pids = pids; }
  }
  private static int checks;
  private static void Check(string name, Reply[] replies, int expectedCalls, int[] expected, int failure) {
    int calls = 0; int[] actual = null; Exception error = null;
    try {
      actual = ReadProcesses(delegate(out uint needed, ref uint count, RM_PROCESS_INFO[] entries, ref uint reasons) {
        if (calls >= replies.Length) throw new Exception("Unexpected extra query: " + name);
        var reply = replies[calls++];
        if (entries == null && count != 0) throw new Exception("Invalid sizing call: " + name);
        if (entries != null && count != entries.Length) throw new Exception("Wrong input capacity: " + name);
        for (int index = 0; entries != null && index < entries.Length && index < reply.Pids.Length; index++)
          entries[index].Process.ProcessId = reply.Pids[index];
        needed = reply.Needed; count = reply.Count; reasons = 0; return reply.Status;
      });
    } catch (Exception caught) { error = caught; }
    if (calls != expectedCalls) throw new Exception(name + ": query count " + calls + " != " + expectedCalls);
    if (failure != 0 && Strict) {
      if (!(error is InvalidOperationException) || error.Message != "PROFILE_FILE_SCAN_LIST_FAILED_" + failure)
        throw new Exception(name + ": expected strict failure " + failure + ", got " + error);
    } else {
      if (error != null) throw new Exception(name + ": unexpected failure", error);
      if (failure != 0) expected = new int[0];
      Array.Sort(actual); Array.Sort(expected);
      if (String.Join(",", actual) != String.Join(",", expected)) throw new Exception(name + ": wrong PIDs");
    }
    checks++;
  }
  public static int RunListTests() {
    Check("initial empty", new [] { new Reply(0, 0, 0) }, 1, new int[0], 0);
    Check("growing list discards partial rows", new [] { new Reply(234, 1, 0), new Reply(234, 3, 1, 999), new Reply(0, 3, 3, 41, 42, 43) }, 3, new [] { 41, 42, 43 }, 0);
    Check("shrinking list", new [] { new Reply(234, 4, 0), new Reply(0, 2, 2, 41, 42) }, 2, new [] { 41, 42 }, 0);
    Check("duplicates", new [] { new Reply(234, 3, 0), new Reply(0, 3, 3, 41, 41, 42) }, 2, new [] { 41, 42 }, 0);
    Check("shrinks to empty", new [] { new Reply(234, 1, 0), new Reply(0, 0, 0) }, 2, new int[0], 0);
    Check("bounded repeated growth", new [] { new Reply(234, 1, 0), new Reply(234, 2, 1, 999), new Reply(234, 3, 2, 998, 999), new Reply(234, 4, 3, 997, 998, 999) }, 4, null, 234);
    Check("initial permission failure", new [] { new Reply(5, 0, 0) }, 1, null, 5);
    Check("fill permission failure is not retried", new [] { new Reply(234, 1, 0), new Reply(5, 2, 1, 999) }, 2, null, 5);
    Check("invalid zero sizing", new [] { new Reply(234, 0, 0) }, 1, null, 13);
    Check("initial allocation cap", new [] { new Reply(234, 16385, 0) }, 1, null, 13);
    Check("growth allocation cap", new [] { new Reply(234, 1, 0), new Reply(234, 16385, 1, 999) }, 2, null, 13);
    Check("success count overflow", new [] { new Reply(234, 1, 0), new Reply(0, 1, 2, 41) }, 2, null, 13);
    Check("success needed overflow", new [] { new Reply(234, 1, 0), new Reply(0, 2, 1, 41) }, 2, null, 13);
    Check("success incomplete rows", new [] { new Reply(234, 2, 0), new Reply(0, 2, 1, 41) }, 2, null, 13);
    Check("invalid initial success", new [] { new Reply(0, 1, 0) }, 1, null, 13);
    Check("invalid process identity", new [] { new Reply(234, 1, 0), new Reply(0, 1, 1, 0) }, 2, null, 13);
    Check("more data without larger capacity", new [] { new Reply(234, 1, 0), new Reply(234, 1, 1, 999) }, 2, null, 13);
    return checks;
  }
}
public static class RestartManagerListTests {
  public static int Main() {
    try { Console.WriteLine("{\"ok\":true,\"checks\":" + ProfilePilotRestartManager.RunListTests() + ",\"nativeCalls\":0}"); return 0; }
    catch (Exception error) { Console.Error.WriteLine(error); return 1; }
  }
}
