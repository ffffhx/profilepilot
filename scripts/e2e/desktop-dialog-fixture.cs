using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Owned native Common Item Dialog acceptance surface. No hook or input injector.
// Framework FileDialog lacks public AddToRecent, so this fixture calls the
// documented IFileOpenDialog API with FOS_DONTADDTORECENT, without reflection.
public static class DesktopDialogFixture {
    const uint Options=0x02000000|0x00001000|0x00000800|0x8|0x40|0x00040000;
    const int Cancelled=unchecked((int)0x800704C7);
    public const string FileLabel="Owned file",OpenLabel="Open owned";
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
    static string state,nonce,directory,allowedFile,startedTicks,activeTitle,activeMode,closeReason="window_closed";
    static int pid,sequence,sentinels,reentrant,rejectedFolders,rejectedFiles,fileOkCalls,acceptedFiles;
    static uint threadId;
    static bool closing,dialogBusy,cleanupAfterRelease;
    static IntPtr parentHandle,dialogHandle;
    static IFileDialog active;
    static Form form;
    public sealed class FailureDetails {
        public string operation,type,hresultHex,message;
        public int hresult;
    }
    public sealed class FreshCleanupDetails {
        public bool attempted,clientScoped,cleared,released;
        public int? clearHresult;
        public string skippedReason;
        public FailureDetails[] failures;
    }
    // Explicit diagnostic only. This object is never shown or assigned active.
    // The original instance's failure remains part of the overall result.
    static FreshCleanupDetails ClearWithFreshInstance(Guid client) {
        var result=new FreshCleanupDetails{attempted=true};var failures=new List<FailureDetails>();
        IFileDialog fresh=null;string operation="FreshFileOpenDialog.Create";
        try{
            fresh=(IFileDialog)new FileOpenDialog();
            operation="FreshIFileDialog.SetClientGuid";fresh.SetClientGuid(ref client);result.clientScoped=true;
            operation="FreshIFileDialog.ClearClientData";fresh.ClearClientData();result.clearHresult=0;result.cleared=true;
        }catch(Exception failure){
            if(operation=="FreshIFileDialog.ClearClientData")result.clearHresult=failure.HResult;
            failures.Add(DescribeFailure(operation,failure));
        }finally{
            try{Release(fresh);result.released=fresh!=null;}catch(Exception failure){failures.Add(DescribeFailure("ReleaseFreshDialog",failure));}
        }
        result.failures=failures.ToArray();return result;
    }
    // Pure formatting: do not use GetHRForException, which mutates COM error info.
    public static FailureDetails DescribeFailure(string operation,Exception failure){
        return new FailureDetails{operation=operation,type=failure.GetType().FullName,hresult=failure.HResult,
            hresultHex="0x"+unchecked((uint)failure.HResult).ToString("X8",System.Globalization.CultureInfo.InvariantCulture),message=failure.Message};
    }
    static void Save(string suffix,object value){
        string file=state+suffix,temporary=file+".new";
        File.WriteAllText(temporary,Json.Serialize(value),new UTF8Encoding(false));
        if(File.Exists(file))File.Replace(temporary,file,null);else File.Move(temporary,file);
    }
    static bool SamePath(string first,string second){return String.Equals(Path.GetFullPath(first),Path.GetFullPath(second),StringComparison.OrdinalIgnoreCase);}
    static string ItemPath(IShellItem item){
        IntPtr value;item.GetDisplayName(0x80058000,out value);
        try{return Marshal.PtrToStringUni(value);}finally{Marshal.FreeCoTaskMem(value);}
    }
    static void Release(object value){if(value!=null && Marshal.IsComObject(value))Marshal.FinalReleaseComObject(value);}
    static void SaveState(){Save(".state.json",new{nonce,pid,startedUtcTicks=startedTicks,sequence,sentinels,reentrant,rejectedFolders,rejectedFiles,fileOkCalls,acceptedFiles,modal=active!=null,closing});}
    static void FindDialog(){
        if(active==null || dialogHandle!=IntPtr.Zero)return;
        EnumThreadWindows(threadId,(handle,unused)=>{
            uint ownerPid;GetWindowThreadProcessId(handle,out ownerPid);
            var title=new StringBuilder(512);GetWindowText(handle,title,title.Capacity);
            var kind=new StringBuilder(128);GetClassName(handle,kind,kind.Capacity);
            if(ownerPid==(uint)pid && title.ToString()==activeTitle && kind.ToString()=="#32770" && GetWindow(handle,4)==parentHandle){
                dialogHandle=handle;
                Save(".dialog-"+sequence+".json",new{nonce,pid,startedUtcTicks=startedTicks,sequence,mode=activeMode,title=activeTitle,hwnd=handle.ToInt64().ToString(),ownerHwnd=parentHandle.ToInt64().ToString(),className=kind.ToString(),options=Options,addToRecent=false});
                return false;
            }
            return true;
        },IntPtr.Zero);
    }
    static void CloseOwned(string reason){
        if(closing)return;closing=true;closeReason=reason;SaveState();
        if(active!=null){active.Close(Cancelled);return;}
        if(dialogBusy)return;
        form.Close();
    }
    [ComVisible(true),ClassInterface(ClassInterfaceType.None)]
    public sealed class Events : IFileDialogEvents {
        public int OnFileOk(IFileDialog dialog){
            IShellItem selected=null;
            fileOkCalls++;
            try{dialog.GetResult(out selected);if(SamePath(ItemPath(selected),allowedFile)){acceptedFiles++;SaveState();return 0;}}
            catch{ /* Fail closed; never emit another path or read its contents. */ }
            finally{Release(selected);}
            rejectedFiles++;SaveState();return 1;
        }
        public int OnFolderChanging(IFileDialog dialog,IShellItem folder){
            try{if(SamePath(ItemPath(folder),directory))return 0;}catch{}
            rejectedFolders++;SaveState();return 1;
        }
        public int OnFolderChange(IFileDialog dialog){FindDialog();return 0;}
        public int OnSelectionChange(IFileDialog dialog){return 0;}
        public int OnShareViolation(IFileDialog dialog,IShellItem item,out uint response){response=0;return 0;}
        public int OnTypeChange(IFileDialog dialog){return 0;}
        public int OnOverwrite(IFileDialog dialog,IShellItem item,out uint response){response=0;return 0;}
    }
    static void Open(string mode){
        if(closing || dialogBusy){reentrant++;SaveState();return;}
        dialogBusy=true;
        sequence++;activeMode=mode;activeTitle="ProfilePilot native dialog "+nonce+" "+sequence;dialogHandle=IntPtr.Zero;
        IFileDialog dialog=null;IShellItem folder=null;uint cookie=0;bool advised=false,clientScoped=false,clientCleared=false,clientCleanupAttempted=false,showInvoked=false,showReturned=false;
        var failures=new List<FailureDetails>();Guid client=new Guid(nonce);
        bool originalRcwReleased=false;FreshCleanupDetails freshCleanup=null;
        int result=unchecked((int)0x80004005);string selectedPath=null,workingDirectory=Environment.CurrentDirectory,operation="FileOpenDialog.Create";
        try{
            dialog=(IFileDialog)new FileOpenDialog();active=dialog;
            // SetClientGuid is documented to be the first call after creation.
            operation="IFileDialog.SetClientGuid";dialog.SetClientGuid(ref client);clientScoped=true;
            operation="IFileDialog.SetOptions";dialog.SetOptions(Options);uint actualOptions;
            operation="IFileDialog.GetOptions";dialog.GetOptions(out actualOptions);
            operation="VerifyOptions";
            if((actualOptions&Options)!=Options || (actualOptions&0x200)!=0)throw new InvalidOperationException("Common dialog option contract was not applied");
            operation="SHCreateItemFromParsingName";Guid shellId=typeof(IShellItem).GUID;int hr=SHCreateItemFromParsingName(directory,IntPtr.Zero,ref shellId,out folder);Marshal.ThrowExceptionForHR(hr);
            operation="IFileDialog.SetDefaultFolder";dialog.SetDefaultFolder(folder);
            operation="IFileDialog.SetFolder";dialog.SetFolder(folder);
            operation="IFileDialog.SetTitle";dialog.SetTitle(activeTitle);
            // The nonce is in the exact dialog title. Long labels can consume
            // the common dialog's filename field/button layout at 125% DPI.
            operation="IFileDialog.SetOkButtonLabel";dialog.SetOkButtonLabel(OpenLabel);
            operation="IFileDialog.SetFileNameLabel";dialog.SetFileNameLabel(FileLabel);
            operation="IFileDialog.SetFileTypes";dialog.SetFileTypes(1,new[]{new FilterSpec{label="Owned nonce text",pattern=Path.GetFileName(allowedFile)}});
            operation="IFileDialog.SetFileTypeIndex";dialog.SetFileTypeIndex(1);
            operation="IFileDialog.SetDefaultExtension";dialog.SetDefaultExtension("txt");
            operation="IFileDialog.SetFileName";dialog.SetFileName("");
            operation="IFileDialog.Advise";dialog.Advise(new Events(),out cookie);advised=true;
            operation="WriteOpeningReceipt";
            Save(".opening-"+sequence+".json",new{nonce,pid,startedUtcTicks=startedTicks,sequence,mode,options=actualOptions,addToRecent=false,allowedFile,initialDirectory=directory,restoresDirectory=true,multiselect=false,clientGuid=client.ToString("D"),clientScoped,fileLabel=FileLabel,openLabel=OpenLabel});SaveState();
            // Deliberately synchronous. Acceptance must discover whether native
            // UIA Invoke returns while this real modal loop is still running.
            operation="IFileDialog.Show";showInvoked=true;result=dialog.Show(parentHandle);showReturned=true;
            if(result==0){
                IShellItem item=null;try{
                    operation="IFileDialog.GetResult";dialog.GetResult(out item);
                    operation="IShellItem.GetDisplayName";string candidate=ItemPath(item);
                    operation="VerifyOwnedSelection";if(!SamePath(candidate,allowedFile))throw new InvalidOperationException("Unowned selection refused");selectedPath=allowedFile;
                }finally{try{Release(item);}catch(Exception failure){failures.Add(DescribeFailure("ReleaseSelectedItem",failure));}}
            }else if(result!=Cancelled)Marshal.ThrowExceptionForHR(result);
        }catch(Exception failure){failures.Add(DescribeFailure(operation,failure));}
        finally{
            if(dialog!=null){
                try{if(advised)dialog.Unadvise(cookie);}catch(Exception failure){failures.Add(DescribeFailure("IFileDialog.Unadvise",failure));}
                // Never clear default user history if setup failed before the
                // nonce-derived client GUID was accepted by this instance.
                if(clientScoped)try{clientCleanupAttempted=true;dialog.ClearClientData();clientCleared=true;}catch(Exception failure){failures.Add(DescribeFailure("IFileDialog.ClearClientData",failure));}
            }
            active=null;
            try{Release(folder);}catch(Exception failure){failures.Add(DescribeFailure("ReleaseFolder",failure));}
            try{Release(dialog);originalRcwReleased=dialog!=null;}catch(Exception failure){failures.Add(DescribeFailure("ReleaseDialog",failure));}
            if(cleanupAfterRelease){
                bool prerequisites=clientScoped && originalRcwReleased && showReturned && (result==0 || result==Cancelled)
                    && failures.TrueForAll(value=>value.operation=="IFileDialog.ClearClientData");
                freshCleanup=prerequisites?ClearWithFreshInstance(client):new FreshCleanupDetails{skippedReason="original_lifecycle_unconfirmed",failures=new FailureDetails[0]};
            }
            bool workingDirectoryRestored=SamePath(Environment.CurrentDirectory,workingDirectory);
            string error=failures.Count==0?null:failures[0].operation+" "+failures[0].hresultHex+": "+failures[0].message;
            dialogBusy=false;
            Save(".result-"+sequence+".json",new{nonce,pid,startedUtcTicks=startedTicks,sequence,mode,result,resultHex="0x"+unchecked((uint)result).ToString("X8"),showInvoked,showReturned,
                ok=failures.Count==0&&workingDirectoryRestored&&(!cleanupAfterRelease || (freshCleanup.cleared&&freshCleanup.released&&freshCleanup.failures.Length==0)),
                selectedPath,error,failures,clientGuid=client.ToString("D"),clientScoped,clientCleanupAttempted,clientCleared,originalRcwReleased,freshCleanup,
                workingDirectoryRestored,parentEnabled=form.Enabled,closing,sentinels,reentrant,fileOkCalls,acceptedFiles});
            SaveState();if(closing)form.BeginInvoke((Action)(()=>form.Close()));
        }
    }
    [STAThread] static void Main(string[] args){
        if((args.Length!=3 && args.Length!=4) || !System.Text.RegularExpressions.Regex.IsMatch(args[1],"^[a-f0-9]{32}$")
            || (args.Length==4 && args[3]!="--cleanup-after-release"))throw new ArgumentException("Expected state, nonce and one owned file, optionally --cleanup-after-release");
        cleanupAfterRelease=args.Length==4;
        state=Path.GetFullPath(args[0]);nonce=args[1];allowedFile=Path.GetFullPath(args[2]);directory=Path.GetDirectoryName(allowedFile);
        if(!SamePath(Path.GetDirectoryName(state),directory) || Path.GetFileName(allowedFile)!=nonce+".txt" || !File.Exists(allowedFile) || (File.GetAttributes(allowedFile)&FileAttributes.ReparsePoint)!=0)throw new ArgumentException("Expected the precreated owned nonce file");
        using(var self=Process.GetCurrentProcess()){pid=self.Id;startedTicks=self.StartTime.ToUniversalTime().Ticks.ToString();}
        threadId=GetCurrentThreadId();var lifetime=Stopwatch.StartNew();
        Application.EnableVisualStyles();
        using(form=new Form{Text="ProfilePilot dialog fixture "+nonce,Width=700,Height=220,StartPosition=FormStartPosition.CenterScreen}){
            var cancel=new Button{Left=20,Top=25,Width=300,Height=40,Text="Open cancellation dialog",AccessibleName="Open cancellation dialog "+nonce};
            var open=new Button{Left=340,Top=25,Width=300,Height=40,Text="Open selection dialog",AccessibleName="Open selection dialog "+nonce};
            var sentinel=new Button{Left=20,Top=90,Width=620,Height=35,Text="Parent sentinel",AccessibleName="Parent sentinel "+nonce};
            cancel.Click+=(s,e)=>Open("cancel");open.Click+=(s,e)=>Open("open");sentinel.Click+=(s,e)=>{sentinels++;SaveState();};
            form.Controls.AddRange(new Control[]{cancel,open,sentinel});
            var timer=new Timer{Interval=50};
            timer.Tick+=(s,e)=>{
                try{
                    FindDialog();
                    if(File.Exists(state+".close") && File.ReadAllText(state+".close",Encoding.UTF8)==nonce){CloseOwned("requested");return;}
                    if(lifetime.ElapsedMilliseconds>300000 || !File.Exists(state+".heartbeat") || DateTime.UtcNow-File.GetLastWriteTimeUtc(state+".heartbeat")>TimeSpan.FromSeconds(30))CloseOwned("heartbeat_or_ttl");
                }catch(Exception failure){Save(".fixture-error.json",new{nonce,pid,startedUtcTicks=startedTicks,error=DescribeFailure("FixtureTimer",failure)});CloseOwned("fixture_error");}
            };
            form.Shown+=(s,e)=>{parentHandle=form.Handle;Save(".ready.json",new{nonce,pid,startedUtcTicks=startedTicks,hwnd=parentHandle.ToInt64().ToString(),title=form.Text,administrator=new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator),allowedFile,directory,dialogApi="IFileOpenDialog",addToRecent=false});SaveState();timer.Start();};
            form.FormClosed+=(s,e)=>{timer.Dispose();Save(".closed.json",new{nonce,pid,startedUtcTicks=startedTicks,reason=closeReason,modal=active!=null,sequence,sentinels,reentrant});};
            Application.Run(form);
        }
    }
    delegate bool WindowCallback(IntPtr window,IntPtr unused);
    [DllImport("user32.dll")]static extern bool EnumThreadWindows(uint thread,WindowCallback callback,IntPtr unused);
    [DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr window,StringBuilder text,int count);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr window,StringBuilder text,int count);
    [DllImport("user32.dll")]static extern IntPtr GetWindow(IntPtr window,uint relation);
    [DllImport("shell32.dll",CharSet=CharSet.Unicode,PreserveSig=true)]static extern int SHCreateItemFromParsingName(string path,IntPtr binding,ref Guid iid,out IShellItem item);
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]public struct FilterSpec{[MarshalAs(UnmanagedType.LPWStr)]public string label;[MarshalAs(UnmanagedType.LPWStr)]public string pattern;}
    [ComImport,Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]class FileOpenDialog{}
    [ComImport,Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]public interface IShellItem{
        void BindToHandler(IntPtr binding,ref Guid handler,ref Guid iid,out IntPtr result);void GetParent(out IShellItem parent);
        void GetDisplayName(uint kind,out IntPtr name);void GetAttributes(uint mask,out uint attributes);void Compare(IShellItem item,uint hint,out int order);
    }
    [ComImport,Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]public interface IFileDialog{
        [PreserveSig]int Show(IntPtr parent);
        void SetFileTypes(uint count,[MarshalAs(UnmanagedType.LPArray,SizeParamIndex=0)]FilterSpec[] filters);void SetFileTypeIndex(uint index);void GetFileTypeIndex(out uint index);
        void Advise(IFileDialogEvents events,out uint cookie);void Unadvise(uint cookie);void SetOptions(uint options);void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem folder);void SetFolder(IShellItem folder);void GetFolder(out IShellItem folder);void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)]string name);void GetFileName([MarshalAs(UnmanagedType.LPWStr)]out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)]string title);void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)]string text);void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)]string label);
        void GetResult(out IShellItem item);void AddPlace(IShellItem item,uint placement);void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)]string extension);
        void Close(int result);void SetClientGuid(ref Guid client);void ClearClientData();void SetFilter(IntPtr filter);
    }
    [ComVisible(true),Guid("973510DB-7D7F-452B-8975-74A85828D354"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]public interface IFileDialogEvents{
        [PreserveSig]int OnFileOk(IFileDialog dialog);[PreserveSig]int OnFolderChanging(IFileDialog dialog,IShellItem folder);
        [PreserveSig]int OnFolderChange(IFileDialog dialog);[PreserveSig]int OnSelectionChange(IFileDialog dialog);
        [PreserveSig]int OnShareViolation(IFileDialog dialog,IShellItem item,out uint response);[PreserveSig]int OnTypeChange(IFileDialog dialog);
        [PreserveSig]int OnOverwrite(IFileDialog dialog,IShellItem item,out uint response);
    }
}
