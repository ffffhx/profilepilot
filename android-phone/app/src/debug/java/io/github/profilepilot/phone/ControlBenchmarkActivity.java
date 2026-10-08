package io.github.profilepilot.phone;

import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.os.Bundle;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/** Offline, synthetic UI fixture. This class and its exported activity exist only in debug APKs. */
public final class ControlBenchmarkActivity extends ComponentActivity {
    private static final int[] ROW_IDS = {
        R.id.bench_case_01, R.id.bench_case_02, R.id.bench_case_03, R.id.bench_case_04,
        R.id.bench_case_05, R.id.bench_case_06, R.id.bench_case_07, R.id.bench_case_08,
        R.id.bench_case_09, R.id.bench_case_10, R.id.bench_case_11, R.id.bench_case_12,
        R.id.bench_case_13, R.id.bench_case_14, R.id.bench_case_15, R.id.bench_case_16,
        R.id.bench_case_17, R.id.bench_case_18, R.id.bench_case_19, R.id.bench_case_20,
        R.id.bench_case_21, R.id.bench_case_22, R.id.bench_case_23, R.id.bench_case_24,
        R.id.bench_case_25, R.id.bench_case_26, R.id.bench_case_27, R.id.bench_case_28,
        R.id.bench_case_29, R.id.bench_case_30, R.id.bench_case_31, R.id.bench_case_32,
        R.id.bench_case_33, R.id.bench_case_34, R.id.bench_case_35, R.id.bench_case_36,
        R.id.bench_case_37, R.id.bench_case_38, R.id.bench_case_39, R.id.bench_case_40
    };
    private LinearLayout root;
    private WebView webView;
    private AlertDialog dialog;
    private String page = "menu", formValue = "", formStatus = "Form status: ready";
    private String dialogResult = "Dialog result: none";
    private int counter, listOffset;
    private boolean checked;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setDecorFitsSystemWindows(false);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (page.equals("detail")) showList();
                else if (!page.equals("menu")) showMenu();
                else finish();
            }
        });
        reset();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent.getBooleanExtra("bench_reset", false)) reset();
    }

    private void reset() {
        if (dialog != null) { dialog.dismiss(); dialog = null; }
        formValue = "";
        formStatus = "Form status: ready";
        dialogResult = "Dialog result: none";
        counter = 0;
        checked = false;
        listOffset = 0;
        showMenu();
    }

    private void startPage(String name, int title) {
        hideKeyboard();
        disposeWebView();
        page = name;
        root = column();
        root.setId(R.id.bench_root);
        root.setBackgroundColor(Color.WHITE);
        root.setFocusableInTouchMode(true);
        // Leave room for both system bars and the phone-control capsule on API 30 and API 35+.
        root.setPadding(dp(20), dp(76), dp(20), dp(20));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
            view.setPadding(dp(20) + bars.left, dp(56) + bars.top,
                    dp(20) + bars.right, dp(12) + Math.max(bars.bottom, keyboard.bottom));
            return insets;
        });
        setContentView(root);
        root.requestApplyInsets();
        if (!name.equals("menu")) {
            Button menu = button(R.id.bench_menu, getString(R.string.bench_menu_label));
            menu.setOnClickListener(view -> showMenu());
            root.addView(menu, fullWidth(dp(48)));
        }
        TextView heading = label(R.id.bench_title, getString(title));
        heading.setTextSize(23);
        heading.setAccessibilityHeading(true);
        root.addView(heading, fullWidth(dp(52)));
    }

    private void showMenu() {
        startPage("menu", R.string.bench_heading);
        addMenuButton(R.id.bench_open_form, "1. Native form", this::showForm);
        addMenuButton(R.id.bench_open_list, "2. Long list", this::showList);
        addMenuButton(R.id.bench_open_state, "3. Dynamic state", this::showState);
        addMenuButton(R.id.bench_open_web, "4. Local WebView", this::showWeb);
    }

    private void addMenuButton(int id, String label, Runnable action) {
        Button button = button(id, label);
        button.setOnClickListener(view -> action.run());
        root.addView(button, fullWidth(dp(64)));
    }

    private void showForm() {
        startPage("form", R.string.bench_form_heading);
        LinearLayout content = scrollContent(R.id.bench_form_scroll);
        TextView inputLabel = label(R.id.bench_input_label, "Native input");
        inputLabel.setLabelFor(R.id.bench_input);
        content.addView(inputLabel);
        EditText input = new EditText(this);
        input.setId(R.id.bench_input);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        input.setText(formValue);
        content.addView(input, fullWidth(dp(56)));
        TextView mirror = label(R.id.bench_mirror, mirrorText());
        content.addView(mirror);
        TextView status = label(R.id.bench_form_status, formStatus);
        content.addView(status);
        input.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence value, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence value, int start, int before, int count) {
                formValue = value.toString();
                formStatus = "Form status: editing";
                mirror.setText(mirrorText());
                status.setText(formStatus);
            }
            @Override public void afterTextChanged(Editable value) { }
        });
        Button submit = button(R.id.bench_submit, "Submit native form");
        submit.setOnClickListener(view -> {
            formStatus = "Form submitted: " + formValue;
            status.setText(formStatus);
            hideKeyboard();
            root.requestFocus();
        });
        content.addView(submit, fullWidth(dp(56)));
    }

    private String mirrorText() { return "Mirror: " + (formValue.isEmpty() ? "(empty)" : formValue); }

    private void showList() {
        startPage("list", R.string.bench_list_heading);
        ScrollView scroll = new ScrollView(this) {
            @Override public void fling(int velocityY) { /* No inertia: gesture completion is deterministic. */ }
        };
        scroll.setId(R.id.bench_list);
        scroll.setSmoothScrollingEnabled(false);
        LinearLayout rows = column();
        rows.setId(R.id.bench_rows);
        for (int i = 0; i < ROW_IDS.length; i++) {
            final String name = String.format(Locale.ROOT, "Case %02d", i + 1);
            Button row = button(ROW_IDS[i], name);
            row.setOnClickListener(view -> {
                listOffset = scroll.getScrollY();
                showDetail(name);
            });
            rows.addView(row, fullWidth(dp(72)));
        }
        scroll.addView(rows);
        root.addView(scroll, remainingSpace());
        scroll.post(() -> scroll.scrollTo(0, listOffset));
    }

    private void showDetail(String name) {
        startPage("detail", R.string.bench_list_heading);
        root.addView(label(R.id.bench_detail, "Detail: " + name));
        Button back = button(R.id.bench_back_to_list, "Back to list");
        back.setOnClickListener(view -> showList());
        root.addView(back, fullWidth(dp(56)));
    }

    private void showState() {
        startPage("state", R.string.bench_state_heading);
        LinearLayout content = scrollContent(R.id.bench_state_scroll);
        TextView count = label(R.id.bench_counter, "Counter: " + counter);
        content.addView(count);
        Button increment = button(R.id.bench_increment, "Increment counter");
        increment.setOnClickListener(view -> count.setText("Counter: " + ++counter));
        content.addView(increment, fullWidth(dp(48)));
        CheckBox checkbox = new CheckBox(this);
        checkbox.setId(R.id.bench_checkbox);
        checkbox.setText("Enable local option");
        checkbox.setChecked(checked);
        content.addView(checkbox, fullWidth(dp(48)));
        TextView checkboxStatus = label(R.id.bench_checkbox_status, checkboxText());
        content.addView(checkboxStatus);
        checkbox.setOnCheckedChangeListener((button, selected) -> {
            checked = selected;
            checkboxStatus.setText(checkboxText());
        });
        Button disabled = button(R.id.bench_disabled, "Disabled control");
        disabled.setEnabled(false);
        content.addView(disabled, fullWidth(dp(48)));
        TextView passwordLabel = label(R.id.bench_password_label, "Synthetic password");
        passwordLabel.setLabelFor(R.id.bench_password);
        content.addView(passwordLabel);
        EditText password = new EditText(this);
        password.setId(R.id.bench_password);
        password.setSingleLine(true);
        password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        password.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        password.setText(R.string.bench_synthetic_password);
        content.addView(password, fullWidth(dp(52)));
        Button open = button(R.id.bench_open_dialog, "Open local dialog");
        open.setOnClickListener(view -> showDialog());
        content.addView(open, fullWidth(dp(48)));
        content.addView(label(R.id.bench_dialog_result, dialogResult));
    }

    private String checkboxText() { return "Checkbox: " + (checked ? "checked" : "unchecked"); }

    private void showDialog() {
        TextView message = label(R.id.bench_dialog_message, "Confirm a local benchmark action?");
        message.setPadding(dp(24), dp(16), dp(24), dp(16));
        dialog = new AlertDialog.Builder(this)
                .setTitle("Local confirmation")
                .setView(message)
                .setPositiveButton("Confirm local action", (window, which) -> finishDialog("confirmed"))
                .setNegativeButton("Cancel local action", (window, which) -> finishDialog("cancelled"))
                .setOnCancelListener(window -> finishDialog("cancelled"))
                .create();
        dialog.show();
    }

    private void finishDialog(String result) {
        dialogResult = "Dialog result: " + result;
        TextView status = findViewById(R.id.bench_dialog_result);
        if (status != null) status.setText(dialogResult);
    }

    private void showWeb() {
        startPage("web", R.string.bench_web_heading);
        webView = new WebView(this);
        webView.setId(R.id.bench_webview);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setBlockNetworkLoads(true);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(false);
        webView.getSettings().setDomStorageEnabled(false);
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
            }
        });
        root.addView(webView, remainingSpace());
        try (InputStream input = getAssets().open("control-benchmark.html")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
            String html = new String(bytes.toByteArray(), StandardCharsets.UTF_8);
            webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
        } catch (IOException error) {
            throw new IllegalStateException("Missing local benchmark asset", error);
        }
    }

    private LinearLayout scrollContent(int id) {
        ScrollView scroll = new ScrollView(this);
        scroll.setId(id);
        LinearLayout content = column();
        scroll.addView(content);
        root.addView(scroll, remainingSpace());
        return content;
    }

    private LinearLayout column() {
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        return column;
    }

    private TextView label(int id, String text) {
        TextView label = new TextView(this);
        label.setId(id);
        label.setText(text);
        label.setTextSize(16);
        label.setTextColor(0xff182230);
        label.setPadding(0, dp(6), 0, dp(6));
        return label;
    }

    private Button button(int id, String text) {
        Button button = new Button(this);
        button.setId(id);
        button.setText(text);
        button.setAllCaps(false);
        button.setTextSize(16);
        return button;
    }

    private LinearLayout.LayoutParams fullWidth(int height) {
        return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, height);
    }

    private LinearLayout.LayoutParams remainingSpace() {
        return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private void hideKeyboard() {
        View focused = getCurrentFocus();
        if (focused != null) getSystemService(InputMethodManager.class)
                .hideSoftInputFromWindow(focused.getWindowToken(), 0);
    }

    private void disposeWebView() {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
    }

    @Override protected void onDestroy() {
        if (dialog != null) dialog.dismiss();
        disposeWebView();
        super.onDestroy();
    }
}
