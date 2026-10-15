package io.github.profilepilot.phone;

import java.net.URI;
import java.util.Locale;
import org.json.JSONObject;

/** Android has its own version sequence; desktop release tags are not version codes. */
record UpdateRelease(long versionCode, String versionName, int minSdk, String notes,
                     String url, long size, String sha256) {
  static final long MAX_APK_BYTES=150L*1024*1024;
  static final String MANIFEST_URL="https://github.com/ffffhx/profilepilot/releases/download/android-latest/ProfilePilot-android-update.json";

  static UpdateRelease parse(String text) throws Exception {
    return parse(text,"io.github.profilepilot.phone");
  }
  static UpdateRelease parse(String text,String applicationId) throws Exception {
    JSONObject json=new JSONObject(text);
    if (integer(json,"schemaVersion")!=1 || !applicationId.equals(json.getString("applicationId")))
      throw new IllegalArgumentException("更新信息不适用于此 App");
    long code=integer(json,"versionCode"), size=integer(json,"size");
    long sdk=integer(json,"minSdk");
    String name=json.getString("versionName"), notes=json.optString("notes","");
    String url=json.getString("url"), hash=json.getString("sha256").toLowerCase(Locale.ROOT);
    URI uri=new URI(url);
    if (code<1 || code>2100000000L || name.isBlank() || name.length()>80 || sdk<30 || sdk>1000
        || size<4 || size>MAX_APK_BYTES || !hash.matches("[a-f0-9]{64}") || notes.length()>16000
        || !"https".equals(uri.getScheme()) || !"github.com".equals(uri.getHost())
        || uri.getPort()!=-1 || uri.getUserInfo()!=null || uri.getQuery()!=null || uri.getFragment()!=null
        || !uri.getRawPath().matches("/ffffhx/profilepilot/releases/download/[A-Za-z0-9._%-]+/ProfilePilot-android\\.apk"))
      throw new IllegalArgumentException("更新信息不完整或下载地址无效");
    return new UpdateRelease(code,name,(int)sdk,notes,url,size,hash);
  }

  private static long integer(JSONObject json,String name) throws Exception {
    Object value=json.get(name);
    if (!(value instanceof Number) || !value.toString().matches("[0-9]+"))
      throw new IllegalArgumentException("更新信息中的数字无效");
    return json.getLong(name);
  }
  boolean newerThan(long installedCode) { return versionCode>installedCode; }
}
