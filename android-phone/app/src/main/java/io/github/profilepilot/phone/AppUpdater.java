package io.github.profilepilot.phone;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import java.io.File;
import java.io.IOException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.function.Consumer;

/** Application-scoped work survives Activity recreation without retaining its views. */
final class AppUpdater {
  enum Stage { IDLE, CHECKING, AVAILABLE, CURRENT, INCOMPATIBLE, DOWNLOADING, VERIFYING, READY, ERROR }
  record State(Stage stage,UpdateRelease release,int percent,String message) {
    boolean busy() { return stage==Stage.CHECKING || stage==Stage.DOWNLOADING || stage==Stage.VERIFYING; }
  }
  private static AppUpdater instance;
  static synchronized AppUpdater get(Context context) {
    if (instance==null) instance=new AppUpdater(context,new UpdateTransfer(),BuildConfig.VERSION_CODE);
    return instance;
  }
  private final Context context;
  private final UpdateTransfer transfer;
  private final long installedCode;
  private final Handler main=new Handler(Looper.getMainLooper());
  private final ExecutorService worker=Executors.newSingleThreadExecutor();
  private final Set<Consumer<State>> listeners=new HashSet<>();
  private final File directory;
  private State state=new State(Stage.IDLE,null,0,"");
  private Future<?> pending;
  private int generation;

  AppUpdater(Context context,UpdateTransfer transfer,long installedCode) {
    this.context=context.getApplicationContext(); this.transfer=transfer; this.installedCode=installedCode;
    directory=new File(context.getFilesDir(),"updates");
  }
  State state() { return state; }
  void observe(Consumer<State> listener) { listeners.add(listener); listener.accept(state); }
  void remove(Consumer<State> listener) { listeners.remove(listener); }
  private void set(State next) { state=next; for (Consumer<State> listener:new HashSet<>(listeners)) listener.accept(next); }
  private void publish(int ticket,State next) { main.post(() -> { if (ticket==generation) set(next); }); }
  private File apk(UpdateRelease release) { return new File(directory,release.sha256()+".apk"); }
  private void fail(int ticket,UpdateRelease release,Exception error) {
    String message=error instanceof java.net.SocketTimeoutException ? "连接更新服务器超时，请检查网络后重试"
        : error instanceof java.net.UnknownHostException ? "无法连接更新服务器，请检查网络后重试"
        : error instanceof IOException || error instanceof IllegalArgumentException ? error.getMessage()
        : "无法读取更新信息或安装包，请稍后重试";
    publish(ticket,new State(Stage.ERROR,release,0,message==null?"更新失败，请稍后重试":message));
  }

  void check() {
    if (state.busy()) return;
    int ticket=++generation; set(new State(Stage.CHECKING,null,0,"正在检查更新…"));
    pending=worker.submit(() -> {
      try {
        UpdateRelease release=UpdateRelease.parse(transfer.manifest(),context.getPackageName());
        if (!release.newerThan(installedCode)) {
          publish(ticket,new State(Stage.CURRENT,release,0,"当前已是最新版本")); return;
        }
        if (release.minSdk()>Build.VERSION.SDK_INT) {
          publish(ticket,new State(Stage.INCOMPATIBLE,release,0,"新版本需要更新的安卓系统，当前手机暂不支持")); return;
        }
        if (apk(release).exists()) {
          try { verifyPackage(apk(release),release); publish(ticket,new State(Stage.READY,release,100,"下载完成，可以安装")); return; }
          catch (Exception invalid) { apk(release).delete(); }
        }
        publish(ticket,new State(Stage.AVAILABLE,release,0,"发现新版本 "+release.versionName()));
      } catch (Exception error) { fail(ticket,null,error); }
    });
  }

  void download() {
    UpdateRelease release=state.release();
    if (state.busy() || release==null || !release.newerThan(installedCode) || release.minSdk()>Build.VERSION.SDK_INT) return;
    int ticket=++generation; set(new State(Stage.DOWNLOADING,release,0,"正在下载…"));
    pending=worker.submit(() -> {
      File partial=new File(directory,"download.part");
      try {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建下载文件，请检查手机存储空间");
        File[] old=directory.listFiles();
        if (old!=null) for (File file:old) if (!file.equals(apk(release))) file.delete();
        final int[] last={-1};
        transfer.download(release,partial,bytes -> {
          int percent=(int)(bytes*100/release.size());
          if (percent!=last[0]) { last[0]=percent; publish(ticket,new State(Stage.DOWNLOADING,release,percent,"正在下载…")); }
        });
        publish(ticket,new State(Stage.VERIFYING,release,100,"正在校验安装包…"));
        verifyPackage(partial,release);
        if (apk(release).exists() && !apk(release).delete()) throw new IOException("无法替换旧安装包，请重试");
        if (!partial.renameTo(apk(release))) throw new IOException("无法保存安装包，请检查手机存储空间");
        publish(ticket,new State(Stage.READY,release,100,"下载完成，可以安装"));
      } catch (Exception error) { fail(ticket,release,error); }
      finally { partial.delete(); }
    });
  }
  void cancel() {
    if (state.stage()!=Stage.DOWNLOADING) return;
    generation++; if (pending!=null) pending.cancel(true);
    set(new State(Stage.AVAILABLE,state.release(),0,"下载已取消，可重新下载"));
  }

  void prepareInstall(Consumer<File> ready) {
    if (state.stage()!=Stage.READY) return;
    UpdateRelease release=state.release(); int ticket=++generation;
    set(new State(Stage.VERIFYING,release,100,"正在准备安装…"));
    pending=worker.submit(() -> {
      try {
        File file=apk(release); verifyPackage(file,release);
        main.post(() -> {
          if (ticket!=generation) return;
          set(new State(Stage.READY,release,100,"请在系统界面确认安装；取消后可再次安装")); ready.accept(file);
        });
      } catch (Exception error) { apk(release).delete(); fail(ticket,release,error); }
    });
  }

  void verifyPackage(File file,UpdateRelease release) throws Exception {
    UpdateTransfer.verify(file,release);
    PackageManager packages=context.getPackageManager();
    PackageInfo candidate=packages.getPackageArchiveInfo(file.getAbsolutePath(),PackageManager.GET_SIGNING_CERTIFICATES);
    PackageInfo installed=packages.getPackageInfo(context.getPackageName(),PackageManager.GET_SIGNING_CERTIFICATES);
    if (candidate==null || !context.getPackageName().equals(candidate.packageName)
        || candidate.getLongVersionCode()!=release.versionCode() || !release.versionName().equals(candidate.versionName)
        || candidate.getLongVersionCode()<=installedCode || candidate.applicationInfo==null
        || candidate.applicationInfo.minSdkVersion>Build.VERSION.SDK_INT)
      throw new IOException("安装包的应用或版本不符，请重新检查更新");
    if (candidate.signingInfo==null || installed.signingInfo==null)
      throw new IOException("无法验证安装包签名，请重新下载");
    Signature[] current=installed.signingInfo.getApkContentsSigners();
    boolean compatible;
    if (candidate.signingInfo.hasMultipleSigners() || installed.signingInfo.hasMultipleSigners()) {
      compatible=new HashSet<>(Arrays.asList(current)).equals(new HashSet<>(Arrays.asList(candidate.signingInfo.getApkContentsSigners())));
    } else {
      // Accept the installed signer in the APK's verified signing lineage (key rotation).
      compatible=Arrays.asList(candidate.signingInfo.getSigningCertificateHistory()).contains(current[0]);
    }
    if (!compatible) throw new IOException("新版安装包与当前 App 签名不同，无法直接更新。请联系发布方获取相同签名的版本，保留当前 App 和数据");
  }
}
