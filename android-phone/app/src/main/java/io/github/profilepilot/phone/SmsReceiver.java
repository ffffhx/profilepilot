package io.github.profilepilot.phone;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.provider.Telephony;
import android.telephony.SmsMessage;
import java.util.UUID;
import org.json.JSONObject;

public final class SmsReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) return;
        SmsMessage[] parts = Telephony.Sms.Intents.getMessagesFromIntent(intent);
        if (parts == null || parts.length == 0) return;
        StringBuilder text = new StringBuilder();
        for (SmsMessage part : parts) {
            if (part == null || part.getMessageBody() == null) return;
            text.append(part.getMessageBody());
        }
        try {
            int slot = intent.getIntExtra(android.telephony.SubscriptionManager.EXTRA_SLOT_INDEX,
                intent.getIntExtra("slot", -1));
            JSONObject sms = new JSONObject().put("event", "sms:received")
                .put("messageId", UUID.randomUUID().toString())
                .put("sender", parts[0].getOriginatingAddress() == null ? "" : parts[0].getOriginatingAddress())
                .put("message", text.toString()).put("receivedAt", System.currentTimeMillis())
                .put("simNumber", slot >= 0 && slot < 32 ? slot + 1 : JSONObject.NULL);
            new SmsOutbox(context).enqueue(sms);
        } catch (Exception unavailable) {
            android.util.Log.w("ProfilePilotSms", "无法暂存新短信");
        }
    }
}
