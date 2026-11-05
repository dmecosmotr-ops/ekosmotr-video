import micam.miss.MediaPacket;
import micam.miss.MissClient;
import micam.miss.MissCrypto;
import micam.pppp.InitString;
import micam.pppp.PpppConnection;
import micam.pppp.RelaySession;
import micam.pppp.Uid;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Properties;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Diagnostic relay transport. Stdout is live HEVC only; stdin STOP/EOF closes it.
 * Args: private provisioning.properties, quality 0..3, max live seconds 1..600.
 * Uses pre-existing external micam transport classes; not a production integration.
 */
public final class RelayLive {
    private static final Duration CONNECT = Duration.ofSeconds(30);
    private static final Duration AUTH = Duration.ofSeconds(10);
    private static final Duration STALL = Duration.ofSeconds(10);
    private static final long BYTE_LIMIT = 500_000_000L;
    private enum Stage { INPUT, RELAY, AUTH, CAPTURE }
    private enum Event { STARTED, RETRY, READY, FRAME_READY, COMPLETE, ERROR, CANCELLED }
    private enum FailureCode { INPUT_INVALID, RELAY_FAILED, AUTH_FAILED, CAPTURE_FAILED,
        FRAME_TIMEOUT, UNSUPPORTED_CODEC, CODEC_CHANGED, BYTE_LIMIT, OUTPUT_CLOSED }
    private static final class LiveFailure extends Exception {
        final FailureCode code;
        LiveFailure(FailureCode code) { this.code = code; }
    }
    private static void trace(Stage stage, Event event) {
        // Enum names only: never forward upstream text, paths, credentials or IDs.
        System.err.println("stage=" + stage.name() + " event=" + event.name());
    }

    private static final class Session {
        final AtomicBoolean stopped = new AtomicBoolean();
        volatile RelaySession relay;
        volatile PpppConnection connection;
        volatile MissClient miss;
        volatile boolean videoRequested;
        synchronized void close() {
            stopped.set(true);
            if (videoRequested && miss != null && relay != null) {
                videoRequested = false;
                final MissClient client = miss;
                final RelaySession socket = relay;
                try { bounded(() -> { client.stopVideo(); return null; }, Duration.ofMillis(700), socket::close); }
                catch (Exception ignored) { }
            }
            if (connection != null) {
                try { connection.close(); } catch (Exception ignored) { }
                connection = null;
            }
            if (relay != null) { relay.close(); relay = null; }
        }
        void requireActive() throws Exception { if (stopped.get()) throw new Exception(); }
    }

    public static void main(String[] args) {
        Thread.setDefaultUncaughtExceptionHandler((thread, failure) -> {});
        Session session = new Session();
        Runtime.getRuntime().addShutdownHook(new Thread(session::close, "live-cleanup"));
        Thread command = new Thread(() -> {
            try { new BufferedReader(new InputStreamReader(System.in)).readLine(); }
            catch (Exception ignored) { }
            session.close();
        }, "live-control");
        command.setDaemon(true);
        command.start();
        int result = run(args, session);
        session.close();
        System.exit(result);
    }

    private static int run(String[] args, Session session) {
        byte[] privateKey = null, sessionKey = null;
        Stage stage = Stage.INPUT;
        trace(stage, Event.STARTED);
        try {
            if (args.length != 3) throw new Exception();
            Path input = Path.of(args[0]).toAbsolutePath().normalize();
            boolean isPrivate = false;
            for (Path component : input) if (component.toString().equalsIgnoreCase("private")) isPrivate = true;
            if (!isPrivate || !Files.isRegularFile(input, LinkOption.NOFOLLOW_LINKS) || Files.size(input) > 32768) throw new Exception();
            int quality = Integer.parseInt(args[1]), seconds = Integer.parseInt(args[2]);
            if (quality < 0 || quality > 3 || seconds < 1 || seconds > 600) throw new Exception();
            Properties properties = new Properties();
            try (InputStream stream = Files.newInputStream(input)) { properties.load(stream); }
            if (!"4".equals(required(properties, "vendor"))) throw new Exception();
            String clientPublic = hex(properties, "clientPublic", 32);
            String devicePublic = hex(properties, "devicePublic", 32);
            String signature = hex(properties, "sign", -1);
            privateKey = HexFormat.of().parseHex(hex(properties, "clientPrivate", 32));
            String serverList = properties.getProperty("servers", "").trim();
            List<String> servers = serverList.isEmpty()
                ? InitString.servers(required(properties, "initString"))
                : Arrays.stream(serverList.split(",")).map(String::trim).toList();
            if (servers.isEmpty() || servers.size() > 32 || servers.stream().anyMatch(s -> !publicIpv4(s))) throw new Exception();
            Uid uid = Uid.parse(required(properties, "p2pId"));
            properties.clear();
            trace(stage, Event.READY);
            session.requireActive();
            stage = Stage.RELAY;
            trace(stage, Event.STARTED);
            RelaySession relay = connectRelay(uid, servers, session);
            trace(stage, Event.READY);
            session.requireActive();
            PpppConnection connection = new PpppConnection(relay.socket(), relay.relay(), line -> {});
            session.connection = connection;
            connection.start();
            MissClient miss = new MissClient(connection);
            session.miss = miss;
            session.requireActive();
            stage = Stage.AUTH;
            trace(stage, Event.STARTED);
            bounded(() -> miss.authenticate(clientPublic, signature, AUTH), AUTH, relay::close);
            sessionKey = MissCrypto.sessionKey(privateKey, devicePublic);
            miss.useSessionKey(sessionKey);
            trace(stage, Event.READY);
            session.requireActive();
            stage = Stage.CAPTURE;
            trace(stage, Event.STARTED);
            session.videoRequested = true;
            miss.startVideo(quality, false);
            long deadline = System.nanoTime() + Duration.ofSeconds(seconds).toNanos();
            long lastFrame = System.nanoTime(), bytes = 0;
            boolean started = false;
            String codec = null;
            while (!session.stopped.get() && System.nanoTime() < deadline) {
                MediaPacket packet = miss.nextMedia(Duration.ofMillis(500));
                if (System.nanoTime() - lastFrame > STALL.toNanos()) throw new LiveFailure(FailureCode.FRAME_TIMEOUT);
                if (packet == null || !packet.isVideo() || packet.payload().length == 0) continue;
                if (!started && !packet.isKeyframe()) continue;
                if (!started) {
                    codec = packet.codecName();
                    if (!("H265".equalsIgnoreCase(codec) || "HEVC".equalsIgnoreCase(codec) || "H.265".equalsIgnoreCase(codec))) throw new LiveFailure(FailureCode.UNSUPPORTED_CODEC);
                    started = true;
                } else if (!codec.equals(packet.codecName())) throw new LiveFailure(FailureCode.CODEC_CHANGED);
                if (bytes + packet.payload().length > BYTE_LIMIT) throw new LiveFailure(FailureCode.BYTE_LIMIT);
                System.out.write(packet.payload());
                System.out.flush();
                if (System.out.checkError()) throw new LiveFailure(FailureCode.OUTPUT_CLOSED);
                if (bytes == 0) trace(stage, Event.FRAME_READY);
                bytes += packet.payload().length;
                lastFrame = System.nanoTime();
            }
            trace(stage, session.stopped.get() ? Event.CANCELLED : Event.COMPLETE);
            return started || session.stopped.get() ? 0 : 6;
        } catch (Exception failure) {
            if (session.stopped.get()) trace(stage, Event.CANCELLED);
            else {
                FailureCode code = failure instanceof LiveFailure known ? known.code : switch (stage) {
                    case INPUT -> FailureCode.INPUT_INVALID;
                    case RELAY -> FailureCode.RELAY_FAILED;
                    case AUTH -> FailureCode.AUTH_FAILED;
                    case CAPTURE -> FailureCode.CAPTURE_FAILED;
                };
                System.err.println("stage=" + stage.name() + " event=ERROR code=" + code.name());
            }
            return session.stopped.get() ? 0 : 6;
        } finally {
            session.close();
            if (privateKey != null) Arrays.fill(privateKey, (byte) 0);
            if (sessionKey != null) Arrays.fill(sessionKey, (byte) 0);
        }
    }

    private static RelaySession connectRelay(Uid uid, List<String> servers, Session session) throws Exception {
        // A failed discovery socket is never reused. Retry only before auth/video;
        // this does not repeat camera commands or create concurrent streams.
        for (int attempt = 0; attempt < 2; attempt++) {
            session.requireActive();
            RelaySession candidate = new RelaySession(uid, servers, line -> {});
            session.relay = candidate;
            try {
                session.requireActive();
                bounded(() -> candidate.connect(CONNECT), CONNECT, candidate::close);
                if (candidate.relay() == null
                    || !publicIpv4(candidate.relay().getAddress().getHostAddress())) throw new Exception();
                session.requireActive();
                return candidate;
            } catch (Exception failure) {
                candidate.close();
                if (session.relay == candidate) session.relay = null;
                session.requireActive();
                if (attempt == 1) throw failure;
                trace(Stage.RELAY, Event.RETRY);
            }
        }
        throw new LiveFailure(FailureCode.RELAY_FAILED);
    }

    private static <T> T bounded(Callable<T> action, Duration duration, Runnable abort) throws Exception {
        var executor = Executors.newSingleThreadExecutor(runnable -> {
            Thread worker = new Thread(runnable, "live-stage"); worker.setDaemon(true); return worker;
        });
        var future = executor.submit(action);
        try { return future.get(duration.toMillis(), TimeUnit.MILLISECONDS); }
        catch (Exception failure) { abort.run(); future.cancel(true); throw failure; }
        finally { executor.shutdownNow(); }
    }

    private static String required(Properties properties, String name) throws Exception {
        String value = properties.getProperty(name, "").trim();
        if (value.isEmpty() || value.length() > 8192) throw new Exception();
        return value;
    }

    private static String hex(Properties properties, String name, int length) throws Exception {
        String value = required(properties, name);
        if (value.length() > 4096 || value.length() % 2 != 0 || !value.matches("[0-9a-fA-F]+")
            || (length > 0 && value.length() != length * 2)) throw new Exception();
        return value;
    }

    private static boolean publicIpv4(String address) {
        String[] parts = address.split("\\.", -1);
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        for (int i = 0; i < 4; i++) {
            if (!parts[i].matches("[0-9]{1,3}")) return false;
            octets[i] = Integer.parseInt(parts[i]);
            if (octets[i] > 255) return false;
        }
        int a = octets[0], b = octets[1];
        return !(a == 0 || a == 10 || a == 127 || a >= 224
            || (a == 100 && b >= 64 && b <= 127) || (a == 169 && b == 254)
            || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168)
            || (a == 192 && b == 0) || (a == 198 && (b == 18 || b == 19))
            || (a == 198 && b == 51 && octets[2] == 100) || (a == 203 && b == 0 && octets[2] == 113));
    }
}
