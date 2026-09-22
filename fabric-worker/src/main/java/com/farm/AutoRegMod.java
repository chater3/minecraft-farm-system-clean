package com.farm;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.util.ScreenshotRecorder;
import net.minecraft.entity.Entity;
import net.minecraft.entity.decoration.DisplayEntity;
import net.minecraft.entity.decoration.ItemFrameEntity;
import net.minecraft.util.math.Direction;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.component.type.MapIdComponent;
import net.minecraft.item.map.MapState;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * FarmWorker v5 — капча берётся из СКРИНШОТА (F2) кадром стены из карт:
 *  1. находим стену рамок с картами ПЕРЕД игроком (bbox в мировых координатах)
 *  2. СКРЫВАЕМ HUD (аналог F1) — чат/прицел/рука не должны перекрывать цифры — и делаем скриншот
 *  3. проецируем bbox стены на экран (FOV/pitch/yaw) и кропаем картинку
 *  4. кроп отправляем в YOLO, решение — обычным сообщением в чат
 *  5. при "Вы ввели капчу неправильно" — повторяем цикл (новая картинка на стене), пока есть попытки
 *  6. ждём "Проверка пройдена" → шлём /reg <pass> <pass>
 * (MapState-декодер оставлен только для диагностики — он даёт чёрный экран)
 */
public class AutoRegMod implements ClientModInitializer {

    private enum State { WAIT_WALL, WAIT_SHOT, SOLVING, SENT_DIGITS, SENT_REG }

    private volatile State state = State.WAIT_WALL;
    private volatile boolean passSeen = false;
    private volatile int solveAttempts = 0;
    private volatile int wrongAttempts = 0;
    private volatile int regReprompt = 0;
    private volatile boolean regConfirmed = false;
    private volatile long regStartAt = 0;
    private volatile long digitsSentAt = 0;
    private volatile long regSentAt = 0;

    // снимок
    private volatile File pendingShot = null;
    private volatile String pendingTag = "wall";
    private volatile int hudWarmup = 0; // тиков (x5) до снимка, пока HUD скрыт
    private volatile long shotDeadline = 0;
    private volatile long firstSeenAt = 0;

    // место съёмки (камера в момент скриншота)
    private volatile double eyeX, eyeY, eyeZ;
    private volatile double yawDeg, pitchDeg;

    // стена в КАМЕРНЫХ координатах (блоки): l — поперёк взгляда, v — вверх от глаз, f — вперёд
    private volatile double wallLMin = 0, wallLMax = 0, wallVMin = 0, wallVMax = 0, wallFwd = 1;
    private volatile boolean processing = false;
    private volatile Double fovDeg = null;

    private int tickCounter = 0;
    private int ticksInWorld = 0;
    private boolean dumped = false;
    private long lastShotAt = 0;

    private int lastFrameCount = -1;
    private int stableScans = 0;

    @Override
    public void onInitializeClient() {
        System.out.println("[FarmWorker] v5 запущен: скрытый HUD + кроп стены + повтор при ошибке");

        ClientReceiveMessageEvents.GAME.register((message, overlay) -> {
            String text = message.getString();
            System.out.println("[FarmWorker] SRV: " + text);
            if (text.contains("Проверка пройдена")) {
                passSeen = true;
                System.out.println("[FarmWorker] STATE PASS_OK");
            } else if (text.contains("не прошли проверку")) {
                System.out.println("[FarmWorker] STATE EXIT 3: BotFilter отклонил ответ");
                System.exit(3);
            } else if (text.contains("капчу неправильно")) {
                wrongAttempts++;
                System.out.println("[FarmWorker] STATE CAPTCHA_WRONG #" + wrongAttempts);
                if (wrongAttempts >= 3) {
                    System.out.println("[FarmWorker] STATE EXIT 3: попытки на капчу исчерпаны (3 неверных ответа)");
                    System.exit(3);
                }
                // на стене уже новая картинка — переснимаем и решаем заново
                requestShot("wrong" + wrongAttempts);
            } else if (text.contains("Зарегистрируйтесь")) {
                System.out.println("[FarmWorker] SRV REG_PROMPT (state=" + state + ")");
                // после нашей команды сервер переспрашивает → повторяем /reg <Пароль>
                if (state == State.SENT_REG && regReprompt < 2) {
                    regReprompt++;
                    MinecraftClient.getInstance().execute(() -> {
                        var p = MinecraftClient.getInstance().player;
                        if (p == null) return;
                        String pass = System.getProperty("farm.password", "FallbackPass123");
                        p.networkHandler.sendChatCommand("reg " + pass);
                        regSentAt = System.currentTimeMillis() + 8000;
                        System.out.println("[FarmWorker] REG_RESEND #" + regReprompt + " /reg " + pass);
                    });
                }
            } else if (text.contains("спешная регистрация") || text.contains("Добро пожаловать")) {
                regConfirmed = true;
                System.out.println("[FarmWorker] STATE REG_OK: " + text.trim());
            } else if (text.toLowerCase().contains("егистр")) {
                System.out.println("[FarmWorker] STATE REG_CONFIRM: " + text);
            }
        });

        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            if (client.player == null || client.world == null) {
                ticksInWorld = 0;
                dumped = false;
                processing = false;
                return;
            }
            ticksInWorld++;
            tickCounter++;
            if (tickCounter % 5 != 0) return; // каждые 0.25с

            switch (state) {
                case WAIT_WALL -> {
                    if (!dumped && ticksInWorld >= 80) { // ~2с
                        dumpNearby(client);
                        takeScreenshot(client, "dump");
                        dumped = true;
                    }
                    scanWall(client);
                    if (lastFrameCount == 0 && ticksInWorld >= 2400) { // 60с
                        System.out.println("[FarmWorker] STATE EXIT 4: стена с картами не найдена за 60с");
                        System.exit(4);
                    }
                }
                case WAIT_SHOT -> {
                    if (hudWarmup > 0) {
                        // HUD скрыт — ждём несколько кадров рендера, чтобы снимок был чистым
                        if (--hudWarmup == 0) {
                            System.out.println("[FarmWorker] hudHidden=" + client.options.hudHidden + " перед снимком");
                            takeScreenshot(client, pendingTag);
                        }
                        return;
                    }
                    File shot = pendingShot;
                    long now = System.currentTimeMillis();
                    if (shot != null && shot.exists() && shot.length() > 0) {
                        if (firstSeenAt == 0) firstSeenAt = now;
                        if (now - firstSeenAt > 300 && !processing) { // файл дописан
                            processing = true;
                            final File shotFile = shot;
                            new Thread(() -> processShot(client, shotFile), "captcha-process").start();
                        }
                    }
                    if (now > shotDeadline && !processing) {
                        System.out.println("[FarmWorker] Ждём скриншот дольше 15с — переснимаем");
                        takeScreenshot(client, "wall_retry");
                        shotDeadline = now + 15000;
                        firstSeenAt = 0;
                    }
                }
                case SOLVING -> { /* ответ HTTP в потоке */ }
                case SENT_DIGITS -> {
                    long now = System.currentTimeMillis();
                    if (passSeen) {
                        String pass = System.getProperty("farm.password", "FallbackPass123");
                        // сервер: "/reg <Пароль>" — ровно ОДИН аргумент
                        String cmd = "reg " + pass;
                        System.out.println("[FarmWorker] STATE REG_SEND /" + cmd);
                        client.player.networkHandler.sendChatCommand(cmd);
                        regSentAt = now + 8000;
                        regStartAt = now;
                        state = State.SENT_REG;
                    } else if (digitsSentAt > 0 && now > digitsSentAt + 25000) {
                        System.out.println("[FarmWorker] STATE EXIT 4: BotFilter не подтвердил прохождение за 25с");
                        System.exit(4);
                    }
                }
                case SENT_REG -> {
                    long now = System.currentTimeMillis();
                    if (regConfirmed) {
                        System.out.println("[FarmWorker] STATE EXIT 0: регистрация подтверждена сервером");
                        System.exit(0);
                    }
                    if (now > regSentAt && now - regStartAt > 25000) {
                        System.out.println("[FarmWorker] STATE EXIT 3: сервер не подтвердил регистрацию за 25с");
                        System.exit(3);
                    }
                }
            }
        });
    }

    /* ---------------- поиск стены и кадрирование ---------------- */

    private void scanWall(MinecraftClient client) {
        double yaw = Math.toRadians(client.player.getYaw());
        double pitch = Math.toRadians(client.player.getPitch());
        double fx = -Math.cos(pitch) * Math.sin(yaw);
        double fy = -Math.sin(pitch);
        double fz = Math.cos(pitch) * Math.cos(yaw);
        double rl = Math.hypot(-fz, fx);
        double rx = -fz / rl;
        double rz = fx / rl;

        var eye = client.player.getEyePos();
        double ex = eye.x, ey = eye.y, ez = eye.z;

        List<double[]> framePts = new ArrayList<>(); // {l, v, f} — рамки, смотрящие на игрока
        List<double[]> dispPts = new ArrayList<>();  // item display'ы (нет направления)
        int excluded = 0;

        for (Entity e : client.world.getEntities()) {
            if (client.player.distanceTo(e) > 12.0) continue;
            ItemStack s = stackOf(e);
            if (s == null || !s.isOf(Items.FILLED_MAP)) continue;

            MapIdComponent id = s.get(DataComponentTypes.MAP_ID);
            MapState st = id != null ? client.world.getMapState(id) : null;
            if (st == null) continue;
            int nonzero = 0;
            for (byte b : st.colors) if (b != 0) nonzero++;
            if (nonzero < 300) continue;

            double dx = e.getX() - ex;
            double dy = e.getY() - ey;
            double dz = e.getZ() - ez;
            double f = dx * fx + dy * fy + dz * fz; // насколько вперёд от игрока
            if (f < 1.0) continue;                  // за спиной / вплотную — не считаем
            double l = dx * rx + dz * rz;           // поперёк взгляда (боковая координата)

            if (e instanceof ItemFrameEntity frame) {
                // берём только рамки, чья лицевая сторона смотрёт НА игрока —
                // иначе в bbox попадут боковые/задние стенки
                var nv = frame.getFacing().getVector();
                double faceDot = nv.getX() * fx + nv.getY() * fy + nv.getZ() * fz;
                if (faceDot > -0.5) { excluded++; continue; }
                framePts.add(new double[]{l, e.getY() - ey, f});
            } else {
                dispPts.add(new double[]{l, e.getY() - ey, f});
            }
        }

        List<double[]> pts;
        if (framePts.size() >= 6) pts = framePts;
        else if (framePts.size() + dispPts.size() >= 6) {
            pts = new ArrayList<>(framePts);
            pts.addAll(dispPts);
        } else pts = framePts;

        int count = pts.size();
        if (count != lastFrameCount) {
            System.out.println("[FarmWorker] WALL frames=" + count
                    + " (facing=" + framePts.size() + " displays=" + dispPts.size() + " excluded=" + excluded + ")");
            lastFrameCount = count;
            stableScans = 0;
            return;
        }
        if (count < 6) return;
        if (++stableScans < 2) return;

        double lMin = Double.MAX_VALUE, lMax = -Double.MAX_VALUE;
        double vMin = Double.MAX_VALUE, vMax = -Double.MAX_VALUE;
        double fSum = 0;
        for (double[] p : pts) {
            lMin = Math.min(lMin, p[0] - 0.5);
            lMax = Math.max(lMax, p[0] + 0.5);
            vMin = Math.min(vMin, p[1] - 0.5);
            vMax = Math.max(vMax, p[1] + 0.5);
            fSum += p[2];
        }
        wallLMin = lMin;
        wallLMax = lMax;
        wallVMin = vMin;
        wallVMax = vMax;
        wallFwd = fSum / pts.size();

        // камера в момент съёмки
        eyeX = ex;
        eyeY = ey;
        eyeZ = ez;
        yawDeg = client.player.getYaw();
        pitchDeg = client.player.getPitch();

        System.out.printf("[FarmWorker] STATE WALL_READY l=[%.2f..%.2f] v=[%.2f..%.2f] f=%.2f eye=(%.2f,%.2f,%.2f) yaw=%.1f pitch=%.1f%n",
                wallLMin, wallLMax, wallVMin, wallVMax, wallFwd, eyeX, eyeY, eyeZ, yawDeg, pitchDeg);

        requestShot("wall");
        state = State.WAIT_SHOT; // синхронно — чтобы WAIT_WALL не дёргал scanWall заново
        stableScans = 0;
    }

    /**
     * Запрашивает скриншот: скрывает HUD, ждёт несколько кадров рендера
     * (иначе в буфер попадёт кадр со старым HUD) и снимает.
     */
    private void requestShot(String tag) {
        MinecraftClient c = MinecraftClient.getInstance();
        c.execute(() -> {
            pendingTag = tag;
            hudWarmup = 4; // 4 × 5 тиков ≈ 1с — HUD гарантированно скрыт в буфере
            c.options.hudHidden = true;
            processing = false;
            firstSeenAt = 0;
            state = State.WAIT_SHOT;
            shotDeadline = System.currentTimeMillis() + 15000;
            System.out.println("[FarmWorker] SHOT_REQUEST tag=" + tag + " (HUD скрыт, снимок через ~1с)");
        });
    }

    /** Кропает из скриншота область стены и решает капчу. Работает в отдельном потоке. */
    private void processShot(MinecraftClient client, File shotFile) {
        try {
            BufferedImage shot = ImageIO.read(shotFile);
            if (shot == null) throw new IllegalStateException("не удалось прочитать скриншот " + shotFile);

            double fov = getFovDeg(client);
            int[] c1 = projectCam(wallLMin, wallVMin, wallFwd, fov, shot.getWidth(), shot.getHeight());
            int[] c2 = projectCam(wallLMax, wallVMax, wallFwd, fov, shot.getWidth(), shot.getHeight());

            int margin = 6;
            int x = Math.max(0, Math.min(c1[0], c2[0]) - margin);
            int y = Math.max(0, Math.min(c1[1], c2[1]) - margin);
            int w = Math.min(shot.getWidth() - x, Math.abs(c2[0] - c1[0]) + margin * 2);
            int h = Math.min(shot.getHeight() - y, Math.abs(c2[1] - c1[1]) + margin * 2);

            if (w < 40 || h < 40) {
                System.out.println("[FarmWorker] CROP too small " + w + "x" + h + " — переснимаем");
                requestShot("wall_small");
                return;
            }

            BufferedImage crop = shot.getSubimage(x, y, w, h);
            // уникальное имя на процесс: два клиента в одной папке не перетирают файл
            File out = MapRenderer.saveImage(crop,
                    "captcha_" + ProcessHandle.current().pid() + "_" + System.currentTimeMillis() + ".png");
            try {
                MapRenderer.saveImage(crop, "current_captcha.png"); // отладочная копия «последнего» кропа
            } catch (Throwable ignored) { /* гонка двух клиентов не страшна */ }

            System.out.printf("[FarmWorker] STATE CROP x=%d y=%d w=%d h=%d corners=(%d,%d)-(%d,%d) img=%dx%d%n",
                    x, y, w, h, c1[0], c1[1], c2[0], c2[1], shot.getWidth(), shot.getHeight());

            state = State.SOLVING;
            solveWorker(out);
        } catch (Exception e) {
            System.err.println("[FarmWorker] STATE EXIT 5: обработка скриншота: " + e);
            e.printStackTrace();
            System.exit(5);
        }
    }

    /** Проекция точки (l — поперёк взгляда, v — вверх от глаз, f — вперёд) в пиксели скриншота. */
    private int[] projectCam(double l, double v, double f, double fov, int imgW, int imgH) {
        double tan = Math.tan(Math.toRadians(fov) / 2.0);
        double aspect = (double) imgW / imgH;

        double ndcX = l / (f * tan * aspect);
        double ndcY = v / (f * tan);

        int sx = (int) Math.round((ndcX * 0.5 + 0.5) * imgW);
        int sy = (int) Math.round((0.5 - ndcY * 0.5) * imgH);
        return new int[]{sx, sy};
    }

    /** FOV из options.txt: современные версии хранят долю слайда 70..110 (0.45 => 88°). */
    private double getFovDeg(MinecraftClient client) {
        if (fovDeg != null) return fovDeg;
        double result = 70.0;
        try (BufferedReader reader = new BufferedReader(new FileReader(new File(client.runDirectory, "options.txt")))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.startsWith("fov:")) {
                    double v = Double.parseDouble(line.substring(4).trim());
                    result = v > 1.0 ? v : 70.0 + 40.0 * v;
                    break;
                }
            }
        } catch (Exception e) {
            System.out.println("[FarmWorker] FOV не прочитан, используем 70: " + e);
        }
        fovDeg = result;
        System.out.println("[FarmWorker] FOV = " + result + "°");
        return result;
    }

    /* ---------------- отправка решения и регистрация ---------------- */

    private void solveWorker(File baseImage) {
        try {
            System.out.println("[FarmWorker] STATE SOLVE_START " + baseImage.getName());
            String digits = "";

            // одна попытка — флипы детерминированы и только тратят время до кика
            String result = CaptchaClient.solveCaptcha(baseImage);
            System.out.println("[FarmWorker] STATE SOLVED [" + result + "]");
            if (result != null && result.matches("\\d{4,7}")) {
                digits = result;
            } else {
                System.out.println("[FarmWorker] ответ [" + result + "] не похож на 4-7 цифр — новый кадр");
            }

            if (digits.isEmpty()) {
                solveAttempts++;
                if (solveAttempts >= 5) {
                    System.out.println("[FarmWorker] STATE EXIT 3: нейросеть не распознала капчу (5 попыток)");
                    System.exit(3);
                }
                // заново: новый кадр, новый кроп
                requestShot("solve_retry" + solveAttempts);
                return;
            }

            final String text = digits;
            MinecraftClient.getInstance().execute(() -> {
                var player = MinecraftClient.getInstance().player;
                if (player == null || player.networkHandler == null) {
                    System.out.println("[FarmWorker] STATE EXIT 6: нет игрока для отправки чата");
                    System.exit(6);
                    return;
                }
                player.networkHandler.sendChatMessage(text);
                System.out.println("[FarmWorker] STATE CHAT_SENT [" + text + "]");
                digitsSentAt = System.currentTimeMillis();
                state = State.SENT_DIGITS;
            });
        } catch (Exception e) {
            System.err.println("[FarmWorker] STATE EXIT 7: solve: " + e);
            e.printStackTrace();
            solveAttempts++;
            if (solveAttempts >= 5) System.exit(7);
            else requestShot("solve_exc" + solveAttempts);
        } finally {
            // временный кропcaptcha_<pid>_<ts>.png больше не нужен — убираем
            try {
                if (baseImage != null && baseImage.getName().startsWith("captcha_")) baseImage.delete();
            } catch (Throwable ignored) { /* не мешаем выходу */ }
        }
    }

    private File flipImage(File base, int flip) throws Exception {
        BufferedImage src = ImageIO.read(base);
        BufferedImage dst = new BufferedImage(src.getWidth(), src.getHeight(), BufferedImage.TYPE_INT_RGB);
        boolean fx = flip == 1 || flip == 3;
        boolean fy = flip == 2 || flip == 3;
        for (int yy = 0; yy < src.getHeight(); yy++) {
            for (int xx = 0; xx < src.getWidth(); xx++) {
                int dx = fx ? src.getWidth() - 1 - xx : xx;
                int dy = fy ? src.getHeight() - 1 - yy : yy;
                dst.setRGB(dx, dy, src.getRGB(xx, yy));
            }
        }
        File out = new File("current_captcha_f" + flip + ".png");
        ImageIO.write(dst, "png", out);
        return out;
    }

    /* ---------------- диагностика и скриншот ---------------- */

    private void dumpNearby(MinecraftClient client) {
        System.out.println("[FarmWorker] ---- DUMP START ----");
        System.out.printf("[FarmWorker] POS x=%.2f y=%.2f z=%.2f yaw=%.1f pitch=%.1f%n",
                client.player.getX(), client.player.getY(), client.player.getZ(),
                client.player.getYaw(), client.player.getPitch());

        Map<String, Integer> types = new HashMap<>();
        int near = 0;
        for (Entity e : client.world.getEntities()) {
            if (client.player.distanceTo(e) > 12.0) continue;
            near++;
            types.merge(e.getType().getName().getString(), 1, Integer::sum);
        }
        System.out.println("[FarmWorker] entities<=12m: " + near + " " + types);

        int printed = 0;
        boolean rawLogged = false;
        for (Entity e : client.world.getEntities()) {
            double d = client.player.distanceTo(e);
            if (d > 12.0) continue;
            ItemStack s = stackOf(e);
            if (s == null || !s.isOf(Items.FILLED_MAP)) continue;
            MapIdComponent id = s.get(DataComponentTypes.MAP_ID);
            MapState st = id != null ? client.world.getMapState(id) : null;
            int nonzero = 0;
            if (st != null) for (byte b : st.colors) if (b != 0) nonzero++;
            System.out.printf("[FarmWorker] MAP DUMP id=%s dist=%.2f pos=(%.2f,%.2f,%.2f) nonzero=%d%n",
                    id, d, e.getX(), e.getY(), e.getZ(), nonzero);
            if (st != null && !rawLogged) {
                logRawBytes(st);
                rawLogged = true;
            }
            if (++printed >= 30) break;
        }
        if (printed == 0) System.out.println("[FarmWorker] MAP DUMP: карт рядом нет");
        System.out.println("[FarmWorker] ---- DUMP END ----");
    }

    /** Почему MapState рендерится в чёрное: первые байты + гистограмма. */
    private void logRawBytes(MapState st) {
        StringBuilder sb = new StringBuilder("[FarmWorker] MAP RAW first32=");
        for (int i = 0; i < 32 && i < st.colors.length; i++) {
            sb.append(String.format("%02X ", st.colors[i] & 0xFF));
        }
        Map<Integer, Integer> hist = new HashMap<>();
        for (byte b : st.colors) hist.merge(b & 0xFF, 1, Integer::sum);
        sb.append("| distinct=").append(hist.size());
        int shown = 0;
        for (Map.Entry<Integer, Integer> en : hist.entrySet()) {
            if (shown++ >= 8) break;
            sb.append(String.format(" [%02X]=%d", en.getKey(), en.getValue()));
        }
        System.out.println(sb);
    }

    private ItemStack stackOf(Entity e) {
        if (e instanceof ItemFrameEntity frame) return frame.getHeldItemStack();
        if (e instanceof DisplayEntity.ItemDisplayEntity display) return display.getItemStack();
        return null;
    }

    /** Скриншот в game/screenshots (аналог F2). Только из рендертотока. */
    private void takeScreenshot(MinecraftClient client, String tag) {
        long now = System.currentTimeMillis();
        if (now - lastShotAt < 1500) return;
        lastShotAt = now;
        // префикс юзером: два клиента в общей папке screenshots не путают файлы
        String uname = System.getProperty("farm.username");
        if (uname == null || uname.isEmpty()) {
            try {
                uname = client.getSession().getUsername();
            } catch (Throwable t) {
                uname = "player";
            }
        }
        uname = uname.replaceAll("[^A-Za-z0-9_]", "_");
        String name = "autoreg_" + uname + "_" + tag + "_" + now;
        try {
            ScreenshotRecorder.saveScreenshot(
                    client.runDirectory,
                    name,
                    client.getFramebuffer(),
                    message -> System.out.println("[FarmWorker] SHOT_MSG: " + message.getString()));
            File dir = new File(client.runDirectory, "screenshots");
            // ScreenshotRecorder может добавить .png — проверим оба варианта при ожидании
            pendingShot = new File(dir, name);
            System.out.println("[FarmWorker] SHOT_OK tag=" + tag + " file=" + pendingShot.getAbsolutePath());
        } catch (Throwable t) {
            System.out.println("[FarmWorker] SHOT_FAIL tag=" + tag + " err=" + t);
        }
    }
}
