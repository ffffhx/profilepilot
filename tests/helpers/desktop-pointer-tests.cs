using System;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using ProfilePilot.Desktop;

// This executable links only pure coordinate code. It cannot query a display,
// create a window, capture a screenshot, install a hook or dispatch input.
public static class DesktopPointerTests {
    static readonly List<string> Checks=new List<string>();
    static int RoundTripPoints;
    static void Assert(bool value,string message){if(!value)throw new Exception(message);}
    static void Check(string name,Action body){body();Checks.Add(name);}
    static void Rejected(Action body,string parameter){
        try{body();}
        catch(ArgumentOutOfRangeException error){Assert(error.ParamName==parameter,"Unexpected rejected parameter: "+error.ParamName);return;}
        throw new Exception("Invalid coordinate or geometry was accepted");
    }
    static long Decode(int normalized,int origin,int span){return origin+((long)normalized*span)/65536L;}
    public static int Main(){
        Check("prepared packets request only MOVE, ABSOLUTE and VIRTUALDESK",()=>{
            var packet=DesktopPointerCoordinates.Normalize(20,30,0,0,1920,1080);
            Assert(DesktopPointerCoordinates.AbsoluteMoveFlags==0xc001u && packet.Flags==0xc001u,"Wrong pointer flags");
            Assert(packet.X>0 && packet.X<=65535 && packet.Y>0 && packet.Y<=65535,"Packet outside normalized range");
        });
        Check("one-pixel axes target their center without division by zero",()=>{
            foreach(int origin in new[]{Int32.MinValue,-1,0,1,Int32.MaxValue})
                Assert(DesktopPointerCoordinates.NormalizeAxis(origin,origin,1)==32768,"Singleton axis did not map to center");
        });
        Check("negative virtual desktop origins and last included pixels map correctly",()=>{
            var first=DesktopPointerCoordinates.Normalize(-3840,-1080,-3840,-1080,7680,3240);
            var last=DesktopPointerCoordinates.Normalize(3839,2159,-3840,-1080,7680,3240);
            Assert(first.X==4 && first.Y==10 && last.X==65531 && last.Y==65525,"Negative-origin midpoint mismatch");
            Assert(Decode(first.X,-3840,7680)==-3840 && Decode(first.Y,-1080,3240)==-1080,"First pixel moved");
            Assert(Decode(last.X,-3840,7680)==3839 && Decode(last.Y,-1080,3240)==2159,"Last pixel moved");
        });
        Check("translating physical origin preserves normalized offsets",()=>{
            foreach(int offset in new[]{0,1,1919,3839}){
                int expected=DesktopPointerCoordinates.NormalizeAxis(offset,0,3840);
                foreach(int origin in new[]{-32768,-3840,-1920,1920,32768})
                    Assert(DesktopPointerCoordinates.NormalizeAxis(origin+offset,origin,3840)==expected,"Translation changed mapping");
            }
        });
        Check("the maximum supported span uses 64-bit midpoint multiplication",()=>{
            Assert(DesktopPointerCoordinates.NormalizeAxis(0,0,32768)==1,"First normalized pixel wrong");
            Assert(DesktopPointerCoordinates.NormalizeAxis(32767,0,32768)==65535,"32-bit product overflowed");
            Assert(DesktopPointerCoordinates.NormalizeAxis(16384,0,32768)==32769,"Midpoint rounding changed");
        });
        Check("valid geometry at Win32 LONG endpoints does not overflow",()=>{
            Assert(DesktopPointerCoordinates.NormalizeAxis(Int32.MinValue,Int32.MinValue,32768)==1,"Negative LONG endpoint changed");
            Assert(DesktopPointerCoordinates.NormalizeAxis(Int32.MinValue+32767,Int32.MinValue,32768)==65535,"Negative LONG span changed");
            Assert(DesktopPointerCoordinates.NormalizeAxis(Int32.MaxValue,Int32.MaxValue-32767,32768)==65535,"Positive LONG endpoint changed");
        });
        Check("zero, negative and unsupported large spans are rejected",()=>{
            foreach(int span in new[]{Int32.MinValue,-1,0,32769,65536,Int32.MaxValue})
                Rejected(()=>DesktopPointerCoordinates.NormalizeAxis(0,0,span),"span");
        });
        Check("points outside the half-open virtual rectangle are rejected without clamping",()=>{
            Rejected(()=>DesktopPointerCoordinates.Normalize(-101,0,-100,-100,200,200),"pixel");
            Rejected(()=>DesktopPointerCoordinates.Normalize(100,0,-100,-100,200,200),"pixel");
            Rejected(()=>DesktopPointerCoordinates.Normalize(0,-101,-100,-100,200,200),"pixel");
            Rejected(()=>DesktopPointerCoordinates.Normalize(0,100,-100,-100,200,200),"pixel");
        });
        Check("large signed differences cannot wrap into an apparently valid coordinate",()=>{
            Rejected(()=>DesktopPointerCoordinates.NormalizeAxis(Int32.MaxValue,Int32.MinValue,32768),"pixel");
            Rejected(()=>DesktopPointerCoordinates.NormalizeAxis(Int32.MinValue,Int32.MaxValue,1),"pixel");
        });
        Check("virtual geometry whose last pixel exceeds Win32 LONG is rejected",()=>{
            Rejected(()=>DesktopPointerCoordinates.NormalizeAxis(Int32.MaxValue,Int32.MaxValue,2),"origin");
            Rejected(()=>DesktopPointerCoordinates.NormalizeAxis(Int32.MaxValue-100,Int32.MaxValue-100,32768),"origin");
        });
        Check("both axes are validated before a usable pointer packet is returned",()=>{
            Rejected(()=>DesktopPointerCoordinates.Normalize(0,0,0,0,1920,0),"span");
            Rejected(()=>DesktopPointerCoordinates.Normalize(0,0,0,0,0,1080),"span");
            Rejected(()=>DesktopPointerCoordinates.Normalize(0,Int32.MaxValue,0,Int32.MaxValue,1920,2),"origin");
        });
        Check("480192 pixel-center mappings round-trip monotonically in the 65536-cell model",()=>{
            int[] spans={1,2,3,768,1080,1250,1440,1920,2160,2560,3440,3840,5760,7680,15360,32768};
            int[] origins={-32768,-3840,-1920,-1080,0,1920};
            foreach(int span in spans)foreach(int origin in origins){
                int previous=-1;
                for(int offset=0;offset<span;offset++){
                    int normalized=DesktopPointerCoordinates.NormalizeAxis(origin+offset,origin,span);
                    Assert(normalized>=1 && normalized<=65535 && normalized>previous,"Non-monotonic or invalid normalized value");
                    Assert(Decode(normalized,origin,span)==origin+offset,"Model round-trip changed a physical pixel");
                    previous=normalized;RoundTripPoints++;
                }
            }
            Assert(RoundTripPoints==480192,"Round-trip matrix changed unexpectedly");
        });
        Console.WriteLine(new JavaScriptSerializer().Serialize(new {ok=true,checks=Checks.ToArray(),roundTripPoints=RoundTripPoints,flags=DesktopPointerCoordinates.AbsoluteMoveFlags,osInputTest=false}));
        return 0;
    }
}
