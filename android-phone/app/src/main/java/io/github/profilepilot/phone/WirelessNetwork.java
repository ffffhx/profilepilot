package io.github.profilepilot.phone;

import android.content.Context;
import android.net.*;
import android.net.nsd.*;
import android.os.*;
import java.net.Inet4Address;
import java.util.*;
import org.json.*;

/** Address hints only. Discover the system's advertised port without hidden APIs,
 * settings scraping, enabling debugging, pairing, or opening a control session. */
final class WirelessNetwork {
  private static WirelessNetwork current;
  private final Context context;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final NsdManager nsd;
  private final ConnectivityManager connectivity;
  private NsdManager.DiscoveryListener listener;
  private final Map<String, Long> endpoints = new LinkedHashMap<>();
  private Set<String> addresses = new TreeSet<>();
  private int generation;
  private boolean closed;
  private final ConnectivityManager.NetworkCallback callback = new ConnectivityManager.NetworkCallback() {
    @Override public void onAvailable(Network network) { changed(); }
    @Override public void onLost(Network network) { changed(); }
    @Override public void onLinkPropertiesChanged(Network network, LinkProperties properties) { changed(); }
  };
  private final Runnable cycle = new Runnable() { public void run() { scan(); main.postDelayed(this, 15000); } };

  private WirelessNetwork(Context context) {
    this.context = context.getApplicationContext();
    nsd = context.getSystemService(NsdManager.class);
    connectivity = context.getSystemService(ConnectivityManager.class);
    try { connectivity.registerNetworkCallback(new NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
      .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build(), callback); } catch (RuntimeException ignored) { }
    main.post(cycle);
  }
  static void start(Context context) { if (current == null) current = new WirelessNetwork(context); }
  static void stop() {
    WirelessNetwork old = current; current = null;
    if (old == null) return;
    old.closed = true; old.generation++; old.stopScan(); old.main.removeCallbacksAndMessages(null);
    try { old.connectivity.unregisterNetworkCallback(old.callback); } catch (RuntimeException ignored) { }
    old.endpoints.clear();
  }
  private void changed() {
    main.post(() -> { if (!closed) { endpoints.clear(); main.removeCallbacks(cycle); main.post(cycle); } });
  }
  private static Set<String> wifiAddresses(Context context) {
    Set<String> values = new TreeSet<>();
    try {
      ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
      for (Network network : manager.getAllNetworks()) {
        NetworkCapabilities caps = manager.getNetworkCapabilities(network);
        if (caps == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)) continue;
        LinkProperties properties = manager.getLinkProperties(network);
        if (properties == null) continue;
        for (LinkAddress link : properties.getLinkAddresses()) {
          java.net.InetAddress ip = link.getAddress();
          if (ip instanceof Inet4Address && (ip.isSiteLocalAddress() || ip.isLinkLocalAddress()) && values.size() < 8) values.add(ip.getHostAddress());
        }
      }
    } catch (RuntimeException ignored) { }
    return values;
  }
  static JSONObject snapshot(Context context) throws JSONException {
    Set<String> ips = wifiAddresses(context);
    JSONArray found = new JSONArray();
    WirelessNetwork value = current;
    if (value != null) {
      if (!ips.equals(value.addresses)) { value.endpoints.clear(); value.addresses = ips; }
      long now = SystemClock.elapsedRealtime();
      for (Map.Entry<String, Long> entry : value.endpoints.entrySet()) {
        long age = now - entry.getValue();
        if (age >= 0 && age < 30000 && ips.contains(entry.getKey().split(":")[0]))
          found.put(new JSONObject().put("address", entry.getKey()).put("ageMs", age));
      }
    }
    return new JSONObject().put("wifiIpv4", new JSONArray(ips)).put("adbEndpoints", found);
  }
  private void stopScan() {
    if (listener != null) { try { nsd.stopServiceDiscovery(listener); } catch (RuntimeException ignored) { } listener = null; }
  }
  private void scan() {
    if (closed) return;
    int version = ++generation; stopScan();
    Set<String> ips = wifiAddresses(context);
    if (!ips.equals(addresses)) { endpoints.clear(); addresses = ips; }
    if (ips.isEmpty() || nsd == null) return;
    // Give Android time to finish stopping the previous discovery request.
    main.postDelayed(() -> {
      if (closed || version != generation) return;
      ArrayDeque<NsdServiceInfo> queue = new ArrayDeque<>();
      listener = new NsdManager.DiscoveryListener() {
        boolean resolving;
        int resolved;
        void next() {
          if (closed || version != generation || resolving || queue.isEmpty() || resolved >= 16) return;
          NsdServiceInfo service = queue.removeFirst(); resolving = true; resolved++;
          try { nsd.resolveService(service, new NsdManager.ResolveListener() {
            public void onResolveFailed(NsdServiceInfo info, int code) { main.post(() -> { resolving = false; next(); }); }
            public void onServiceResolved(NsdServiceInfo info) { main.post(() -> {
              if (!closed && version == generation && info.getHost() != null && addresses.contains(info.getHost().getHostAddress()) && info.getPort() > 0 && info.getPort() <= 65535 && endpoints.size() < 8)
                endpoints.put(info.getHost().getHostAddress() + ":" + info.getPort(), SystemClock.elapsedRealtime());
              resolving = false; next();
            }); }
          }); } catch (RuntimeException ignored) { resolving = false; next(); }
        }
        public void onDiscoveryStarted(String type) { }
        public void onDiscoveryStopped(String type) { }
        public void onStartDiscoveryFailed(String type, int code) { }
        public void onStopDiscoveryFailed(String type, int code) { }
        public void onServiceFound(NsdServiceInfo info) { main.post(() -> { if (version == generation && queue.size() < 16) { queue.add(info); next(); } }); }
        public void onServiceLost(NsdServiceInfo info) { main.post(() -> { if (version == generation) endpoints.clear(); }); }
      };
      try { nsd.discoverServices("_adb-tls-connect._tcp.", NsdManager.PROTOCOL_DNS_SD, listener); }
      catch (RuntimeException ignored) { listener = null; }
    }, 200);
  }
}
