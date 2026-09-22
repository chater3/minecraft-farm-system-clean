package com.farm;

import net.minecraft.item.map.MapState;
import net.minecraft.block.MapColor;
import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;

public class MapRenderer {

    /** Рендер одной карты 128x128 из MapState. */
    public static BufferedImage render(MapState mapState) {
        BufferedImage image = new BufferedImage(128, 128, BufferedImage.TYPE_INT_RGB);

        for (int i = 0; i < 16384; i++) {
            int x = i % 128;
            int y = i / 128;

            int colorByte = mapState.colors[i] & 255;
            int colorId = colorByte / 4;
            int brightness = colorByte & 3;

            MapColor color = MapColor.get(colorId);
            int rgb = color != null ? color.getRenderColor(brightness) : 0;

            image.setRGB(x, y, rgb);
        }
        return image;
    }

    public static File saveImage(BufferedImage image, String filename) throws IOException {
        File outputFile = new File(filename);
        ImageIO.write(image, "png", outputFile);
        return outputFile;
    }

    public static File saveMapToFile(MapState mapState, String filename) throws IOException {
        return saveImage(render(mapState), filename);
    }
}
