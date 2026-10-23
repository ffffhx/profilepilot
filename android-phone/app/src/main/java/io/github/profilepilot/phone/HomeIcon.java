package io.github.profilepilot.phone;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.drawable.Drawable;
import android.view.View;

/** Small native line icons; no font-dependent glyphs or bitmap scaling. */
final class HomeIcon extends View {
  private String name;
  private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final Drawable brand;
  private int color;

  HomeIcon(Context context, String name, int color) {
    super(context);
    this.name = name;
    this.color = color;
    brand = "brand".equals(name) ? context.getDrawable(R.drawable.ic_profilepilot) : null;
    setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
  }

  void color(int value) { if (color != value) { color = value; invalidate(); } }
  void name(String value) { if (!name.equals(value)) { name = value; invalidate(); } }

  @Override protected void onDraw(Canvas canvas) {
    super.onDraw(canvas);
    float size = Math.min(getWidth(), getHeight());
    canvas.save();
    canvas.translate((getWidth() - size) / 2, (getHeight() - size) / 2);
    canvas.scale(size / 24, size / 24);
    paint.setColor(color);
    paint.setStyle(Paint.Style.STROKE);
    paint.setStrokeWidth(1.6f);
    paint.setStrokeCap(Paint.Cap.ROUND);
    paint.setStrokeJoin(Paint.Join.ROUND);
    switch (name) {
      case "brand" -> {
        brand.setBounds(0, 0, 24, 24);
        brand.draw(canvas);
      }
      case "computer" -> {
        canvas.drawRoundRect(2.5f,3.5f,21.5f,16.5f,2,2,paint);
        line(canvas,6,12.5f,18,12.5f); line(canvas,12,16.5f,12,21); line(canvas,9,21,15,21);
      }
      case "computer-wait", "computer-check", "computer-alert", "computer-control", "disconnected" -> {
        canvas.drawRoundRect(2,3,20,15,2,2,paint);
        line(canvas,10,15,10,20); line(canvas,6,20,13,20);
        if ("computer-control".equals(name)) {
          paint.setStyle(Paint.Style.FILL); path(canvas,true,14,11,23,16,19,17,17,22);
        } else {
          paint.setStyle(Paint.Style.FILL); paint.setColor(getContext().getResources().getColor(android.R.color.white,null));
          canvas.drawCircle(18,17,6,paint); paint.setColor(color); paint.setStyle(Paint.Style.STROKE);
          if ("disconnected".equals(name)) {
            path(canvas,false,14,16,16,14,18,14); path(canvas,false,18,20,20,20,22,18);
            line(canvas,15,22,21,12);
          } else {
            canvas.drawCircle(18,17,5,paint);
            if ("computer-wait".equals(name)) path(canvas,false,18,14,18,17,20,18);
            else if ("computer-check".equals(name)) path(canvas,false,15.5f,17,17.3f,19,20.5f,15);
            else { line(canvas,18,14,18,17); paint.setStyle(Paint.Style.FILL); canvas.drawCircle(18,20,.7f,paint); }
          }
        }
      }
      case "eye" -> {
        Path eye=new Path(); eye.moveTo(1,12); eye.cubicTo(7,2,17,2,23,12);
        eye.cubicTo(17,22,7,22,1,12); canvas.drawPath(eye,paint); canvas.drawCircle(12,12,3,paint);
      }
      case "pause-circle" -> { canvas.drawCircle(12,12,10,paint); line(canvas,9,8,9,16); line(canvas,15,8,15,16); }
      case "settings" -> {
        Path gear=new Path();
        for (int i=0;i<32;i++) {
          double angle=i*Math.PI/16; float radius=i%4==0 || i%4==3?10:8;
          float x=12+(float)Math.cos(angle)*radius,y=12+(float)Math.sin(angle)*radius;
          if(i==0) gear.moveTo(x,y); else gear.lineTo(x,y);
        }
        gear.close(); canvas.drawPath(gear,paint); canvas.drawCircle(12,12,3.2f,paint);
      }
      case "back" -> { path(canvas,false,11,4,3,12,11,20); line(canvas,3,12,21,12); }
      case "sync" -> { canvas.drawArc(3,3,21,21,205,145,false,paint); canvas.drawArc(3,3,21,21,25,145,false,paint); path(canvas,false,15,3,21,3,21,9); path(canvas,false,9,21,3,21,3,15); }
      case "update" -> { canvas.drawCircle(12,12,10,paint); path(canvas,false,7,11,12,6,17,11); line(canvas,12,6,12,18); }
      case "phone" -> {
        canvas.drawRoundRect(6,2,18,22,2.5f,2.5f,paint);
        line(canvas,10,5,14,5); line(canvas,11,19,13,19);
      }
      case "check" -> path(canvas,false,5,12,9,16,19,6);
      case "chevron" -> path(canvas,false,9,5,16,12,9,19);
      case "down" -> path(canvas,false,5,9,12,16,19,9);
      case "close" -> { line(canvas,6,6,18,18); line(canvas,6,18,18,6); }
      case "more" -> {
        paint.setStyle(Paint.Style.FILL);
        for (int x : new int[] {5,12,19}) canvas.drawCircle(x,12,1.4f,paint);
      }
      case "accessibility" -> {
        canvas.drawCircle(12,4,2,paint); path(canvas,false,4,8,12,10,20,8);
        line(canvas,12,10,12,15); path(canvas,false,8,21,12,15,16,21);
      }
      case "overlay" -> {
        canvas.drawRoundRect(3,4,21,20,3,3,paint);
        canvas.drawRoundRect(7,7,17,11,2,2,paint); line(canvas,8,16,16,16);
      }
      case "bell" -> {
        Path bell = new Path(); bell.moveTo(6,14); bell.lineTo(6,8);
        bell.cubicTo(6,0,18,0,18,8); bell.lineTo(18,14); bell.lineTo(20,17);
        bell.lineTo(4,17); bell.close(); canvas.drawPath(bell,paint); line(canvas,10,21,14,21);
      }
      case "usb" -> {
        line(canvas,12,20,12,3); path(canvas,false,9,6,12,3,15,6);
        path(canvas,false,12,15,7,11,7,8); path(canvas,false,12,18,17,13,17,9);
        canvas.drawCircle(7,6.5f,1.5f,paint); canvas.drawRect(15.5f,6,18.5f,9,paint);
        canvas.drawCircle(12,21,1,paint);
      }
      case "wifi" -> {
        canvas.drawArc(0,3,24,23,220,100,false,paint);
        canvas.drawArc(4,8,20,22,220,100,false,paint);
        canvas.drawArc(8,13,16,21,220,100,false,paint);
        paint.setStyle(Paint.Style.FILL); canvas.drawCircle(12,20,1,paint);
      }
      case "shield" -> {
        Path shield = new Path(); shield.moveTo(12,2); shield.lineTo(20,5); shield.lineTo(20,11);
        shield.cubicTo(20,16,16,19,12,22); shield.cubicTo(8,19,4,16,4,11);
        shield.lineTo(4,5); shield.close(); canvas.drawPath(shield,paint);
        path(canvas,false,8,12,11,15,16,9);
      }
      case "pause" -> { line(canvas,8,5,8,19); line(canvas,16,5,16,19); }
      case "help" -> {
        canvas.drawCircle(12,12,9,paint);
        Path help = new Path(); help.moveTo(9,9); help.cubicTo(9,5,15,5,15,9);
        help.cubicTo(15,11,12,11,12,13); canvas.drawPath(help,paint);
        paint.setStyle(Paint.Style.FILL); canvas.drawCircle(12,17,.8f,paint);
      }
      default -> { line(canvas,6,12,10,12); line(canvas,14,12,18,12); }
    }
    canvas.restore();
  }

  private void line(Canvas canvas, float x, float y, float endX, float endY) {
    canvas.drawLine(x,y,endX,endY,paint);
  }
  private void path(Canvas canvas, boolean close, float... points) {
    Path path = new Path(); path.moveTo(points[0],points[1]);
    for (int i=2; i<points.length; i+=2) path.lineTo(points[i],points[i+1]);
    if (close) path.close(); canvas.drawPath(path,paint);
  }
}
