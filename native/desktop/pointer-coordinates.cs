using System;

namespace ProfilePilot.Desktop {
    public struct DesktopAbsolutePointer {
        public readonly int X,Y;
        public readonly uint Flags;
        internal DesktopAbsolutePointer(int x,int y){X=x;Y=y;Flags=DesktopPointerCoordinates.AbsoluteMoveFlags;}
    }
    // Pure geometry preparation only. Inputs are physical screen pixels, not
    // DIPs or screenshot pixels. The caller owns DPI awareness, current virtual
    // desktop metrics, window/occlusion checks, cancellation and actual input.
    public static class DesktopPointerCoordinates {
        public const int MaximumSpan=32768;
        public const uint AbsoluteMoveFlags=0x0001u|0x8000u|0x4000u; // MOVE | ABSOLUTE | VIRTUALDESK

        public static int NormalizeAxis(int pixel,int origin,int span){
            if(span<1 || span>MaximumSpan)throw new ArgumentOutOfRangeException("span");
            // Validate the last included pixel, not the exclusive end. A one-
            // pixel axis at Int32.MaxValue is valid without overflowing an int.
            if((long)origin+span-1>Int32.MaxValue)throw new ArgumentOutOfRangeException("origin");
            long offset=(long)pixel-origin;
            if(offset<0 || offset>=span)throw new ArgumentOutOfRangeException("pixel");
            // Target a pixel's midpoint in the 65536-cell absolute input space.
            // Microsoft WPF uses this approach to avoid rounding into a previous
            // pixel: https://source.dot.net/UIAutomationClientSideProviders/MS/Internal/AutomationProxies/Input.cs.html
            // The numerator can exceed Int32.MaxValue even for a supported span.
            return (int)(((2L*offset+1)*65536L)/(2L*span));
        }
        public static DesktopAbsolutePointer Normalize(int x,int y,int left,int top,int width,int height){
            return new DesktopAbsolutePointer(NormalizeAxis(x,left,width),NormalizeAxis(y,top,height));
        }
    }
}
