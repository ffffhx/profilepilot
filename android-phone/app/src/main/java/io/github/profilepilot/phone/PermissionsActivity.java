package io.github.profilepilot.phone;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/** Compatibility entry for older desktop builds; all phone UI now lives on home. */
public final class PermissionsActivity extends Activity {
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    Intent home=new Intent(this,MainActivity.class)
        .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    if (getIntent().hasExtra("token")) home.putExtra("token",getIntent().getStringExtra("token"));
    if (getIntent().hasExtra("computer")) home.putExtra("computer",getIntent().getStringExtra("computer"));
    home.putExtra("wirelessGuide",getIntent().getBooleanExtra("wirelessGuide",false));
    getIntent().removeExtra("token");
    startActivity(home);
    finish();
  }
}
