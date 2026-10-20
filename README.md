# Discord Music Bot

Музыкальный Discord-бот на Node.js с поддержкой Components V2, аудиофильтрами (Slowed, Bassboost, Speed UP, 8D Audio), Smart Crossfade, автоплеем и поиском по YouTube / Spotify.

## Возможности

- **Воспроизведение (`/play`)**: треки и плейлисты YouTube / Spotify, быстрый поиск с автодополнением (Deezer/iTunes).
- **Аудиофильтры на лету**: Slowed + Reverb, Bassboosted (Hard), Speed UP, 8D Audio.
- **Smart Crossfade (`/crossfade`)**: плавный переход между песнями.
- **Smart Autoplay**: автоматический подбор похожих треков при окончании очереди.
- **Очередь и история**: `/queue` (постраничный просмотр очереди), `/history` (повтор недавних треков в один клик).
- **Интерактивные кнопки**: управление воспроизведением прямо под карточкой трека.

---

## 1. Создание и настройка бота в Discord

1. Перейдите в [Discord Developer Portal](https://discord.com/developers/applications) и нажмите кнопку **New Application**.
2. В разделе **General Information** скопируйте **Application ID** (это значение для `DISCORD_CLIENT_ID`).
3. Перейдите во вкладку **Bot**:
   - Нажмите **Reset Token** и скопируйте полученный ключ (это значение для `DISCORD_TOKEN`).
   - В блоке **Privileged Gateway Intents** включите **Server Members Intent**.
4. Перейдите во вкладку **OAuth2** -> **URL Generator**:
   - В блоке **Scopes** отметьте: `bot`, `applications.commands`.
   - В блоке **Bot Permissions** отметьте: `Connect`, `Speak`, `Send Messages`, `View Channel`, `Read Message History`.
   - Скопируйте полученную ссылку внизу страницы, откройте в браузере и добавьте бота на свой Discord-сервер.

---

## 2. Установка и запуск

### Требования
- Node.js версии 20+
- ОС: Linux (Ubuntu/Debian) или Windows

### Быстрый старт

1. Установите зависимости:
   ```bash
   npm install
   ```

2. Скопируйте шаблон `.env.example` в `.env` и заполните:
   ```env
   DISCORD_TOKEN=ваш_токен_бота
   DISCORD_CLIENT_ID=id_приложения
   DISCORD_GUILD_ID=id_сервера  # опционально, для мгновенной регистрации команд на конкретном сервере
   ```

3. Зарегистрируйте слэш-команды в Discord:
   ```bash
   npm run deploy
   ```

4. Запустите бота:
   ```bash
   npm start
   ```

---

## 3. Развертывание на сервере (Linux / VPS через PM2)

Для постоянной работы бота в фоновом режиме:

```bash
# Установка PM2
npm install -g pm2

# Запуск бота
pm2 start src/index.js --name "music-bot"

# Настройка автозапуска при перезагрузке сервера
pm2 save
pm2 startup
```

---

## 4. Как запустить музыку в самом Discord

1. Зайдите в любой голосовой канал на вашем сервере.
2. В любом текстовом канале напишите слэш-команду:
   ```text
   /play query: название песни или ссылка (YouTube / Spotify)
   ```
3. Бот подключится к вашему голосовому каналу, отправит карточку плеера и начнет воспроизведение.
4. Переключать треки, ставить на паузу и включать фильтры звука можно нажатием кнопок прямо под карточкой трека.
