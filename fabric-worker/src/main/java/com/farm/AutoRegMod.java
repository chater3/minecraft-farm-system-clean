package com.farm;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.client.MinecraftClient;
import net.minecraft.entity.Entity;
import net.minecraft.entity.decoration.DisplayEntity;
import net.minecraft.entity.decoration.ItemFrameEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.component.type.MapIdComponent;
import net.minecraft.item.map.MapState;
import java.io.File;

public class AutoRegMod implements ClientModInitializer {
    private boolean isCaptchaProcessed = false;
    private int tickDelay = 0;

    @Override
    public void onInitializeClient() {
        System.out.println("[FarmWorker] Умный поиск капчи запущен...");

        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            if (client.player == null || client.world == null || isCaptchaProcessed) {
                return;
            }

            tickDelay++;
            if (tickDelay < 10)
                return; // Проверяем каждые полсекунды
            tickDelay = 0;

            Entity closestEntity = null;
            double minDistance = Double.MAX_VALUE;
            ItemStack targetStack = null;

            // Ищем ближайшую карту в радиусе 5 блоков (игнорируем то, что далеко)
            for (Entity entity : client.world.getEntities()) {
                double distance = client.player.distanceTo(entity);
                if (distance > 5.0)
                    continue; // Слишком далеко, пропускаем

                ItemStack stack = null;
                if (entity instanceof ItemFrameEntity frame) {
                    stack = frame.getHeldItemStack();
                } else if (entity instanceof DisplayEntity.ItemDisplayEntity display) {
                    stack = display.getItemStack();
                }

                if (stack != null && stack.isOf(Items.FILLED_MAP)) {
                    if (distance < minDistance) {
                        minDistance = distance;
                        closestEntity = entity;
                        targetStack = stack;
                    }
                }
            }

            // Если нашли самую близкую карту прямо перед собой — обрабатываем её
            if (targetStack != null) {
                if (processIfMap(client, targetStack)) {
                    isCaptchaProcessed = true;
                }
            }
        });
    }

    private boolean processIfMap(MinecraftClient client, ItemStack stack) {
        MapIdComponent mapId = stack.get(DataComponentTypes.MAP_ID);
        if (mapId != null) {
            MapState mapState = client.world.getMapState(mapId);
            if (mapState != null && mapState.colors.length > 0) {
                processCaptchaAndRegister(client, mapState);
                return true;
            }
        }
        return false;
    }

    private void processCaptchaAndRegister(MinecraftClient client, MapState mapState) {
        new Thread(() -> {
            try {
                System.out.println("[FarmWorker] Главная капча найдена! Рендерим...");
                File imgFile = MapRenderer.saveMapToFile(mapState, "current_captcha.png");

                System.out.println("[FarmWorker] Отправляем картинку на Python YOLO сервер...");
                String captchaText = CaptchaClient.solveCaptcha(imgFile);
                System.out.println("[FarmWorker] Нейросеть распознала: " + captchaText);

                if (!captchaText.isEmpty()) {
                    String password = System.getProperty("farm.password", "FallbackPass123");
                    String command = "register " + password + " " + captchaText;
                    System.out.println("[FarmWorker] Вводим в чат: /" + command);

                    client.execute(() -> {
                        if (client.player != null && client.player.networkHandler != null) {
                            client.player.networkHandler.sendChatCommand(command);
                        }
                    });

                    Thread.sleep(3000);
                    System.exit(0);
                } else {
                    System.err.println("[FarmWorker] Ошибка: нейросеть не смогла прочитать цифры.");
                    isCaptchaProcessed = false;
                }
            } catch (Exception e) {
                e.printStackTrace();
                isCaptchaProcessed = false;
            }
        }).start();
    }
}