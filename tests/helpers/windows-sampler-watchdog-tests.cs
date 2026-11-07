using System;
using System.Collections.Generic;
using ProfilePilot.WindowsSampler;

public static class WindowsSamplerWatchdogTests {
    sealed class Owned : WindowsSamplerWatchdogIdentity.IOwnedProcess {
        public string Birth="639289000000000000",Image="C:\\fixture.exe",Hash=new string('a',64);
        public bool Exited,Disposed,ThrowImage,ThrowKill;
        public int Kills,Waits;
        public bool HasExited {get{return Exited;}}
        public string StartTicks {get{return Birth;}}
        public string Executable {get{if(ThrowImage)throw new Exception("unexpected image read");return Image;}}
        public string Sha256 {get{return Hash;}}
        public int ExitCode {get{return 2;}}
        public string ExitUtcTicks {get{return "639289000100000000";}}
        public bool Wait(int milliseconds){Waits++;return Exited;}
        public void Kill(){Kills++;if(ThrowKill)throw new Exception("fake failed kill");Exited=true;}
        public void Dispose(){Disposed=true;}
    }
    static void Need(bool value,string name) { if(!value)throw new Exception(name); }
    public static int Main() {
        int exits=0, waits=0; long now=0; var delays=new List<int>();
        WatchdogLoop.Run(()=>now, ms=>{waits++;delays.Add(ms);now+=ms;return false;},()=>false,code=>{Need(code==2,"exit code");exits++;});
        Need(exits==1 && waits==1 && delays[0]==10000,"full lifetime");
        exits=0;now=9999;delays.Clear();
        WatchdogLoop.Run(()=>now,ms=>{delays.Add(ms);now+=ms;return false;},()=>false,code=>exits++);
        Need(exits==1 && delays.Count==1 && delays[0]==1,"last millisecond");
        WatchdogLoop.Run(()=>{throw new Exception("clock after cancel");},ms=>{throw new Exception("wait after cancel");},()=>true,code=>{throw new Exception("exit after cancel");});
        exits=0;bool cancelled=false;now=0;
        WatchdogLoop.Run(()=>now,ms=>{cancelled=true;return true;},()=>cancelled,code=>exits++);
        Need(exits==0,"normal completion cancels");
        waits=0;exits=0;now=0;
        WatchdogLoop.Run(()=>now,ms=>{waits++;if(waits==3)now=10000;Need(waits<=3,"unbounded fake wait");return false;},()=>false,code=>exits++);
        Need(waits==3 && exits==1,"spurious wake does not renew deadline");
        foreach(long invalid in new[]{-1L,10000L,Int64.MaxValue}) {
            exits=0;WatchdogLoop.Run(()=>invalid,ms=>{throw new Exception("wait after expiry");},()=>false,code=>exits++);Need(exits==1,"expired/overflow");
        }
        bool changed=false;exits=0;
        WatchdogLoop.Run(()=>{changed=true;return 10000;},ms=>false,()=>changed,code=>exits++);
        Need(exits==0,"cancellation before exit wins");
        var own=new Owned();
        var alive=WindowsSamplerWatchdogIdentity.WaitOwned(42,own.Birth,own.Image,own.Hash,1,false,id=>own);
        Need(alive.timedOut && !alive.originalExited && !alive.forced && own.Kills==0 && own.Disposed,"passive alive wait");
        own=new Owned();var forced=WindowsSamplerWatchdogIdentity.WaitOwned(42,own.Birth,own.Image,own.Hash,10000,true,id=>own);
        Need(forced.forced && forced.timedOut && forced.originalExited && forced.closeConfirmed && own.Kills==1 && own.Disposed,"force remains explicit failure evidence");
        own=new Owned{Birth="639289000000000001",ThrowImage=true};
        var replaced=WindowsSamplerWatchdogIdentity.WaitOwned(42,"639289000000000000","C:\\fixture.exe",new string('a',64),1,true,id=>own);
        Need(replaced.replacementUntouched && own.Kills==0 && own.Waits==0 && own.Disposed,"replacement never inspected or killed");
        foreach(bool hashMismatch in new[]{false,true}) {
            own=new Owned();if(hashMismatch)own.Hash=new string('b',64);else own.Image="C:\\other.exe";
            bool refused=false;try{WindowsSamplerWatchdogIdentity.WaitOwned(42,own.Birth,"C:\\fixture.exe",new string('a',64),10000,true,id=>own);}catch(InvalidOperationException){refused=true;}
            Need(refused && own.Kills==0 && own.Waits==0 && own.Disposed,"identity mismatch never killed");
        }
        own=new Owned{Exited=true,ThrowImage=true};
        var ended=WindowsSamplerWatchdogIdentity.WaitOwned(42,own.Birth,own.Image,own.Hash,1,true,id=>own);
        Need(ended.originalExited && ended.exitCode==2 && ended.exitedUtcTicks==own.ExitUtcTicks && own.Kills==0 && own.Disposed,"same pinned process exit identity");
        var absent=WindowsSamplerWatchdogIdentity.WaitOwned(42,"639289000000000000","C:\\fixture.exe",new string('a',64),1,true,id=>{throw new ArgumentException();});
        Need(absent.originalExited && absent.exitCode==null && !absent.forced,"absent PID is no exit-code proof");
        own=new Owned{ThrowKill=true};var uncertain=WindowsSamplerWatchdogIdentity.WaitOwned(42,own.Birth,own.Image,own.Hash,1,true,id=>own);
        Need(uncertain.forced && !uncertain.closeConfirmed && !uncertain.originalExited && uncertain.error=="OWNED_CLEANUP_FAILED" && own.Kills==1 && own.Disposed,"failed force remains forced and unconfirmed");
        Console.WriteLine("{\"ok\":true,\"checks\":17,\"nativeCalls\":0,\"threadsStarted\":0}");return 0;
    }
}
