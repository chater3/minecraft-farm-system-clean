import requests

# URL вашего поднятого сервера
url = "http://127.0.0.1:5000/solve"
# Укажите путь к реальной картинке с капчей
image_path = "test_captcha.png" 

try:
    with open(image_path, "rb") as file:
        files = {"file": file}
        print("Отправка запроса на сервер...")
        response = requests.post(url, files=files)
        
    # Выводим ответ от сервера
    print("Статус код:", response.status_code)
    print("Ответ:", response.json())
except FileNotFoundError:
    print(f"Положите картинку {image_path} рядом со скриптом!")