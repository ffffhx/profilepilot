using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Console-only owned evidence: one open nonce file and separate loopback
// listeners. It never creates a window, injects input or reads file contents.
public static class WindowsSamplerFixture {
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
    static string state,nonce,startedUtcTicks,creationFileTime;static int pid;
    static void Save(string suffix,object value){
        string file=state+suffix,temp=file+".new";File.WriteAllText(temp,Json.Serialize(value),new UTF8Encoding(false));
        if(File.Exists(file))File.Replace(temp,file,null);else File.Move(temp,file);
    }
    public static int Main(string[] args){
        if(args.Length==3 && args[0]=="--birth")return ReadOwnedBirth(args);
        if(args.Length!=3 || !System.Text.RegularExpressions.Regex.IsMatch(args[1],"^[a-f0-9]{32}$"))return 2;
        state=Path.GetFullPath(args[0]);nonce=args[1];string file=Path.GetFullPath(args[2]);
        if(!String.Equals(Path.GetDirectoryName(state),Path.GetDirectoryName(file),StringComparison.OrdinalIgnoreCase) || Path.GetFileName(file)!=nonce+".txt" || !File.Exists(file) || (File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0)return 2;
        using(var self=Process.GetCurrentProcess()){
            pid=self.Id;startedUtcTicks=self.StartTime.ToUniversalTime().Ticks.ToString();
            long created,exited,kernel,user;if(!GetProcessTimes(self.Handle,out created,out exited,out kernel,out user) || created<=0)return 2;
            creationFileTime=unchecked((ulong)created).ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
        FileStream held=null;TcpListener ipv4=null,ipv6=null;string reason="failure";int exitCode=2;
        try{
            held=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.Read);
            ipv4=new TcpListener(IPAddress.Loopback,0);ipv4.Start();
            ipv6=new TcpListener(IPAddress.IPv6Loopback,0);ipv6.Server.DualMode=false;ipv6.Start();
            Save(".ready.json",new{nonce,pid,startedUtcTicks,creationFileTime,ipv4Port=((IPEndPoint)ipv4.LocalEndpoint).Port,ipv6Port=((IPEndPoint)ipv6.LocalEndpoint).Port});
            var lifetime=Stopwatch.StartNew();
            while(true){
                if(File.Exists(state+".close") && File.ReadAllText(state+".close",Encoding.UTF8)==nonce){reason="requested";exitCode=0;break;}
                if(lifetime.ElapsedMilliseconds>240000 || !File.Exists(state+".heartbeat") || DateTime.UtcNow-File.GetLastWriteTimeUtc(state+".heartbeat")>TimeSpan.FromSeconds(30)){reason="heartbeat_or_ttl";break;}
                Thread.Sleep(50);
            }
        }catch(Exception){reason="fixture_failed";}
        finally{
            try{if(ipv4!=null)ipv4.Stop();if(ipv6!=null)ipv6.Stop();if(held!=null)held.Dispose();}
            catch(Exception){reason="cleanup_failed";exitCode=2;}
            Save(".closed.json",new{nonce,pid,startedUtcTicks,creationFileTime,reason,exitCode});
        }
        return exitCode;
    }
    static int ReadOwnedBirth(string[] args){
        int ownedPid;ulong expected;
        if(!Int32.TryParse(args[1],out ownedPid) || ownedPid<=0 || !UInt64.TryParse(args[2],out expected) || expected==0)return 2;
        IntPtr handle=OpenProcess(0x00101000,false,ownedPid);
        if(handle==IntPtr.Zero)return 2;
        try{
            long created,exited,kernel,user;
            if(WaitForSingleObject(handle,0)!=258 || !GetProcessTimes(handle,out created,out exited,out kernel,out user) || unchecked((ulong)created)!=expected || WaitForSingleObject(handle,0)!=258)return 2;
            Console.WriteLine(Json.Serialize(new{ok=true,pid=ownedPid,creationFileTime=unchecked((ulong)created).ToString(System.Globalization.CultureInfo.InvariantCulture)}));return 0;
        }finally{CloseHandle(handle);}
    }
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetProcessTimes(IntPtr process,out long creation,out long exit,out long kernel,out long user);
    [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint access,bool inherit,int process);
    [DllImport("kernel32.dll")]static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
}
