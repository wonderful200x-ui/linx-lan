package local.linx.android.core;

import static local.linx.android.core.Wire.object;

import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;

/** Compatible with the desktop linx-lan/1 protocol, including streaming SHA-256 trailers. */
public final class LanEngine implements Closeable {
  public static final String PROTOCOL = "linx-lan/1", GROUP = "239.255.77.88";
  public static final int DISCOVERY_PORT = 45893;
  public final File home, received;
  public volatile String id, name, warning = "";
  public volatile int port;
  public volatile Runnable listener = () -> {};
  public volatile java.util.function.Consumer<String> notification = s -> {};
  private final String token = UUID.randomUUID().toString() + UUID.randomUUID();
  private final ConcurrentMap<String, Peer> peers = new ConcurrentHashMap<>();
  private final ConcurrentMap<String, Transfer> transfers = new ConcurrentHashMap<>();
  private final List<JSONObject> messages = new CopyOnWriteArrayList<>();
  private final ConcurrentMap<String, CompletableFuture<Peer>> connecting =
      new ConcurrentHashMap<>();
  private final Set<Socket> sockets = ConcurrentHashMap.newKeySet();
  private final ThreadPoolExecutor workers =
      new ThreadPoolExecutor(
          4,
          12,
          30,
          TimeUnit.SECONDS,
          new ArrayBlockingQueue<>(80),
          r -> {
            Thread t = new Thread(r, "linx-network");
            t.setDaemon(true);
            return t;
          },
          new ThreadPoolExecutor.AbortPolicy());
  private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(2);
  private final AtomicBoolean dirty = new AtomicBoolean();
  private ServerSocket server;
  private MulticastSocket multicast;
  private volatile boolean running;

  public static final class Peer {
    public String id, name, address, platform, token;
    public int port;
    public volatile long lastSeen;
    public volatile boolean online;

    JSONObject json() {
      return object(
          "id",
          id,
          "name",
          name,
          "address",
          address,
          "port",
          port,
          "platform",
          platform,
          "online",
          online);
    }
  }

  private static final class Entry {
    String path, type;
    long size;
    File source;
    volatile boolean done;

    JSONObject json() {
      return object("path", path, "type", type, "size", size);
    }
  }

  public static final class Transfer {
    public String id, peerId, peerName, name, direction, secret, remoteId;
    public volatile String status = "pending", error = "", currentFile = "";
    public volatile long bytes, total, updatedAt, createdAt;
    public volatile double speed;
    public File receiveDir;
    public final List<Entry> entries = new ArrayList<>();
    public Peer peer;
    public volatile Socket socket;
    public volatile boolean cancelled;
    boolean writing;

    JSONObject json() {
      int count = 0;
      for (Entry e : entries) if (e.type.equals("file")) count++;
      JSONObject j =
          object(
              "id",
              id,
              "peerId",
              peerId,
              "peerName",
              peerName,
              "name",
              name,
              "direction",
              direction,
              "status",
              status,
              "error",
              error,
              "currentFile",
              currentFile,
              "bytes",
              bytes,
              "total",
              total,
              "speed",
              speed,
              "createdAt",
              createdAt,
              "fileCount",
              count);
      if (receiveDir != null)
        try {
          j.put("receiveDir", receiveDir.getAbsolutePath());
        } catch (JSONException ignored) {
        }
      return j;
    }
  }

  public LanEngine(File directory, String defaultName) throws Exception {
    home = directory;
    received = new File(home, "received");
    if (!home.isDirectory() && !home.mkdirs()) throw new IOException("不能创建应用目录");
    if (!received.isDirectory() && !received.mkdirs()) throw new IOException("不能创建接收目录");
    id = UUID.randomUUID().toString();
    name = defaultName.length() > 40 ? defaultName.substring(0, 40) : defaultName;
    File state = new File(home, "state.json");
    if (state.isFile())
      try {
        JSONObject saved =
            new JSONObject(
                new String(
                    Files.readAllBytes(state.toPath()), java.nio.charset.StandardCharsets.UTF_8));
        id = saved.optString("id", id);
        name = saved.optString("name", name);
        JSONArray list = saved.optJSONArray("messages");
        if (list != null)
          for (int i = Math.max(0, list.length() - 2000); i < list.length(); i++)
            messages.add(list.getJSONObject(i));
      } catch (Exception e) {
        warning = "本地记录读取失败，已新建会话";
      }
  }

  public void execute(Runnable task) {
    if (running)
      try {
        workers.execute(task);
      } catch (RejectedExecutionException e) {
        warning = "任务过多，请稍后重试";
        emit();
      }
  }

  public void start() throws IOException {
    server = new ServerSocket();
    server.setReuseAddress(true);
    server.bind(new InetSocketAddress("0.0.0.0", 0));
    port = server.getLocalPort();
    running = true;
    Thread accept =
        new Thread(
            () -> {
              while (running)
                try {
                  Socket s = server.accept();
                  s.setSoTimeout(60000);
                  sockets.add(s);
                  try {
                    workers.execute(() -> serve(s));
                  } catch (RejectedExecutionException e) {
                    sockets.remove(s);
                    s.close();
                  }
                } catch (IOException e) {
                  if (running) {
                    warning = e.getMessage();
                    emit();
                  }
                }
            },
            "linx-http");
    accept.setDaemon(true);
    accept.start();
    try {
      multicast = new MulticastSocket(null);
      multicast.setReuseAddress(true);
      multicast.bind(new InetSocketAddress(DISCOVERY_PORT));
      multicast.setBroadcast(true);
      multicast.setTimeToLive(1);
      for (NetworkInterface network : Collections.list(NetworkInterface.getNetworkInterfaces()))
        try {
          if (network.isUp() && !network.isLoopback())
            multicast.joinGroup(new InetSocketAddress(GROUP, DISCOVERY_PORT), network);
        } catch (Exception ignored) {
        }
      Thread discovery =
          new Thread(
              () -> {
                byte[] buf = new byte[2048];
                while (running)
                  try {
                    DatagramPacket packet = new DatagramPacket(buf, buf.length);
                    multicast.receive(packet);
                    JSONObject h =
                        new JSONObject(
                            new String(
                                packet.getData(),
                                0,
                                packet.getLength(),
                                java.nio.charset.StandardCharsets.UTF_8));
                    if (PROTOCOL.equals(h.optString("protocol")) && !id.equals(h.optString("id"))) {
                      String address = packet.getAddress().getHostAddress();
                      int remotePort = h.optInt("port");
                      execute(
                          () -> {
                            try {
                              discover(address, remotePort);
                            } catch (Exception ignored) {
                            }
                          });
                    }
                  } catch (Exception ignored) {
                  }
              },
              "linx-discovery");
      discovery.setDaemon(true);
      discovery.start();
    } catch (Exception e) {
      warning = "自动发现受限，可手动连接：" + e.getMessage();
    }
    scheduler.scheduleAtFixedRate(
        () -> {
          announce();
          long now = System.currentTimeMillis();
          for (Peer p : peers.values()) {
            if (now - p.lastSeen > 12000) p.online = false;
            if (now - p.lastSeen > 3000)
              execute(
                  () -> {
                    try {
                      discover(p.address, p.port);
                    } catch (Exception ignored) {
                    }
                  });
          }
          for (Transfer t : transfers.values())
            if (!terminal(t.status)) {
              long limit = t.status.equals("pending") ? 600000 : 60000;
              if (now - t.updatedAt > limit) {
                cancel(t.id);
                t.status = "failed";
                t.error = "等待或传输超时，请重新发送";
              }
            }
          emit();
        },
        0,
        2500,
        TimeUnit.MILLISECONDS);
    scheduler.scheduleAtFixedRate(
        () -> {
          if (dirty.getAndSet(false))
            try {
              persist();
            } catch (Exception e) {
              warning = "记录保存失败：" + e.getMessage();
            }
        },
        1,
        1,
        TimeUnit.SECONDS);
  }

  public List<String> addresses() {
    List<String> list = new ArrayList<>();
    try {
      for (NetworkInterface n : Collections.list(NetworkInterface.getNetworkInterfaces()))
        for (InetAddress a : Collections.list(n.getInetAddresses()))
          if (a instanceof Inet4Address && !a.isLoopbackAddress()) list.add(a.getHostAddress());
    } catch (Exception ignored) {
    }
    return list;
  }

  public JSONObject hello() {
    return object(
        "protocol", PROTOCOL, "id", id, "name", name, "platform", "android", "port", port);
  }

  public JSONObject snapshot() {
    JSONArray ps = new JSONArray(), ts = new JSONArray(), ms = new JSONArray();
    for (Peer p : peers.values()) ps.put(p.json());
    List<Transfer> list = new ArrayList<>(transfers.values());
    list.sort((a, b) -> Long.compare(b.createdAt, a.createdAt));
    for (Transfer t : list) ts.put(t.json());
    for (JSONObject m : messages) ms.put(m);
    return object(
        "id",
        id,
        "name",
        name,
        "port",
        port,
        "addresses",
        new JSONArray(addresses()),
        "peers",
        ps,
        "transfers",
        ts,
        "messages",
        ms,
        "warning",
        warning,
        "receivedDir",
        received.getAbsolutePath());
  }

  private void emit() {
    dirty.set(true);
    try {
      listener.run();
    } catch (Exception ignored) {
    }
  }

  private synchronized void persist() throws Exception {
    JSONArray ms = new JSONArray();
    for (JSONObject m : messages) ms.put(m);
    File temp = new File(home, "state.tmp");
    try (OutputStream out = new FileOutputStream(temp)) {
      out.write(
          object("id", id, "name", name, "messages", ms)
              .toString()
              .getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
    Files.move(
        temp.toPath(), new File(home, "state.json").toPath(), StandardCopyOption.REPLACE_EXISTING);
  }

  public void rename(String value) throws Exception {
    value = value.trim();
    if (value.isEmpty() || value.length() > 40) throw new IOException("终端名称需为1–40个字符");
    name = value;
    persist();
    announce();
    emit();
  }

  public void announce() {
    if (multicast == null || multicast.isClosed()) return;
    byte[] data = hello().toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
    for (String target : Arrays.asList(GROUP, "255.255.255.255"))
      try {
        multicast.send(
            new DatagramPacket(data, data.length, InetAddress.getByName(target), DISCOVERY_PORT));
      } catch (Exception ignored) {
      }
  }

  public Peer discover(String address, int remotePort) throws Exception {
    String key = address + ":" + remotePort;
    CompletableFuture<Peer> future = new CompletableFuture<>(),
        existing = connecting.putIfAbsent(key, future);
    if (existing != null) return existing.get(7, TimeUnit.SECONDS);
    try {
      JSONObject h = Wire.request(address, remotePort, "", "/hello", null, "GET");
      if (!PROTOCOL.equals(h.optString("protocol"))
          || h.optString("id").length() > 100
          || h.optString("id").isEmpty()
          || h.optString("token").length() < 16) throw new IOException("不是邻讯客户端");
      if (id.equals(h.getString("id"))) throw new IOException("这是当前手机");
      Peer p = new Peer();
      p.id = h.getString("id");
      p.name = h.optString("name", "终端");
      if (p.name.length() > 40) p.name = p.name.substring(0, 40);
      p.address = address;
      p.port = remotePort;
      p.platform = h.optString("platform");
      p.token = h.getString("token");
      p.online = true;
      p.lastSeen = System.currentTimeMillis();
      peers.put(p.id, p);
      emit();
      future.complete(p);
      return p;
    } catch (Exception e) {
      future.completeExceptionally(e);
      throw e;
    } finally {
      connecting.remove(key, future);
    }
  }

  public String connect(String address, int remotePort) throws Exception {
    Peer p = discover(address, remotePort);
    request(p, "/introduce", hello(), "POST");
    return p.id;
  }

  private JSONObject request(Peer p, String route, JSONObject data, String method)
      throws Exception {
    return Wire.request(p.address, p.port, p.token, route, data, method);
  }

  private Peer peer(String peerId) throws IOException {
    Peer p = peers.get(peerId);
    if (p == null || !p.online) throw new IOException("请先选择在线终端");
    return p;
  }

  public void sendMessage(String peerId, String text) throws Exception {
    text = text.trim();
    if (text.isEmpty() || text.length() > 20000) throw new IOException("消息需为1–20,000字符");
    Peer p = peer(peerId);
    String mid = UUID.randomUUID().toString();
    request(p, "/message", object("id", mid, "text", text, "sender", hello()), "POST");
    addMessage(
        object(
            "id",
            mid,
            "peerId",
            p.id,
            "peerName",
            p.name,
            "direction",
            "outgoing",
            "text",
            text,
            "createdAt",
            System.currentTimeMillis()));
  }

  private synchronized void addMessage(JSONObject m) {
    for (JSONObject old : messages) if (old.optString("id").equals(m.optString("id"))) return;
    messages.add(m);
    while (messages.size() > 2000) messages.remove(0);
    emit();
  }

  public static String safePath(String relative) throws IOException {
    if (relative == null
        || relative.isEmpty()
        || relative.length() > 2048
        || relative.startsWith("/")
        || relative.contains("\\")) throw new IOException("无效路径");
    for (String part : relative.split("/", -1))
      if (part.isEmpty()
          || part.equals(".")
          || part.equals("..")
          || part.matches(".*[<>:\"|?*\\x00-\\x1f].*")
          || part.matches(".*[. ]$")
          || part.matches("(?i)^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\\..*)?$"))
        throw new IOException("文件名不兼容电脑：" + relative);
    return relative;
  }

  private static boolean terminal(String status) {
    return Arrays.asList("completed", "failed", "cancelled", "rejected").contains(status);
  }

  private void collect(File file, String relative, List<Entry> entries, Set<String> seen)
      throws Exception {
    safePath(relative);
    if (!seen.add(relative.toLowerCase(Locale.ROOT))) throw new IOException("文件重名：" + relative);
    if (Files.isSymbolicLink(file.toPath())) throw new IOException("不支持符号链接");
    Entry e = new Entry();
    e.path = relative;
    e.source = file;
    e.type = file.isDirectory() ? "directory" : "file";
    e.size = file.isDirectory() ? 0 : file.length();
    if (!file.exists() || (!file.isFile() && !file.isDirectory())) throw new IOException("文件不存在");
    entries.add(e);
    if (entries.size() > 10000) throw new IOException("每批最多10,000个文件和目录");
    if (file.isDirectory()) {
      File[] children = file.listFiles();
      if (children == null) throw new IOException("目录不可读");
      Arrays.sort(children, Comparator.comparing(File::getName));
      for (File child : children) collect(child, relative + "/" + child.getName(), entries, seen);
    }
  }

  public String sendFiles(String peerId, List<File> files) throws Exception {
    if (files.isEmpty()) throw new IOException("请先选择图片或文件");
    Transfer t = new Transfer();
    t.id = UUID.randomUUID().toString();
    t.peer = peer(peerId);
    t.peerId = peerId;
    t.peerName = t.peer.name;
    t.direction = "outgoing";
    t.createdAt = t.updatedAt = System.currentTimeMillis();
    Set<String> names = new HashSet<>();
    for (File file : files) collect(file, file.getName(), t.entries, names);
    for (Entry e : t.entries) t.total = Math.addExact(t.total, e.size);
    if (t.total > 9007199254740991L) throw new IOException("文件总量超限");
    t.name = files.get(0).getName() + (files.size() > 1 ? " 等 " + files.size() + " 项" : "");
    addTransfer(t);
    execute(() -> runSend(t));
    return t.id;
  }

  public String retry(String transferId) throws Exception {
    Transfer original = transfers.get(transferId);
    if (original == null || !"outgoing".equals(original.direction) || !terminal(original.status))
      throw new IOException("请重新选择文件发送");
    List<File> roots = new ArrayList<>();
    for (Entry entry : original.entries) if (!entry.path.contains("/")) roots.add(entry.source);
    return sendFiles(original.peerId, roots);
  }

  private synchronized void addTransfer(Transfer t) throws IOException {
    int active = 0;
    for (Transfer old : transfers.values()) if (!terminal(old.status)) active++;
    if (active >= 30) throw new IOException("待处理传输过多");
    if (transfers.size() >= 130) {
      List<Transfer> list = new ArrayList<>(transfers.values());
      list.sort(Comparator.comparingLong(v -> v.createdAt));
      for (Transfer old : list)
        if (terminal(old.status) && transfers.size() > 100) transfers.remove(old.id);
    }
    transfers.put(t.id, t);
    emit();
  }

  private void check(Transfer t) throws IOException {
    if (t.cancelled || !running) throw new IOException("传输已取消");
  }

  private void runSend(Transfer t) {
    String route = null;
    try {
      JSONArray entries = new JSONArray();
      for (Entry e : t.entries) entries.put(e.json());
      JSONObject offer =
          request(t.peer, "/offer", object("sender", hello(), "entries", entries), "POST");
      t.remoteId = offer.getString("id");
      t.secret = offer.getString("secret");
      route = "/transfer/" + t.remoteId;
      String query = "?secret=" + t.secret;
      long deadline = System.currentTimeMillis() + 600000;
      while (true) {
        check(t);
        JSONObject result = request(t.peer, route + query, null, "GET");
        String status = result.optString("status");
        if (status.equals("receiving")) break;
        if (terminal(status)) {
          t.status = status;
          t.error = result.optString("error");
          emit();
          return;
        }
        if (System.currentTimeMillis() > deadline) throw new IOException("等待接收超时");
        t.updatedAt = System.currentTimeMillis();
        Thread.sleep(600);
      }
      t.status = "sending";
      emit();
      for (int i = 0; i < t.entries.size(); i++) {
        Entry e = t.entries.get(i);
        if (e.type.equals("file")) {
          check(t);
          upload(t, e, route + "/" + i + query);
        }
      }
      check(t);
      request(t.peer, route + "/finish" + query, object(), "POST");
      t.status = "completed";
      t.bytes = t.total;
      t.speed = 0;
      emit();
    } catch (Exception e) {
      if (!t.cancelled) {
        t.status = "failed";
        t.error = message(e);
        t.speed = 0;
        emit();
      }
      if (route != null)
        try {
          request(t.peer, route + "/cancel?secret=" + t.secret, object(), "POST");
        } catch (Exception ignored) {
        }
    }
  }

  private void upload(Transfer t, Entry e, String route) throws Exception {
    if (e.source.length() != e.size) throw new IOException("源文件大小发生变化");
    t.currentFile = e.path;
    long base = t.bytes, bytes = 0, lastTime = System.currentTimeMillis(), lastBytes = base;
    MessageDigest hash = MessageDigest.getInstance("SHA-256");
    try (Socket socket = new Socket()) {
      t.socket = socket;
      socket.connect(new InetSocketAddress(t.peer.address, t.peer.port), 5000);
      socket.setSoTimeout(60000);
      socket.setTcpNoDelay(true);
      OutputStream out = new BufferedOutputStream(socket.getOutputStream(), 65536);
      InputStream response = new BufferedInputStream(socket.getInputStream());
      Wire.ascii(
          out,
          "PUT "
              + route
              + " HTTP/1.1\r\nHost: "
              + t.peer.address
              + ":"
              + t.peer.port
              + "\r\nx-linx-token: "
              + t.peer.token
              + "\r\n"
              + "Transfer-Encoding: chunked\r\n"
              + "Trailer: x-content-sha256\r\n"
              + "Content-Type: application/octet-stream\r\n"
              + "Connection: close\r\n\r\n");
      try (InputStream in = new FileInputStream(e.source)) {
        byte[] buffer = new byte[65536];
        for (int n; (n = in.read(buffer)) != -1; ) {
          check(t);
          bytes += n;
          if (bytes > e.size) throw new IOException("源文件变化");
          hash.update(buffer, 0, n);
          Wire.ascii(out, Integer.toHexString(n) + "\r\n");
          out.write(buffer, 0, n);
          Wire.ascii(out, "\r\n");
          t.bytes = base + bytes;
          t.updatedAt = System.currentTimeMillis();
          if (t.updatedAt - lastTime > 250) {
            t.speed = (t.bytes - lastBytes) * 1000.0 / (t.updatedAt - lastTime);
            lastBytes = t.bytes;
            lastTime = t.updatedAt;
            emit();
          }
        }
      }
      Wire.ascii(out, "0\r\nx-content-sha256: " + hex(hash.digest()) + "\r\n\r\n");
      out.flush();
      String status = Wire.line(response);
      Map<String, String> headers = Wire.headers(response);
      JSONObject result = Wire.jsonBody(response, headers);
      if (!status.startsWith("HTTP/1.1 200"))
        throw new IOException(result.optString("error", "对方拒绝文件"));
      if (bytes != e.size) throw new IOException("源文件变短");
      t.bytes = base + e.size;
      emit();
    } finally {
      t.socket = null;
    }
  }

  private static String hex(byte[] data) {
    StringBuilder result = new StringBuilder();
    for (byte b : data) result.append(String.format(Locale.ROOT, "%02x", b & 255));
    return result.toString();
  }

  private static String message(Exception e) {
    return e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
  }

  private void serve(Socket socket) {
    try (Socket s = socket) {
      InputStream in = new BufferedInputStream(s.getInputStream(), 65536);
      OutputStream out = s.getOutputStream();
      try {
        String[] first = Wire.line(in).split(" ");
        if (first.length != 3) throw new IOException("请求无效");
        Map<String, String> headers = Wire.headers(in);
        URI uri = URI.create(first[1]);
        String route = uri.getPath(), method = first[0];
        if (route.equals("/hello") && method.equals("GET")) {
          JSONObject h = hello();
          h.put("token", token);
          Wire.respond(out, 200, h);
          return;
        }
        if (!token.equals(headers.get("x-linx-token"))) {
          Wire.respond(out, 401, object("error", "连接凭证失效，请重新发现"));
          return;
        }
        if (method.equals("POST")
            && Arrays.asList("/introduce", "/message", "/offer").contains(route)) {
          JSONObject body = Wire.jsonBody(in, headers),
              sender = route.equals("/introduce") ? body : body.getJSONObject("sender");
          String senderId = sender.optString("id"), senderName = sender.optString("name");
          int senderPort = sender.optInt("port");
          if (!PROTOCOL.equals(sender.optString("protocol"))
              || senderId.isEmpty()
              || senderId.length() > 100
              || senderId.equals(id)
              || senderPort < 1
              || senderPort > 65535) throw new IOException("发送终端信息无效");
          if (senderName.length() > 40) senderName = senderName.substring(0, 40);
          String address = s.getInetAddress().getHostAddress();
          execute(
              () -> {
                try {
                  discover(address, senderPort);
                } catch (Exception ignored) {
                }
              });
          if (route.equals("/introduce")) {
            Wire.respond(out, 200, object("ok", true));
            return;
          }
          if (route.equals("/message")) {
            String text = body.getString("text"), mid = body.getString("id");
            if (text.trim().isEmpty() || text.length() > 20000 || mid.length() > 100)
              throw new IOException("消息无效");
            addMessage(
                object(
                    "id",
                    mid,
                    "peerId",
                    senderId,
                    "peerName",
                    senderName,
                    "text",
                    text,
                    "direction",
                    "incoming",
                    "createdAt",
                    System.currentTimeMillis()));
            notification.accept(senderName + "：" + text.substring(0, Math.min(80, text.length())));
            Wire.respond(out, 200, object("ok", true));
            return;
          }
          Transfer t = new Transfer();
          t.id = UUID.randomUUID().toString();
          t.secret = UUID.randomUUID().toString();
          t.direction = "incoming";
          t.peerId = senderId;
          t.peerName = senderName;
          t.createdAt = t.updatedAt = System.currentTimeMillis();
          JSONArray list = body.getJSONArray("entries");
          if (list.length() == 0 || list.length() > 10000) throw new IOException("文件清单超限");
          Map<String, String> names = new HashMap<>();
          Set<String> roots = new LinkedHashSet<>();
          for (int i = 0; i < list.length(); i++) {
            JSONObject j = list.getJSONObject(i);
            Entry e = new Entry();
            e.path = safePath(j.getString("path"));
            e.type = j.getString("type");
            double size = j.getDouble("size");
            if (!Double.isFinite(size)
                || size < 0
                || size > 9007199254740991L
                || size != Math.floor(size)) throw new IOException("文件大小无效");
            e.size = (long) size;
            if (!Arrays.asList("file", "directory").contains(e.type)
                || (e.type.equals("directory") && e.size != 0)
                || names.put(e.path.toLowerCase(Locale.ROOT), e.type) != null)
              throw new IOException("文件清单无效或文件重名");
            t.total = Math.addExact(t.total, e.size);
            t.entries.add(e);
            roots.add(e.path.split("/")[0]);
          }
          if (t.total > 9007199254740991L) throw new IOException("文件总量超限");
          for (Entry e : t.entries) {
            String parent = e.path.toLowerCase(Locale.ROOT);
            while (parent.contains("/")) {
              parent = parent.substring(0, parent.lastIndexOf('/'));
              if (!"directory".equals(names.get(parent))) throw new IOException("目录清单不完整");
            }
          }
          t.name = roots.iterator().next() + (roots.size() > 1 ? " 等 " + roots.size() + " 项" : "");
          addTransfer(t);
          notification.accept("收到 " + senderName + " 的文件：" + t.name);
          Wire.respond(out, 200, object("id", t.id, "secret", t.secret));
          return;
        }
        String[] parts = route.split("/");
        if (parts.length < 3 || !parts[1].equals("transfer")) throw new IOException("未知请求");
        Transfer t = transfers.get(parts[2]);
        String secret = headers.get("x-transfer-secret");
        if (secret == null && uri.getRawQuery() != null)
          for (String query : uri.getRawQuery().split("&"))
            if (query.startsWith("secret=")) secret = query.substring(7);
        if (t == null || !"incoming".equals(t.direction) || !t.secret.equals(secret)) {
          Wire.respond(out, 403, object("error", "传输凭证无效"));
          return;
        }
        t.updatedAt = System.currentTimeMillis();
        if (method.equals("GET") && parts.length == 3) {
          Wire.respond(out, 200, object("status", t.status, "error", t.error));
          return;
        }
        if (parts.length != 4) throw new IOException("传输请求无效");
        if (method.equals("POST") && parts[3].equals("cancel")) {
          cancel(t.id);
          Wire.respond(out, 200, object("ok", true));
          return;
        }
        if (method.equals("POST") && parts[3].equals("finish")) {
          synchronized (t) {
            check(t);
            if (!t.status.equals("receiving") || t.writing) throw new IOException("接收尚未完成");
            for (Entry e : t.entries)
              if (e.type.equals("file") && !e.done) throw new IOException("文件不完整");
            t.status = "completed";
            t.bytes = t.total;
            t.speed = 0;
          }
          emit();
          notification.accept("接收完成：" + t.name);
          Wire.respond(out, 200, object("ok", true));
          return;
        }
        if (!method.equals("PUT")) throw new IOException("不支持的传输方法");
        receive(t, Integer.parseInt(parts[3]), s, in, headers);
        Wire.respond(out, 200, object("ok", true));
      } catch (Exception e) {
        try {
          Wire.respond(out, 400, object("error", message(e)));
        } catch (Exception ignored) {
        }
      }
    } catch (IOException ignored) {
    } finally {
      sockets.remove(socket);
    }
  }

  private void receive(
      Transfer t, int index, Socket socket, InputStream in, Map<String, String> headers)
      throws Exception {
    Entry e;
    synchronized (t) {
      check(t);
      if (!t.status.equals("receiving") || t.writing || index < 0 || index >= t.entries.size())
        throw new IOException("传输状态无效");
      e = t.entries.get(index);
      if (!e.type.equals("file") || e.done) throw new IOException("文件状态无效");
      t.writing = true;
      t.socket = socket;
    }
    File partial = new File(t.receiveDir, ".linx-" + UUID.randomUUID() + ".part"),
        destination = new File(t.receiveDir, e.path);
    long base = t.bytes;
    long[] count = {0}, lastTime = {System.currentTimeMillis()}, lastBytes = {base};
    t.currentFile = e.path;
    MessageDigest hash = MessageDigest.getInstance("SHA-256");
    try (OutputStream file = new BufferedOutputStream(new FileOutputStream(partial), 65536)) {
      Map<String, String> trailers =
          Wire.body(
              in,
              headers,
              e.size,
              (buffer, offset, n) -> {
                check(t);
                file.write(buffer, offset, n);
                hash.update(buffer, offset, n);
                count[0] += n;
                t.bytes = base + count[0];
                t.updatedAt = System.currentTimeMillis();
                if (t.updatedAt - lastTime[0] > 250) {
                  t.speed = (t.bytes - lastBytes[0]) * 1000.0 / (t.updatedAt - lastTime[0]);
                  lastTime[0] = t.updatedAt;
                  lastBytes[0] = t.bytes;
                  emit();
                }
              });
      file.flush();
      if (count[0] != e.size || !hex(hash.digest()).equals(trailers.get("x-content-sha256")))
        throw new IOException("文件大小或 SHA-256 校验失败");
      check(t);
    } catch (Exception ex) {
      Files.deleteIfExists(partial.toPath());
      t.bytes = base;
      if (!t.cancelled) {
        t.status = "failed";
        t.error = message(ex);
      }
      throw ex;
    } finally {
      synchronized (t) {
        t.writing = false;
        t.socket = null;
      }
      emit();
    }
    synchronized (t) {
      try {
        check(t);
        Files.move(partial.toPath(), destination.toPath());
        e.done = true;
      } catch (Exception ex) {
        Files.deleteIfExists(partial.toPath());
        if (!t.cancelled) {
          t.status = "failed";
          t.error = message(ex);
        }
        emit();
        throw ex;
      }
    }
    emit();
  }

  public void accept(String transferId, boolean yes) throws Exception {
    Transfer t = transfers.get(transferId);
    if (t == null) throw new IOException("请求不存在");
    synchronized (t) {
      if (!t.status.equals("pending") || !t.direction.equals("incoming"))
        throw new IOException("请求已处理");
      if (!yes) {
        t.status = "rejected";
        emit();
        return;
      }
      if (received.getUsableSpace() < t.total) throw new IOException("手机可用空间不足");
      t.receiveDir = Files.createTempDirectory(received.toPath(), "邻讯-").toFile();
      for (Entry e : t.entries)
        if (e.type.equals("directory")) {
          File dir = new File(t.receiveDir, e.path);
          if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("不能创建接收目录");
        }
      t.status = "receiving";
      t.updatedAt = System.currentTimeMillis();
    }
    emit();
  }

  public boolean hasActiveTransfers() {
    for (Transfer t : transfers.values()) if (!terminal(t.status)) return true;
    return false;
  }

  public void cancel(String transferId) {
    Transfer t = transfers.get(transferId);
    if (t == null) return;
    synchronized (t) {
      if (terminal(t.status)) return;
      t.cancelled = true;
      t.status = "cancelled";
      t.speed = 0;
      if (t.socket != null)
        try {
          t.socket.close();
        } catch (Exception ignored) {
        }
    }
    emit();
  }

  public List<File> receivedFiles(String transferId) throws IOException {
    Transfer t = transfers.get(transferId);
    if (t == null || t.receiveDir == null) throw new IOException("没有接收文件");
    List<File> result = new ArrayList<>();
    for (Entry e : t.entries) if (e.done) result.add(new File(t.receiveDir, e.path));
    return result;
  }

  public List<File> allReceivedFiles() {
    List<File> files = new ArrayList<>();
    walkReceived(received, files);
    return files;
  }

  private void walkReceived(File root, List<File> list) {
    File[] children = root.listFiles();
    if (children != null)
      for (File f : children) {
        if (f.isDirectory()) walkReceived(f, list);
        else if (!f.getName().startsWith(".linx-")) list.add(f);
      }
  }

  @Override
  public void close() {
    running = false;
    for (Transfer t : transfers.values()) cancel(t.id);
    scheduler.shutdownNow();
    workers.shutdownNow();
    try {
      if (multicast != null) multicast.close();
      if (server != null) server.close();
    } catch (Exception ignored) {
    }
    for (Socket s : sockets)
      try {
        s.close();
      } catch (Exception ignored) {
      }
    try {
      persist();
    } catch (Exception ignored) {
    }
  }
}
