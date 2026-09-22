import os
import logging
import uuid
from collections import Counter
from PIL import Image
from flask import Flask, request, jsonify

# Исправление фиксации безопасности PyTorch 2.6+ для загрузки YOLO
import torch
from ultralytics.nn.tasks import DetectionModel
torch.serialization.add_safe_globals([DetectionModel])

from ultralytics import YOLO

# ================================================================
#                        НАСТРОЙКИ И ИНИЦИАЛИЗАЦИЯ
# ================================================================

app = Flask(__name__)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
logging.getLogger("ultralytics").setLevel(logging.ERROR)

TEMP_DIR = "temp_captcha"
os.makedirs(TEMP_DIR, exist_ok=True)

MODEL_PATH = os.path.abspath("best.pt")

if not os.path.exists(MODEL_PATH):
    logger.error(f"Модель по пути {MODEL_PATH} не найдена!")
    exit(1)

model = YOLO(MODEL_PATH, task='detect')
logger.info(f"Модель успешно загружена: {MODEL_PATH}")

# ================================================================
#                        ФУНКЦИЯ ОБРАБОТКИ КАПЧИ
# ================================================================

confidence_thresholds = [0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.25]


def _predict(image_path, imgsz):
    """Одна попытка распознавания на заданном размере входа."""
    all_boxes = []
    for conf in confidence_thresholds:
        results = model.predict(
            source=image_path,
            imgsz=imgsz,
            conf=conf,
            iou=0.4,
            verbose=False
        )

        all_boxes = []
        for result in results:
            boxes = result.boxes.data.tolist()
            all_boxes.extend(boxes)

        if len(all_boxes) >= 5:
            all_boxes.sort(key=lambda x: x[4], reverse=True)
            top_5 = all_boxes[:5]
            top_5.sort(key=lambda x: x[0])

            captcha_text = "".join(model.names[int(box[5])] for box in top_5)
            logger.info(f"Распознано (imgsz={imgsz}, conf={conf}): {captcha_text}")
            return captcha_text

    if all_boxes:
        all_boxes.sort(key=lambda x: x[0])
        captcha_text = "".join(model.names[int(box[5])] for box in all_boxes)
        logger.info(f"Распознано частично (imgsz={imgsz}): {captcha_text}")
        return captcha_text

    return ""


def process_captcha(image_path):
    """Мультимасштабное голосование: гадаем на 640/960/1280 и берём большинство.
    При равенстве побеждает первый увиденный ответ (640 — как в обучении)."""
    texts = []
    for imgsz in (640, 960, 1280):
        t = _predict(image_path, imgsz)
        if t:
            texts.append(t)
            # быстрый путь: 640 уже нашёл >=5 цифр — доверяем, без прогонов
            # 960/1280 (каждый ~0.5с на CPU). Иначе — прежний голосование.
            if imgsz == 640 and len(t) >= 5:
                logger.info(f"Быстрый путь (imgsz=640, {len(t)} цифр): {t}")
                return t

    if not texts:
        return ""

    counts = Counter(texts)
    best = max(counts.items(), key=lambda kv: kv[1])[0]
    if len(counts) > 1:
        logger.warning(f"Голосование разошлось: {texts} -> {best}")
    return best

# ================================================================
#                           ЭНДПОИНТ SOLVE
# ================================================================

@app.route('/solve', methods=['POST'])
def solve():
    temp_path = None
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'Отсутствует поле file'}), 400

        file = request.files['file']
        if file.filename == '':
            return jsonify({'error': 'Файл не выбран'}), 400

        file_ext = os.path.splitext(file.filename)[1] or '.png'
        temp_filename = f"{uuid.uuid4()}{file_ext}"
        temp_path = os.path.join(TEMP_DIR, temp_filename)
        file.save(temp_path)

        with Image.open(temp_path) as img:
            img.verify()

        result_text = process_captcha(temp_path)
        return jsonify({'result': result_text})

    except Exception as e:
        logger.error(f"Ошибка при обработке: {str(e)}")
        return jsonify({'error': str(e)}), 500
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)

if __name__ == '__main__':
    print("Запуск сервера распознавания капчи...")
    print("Эндпоинт: http://0.0.0.0:5000/solve (POST)")
    # threaded: параллельные клиенты не ждут друг друга в очереди на инференс
    app.run(host='0.0.0.0', port=5000, debug=False, threaded=True)