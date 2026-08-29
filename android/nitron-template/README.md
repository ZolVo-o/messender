# Исправленный шаблон Nitron

`base.apk` содержит нативную оболочку Nitron 2.0.2 с обработкой `WebChromeClient.onPermissionRequest`.

Стандартная оболочка Nitron добавляет разрешение `RECORD_AUDIO` в Android Manifest, но не передаёт доступ WebView для `getUserMedia()`. Поэтому голосовые сообщения и звонки не работают.

В этом шаблоне Android запрашивает `RECORD_AUDIO` только после явного запроса WebView и выдаёт только `PermissionRequest.RESOURCE_AUDIO_CAPTURE`.

Перед запуском `npx nitron build` выполните `node patch-nitron-template.mjs` из папки `android`. Скрипт копирует этот шаблон в установленный пакет Nitron.
