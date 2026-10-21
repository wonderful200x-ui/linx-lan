import java.io.*;
import java.util.*;
import local.linx.android.core.*;
import org.json.*;

public class InteropHarness {
  public static void main(String[] args) throws Exception {
    LanEngine engine = new LanEngine(new File(args[0]), "Android 测试手机");
    engine.start();
    System.out.println(engine.snapshot());
    System.out.flush();
    try (BufferedReader input = new BufferedReader(new InputStreamReader(System.in))) {
      String line;
      while ((line = input.readLine()) != null) {
        JSONObject result;
        try {
          JSONObject c = new JSONObject(line);
          switch (c.getString("action")) {
            case "snapshot":
              result = engine.snapshot();
              break;
            case "connect":
              result = Wire.object("id", engine.connect(c.getString("address"), c.getInt("port")));
              break;
            case "message":
              engine.sendMessage(c.getString("peerId"), c.getString("text"));
              result = Wire.object("ok", true);
              break;
            case "send":
              List<File> files = new ArrayList<>();
              JSONArray list = c.getJSONArray("paths");
              for (int i = 0; i < list.length(); i++) files.add(new File(list.getString(i)));
              result = Wire.object("id", engine.sendFiles(c.getString("peerId"), files));
              break;
            case "accept":
              engine.accept(c.getString("id"), c.getBoolean("accepted"));
              result = Wire.object("ok", true);
              break;
            case "cancel":
              engine.cancel(c.getString("id"));
              result = Wire.object("ok", true);
              break;
            case "rename":
              engine.rename(c.getString("name"));
              result = Wire.object("ok", true);
              break;
            case "close":
              engine.close();
              System.out.println(Wire.object("ok", true));
              System.out.flush();
              return;
            default:
              throw new IOException("unknown command");
          }
        } catch (Exception e) {
          result = Wire.object("error", e.toString());
        }
        System.out.println(result);
        System.out.flush();
      }
    } finally {
      engine.close();
    }
  }
}
