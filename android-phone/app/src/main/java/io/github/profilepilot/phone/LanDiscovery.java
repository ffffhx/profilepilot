package io.github.profilepilot.phone;

import android.content.Context;
import android.net.*;
import android.net.wifi.WifiManager;
import android.os.*;
import java.net.*;
import java.util.*;

/** Available before debugging/pairing. No control listener, permission grant or session changes. */
final class LanDiscovery {
  private static LanDiscovery current;
  private final Context context;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final Set<Object> owners = Collections.newSetFromMap(new IdentityHashMap<>());
  private final ConnectivityManager connectivity;
  private final String id = UUID.randomUUID().toString();
  private MulticastSocket socket;
  private WifiManager.MulticastLock lock;
  private volatile String wireless = "unconfirmed";
  private boolean closed;
  private final Runnable expire = () -> { if (owners.isEmpty()) close(); };
  private final Runnable refresh = new Runnable() { public void run() {
    if (closed) return;
    try { wireless = new PhoneReadiness(context).wirelessDebugging; } catch (RuntimeException ignored) { wireless = "unconfirmed"; }
    if (socket == null) reopen();
    main.postDelayed(this, 5000);
  } };
  private final ConnectivityManager.NetworkCallback callback = new ConnectivityManager.NetworkCallback() {
    @Override public void onAvailable(Network network) { changed(); }
    @Override public void onLost(Network network) { changed(); }
    @Override public void onLinkPropertiesChanged(Network network, LinkProperties properties) { changed(); }
    private void changed() { main.post(() -> { if (!closed) reopen(); }); }
  };
  static void acquire(Context owner) {
    if (current == null) current = new LanDiscovery(owner.getApplicationContext());
    current.owners.add(owner); current.main.removeCallbacks(current.expire);
  }
  static void release(Context owner) {
    if (current == null) return;
    current.owners.remove(owner);
    // Keep discovery while the user visits system wireless-debugging settings.
    if (current.owners.isEmpty()) current.main.postDelayed(current.expire, 120000);
  }
  static void settingsChanged() { if (current != null) current.reopen(); }
  private LanDiscovery(Context context) {
    this.context = context; connectivity = context.getSystemService(ConnectivityManager.class);
    try { connectivity.registerNetworkCallback(new NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
      .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build(), callback); } catch (RuntimeException ignored) { }
    main.post(refresh);
  }
  private void reopen() {
    stopSocket();
    if (!new ComputerStore(context).discoveryEnabled()) return;
    try {
      List<LinkAddress> links = new ArrayList<>();
      Set<NetworkInterface> interfaces = new HashSet<>();
      for (Network network : connectivity.getAllNetworks()) {
        NetworkCapabilities caps = connectivity.getNetworkCapabilities(network);
        LinkProperties properties = connectivity.getLinkProperties(network);
        if (caps == null || properties == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)) continue;
        for (LinkAddress link : properties.getLinkAddresses()) if (link.getAddress() instanceof Inet4Address && link.getAddress().isSiteLocalAddress()) {
          NetworkInterface adapter = NetworkInterface.getByInetAddress(link.getAddress());
          if (adapter != null) { interfaces.add(adapter); links.add(link); }
        }
      }
      if (interfaces.isEmpty()) return;
      MulticastSocket listener = new MulticastSocket(null); socket = listener;
      listener.setReuseAddress(true); listener.bind(new InetSocketAddress(LanDiscoveryProtocol.PORT));
      for (NetworkInterface adapter : interfaces) listener.joinGroup(new InetSocketAddress(LanDiscoveryProtocol.GROUP, LanDiscoveryProtocol.PORT), adapter);
      WifiManager wifi = context.getSystemService(WifiManager.class);
      lock = wifi.createMulticastLock("profilepilot-discovery"); lock.setReferenceCounted(false); lock.acquire();
      Thread worker = new Thread(() -> listen(listener, links), "phone-lan-discovery"); worker.setDaemon(true); worker.start();
    } catch (Exception ignored) { stopSocket(); }
  }
  private void listen(MulticastSocket listener, List<LinkAddress> links) {
    byte[] buffer = new byte[257]; long lastReply = -1000;
    while (!listener.isClosed()) try {
      DatagramPacket packet = new DatagramPacket(buffer, buffer.length); listener.receive(packet);
      if (!(packet.getAddress() instanceof Inet4Address) || !sameNetwork(packet.getAddress(), links)) continue;
      long now = SystemClock.elapsedRealtime(); if (now - lastReply < 100) continue;
      if (!new ComputerStore(context).discoveryEnabled()) continue;
      byte[] response = LanDiscoveryProtocol.reply(buffer, packet.getOffset(), packet.getLength(), id, Build.MODEL, BuildConfig.VERSION_NAME, BuildConfig.DEBUG, wireless, new ComputerStore(context).clientId());
      if (response != null) { listener.send(new DatagramPacket(response, response.length, packet.getAddress(), packet.getPort())); lastReply = now; }
    } catch (Exception ignored) {
      listener.close(); main.post(() -> { if (socket == listener) stopSocket(); });
    }
  }
  private static boolean sameNetwork(InetAddress remote, List<LinkAddress> links) {
    byte[] bytes = remote.getAddress();
    for (LinkAddress link : links) {
      byte[] local = link.getAddress().getAddress(); int bits = link.getPrefixLength(); boolean matches = true;
      for (int i = 0; i < 4 && bits > 0; i++, bits -= 8) { int mask = 255 << Math.max(0, 8 - bits); if ((bytes[i] & mask) != (local[i] & mask)) { matches = false; break; } }
      if (matches) return true;
    }
    return false;
  }
  private void stopSocket() {
    if (socket != null) { socket.close(); socket = null; }
    if (lock != null) { try { if (lock.isHeld()) lock.release(); } catch (RuntimeException ignored) { } lock = null; }
  }
  private void close() {
    closed = true; main.removeCallbacksAndMessages(null); stopSocket();
    try { connectivity.unregisterNetworkCallback(callback); } catch (RuntimeException ignored) { }
    if (current == this) current = null;
  }
}
