package io.github.profilepilot.phone;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.function.LongConsumer;

/** Bounded HTTPS transfers; partial files never become installable. */
class UpdateTransfer {
  static HttpURLConnection open(String address) throws IOException {
    URL url=new URL(address);
    for (int redirects=0;redirects<6;redirects++) {
      if (!"https".equals(url.getProtocol()) || url.getUserInfo()!=null)
        throw new IOException("更新服务器返回了不安全的下载地址");
      HttpURLConnection connection=(HttpURLConnection)url.openConnection();
      connection.setConnectTimeout(15000); connection.setReadTimeout(20000);
      connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
      connection.setRequestProperty("User-Agent","ProfilePilot-Android/"+BuildConfig.VERSION_NAME);
      connection.setRequestProperty("Accept-Encoding","identity");
      try {
        int status=connection.getResponseCode();
        if (status==200) return connection;
        if (status==301 || status==302 || status==303 || status==307 || status==308) {
          String location=connection.getHeaderField("Location");
          if (location==null) throw new IOException("更新服务器返回了空下载地址");
          url=new URL(url,location);
        } else if (status==404) throw new IOException("发布方尚未提供此版本的更新文件，请稍后重试");
        else throw new IOException("更新服务器暂不可用（HTTP "+status+"），请稍后重试");
      } catch (IOException error) { connection.disconnect(); throw error; }
      connection.disconnect();
    }
    throw new IOException("更新下载重定向次数过多");
  }

  String manifest() throws IOException {
    HttpURLConnection connection=open(UpdateRelease.MANIFEST_URL);
    try (InputStream input=connection.getInputStream(); ByteArrayOutputStream output=new ByteArrayOutputStream()) {
      byte[] buffer=new byte[8192]; int count;
      while ((count=input.read(buffer))!=-1) {
        interrupted();
        if (output.size()+count>65536) throw new IOException("更新信息过大，请稍后重试");
        output.write(buffer,0,count);
      }
      return new String(output.toByteArray(),StandardCharsets.UTF_8);
    } finally { connection.disconnect(); }
  }

  void download(UpdateRelease release,File partial,LongConsumer progress) throws Exception {
    HttpURLConnection connection=open(release.url());
    try (InputStream input=connection.getInputStream()) {
      long length=connection.getContentLengthLong();
      if (length>=0 && length!=release.size()) throw new IOException("安装包大小已改变，请重新检查更新");
      copyVerified(input,partial,release,progress);
    } finally { connection.disconnect(); }
  }

  static void copyVerified(InputStream input,File target,UpdateRelease release,LongConsumer progress) throws Exception {
    boolean valid=false;
    try (FileOutputStream output=new FileOutputStream(target)) {
      MessageDigest digest=MessageDigest.getInstance("SHA-256");
      byte[] buffer=new byte[32768]; long total=0; int count;
      while ((count=input.read(buffer))!=-1) {
        interrupted(); total+=count;
        if (total>release.size()) throw new IOException("安装包大小不符，请重新检查更新");
        output.write(buffer,0,count); digest.update(buffer,0,count); progress.accept(total);
      }
      verifyDigest(total,digest.digest(),release); output.getFD().sync(); valid=true;
    } finally { if (!valid) target.delete(); }
  }

  static void verify(File file,UpdateRelease release) throws Exception {
    if (!file.isFile() || file.length()!=release.size()) throw new IOException("安装包不完整，请重新下载");
    try (InputStream input=new FileInputStream(file)) {
      MessageDigest digest=MessageDigest.getInstance("SHA-256");
      byte[] buffer=new byte[32768]; long total=0; int count;
      while ((count=input.read(buffer))!=-1) { interrupted(); total+=count; digest.update(buffer,0,count); }
      verifyDigest(total,digest.digest(),release);
    }
  }
  private static void verifyDigest(long total,byte[] digest,UpdateRelease release) throws IOException {
    StringBuilder hex=new StringBuilder(); for (byte value:digest) hex.append(String.format(java.util.Locale.ROOT,"%02x",value & 255));
    if (total!=release.size() || !hex.toString().equals(release.sha256()))
      throw new IOException("安装包校验失败，请重新检查更新并下载");
  }
  private static void interrupted() throws InterruptedIOException {
    if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("下载已取消");
  }
}
