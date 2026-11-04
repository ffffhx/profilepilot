package io.github.profilepilot.phone;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import org.json.JSONObject;
import java.io.*;
import java.security.MessageDigest;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** Bounded APK transfer and the ordinary Android installer; no shell authority. */
final class InternetPhonePackages implements Closeable {
  interface Guard { void check() throws Exception; }
  private final Context context;
  private final Handler main = new Handler(Looper.getMainLooper());
  private volatile Job job;
  private static final class Job {
    final String id; final JSONObject artifact, link; final Guard guard;
    volatile String status = "preparing", error = "", packageName = "";
    volatile long previousUpdateTime = -1;
    volatile boolean submitted;
    volatile int installerStatus = Integer.MIN_VALUE;
    int installSession = -1;
    volatile boolean cancelled;
    Job(String id, JSONObject artifact, JSONObject link, Guard guard) { this.id=id; this.artifact=artifact; this.link=link; this.guard=guard; }
  }
  InternetPhonePackages(Context context) { this.context=context; }
  private static String packageName(String name) {
    if (name.length()>255 || !name.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)*")) throw new IllegalArgumentException("应用包名无效");
    return name;
  }
  JSONObject inspect(String name) throws Exception {
    packageName(name);
    JSONObject result=new JSONObject().put("packageName",name).put("checkedAt",System.currentTimeMillis()).put("evidence","Android PackageManager");
    try {
      PackageInfo info=context.getPackageManager().getPackageInfo(name,0);
      result.put("status","installed").put("versionCode",Long.toString(info.getLongVersionCode()))
          .put("versionName",info.versionName).put("firstInstallTime",info.firstInstallTime).put("lastUpdateTime",info.lastUpdateTime);
      try {
        if (info.applicationInfo == null || info.applicationInfo.sourceDir == null) throw new IOException("Installed APK path unavailable");
        String source = info.applicationInfo.sourceDir;
        InstalledApkEvidence.Digest digest = InstalledApkEvidence.read(new File(source));
        PackageInfo after = context.getPackageManager().getPackageInfo(name, 0);
        if (after.applicationInfo == null || !source.equals(after.applicationInfo.sourceDir)
            || after.lastUpdateTime != info.lastUpdateTime || after.getLongVersionCode() != info.getLongVersionCode())
          throw new IOException("Package changed during verification");
        result.put("apkSha256", digest.sha256()).put("apkBytes", digest.bytes()).put("apkEvidence", "installed-base-apk")
            .put("splitCount", info.splitNames == null ? 0 : info.splitNames.length);
      } catch (Exception unavailable) {
        result.put("apkEvidence", "unknown").put("apkEvidenceReason", "系统未提供稳定、可读取且在大小/时间限制内的安装包，不能确认实际安装内容");
      }
      return result;
    } catch (android.content.pm.PackageManager.NameNotFoundException error) {
      // Android package visibility is not proof of absence.
      return result.put("status","unknown").put("reason","应用未安装或系统未授予此包的可见性");
    }
  }
  JSONObject launch(String name) throws Exception {
    Intent intent=context.getPackageManager().getLaunchIntentForPackage(packageName(name));
    if (intent==null) throw new PhoneControlException("PHONE_APP_NOT_READY","未找到可见的应用启动入口");
    context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    return new JSONObject().put("packageName",name).put("launched",true);
  }
  JSONObject start(JSONObject input, Guard guard) throws Exception {
    if (job!=null && !terminal(job.status)) throw new PhoneControlException("PHONE_TARGET_BUSY","已有安装任务，请先核对结果");
    JSONObject artifact=input.getJSONObject("artifact"), link=InternetPhoneSettings.link(context);
    String id=input.getString("jobId");
    if (!UUID.fromString(id).toString().equals(id) || link==null || !artifact.getString("artifactId").matches("[a-f0-9]{64}")
        || !artifact.getString("sha256").matches("[a-f0-9]{64}") || artifact.getLong("bytes")<1 || artifact.getLong("bytes")>512L*1024*1024)
      throw new IllegalArgumentException("安装文件信息无效");
    guard.check(); job=new Job(id,new JSONObject(artifact.toString()),link,guard);
    if (!context.getPackageManager().canRequestPackageInstalls()) {
      job.status="awaiting-permission";
      context.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+context.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    } else download(job);
    return status(id);
  }
  static boolean terminal(String status) { return status.equals("installed") || status.equals("failed") || status.equals("cancelled"); }
  JSONObject status(String id) throws Exception {
    if (job==null || !job.id.equals(id)) throw new PhoneControlException("PHONE_INSTALL_UNKNOWN","安装回执不存在，请核对应用实际版本");
    if (job.status.equals("awaiting-permission") && context.getPackageManager().canRequestPackageInstalls()) {
      job.guard.check(); download(job);
    }
    return new JSONObject().put("jobId",id).put("status",job.status).put("error",job.error).put("packageName",job.packageName);
  }
  private Job ownedJob(String peer, String id) throws Exception {
    Job current = job;
    if (current == null || !current.id.equals(id) || !peer.equals("internet:" + current.link.getString("serverId")))
      throw new PhoneControlException("PHONE_INSTALL_UNKNOWN", "安装回执不存在，请核对应用实际版本");
    return current;
  }
  void authorizeReceipt(String peer, String id) throws Exception { ownedJob(peer, id); }
  JSONObject receipt(String peer, String id) throws Exception { return receipt(peer, id, true); }
  JSONObject receipt(String peer, String id, boolean verifyInstalled) throws Exception {
    Job current = ownedJob(peer, id);
    // Pure observation: it cannot start a download, open UI or grant control.
    JSONObject result = new JSONObject().put("jobId", id).put("status", current.status).put("error", current.error)
        .put("packageName", current.packageName).put("sha256", current.artifact.getString("sha256"))
        .put("reconciled", false);
    if (current.installerStatus != Integer.MIN_VALUE) result.put("installerStatus", current.installerStatus);
    if (verifyInstalled && current.submitted && !current.packageName.isEmpty()) {
      JSONObject installed = inspect(current.packageName);
      result.put("installedEvidence", installed);
      if (InstalledApkEvidence.confirmsUpdate(current.submitted, current.previousUpdateTime,
          installed.optLong("lastUpdateTime", -1), current.artifact.getString("sha256"), current.artifact.getLong("bytes"),
          installed.optString("apkSha256", ""), installed.optLong("apkBytes", -1), installed.optInt("splitCount", -1))) {
        result.put("reportedStatus", result.getString("status")).put("reportedError", result.getString("error"))
            .put("status", "installed").put("error", "").put("reconciled", true);
      }
    }
    return result;
  }
  void cancel(String id) {
    if (job==null || !job.id.equals(id) || terminal(job.status)) return;
    job.cancelled=true; job.status="cancelled";
    if (job.installSession>=0) try { context.getPackageManager().getPackageInstaller().abandonSession(job.installSession); } catch (RuntimeException ignored) { }
  }
  void tick() {
    if (job==null || terminal(job.status)) return;
    // Android has already accepted the verified bytes and now asks the person
    // to approve them. Some vendors suppress overlays on that screen. Retain
    // this explicit confirmation UI while the host releases control; nothing
    // further installs without the person's approval. Explicit cancel still
    // abandons the PackageInstaller session.
    if (job.status.equals("awaiting-confirmation")) return;
    try { job.guard.check(); } catch (Exception error) { cancel(job.id); }
  }
  private void check(Job expected) throws Exception {
    if (expected.cancelled || job!=expected) throw new IOException("安装已停止");
    if (Looper.myLooper()==Looper.getMainLooper()) { expected.guard.check(); return; }
    CompletableFuture<Void> checked=new CompletableFuture<>();
    main.post(() -> { try { if (expected.cancelled || job!=expected) throw new IOException("安装已停止"); expected.guard.check(); checked.complete(null); }
      catch (Exception error) { checked.completeExceptionally(error); } });
    checked.get(6,TimeUnit.SECONDS);
  }
  private void download(Job expected) {
    expected.status="downloading";
    Thread worker=new Thread(() -> {
      File directory=new File(context.getCacheDir(),"internet-installs"), file=new File(directory,expected.id+".apk");
      try {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建安装缓存");
        long size=expected.artifact.getLong("bytes"), offset=0;
        MessageDigest hash=MessageDigest.getInstance("SHA-256");
        try (OutputStream out=new FileOutputStream(file)) {
          while (offset<size) {
            check(expected);
            JSONObject part=InternetPhoneTransport.request(expected.link,"/v1/artifact",expected.link.getString("token"),new JSONObject()
                .put("deviceId",expected.link.getString("deviceId")).put("connectionId",expected.artifact.getString("connectionId"))
                .put("artifactId",expected.artifact.getString("artifactId")).put("offset",offset));
            byte[] bytes=android.util.Base64.decode(part.getString("base64"),android.util.Base64.DEFAULT);
            if (part.getLong("offset")!=offset || bytes.length==0 || bytes.length>768*1024 || offset+bytes.length>size) throw new IOException("安装文件分块无效");
            check(expected); out.write(bytes); hash.update(bytes); offset+=bytes.length;
          }
        }
        StringBuilder hex=new StringBuilder(); for (byte b:hash.digest()) hex.append(String.format(java.util.Locale.ROOT,"%02x",b&255));
        if (!hex.toString().equals(expected.artifact.getString("sha256"))) throw new IOException("APK 校验失败");
        check(expected);
        PackageInfo info=context.getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(),0);
        if (info==null) throw new IOException("不是有效的 Android 安装包");
        if (info.packageName.equals(context.getPackageName())) throw new IOException("请通过 App 自带更新入口更新 ProfilePilot，避免中断控制回执");
        expected.packageName=info.packageName;
        PackageInstaller installer=context.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params=new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(info.packageName); params.setSize(size);
        if (Build.VERSION.SDK_INT>=31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
        check(expected); int sessionId=installer.createSession(params); expected.installSession=sessionId;
        try (PackageInstaller.Session session=installer.openSession(sessionId)) {
          try (InputStream in=new FileInputStream(file); OutputStream out=session.openWrite("base.apk",0,size)) {
            byte[] buffer=new byte[256*1024]; int count;
            while ((count=in.read(buffer))!=-1) { check(expected); out.write(buffer,0,count); }
            session.fsync(out);
          }
          CompletableFuture<Void> committed=new CompletableFuture<>();
          main.post(() -> { try {
            check(expected);
            Intent result=new Intent(context,InternetInstallReceiver.class).setAction("io.github.profilepilot.INSTALL_RESULT")
                .setData(Uri.parse("profilepilot-install://result/"+expected.id));
            int flags=PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT>=31?PendingIntent.FLAG_MUTABLE:0);
            try { expected.previousUpdateTime = context.getPackageManager().getPackageInfo(expected.packageName, 0).lastUpdateTime; }
            catch (android.content.pm.PackageManager.NameNotFoundException unavailable) {
              // Visibility restrictions cannot establish a first install. Leave unknown.
              expected.previousUpdateTime = -1;
            }
            expected.status="installing";
            session.commit(PendingIntent.getBroadcast(context,sessionId,result,flags).getIntentSender());
            expected.submitted = true;
            committed.complete(null);
          } catch (Exception error) { committed.completeExceptionally(error); } });
          committed.get(6,TimeUnit.SECONDS);
        }
      } catch (Exception error) {
        main.post(() -> { if (!expected.cancelled) { expected.status="failed"; expected.error="安装未获确认，请检查系统安装界面及实际应用版本；不会自动重试"; }
          if (expected.installSession>=0 && !expected.status.equals("installed")) try { context.getPackageManager().getPackageInstaller().abandonSession(expected.installSession); } catch (RuntimeException ignored) { } });
      } finally { if (file.exists() && !file.delete()) file.deleteOnExit(); }
    },"phone-internet-install"); worker.setDaemon(true); worker.start();
  }
  void result(Intent intent) {
    if (job==null || intent.getData()==null || !job.id.equals(intent.getData().getLastPathSegment())
        || intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID,-1)!=job.installSession) return;
    int status=intent.getIntExtra(PackageInstaller.EXTRA_STATUS,PackageInstaller.STATUS_FAILURE);
    job.installerStatus = status;
    if (status==PackageInstaller.STATUS_SUCCESS) { job.status="installed"; return; }
    if (job.cancelled) return;
    if (status==PackageInstaller.STATUS_PENDING_USER_ACTION) {
      try {
        check(job); Intent confirmation=intent.getParcelableExtra(Intent.EXTRA_INTENT);
        if (confirmation==null) throw new IOException("缺少安装确认界面");
        job.status="awaiting-confirmation"; context.startActivity(confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      } catch (Exception error) { cancel(job.id); }
    } else { job.status="failed"; job.error="Android 安装器拒绝或取消了安装（"+status+"）"; }
  }
  @Override public void close() { if (job!=null) cancel(job.id); }
}
