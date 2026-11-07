// ProfilePilot-owned Windows Graphics Capture provider. No activation, picker,
// global desktop capture, implicit capture fallback or third-party runtime.
// This prototype deliberately never grants coordinate-input authority.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Runtime.CompilerServices;
using System.Threading;
using Windows.Foundation;
using Windows.Foundation.Metadata;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;

namespace ProfilePilot.Desktop {
    public sealed class WgcRectangle {
        public int X, Y, Width, Height;
        public bool Same(WgcRectangle other) { return other!=null && X==other.X && Y==other.Y && Width==other.Width && Height==other.Height; }
    }
    public sealed class WgcGeometry {
        public int ProcessId;
        public long ProcessStartedUtcTicks;
        public uint Dpi;
        public uint? DisplayAffinity;
        public WgcRectangle Window, VisibleFrame, Client;
        public bool Same(WgcGeometry other) {
            return other!=null && ProcessId==other.ProcessId && ProcessStartedUtcTicks==other.ProcessStartedUtcTicks && Dpi==other.Dpi && DisplayAffinity==other.DisplayAffinity && Window.Same(other.Window) && VisibleFrame.Same(other.VisibleFrame) && Client.Same(other.Client);
        }
    }
    public sealed class WgcCaptureResult {
        public bool Success;
        public string Status, Detail, HResult, GeometryStatus="unavailable";
        public string Source="windows-graphics-capture", ColorMode="SDR-BGRA8";
        public string Stage="admission";
        public bool CaptureStarted, FrameReceived;
        public byte[] Jpeg;
        public int Width, Height, ContentWidth, ContentHeight;
        public long FrameTimestampTicks;
        public double ElapsedMs;
        public string ForegroundBefore, ForegroundAfter;
        public string RequestedWindow;
        public bool WindowExistsAtEntry, WindowExistsAfterRuntime;
        public WgcGeometry Geometry;
        // Candidate means only that source dimensions matched stable DWM bounds.
        // Pixel-origin semantics still need the real fixture matrix. Do not
        // publish this as DesktopImage.captureRect or enable input yet.
        public WgcRectangle CandidateCaptureRect;
        public bool CoordinateInputAvailable { get { return false; } }
    }
    // Keep every public admission/result signature free of WinRT types. The
    // optional implementation lives in a separate type and is not initialized
    // by ordinary UIA/PrintWindow use of the same single-file helper.
    public static class WgcWindowCapture {
        public static WgcCaptureResult Capture(IntPtr window,Func<bool> cancelled,int timeoutMs=5000,int maximumSide=1600){
            var clock=Stopwatch.StartNew();
            try{
                if(timeoutMs<1 || timeoutMs>10000 || maximumSide<64 || maximumSide>1600)
                    return new WgcCaptureResult{Status="bad_request",Detail="Expected a 1..10000 ms deadline and 64..1600 output side.",ElapsedMs=clock.Elapsed.TotalMilliseconds};
                if(cancelled!=null && cancelled())
                    return new WgcCaptureResult{Status="cancelled",Detail="Capture was cancelled; no fallback was attempted.",ElapsedMs=clock.Elapsed.TotalMilliseconds};
                return WgcCaptureRuntime.Capture(window,cancelled,timeoutMs,maximumSide,clock);
            }catch(Exception error){
                return new WgcCaptureResult{Success=false,Status=ErrorStatus(error),Detail=error.Message,HResult="0x"+unchecked((uint)error.HResult).ToString("X8"),ElapsedMs=clock.Elapsed.TotalMilliseconds};
            }
        }
        internal static string ErrorStatus(Exception error){
            uint code=unchecked((uint)error.HResult);
            if(code==0x80070005)return "access_denied";
            if(code==0x887A0005 || code==0x887A0006 || code==0x887A0007 || code==0x887A0020)return "device_lost";
            if(code==0x887A0004)return "device_unsupported";
            if(error is TypeLoadException || error is MissingMethodException || error is FileNotFoundException || error is EntryPointNotFoundException || error is DllNotFoundException || code==0x80040154 || code==0x80004002)return "unsupported_api";
            return "capture_failed";
        }
    }
    static class WgcCaptureRuntime {
        const int MaximumSide=8192;
        const long MaximumPixels=24000000;
        const uint D3d11CreateDeviceBgraSupport=0x20;
        const int RpcChangedMode=unchecked((int)0x80010106);
        [StructLayout(LayoutKind.Sequential)] struct NativeRect { public int Left,Top,Right,Bottom; }
        [StructLayout(LayoutKind.Sequential)] struct NativePoint { public int X,Y; }
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr window,out uint affinity);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out NativeRect rect);
        [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window,out NativeRect rect);
        [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window,ref NativePoint point);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
        [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
        [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("dwmapi.dll",EntryPoint="DwmGetWindowAttribute")] static extern int GetDwmRect(IntPtr window,int attribute,out NativeRect value,int size);
        [DllImport("dwmapi.dll",EntryPoint="DwmGetWindowAttribute")] static extern int GetDwmInt(IntPtr window,int attribute,out int value,int size);
        [DllImport("combase.dll")] static extern int RoInitialize(uint type);
        [DllImport("combase.dll")] static extern void RoUninitialize();
        [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter,int driverType,IntPtr software,uint flags,IntPtr featureLevels,uint featureLevelCount,uint sdkVersion,out IntPtr device,out int featureLevel,out IntPtr context);
        [DllImport("d3d11.dll")] static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice,out IntPtr graphicsDevice);
        [ComImport,System.Runtime.InteropServices.Guid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IGraphicsCaptureItemInterop {
            [PreserveSig] int CreateForWindow(IntPtr window,ref Guid iid,out IntPtr item);
            [PreserveSig] int CreateForMonitor(IntPtr monitor,ref Guid iid,out IntPtr item);
        }
        [ComImport,System.Runtime.InteropServices.Guid("5B0D3235-4DBA-4D44-865E-8F1D0E4FD04D"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMemoryBufferByteAccess { void GetBuffer(out IntPtr buffer,out uint capacity); }
        sealed class CaptureFault : Exception {
            public readonly string Status;
            public CaptureFault(string status,string detail):base(detail){Status=status;}
        }
        sealed class Signals {
            public volatile bool Closed;
            public readonly AutoResetEvent Changed=new AutoResetEvent(false);
            public void Signal(){try{Changed.Set();}catch(ObjectDisposedException){}}
        }
        static void Require(bool condition,string status,string detail){if(!condition)throw new CaptureFault(status,detail);}
        static void Check(Stopwatch clock,int timeoutMs,Func<bool> cancelled){
            if(cancelled!=null && cancelled())throw new CaptureFault("cancelled","Capture was cancelled; no fallback was attempted.");
            if(clock.ElapsedMilliseconds>=timeoutMs)throw new CaptureFault("timeout","The bounded capture deadline expired; no fallback was attempted.");
        }
        static void ThrowHr(int result){if(result<0)Marshal.ThrowExceptionForHR(result);}
        static void DisposeQuietly(IDisposable value){if(value!=null)try{value.Dispose();}catch{}}
        static WgcRectangle Rectangle(NativeRect value){return new WgcRectangle{X=value.Left,Y=value.Top,Width=value.Right-value.Left,Height=value.Bottom-value.Top};}
        static void ValidateSize(int width,int height){Require(width>0 && height>0 && width<=MaximumSide && height<=MaximumSide && (long)width*height<=MaximumPixels,"size_limit","Capture dimensions exceed the 8192-side / 24-million-pixel allowance.");}

        // Caller owns the temporary per-monitor-v2 DPI context.
        static WgcGeometry InspectGeometry(IntPtr window){
            Require(window!=IntPtr.Zero && IsWindow(window),"window_closed","The selected HWND is absent.");
            Require(!IsIconic(window),"window_minimized","The selected window is minimized; capture will not restore it.");
            Require(IsWindowVisible(window),"window_hidden","The selected window is hidden; capture will not show it.");
            uint affinity;bool affinityKnown=GetWindowDisplayAffinity(window,out affinity);
            Require(!affinityKnown || affinity==0,"capture_protected","The selected window excludes its content from capture; no fallback was attempted.");
            int cloaked;ThrowHr(GetDwmInt(window,14,out cloaked,sizeof(int)));
            Require(cloaked==0,"window_cloaked","The selected window is cloaked on this desktop.");
            NativeRect windowRect=new NativeRect(),frameRect=new NativeRect(),clientRect=new NativeRect();NativePoint clientOrigin=new NativePoint();
            Require(GetWindowRect(window,out windowRect) && GetClientRect(window,out clientRect) && ClientToScreen(window,ref clientOrigin),"geometry_unavailable","Could not read the selected window and client geometry.");
            ThrowHr(GetDwmRect(window,9,out frameRect,Marshal.SizeOf(typeof(NativeRect))));
            uint pid;Require(GetWindowThreadProcessId(window,out pid)!=0 && pid!=0,"window_closed","The selected HWND no longer has a process.");
            long started;using(var process=Process.GetProcessById((int)pid))started=process.StartTime.ToUniversalTime().Ticks;
            var geometry=new WgcGeometry{ProcessId=(int)pid,ProcessStartedUtcTicks=started,Dpi=GetDpiForWindow(window),DisplayAffinity=affinityKnown?(uint?)affinity:null,Window=Rectangle(windowRect),VisibleFrame=Rectangle(frameRect),Client=new WgcRectangle{X=clientOrigin.X,Y=clientOrigin.Y,Width=clientRect.Right-clientRect.Left,Height=clientRect.Bottom-clientRect.Top}};
            ValidateSize(geometry.VisibleFrame.Width,geometry.VisibleFrame.Height);
            Require(geometry.Window.Width>0 && geometry.Window.Height>0 && geometry.Dpi>0,"geometry_unavailable","The selected window has invalid physical geometry.");
            return geometry;
        }

        static IDirect3DDevice CreateDevice(){
            IntPtr device=IntPtr.Zero,context=IntPtr.Zero,dxgi=IntPtr.Zero,inspectable=IntPtr.Zero;
            try{
                int featureLevel;
                ThrowHr(D3D11CreateDevice(IntPtr.Zero,1,IntPtr.Zero,D3d11CreateDeviceBgraSupport,IntPtr.Zero,0,7,out device,out featureLevel,out context));
                Guid dxgiId=new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
                ThrowHr(Marshal.QueryInterface(device,ref dxgiId,out dxgi));
                ThrowHr(CreateDirect3D11DeviceFromDXGIDevice(dxgi,out inspectable));
                return (IDirect3DDevice)Marshal.GetObjectForIUnknown(inspectable);
            }finally{
                if(inspectable!=IntPtr.Zero)Marshal.Release(inspectable);
                if(dxgi!=IntPtr.Zero)Marshal.Release(dxgi);
                if(context!=IntPtr.Zero)Marshal.Release(context);
                if(device!=IntPtr.Zero)Marshal.Release(device);
            }
        }
        static GraphicsCaptureItem CreateItem(IntPtr window){
            object factory=WindowsRuntimeMarshal.GetActivationFactory(typeof(GraphicsCaptureItem));
            IntPtr pointer=IntPtr.Zero;
            try{
                Guid itemId=new Guid("79c3f95b-31f7-4ec2-a464-632ef5d30760");
                ThrowHr(((IGraphicsCaptureItemInterop)factory).CreateForWindow(window,ref itemId,out pointer));
                Require(pointer!=IntPtr.Zero,"empty_item","Windows returned no selected-window capture item.");
                return (GraphicsCaptureItem)Marshal.GetObjectForIUnknown(pointer);
            }finally{if(pointer!=IntPtr.Zero)Marshal.Release(pointer);}
        }
        static SoftwareBitmap Readback(Direct3D11CaptureFrame frame,Stopwatch clock,int timeoutMs,Func<bool> cancelled){
            // .NET Framework's await/IBuffer extensions reference the SDK's
            // unified Windows.winmd. Direct IAsyncOperation admission avoids
            // that extra reference and never waits without checking cancellation.
            var operation=SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface);
            try{
                while(operation.Status==AsyncStatus.Started){Check(clock,timeoutMs,cancelled);Thread.Sleep(5);}
                Check(clock,timeoutMs,cancelled);
                Require(operation.Status!=AsyncStatus.Canceled,"cancelled","Windows cancelled the surface readback.");
                return operation.GetResults();
            }finally{
                try{if(operation.Status==AsyncStatus.Started)operation.Cancel();}catch{}
                // Closing a still-running cancelled WinRT operation may reject.
                // We never replace its primary result or wait indefinitely here.
                try{operation.Close();}catch{}
            }
        }
        static byte[] Encode(SoftwareBitmap bitmap,int maximumSide,Stopwatch clock,int timeoutMs,Func<bool> cancelled,out int width,out int height){
            Require(bitmap.BitmapPixelFormat==BitmapPixelFormat.Bgra8,"pixel_format_unsupported","WGC returned a non-BGRA8 surface; HDR conversion is not implemented.");
            ValidateSize(bitmap.PixelWidth,bitmap.PixelHeight);
            double scale=Math.Min(1,maximumSide/(double)Math.Max(bitmap.PixelWidth,bitmap.PixelHeight));
            width=Math.Max(1,(int)(bitmap.PixelWidth*scale));height=Math.Max(1,(int)(bitmap.PixelHeight*scale));
            using(var locked=bitmap.LockBuffer(BitmapBufferAccessMode.Read))
            using(var reference=locked.CreateReference()){
                var plane=locked.GetPlaneDescription(0);IntPtr pointer;uint capacity;
                ((IMemoryBufferByteAccess)(object)reference).GetBuffer(out pointer,out capacity);
                long end=(long)plane.StartIndex+(long)(bitmap.PixelHeight-1)*plane.Stride+(long)bitmap.PixelWidth*4;
                Require(pointer!=IntPtr.Zero && plane.StartIndex>=0 && plane.Stride>0 && plane.Stride>=(long)bitmap.PixelWidth*4 && end<=capacity,"empty_frame","The captured pixel buffer has invalid or incomplete bounds.");
                Check(clock,timeoutMs,cancelled);
                var format=bitmap.BitmapAlphaMode==BitmapAlphaMode.Premultiplied?PixelFormat.Format32bppPArgb:PixelFormat.Format32bppArgb;
                using(var source=new Bitmap(bitmap.PixelWidth,bitmap.PixelHeight,plane.Stride,format,IntPtr.Add(pointer,plane.StartIndex)))
                using(var resized=new Bitmap(width,height,PixelFormat.Format24bppRgb)){
                    using(var graphics=Graphics.FromImage(resized)){
                        graphics.Clear(Color.White);graphics.InterpolationMode=InterpolationMode.HighQualityBilinear;
                        graphics.DrawImage(source,new System.Drawing.Rectangle(0,0,width,height));
                    }
                    Check(clock,timeoutMs,cancelled);
                    using(var bytes=new MemoryStream())
                    using(var parameters=new EncoderParameters(1)){
                        parameters.Param[0]=new EncoderParameter(System.Drawing.Imaging.Encoder.Quality,90L);
                        ImageCodecInfo codec=null;foreach(var candidate in ImageCodecInfo.GetImageEncoders())if(candidate.FormatID==ImageFormat.Jpeg.Guid){codec=candidate;break;}
                        Require(codec!=null,"encoder_unavailable","The system JPEG encoder is unavailable.");
                        resized.Save(bytes,codec,parameters);return bytes.ToArray();
                    }
                }
            }
        }
        static string ErrorStatus(Exception error){
            var fault=error as CaptureFault;if(fault!=null)return fault.Status;
            return WgcWindowCapture.ErrorStatus(error);
        }
        // 1903 supports HWND capture but not this 2004 property. Keep its member
        // reference out of the main capture method's JIT compilation as well.
        [MethodImpl(MethodImplOptions.NoInlining)]
        static void DisableCursor(GraphicsCaptureSession session){session.IsCursorCaptureEnabled=false;}

        // Older Windows may fail while JIT-compiling this method, before its
        // own try block. The separate BCL-only admission type catches that.
        [MethodImpl(MethodImplOptions.NoInlining)]
        internal static WgcCaptureResult Capture(IntPtr window,Func<bool> cancelled,int timeoutMs,int maximumSide,Stopwatch clock){
            var result=new WgcCaptureResult();
            IntPtr previousDpi=IntPtr.Zero;bool initialized=false;
            IDirect3DDevice device=null;GraphicsCaptureItem item=null;Direct3D11CaptureFramePool pool=null;GraphicsCaptureSession session=null;Direct3D11CaptureFrame frame=null;
            var signals=new Signals();
            TypedEventHandler<Direct3D11CaptureFramePool,object> arrived=(sender,args)=>signals.Signal();
            TypedEventHandler<GraphicsCaptureItem,object> closed=(sender,args)=>{signals.Closed=true;signals.Signal();};
            bool watchingFrames=false,watchingItem=false;
            try{
                Require(timeoutMs>=1 && timeoutMs<=10000 && maximumSide>=64 && maximumSide<=1600,"bad_request","Expected a 1..10000 ms deadline and 64..1600 output side.");
                Check(clock,timeoutMs,cancelled);
                result.ForegroundBefore=GetForegroundWindow().ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture);
                result.RequestedWindow=window.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture);
                result.WindowExistsAtEntry=IsWindow(window);
                result.Stage="initialize";
                previousDpi=SetThreadDpiAwarenessContext(new IntPtr(-4));
                Require(previousDpi!=IntPtr.Zero,"dpi_context_unavailable","Could not establish a physical per-monitor-v2 coordinate context.");
                int hr=RoInitialize(1);if(hr>=0)initialized=true;else if(hr!=RpcChangedMode)ThrowHr(hr);
                Require(ApiInformation.IsMethodPresent("Windows.Graphics.Capture.Direct3D11CaptureFramePool","CreateFreeThreaded") && GraphicsCaptureSession.IsSupported(),"unsupported_capture","Windows Graphics Capture is unavailable on this device.");
                result.WindowExistsAfterRuntime=IsWindow(window);
                result.Stage="geometry";
                result.Geometry=InspectGeometry(window);
                Check(clock,timeoutMs,cancelled);
                result.Stage="device";device=CreateDevice();Check(clock,timeoutMs,cancelled);
                result.Stage="item";item=CreateItem(window);Check(clock,timeoutMs,cancelled);
                item.Closed+=closed;watchingItem=true;
                var size=item.Size;
                Require(size.Width==result.Geometry.VisibleFrame.Width && size.Height==result.Geometry.VisibleFrame.Height,"geometry_mismatch","Capture item size does not match the selected window's physical DWM bounds.");
                // One bounded frame is sufficient for a still image and limits
                // GPU allocations. No screen-wide source or fallback is created.
                pool=Direct3D11CaptureFramePool.CreateFreeThreaded(device,DirectXPixelFormat.B8G8R8A8UIntNormalized,1,size);
                pool.FrameArrived+=arrived;watchingFrames=true;
                session=pool.CreateCaptureSession(item);
                if(ApiInformation.IsPropertyPresent("Windows.Graphics.Capture.GraphicsCaptureSession","IsCursorCaptureEnabled"))DisableCursor(session);
                // Keep the system capture border. No permission dialog for
                // borderless access and no attempt to suppress capture notices.
                Check(clock,timeoutMs,cancelled);
                result.Stage="start_capture";session.StartCapture();result.CaptureStarted=true;result.Stage="frame_wait";
                while(frame==null){
                    Check(clock,timeoutMs,cancelled);
                    Require(!signals.Closed && IsWindow(window),"window_closed","The selected capture item closed before a frame arrived.");
                    frame=pool.TryGetNextFrame();
                    if(frame==null)signals.Changed.WaitOne((int)Math.Max(1,Math.Min(25,timeoutMs-clock.ElapsedMilliseconds)));
                }
                var content=frame.ContentSize;
                result.FrameReceived=true;result.Stage="frame_geometry";
                Require(content.Width>0 && content.Height>0,"empty_frame","Windows returned an empty capture frame.");
                result.ContentWidth=content.Width;result.ContentHeight=content.Height;result.FrameTimestampTicks=frame.SystemRelativeTime.Ticks;
                Require(content.Width==size.Width && content.Height==size.Height,"size_changed","Window size changed while the first frame was being captured; no clipped frame was published.");
                Require(result.Geometry.Same(InspectGeometry(window)),"window_changed","The selected process or physical window geometry changed during capture.");
                result.Stage="readback";
                using(var bitmap=Readback(frame,clock,timeoutMs,cancelled)){
                    Require(bitmap.PixelWidth==content.Width && bitmap.PixelHeight==content.Height,"size_changed","The frame surface and content size disagree.");
                    result.Stage="encode";result.Jpeg=Encode(bitmap,maximumSide,clock,timeoutMs,cancelled,out result.Width,out result.Height);
                }
                Check(clock,timeoutMs,cancelled);
                Require(!signals.Closed && result.Geometry.Same(InspectGeometry(window)),"window_changed","The selected window changed while pixels were being read back.");
                var outer=result.Geometry.Window;var visible=result.Geometry.VisibleFrame;
                int x=visible.X-outer.X,y=visible.Y-outer.Y;
                Require(x>=0 && y>=0 && (long)x+visible.Width<=outer.Width && (long)y+visible.Height<=outer.Height,"geometry_mismatch","DWM capture bounds are outside the selected physical window.");
                result.CandidateCaptureRect=new WgcRectangle{X=x,Y=y,Width=visible.Width,Height=visible.Height};
                result.GeometryStatus="stable_dimensions_match_origin_unvalidated";
                result.Success=true;result.Status="captured_unmapped";
                result.Stage="complete";
                result.Detail="WGC bytes and physical dimensions agree. Pixel-origin mapping is not yet qualified for coordinate input.";
            }catch(Exception error){
                result.Success=false;result.Status=ErrorStatus(error);result.Detail=error.Message;
                result.HResult="0x"+unchecked((uint)error.HResult).ToString("X8");result.Jpeg=null;
            }finally{
                if(watchingFrames)try{pool.FrameArrived-=arrived;}catch{}
                if(watchingItem)try{item.Closed-=closed;}catch{}
                DisposeQuietly(frame);DisposeQuietly(session);DisposeQuietly(pool);DisposeQuietly(device);
                signals.Changed.Dispose();
                if(initialized)RoUninitialize();
                if(previousDpi!=IntPtr.Zero)SetThreadDpiAwarenessContext(previousDpi);
                result.ForegroundAfter=GetForegroundWindow().ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture);
                result.ElapsedMs=clock.Elapsed.TotalMilliseconds;
            }
            return result;
        }
    }
}
