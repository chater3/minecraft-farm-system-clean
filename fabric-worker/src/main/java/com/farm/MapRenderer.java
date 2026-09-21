package com.farm;

import net.minecraft.item.map.MapState;
import net.minecraft.block.MapColor;
import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;

public class MapRenderer {

    public static File saveMapToFile(MapState mapState, String filename) throws IOException {
        // Карта в Майнкрафте всегда имеет размер 128x128 пикселей
        BufferedImage image = new BufferedImage(128, 128, BufferedImage.TYPE_INT_RGB);

        // Массив colors хранит 16384 байта (128 * 128)
        for (int i = 0; i < 16384; i++) {
            int x = i % 128;
            int y = i / 128;

            // Базовый алгоритм декодирования цвета карты Minecraft
            int colorByte = mapState.colors[i] & 255;
            int colorId = colorByte / 4;
            int brightness = colorByte & 3;

            MapColor color = MapColor.get(colorId);
            int rgb = color != null ? color.getRenderColor(brightness) : 0;

            image.setRGB(x, y, rgb);
        }

        File outputFile = new File(filename);
        ImageIO.write(image, "png", outputFile);
        return outputFile;
    }
}