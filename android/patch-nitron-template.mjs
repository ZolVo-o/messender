#!/usr/bin/env node
// Nitron 2.0.2 не пересылает getUserMedia() в системное разрешение Android.
// Этот шаблон добавляет безопасную обработку только RESOURCE_AUDIO_CAPTURE.
import { copyFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const androidDir = dirname(fileURLToPath(import.meta.url));
const source = resolve(androidDir, 'nitron-template/base.apk');
const target = resolve(androidDir, 'node_modules/nitron/template/base.apk');

try {
  await access(target, constants.W_OK);
} catch {
  throw new Error('Nitron не установлен. Выполните: npm install --no-save --prefix android nitron@2.0.2');
}

await copyFile(source, target);
console.log('Исправленный шаблон Nitron для микрофона установлен.');
