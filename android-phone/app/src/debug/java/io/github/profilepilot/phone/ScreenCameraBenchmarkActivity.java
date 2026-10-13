package io.github.profilepilot.phone;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.Color;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.journeyapps.barcodescanner.BarcodeView;
import com.journeyapps.barcodescanner.BarcodeCallback;
import com.journeyapps.barcodescanner.BarcodeResult;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;

/** Debug-only real camera consumer: evidence must come from QR decoding camera frames. */
public final class ScreenCameraBenchmarkActivity extends Activity {
    private BarcodeView camera;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.WHITE);
        TextView title = new TextView(this); title.setText("屏幕摄像头 · 真实相机扫码验证"); title.setTextSize(20); title.setPadding(20, 50, 20, 20); root.addView(title);
        camera = new BarcodeView(this); root.addView(camera, new LinearLayout.LayoutParams(-1, 0, 1));
        TextView result = new TextView(this); result.setText("等待电脑二维码…"); result.setTextSize(17); result.setTextColor(0xff19755e); result.setPadding(20, 20, 20, 70); root.addView(result);
        setContentView(root);
        camera.decodeContinuous(new BarcodeCallback() {
            @Override public void barcodeResult(BarcodeResult decoded) {
                result.setText("识别成功：" + decoded.getText());
                try (java.io.FileOutputStream output = openFileOutput("screen-camera-result.json", MODE_PRIVATE)) {
                    JSONObject record = new JSONObject().put("text", decoded.getText()).put("displayId", getDisplay().getDisplayId())
                        .put("at", System.currentTimeMillis());
                    output.write(record.toString().getBytes(StandardCharsets.UTF_8));
                } catch (Exception error) { result.setText(error.getMessage()); }
            }
        });
    }
    @Override protected void onResume() { super.onResume(); camera.resume(); }
    @Override protected void onPause() { camera.pause(); super.onPause(); }
}
